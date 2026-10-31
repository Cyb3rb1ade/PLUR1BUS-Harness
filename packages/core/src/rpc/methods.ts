import { readHostEvalReports } from '../toolcall/host-eval-store.ts';
import { hostEvalGate } from '../toolcall/host-eval.ts';
import type { CheckpointResult, Deferral, Degraded, Engine, JobName, JobRun, Principal, RecallResult } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type { HarnessConfig } from "@plur1bus/config-schema";
import type {
  AgentCloseParams, AgentOpenParams, AgentStatusParams, CallerIdentity, CoreAdoptParams, CoreShutdownParams, CoreStatusResult, JobsHistoryParams, JobsRunParams,
  MemoryCaptureParams, MemoryCaptureResult, MemoryCheckpointParams, MemoryCheckpointResult, MemoryRecallParams, MemoryRecallResult,
  BudgetSetParams, BudgetStatusParams, ModelsAcknowledgeParams, ModelsListParams, ModelsRemoveManualParams, ModelsScanParams, ModelsSetOverrideParams,
} from "@plur1bus/rpc-schema";
import { buildActivityMethods } from "../activity-rpc.ts";
import type { ActivityTracker } from "../activity.ts";
import { buildAdminMethods } from "../admin-ops.ts";
import { buildAuditMethods } from "../audit/rpc.ts";
import type { AuditChain } from "../audit/chain.ts";
import { buildBackupMethods } from "../backup-ops.ts";
import type { Layout } from "../paths.ts";
import type { AgentRegistry } from "../agents.ts";
import { buildDreamsMethods } from "../dreams/methods.ts";
import { joinBlocks } from "../join.ts";
import type { HarnessLogger } from "../logger.ts";
import { apiPrincipal, isClientContext } from "@plur1bus/module-api";
import { buildMemoryCurationMethods } from "../memory-curation.ts";
import { buildMemoryOpMethods, mapMemoryOpError, requireAgent } from "../memory-ops.ts";
import { parseMemoryExport } from "../import/prompt/parse.ts";
import { executePromptImport, rollbackPromptImport } from "../import/prompt/execute.ts";
import { exportMemoriesAsText, EXPORT_PROMPT_TEXT } from "../import/prompt/export.ts";
import { recommendTargets } from "../import/prompt/recommend.ts";
import type { ParsedEntry } from "../import/prompt/types.ts";
import { createRedactor } from "../logs/redact.ts";
import { AGENT_CONTEXT_CLI, callerToPrincipal, validIdentity } from "../principal.ts";
import { deriveUserPrincipal } from "../identity/principals.ts";
import { resolveExposure } from "../memory-exposure/resolve.ts";
import { filterSensitiveBlocks, sensitivityRefusal, sensitivityService } from "../memory-exposure/sensitivity.ts";
import type { Exposure } from "../memory-exposure/types.ts";
import type { MemorySensitivityService } from "../memory-sensitivity/service.ts";
import { authenticatedPrincipal, LOCAL_OWNER } from "../rbac/guard.ts";
import { authorize } from "../rbac/authorize.ts";
import { buildIdentityMethods } from "../identity/rpc.ts";
import type { BudgetService } from "../budget/index.ts";
import type { Egress } from "../egress/index.ts";
import { CatalogError } from "../discovery/overrides.ts";
import { CatalogWriteError } from "../discovery/catalog-store.ts";
import { buildSecretMethods } from "../secrets/rpc.ts";
import { buildApprovalMethods, type ApprovalMethodDeps } from "../approvals/rpc.ts";
import { RpcError } from "./errors.ts";
import type { CallContext, Handler } from "./server.ts";

function mapDiscoveryError(err: unknown): never {
  if (err instanceof CatalogError) {
    if (err.code === "invalid") {
      throw new RpcError("E_INVALID_PARAMS", err.message, err.field !== undefined ? { detail: err.field } : {});
    }
    if (err.code === "conflict") {
      throw new RpcError("E_CONFLICT", err.message);
    }
    if (err.code === "not-found") {
      throw new RpcError("E_NOT_FOUND", err.message);
    }
    if (err.code === "not-manual") {
      throw new RpcError("E_INVALID_PARAMS", err.message, { reason: "not-manual" });
    }
  }
  if (err instanceof CatalogWriteError) {
    throw new RpcError("E_STORAGE", err.message, { reason: "catalog-write-failed" });
  }
  throw err;
}

export interface MethodDeps {
  hostEvalHome?: string;
  /** Read per external memory call; the service can become unavailable during shutdown. */
  memorySensitivity?: () => MemorySensitivityService | null;
  /** The running configuration, read per use: `core.recall.*` and `core.capture.waitMs` are live keys. */
  engine: Engine; config: () => HarnessConfig; agents: AgentRegistry; activity: ActivityTracker; logger: HarnessLogger;
  status: () => CoreStatusResult; shutdown: (budgetMs?: number) => void; journalBacklog: () => number; clock: () => number;
  /** R19: the core-owned shutdown signal, the only abort a capture observes. */
  captureSignal: AbortSignal;
  /** G17: true once the core is stopping or stopped; memory ops are refused from then on. */
  isStopping: () => boolean;
  /** S3/S4: verifies the nonce against run/supervisor.token and makes the connection the lifeline; throws E_UNAUTHORIZED. */
  adopt: (nonce: string, connectionId: string) => CoreStatusResult;
  /** After an applied `admin.migrate`: refreshes `core.status.engine.storeSchema`. */
  onMigrated: () => void | Promise<void>;
  /** M8: where `admin.backup.snapshot` stages (the home layout and the engine's configured store path). */
  backup?: { layout: Layout; baseDbPath: string };
  /** B5: the hash-chained audit file (`audit.verify`). */
  auditChain?: AuditChain;
  auditVerified?: (ok: boolean) => void;
  /** D112: harness-side system jobs registry. */
  systemJobs?: import("../system-jobs/index.ts").SystemJobs;
  /** D112: model discovery service. */
  discovery?: import("../discovery/service.ts").DiscoveryService;
  /** M1b-3: the dreaming scheduler (ADR-009); null while it is not running (`dreams.*` then answers E_NOT_AVAILABLE). */
  dreams?: () => import("../dreams/scheduler.ts").DreamScheduler | null;
  /** Why `dreams` is null when its store failed to open (shown as the refusal's detail). */
  dreamsError?: () => string | undefined;
  /** M3: the identity service (humans, linked channel identities, pairing); `identity.*` is served only when present. */
  identity?: import("../identity/service.ts").IdentityService;
  /** M2: the `admin.reembed.*` handlers (embedding-migrate/rpc.ts), when the core built a migration driver. */
  reembed?: Record<string, Handler>;
  /** M2 L8: the budget service (absent when its store could not be opened). */
  budget?: BudgetService;
  /** B4: the egress policy service (`egress.status`). */
  egress?: Egress;
  /** M2: the secret store and who a connection is. Absent, the `secret.*` methods are not served. */
  secrets?: import("../secrets/rpc.ts").SecretMethodDeps;
  /** D109: `grant.*` and `approval.*`. Absent, they are not served. */
  permissions?: ApprovalMethodDeps;
}

function guardedPrincipal(ctx: CallContext | undefined): import("../rbac/types.ts").Principal | undefined {
  if (!ctx) return undefined;
  try { return authenticatedPrincipal(ctx); } catch { return undefined; }
}

/** Protocol policy follows the verified token binding, never the caller's self-reported channel. */
function protocolExposure(d: MethodDeps, agentId: string, ctx: CallContext): {
  exposure: Exposure; filter: readonly string[];
} | undefined {
  if (isClientContext(ctx)) return undefined;
  const principal = guardedPrincipal(ctx) ?? apiPrincipal(ctx);
  const binding = principal?.binding;
  if (!binding) return undefined;
  if (binding.agentId !== agentId) {
    throw new RpcError("E_DENIED", "agentId does not match token binding", { reason: "agent-binding-mismatch" });
  }
  return {
    exposure: resolveExposure({ channel: binding.audience, agentId, principal, config: d.config() }),
    filter: binding.memory?.filter ?? [],
  };
}

function refusedRecall(reason: string, capChars: number): RecallResult {
  return {
    blocks: [], capChars, degraded: { reason, capability: "recall" },
    timing: { phases: null, totalMs: 0 }, deferrals: [],
  };
}

function identity(d: MethodDeps, caller: CallerIdentity, agentId: string, ctx?: CallContext): { principal: Principal; degraded: Degraded | null } {
  const workspace = requireAgent(d.agents, agentId);
  if (ctx && !isClientContext(ctx)) {
    const delegated = apiPrincipal(ctx);
    const guarded = guardedPrincipal(ctx);
    const effective = guarded ?? delegated ?? undefined;
    const binding = guarded?.binding ?? delegated?.binding;
    if (effective && (delegated != null || binding !== undefined)) {
      if (binding ? binding.agentId !== agentId : effective.kind === "agent") {
        throw new RpcError("E_DENIED", "agentId does not match token binding", { reason: "agent-binding-mismatch" });
      }
      const accountId = validIdentity(caller?.accountId) ? caller.accountId : (binding?.audience ?? "api");
      const { principal } = callerToPrincipal({ channel: "cli", accountId, userId: effective.userId }, agentId, workspace);
      principal.user = deriveUserPrincipal(effective.userId);
      if (effective.tokenScopes) {
        (principal as any).tokenScopes = effective.tokenScopes;
      }
      if (binding) {
        (principal as any).binding = binding;
      }
      return { principal, degraded: null };
    }
  }
  return callerToPrincipal(caller, agentId, workspace);
}

// The wire shapes are closed (rpc.schema.json): project every engine object onto exactly the schema's keys.
const projectDegraded = (g: Degraded | null | undefined): Degraded | null =>
  g ? { reason: String(g.reason), capability: String(g.capability ?? "recall"), ...(typeof g.detail === "string" ? { detail: g.detail } : {}) } : null;
const projectDeferral = (x: Deferral): Deferral => ({ block: x.block, kind: x.kind, from: x.from, to: x.to, reason: x.reason });

function serializeRecall(r: RecallResult, joined: boolean, capChars: number): MemoryRecallResult {
  const blocks = r.blocks.map((b) => ({ name: b.name, text: b.text, droppable: b.droppable, chars: b.chars, ...(b.tokensEstimate !== undefined ? { tokensEstimate: b.tokensEstimate } : {}) }));
  const engineCap = Number.isFinite(r.capChars) ? r.capChars : null;
  const base: MemoryRecallResult = {
    blocks, capChars: engineCap, degraded: projectDegraded(r.degraded), timing: { ...r.timing }, deferrals: (r.deferrals ?? []).map(projectDeferral),
    ...(r.trace ? { trace: r.trace } : {}),
  };
  return joined ? { ...base, joined: joinBlocks(blocks, engineCap === null ? capChars : Math.min(engineCap, capChars)) } : base;
}

const projectCheckpoint = (c: CheckpointResult): MemoryCheckpointResult => ({ agentId: c.agentId, reason: c.reason, digest: c.digest, written: c.written });

/** G17/H3-R21: the refusal a stopping core gives memory calls; clients treat it like an unreachable core. */
const coreStopping = (): RpcError => new RpcError("E_CORE_UNAVAILABLE", "core is stopping", { reason: "core-stopping" });

/** A budget input error (bad id, count, zone, soft > hard) is the caller's: E_INVALID_PARAMS. */
function mapBudgetError(err: unknown): never {
  if (err instanceof RangeError) throw new RpcError("E_INVALID_PARAMS", err.message);
  throw err;
}
const iso = (ms: number) => new Date(ms).toISOString();

export function buildMethods(d: MethodDeps): Record<string, Handler> {
  const openAgents = new Map<string, { close(): Promise<void> }>(); // one map per core

  const runJob = async (p: JobsRunParams, signal: AbortSignal): Promise<JobRun> => {
    if (!p.agentId) throw new RpcError("E_INVALID_PARAMS", "agentId is required for agent jobs", { detail: "agentId" });
    const agentId = p.agentId;
    requireAgent(d.agents, agentId);
    const spec = d.engine.jobs.list().find((j) => j.name === p.job);
    if (!spec) throw new RpcError("E_INVALID_PARAMS", `unknown job ${p.job}`, { detail: "job" });
    d.activity.set(agentId, spec.phase ? { state: "dreaming", phase: spec.phase, job: spec.name } : { state: "maintenance", job: spec.name });
    try { return await d.engine.jobs.run(spec.name, agentId, { signal, trigger: "harness", ...(p.dryRun !== undefined ? { dryRun: p.dryRun } : {}) }); }
    finally { d.activity.idle(agentId); }
  };

  return {
    "core.status": async () => d.status(),
    "core.shutdown": async (p: CoreShutdownParams) => { d.shutdown(p.budgetMs); return { accepted: true as const }; },
    "core.adopt": async (p: CoreAdoptParams, ctx) => ({ status: d.adopt(p.nonce, ctx.connectionId) }),

    "memory.recall": async (p: MemoryRecallParams, ctx) => {
      // H3-R21: a stopping core refuses a recall as core-unavailable (the client answers degraded core-unavailable),
      // instead of passing on the engine's "engine closed" as if the core had served it.
      if (d.isStopping()) throw coreStopping();
      const { principal, degraded } = identity(d, p.caller, p.agentId, ctx);
      const hardMs = p.budget?.hardMs ?? d.config().core.recall.hardBudgetMs;
      const softMs = p.budget?.softMs ?? d.config().core.recall.softBudgetMs;
      const capChars = p.budget?.capChars ?? d.config().core.recall.capChars;
      const protocol = protocolExposure(d, p.agentId, ctx);
      const sensitivity = protocol?.filter.length ? sensitivityService(d.memorySensitivity) : undefined;
      if (protocol) {
        const { recall } = protocol.exposure;
        // The engine always reads workspace and agent-private; its principal can only exclude user memory.
        if (!(recall.workspace && recall.agentPrivate)) {
          return serializeRecall(refusedRecall("scope-not-enforceable", capChars), p.joined === true, capChars);
        }
        const refusal = sensitivityRefusal(protocol.filter, sensitivity);
        if (refusal) return serializeRecall(refusedRecall(refusal, capChars), p.joined === true, capChars);
        if (!recall.user) delete principal.user;
      }
      // The core enforces the hard budget (the engine reads no per-call budget, H3b-b Task 1) by aborting the engine's
      // signal, so the engine cannot tell it from a cancelled caller and answers `aborted`. Spec §6.4 ("Clients under
      // core loss"): a recall past the hard budget returns what is complete with `degraded: timeout`. `aborted` stays
      // for the caller's own cancellation (its connection closed).
      const hard = AbortSignal.timeout(hardMs);
      const signal = AbortSignal.any([ctx.signal, hard]);
      d.activity.set(p.agentId, { state: "recalling" });
      try {
        // RecallQuery has no sessionKey (contract 1.4.1): the session key is capture-side until 2c.
        let r = await d.engine.recall({ query: p.query, principal, agent: AGENT_CONTEXT_CLI, budget: { softMs, hardMs, capChars }, signal });
        if (r.degraded?.reason === "engine-closed" && d.isStopping()) throw coreStopping();
        if (r.degraded?.reason === "aborted" && hard.aborted && !ctx.signal.aborted) {
          r = { ...r, degraded: { reason: "timeout", capability: "recall", detail: `core hard budget ${hardMs} ms` } };
        }
        if (protocol?.filter.length) {
          const blocks = await filterSensitiveBlocks(r.blocks, protocol.filter, sensitivity);
          // Engine traces may carry previews of excluded cards; there is no classified trace contract.
          const refusal = sensitivityRefusal(protocol.filter, sensitivity);
          r = { ...r, blocks, ...(r.trace ? { trace: {} } : {}),
            ...(refusal ? { degraded: { reason: refusal, capability: "recall" } } : {}) };
        }
        const out = serializeRecall(r, p.joined === true, capChars);
        return degraded && !out.degraded ? { ...out, degraded } : out;
      } finally { d.activity.idle(p.agentId); }
    },

    // R19: a capture is never lost because of the wait. Its signal is the core's shutdown signal only — not the
    // connection (a client disconnect never aborts it) and not the waitMs timer (which bounds the reply, not the work).
    "memory.capture": async (p: MemoryCaptureParams, ctx): Promise<MemoryCaptureResult> => {
      // A capture the core cannot take because it is stopping is refused as core-unavailable, never answered as the
      // engine's "not captured": the client (the CLI's memory add) then journals it for the next core (Task 12 soak).
      if (d.isStopping()) throw coreStopping();
      const { principal } = identity(d, p.caller, p.agentId, ctx);
      const protocol = protocolExposure(d, p.agentId, ctx);
      if (protocol && !protocol.exposure.capture) {
        throw new RpcError("E_DENIED", "memory capture is not exposed", { reason: "memory-capture-disabled" });
      }
      d.activity.set(p.agentId, { state: "capturing" });
      const handle = d.engine.capture({
        agentId: p.agentId, principal, agent: AGENT_CONTEXT_CLI, messages: p.messages, incognito: false, // the engine fails closed on anything but an explicit false
        signal: d.captureSignal,
        ...(p.sessionKey ? { sessionKey: p.sessionKey } : {}), ...(p.runId ? { runId: p.runId } : {}),
      });
      const settle = handle.done
        .then((r) => {
          d.logger.info("capture done", { agentId: p.agentId, captureId: handle.id, stored: r.stored, skipped: r.skipped, reason: r.reason });
          if (r.stored > 0) d.dreams?.()?.recordCapture(p.agentId); // the importance signal of ADR-009's primary trigger
          return r;
        })
        .finally(() => d.activity.idle(p.agentId));
      settle.catch((e) => d.logger.warn("capture failed", { agentId: p.agentId, captureId: handle.id, err: e })); // never an unhandled rejection
      const pending: MemoryCaptureResult = { id: handle.id, acceptedAt: handle.acceptedAt, pending: true };
      if (p.wait === false) return pending;
      const waitMs = p.waitMs ?? d.config().core.capture.waitMs;
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<null>((res) => { timer = setTimeout(() => res(null), waitMs); timer.unref(); });
      try {
        let r: Awaited<typeof settle> | null;
        try { r = await Promise.race([settle, timedOut]); } catch (e) { if (d.captureSignal.aborted) throw coreStopping(); throw e; }
        if (r === null) return pending; // the capture keeps running; its .finally resets activity and logs the outcome
        // The core's stop aborted it before anything was stored: not the engine's verdict on the text.
        if (d.captureSignal.aborted && r.stored === 0) throw coreStopping();
        return { id: handle.id, acceptedAt: handle.acceptedAt, stored: r.stored, skipped: r.skipped, ...(r.reason ? { reason: r.reason } : {}) };
      } finally { clearTimeout(timer); }
    },

    "memory.checkpoint": async (p: MemoryCheckpointParams) => {
      requireAgent(d.agents, p.agentId);
      d.activity.set(p.agentId, { state: "checkpointing" });
      try { return projectCheckpoint(await d.engine.checkpoint(p.agentId, p.reason)); } finally { d.activity.idle(p.agentId); }
    },

    ...buildMemoryCurationMethods({ engine: d.engine, agents: d.agents, logger: d.logger, isStopping: d.isStopping }),
    ...buildMemoryOpMethods({ engine: d.engine, agents: d.agents, logger: d.logger, isStopping: d.isStopping }),

    "memory.importText.preview": async (p: { text: string }, ctx?: CallContext) => {
      if (d.isStopping()) throw coreStopping();
      const guarded = ctx ? guardedPrincipal(ctx) : LOCAL_OWNER;
      const isPerson = guarded?.kind === "person";
      const parsed = parseMemoryExport(p.text);
      const availableAgents = d.agents.list();
      const recommendations = recommendTargets(parsed.entries, {
        availableAgents,
        currentAgentId: availableAgents[0] ?? "default",
        hasUserBinding: isPerson,
      });
      return {
        prompt: EXPORT_PROMPT_TEXT,
        recommendations,
        ...parsed,
      };
    },

    "memory.importText.apply": async (p: { entries: any[]; targets: any[]; dryRun?: boolean }, ctx?: CallContext) => {
      if (d.isStopping()) throw coreStopping();
      const guarded = ctx ? authenticatedPrincipal(ctx) : LOCAL_OWNER;
      if (guarded.kind !== "person") {
        throw new RpcError("E_DENIED", "only human persons may perform memory import", { reason: "human-only" });
      }
      if (!Array.isArray(p.entries) || !Array.isArray(p.targets)) {
        throw new RpcError("E_INVALID_PARAMS", "entries and targets arrays required");
      }
      if (p.entries.length > 5000 || p.targets.length > 5000) {
        throw new RpcError("E_INVALID_PARAMS", "too many entries in import batch");
      }
      for (const t of p.targets) {
        if (t?.agentIds && Array.isArray(t.agentIds)) {
          for (const ag of t.agentIds) {
            requireAgent(d.agents, ag);
          }
        }
      }
      const redactor = createRedactor();
      const cleanEntries: ParsedEntry[] = p.entries.map((e: any, i: number) => {
        let text = typeof e?.text === "string" ? e.text : "";
        if (text.length > 4000) text = text.slice(0, 4000);
        text = redactor.text(text);
        return {
          category: e.category,
          sourceType: e.sourceType ?? "memory",
          text,
          warnings: Array.isArray(e.warnings) ? e.warnings : [],
          idempotencyKey: typeof e.idempotencyKey === "string" ? e.idempotencyKey : `entry-${i}`,
          ...(typeof e.recordedAt === "string" ? { recordedAt: e.recordedAt } : {}),
        };
      });

      const defaultAgentId = d.agents.list()[0] ?? "default";
      const workspaceDir = d.agents.workspaceOf(defaultAgentId) ?? (d.hostEvalHome ?? process.cwd());
      const accountId = guarded.binding?.audience ?? "api";
      const userId = guarded.userId;
      const { principal } = callerToPrincipal({ channel: "cli", accountId, userId }, defaultAgentId, workspaceDir);
      principal.user = deriveUserPrincipal(userId);
      principal.trust = "proved";
      const home = d.hostEvalHome ?? process.cwd();
      try {
        return await executePromptImport({
          entries: cleanEntries,
          targets: p.targets,
          dryRun: p.dryRun,
          principal,
          home,
          engine: d.engine,
          agents: d.agents,
          defaultAgentId,
        });
      } catch (err) {
        const mapped = mapMemoryOpError(err, { stopping: d.isStopping() });
        throw mapped ?? err;
      }
    },

    "memory.importText.rollback": async (p: { runId: string }, ctx?: CallContext) => {
      if (d.isStopping()) throw coreStopping();
      const guarded = ctx ? authenticatedPrincipal(ctx) : LOCAL_OWNER;
      if (guarded.kind !== "person") {
        throw new RpcError("E_DENIED", "only human persons may perform rollback", { reason: "human-only" });
      }
      const defaultAgentId = d.agents.list()[0] ?? "default";
      const workspaceDir = d.agents.workspaceOf(defaultAgentId) ?? (d.hostEvalHome ?? process.cwd());
      const accountId = guarded.binding?.audience ?? "api";
      const userId = guarded.userId;
      const { principal } = callerToPrincipal({ channel: "cli", accountId, userId }, defaultAgentId, workspaceDir);
      principal.user = deriveUserPrincipal(userId);
      principal.trust = "proved";
      const home = d.hostEvalHome ?? process.cwd();
      try {
        return await rollbackPromptImport({
          runId: p.runId,
          home,
          engine: d.engine,
          principal,
        });
      } catch (err) {
        const mapped = mapMemoryOpError(err, { stopping: d.isStopping() });
        throw mapped ?? err;
      }
    },

    "memory.exportText": async (p: { agentId?: string }, ctx?: CallContext) => {
      if (d.isStopping()) throw coreStopping();
      const guarded = ctx ? authenticatedPrincipal(ctx) : LOCAL_OWNER;
      if (guarded.kind !== "person") {
        throw new RpcError("E_DENIED", "only human persons may export memories", { reason: "human-only" });
      }
      if (p.agentId) {
        requireAgent(d.agents, p.agentId);
        const auth = authorize(guarded, "agent.read", { kind: "agent", agentId: p.agentId });
        if (auth.effect !== "allow") {
          throw new RpcError("E_DENIED", `agent.read required to export memories of agent '${p.agentId}'`, { reason: "unauthorized" });
        }
      }
      const targetAgentId = p.agentId ?? (d.agents.list()[0] ?? "default");
      const workspaceDir = d.agents.workspaceOf(targetAgentId) ?? (d.hostEvalHome ?? process.cwd());
      const accountId = guarded.binding?.audience ?? "api";
      const userId = guarded.userId;
      const { principal } = callerToPrincipal({ channel: "cli", accountId, userId }, targetAgentId, workspaceDir);
      principal.user = deriveUserPrincipal(userId);
      principal.trust = "proved";
      const sensitivity = d.memorySensitivity ? sensitivityService(d.memorySensitivity) : null;
      try {
        const text = await exportMemoriesAsText({
          principal,
          engine: d.engine,
          agentId: p.agentId,
          sensitivityService: sensitivity,
        });
        const count = (text.match(/^\[/gm) ?? []).length;
        return { text, entryCount: count };
      } catch (err) {
        const mapped = mapMemoryOpError(err, { stopping: d.isStopping() });
        throw mapped ?? err;
      }
    },
    ...buildDreamsMethods({ dreams: () => d.dreams?.() ?? null, agents: d.agents, ...(d.dreamsError ? { unavailableBecause: d.dreamsError } : {}) }),
    ...(d.secrets ? buildSecretMethods(d.secrets) : {}),
    ...(d.permissions ? buildApprovalMethods(d.permissions) : {}),
    ...buildAdminMethods({ engine: d.engine, agents: d.agents, logger: d.logger, isStopping: d.isStopping, onMigrated: d.onMigrated, signal: d.captureSignal }),
    ...(d.reembed ?? {}),

    ...(d.auditChain ? buildAuditMethods({ chain: d.auditChain, ...(d.auditVerified ? { verified: d.auditVerified } : {}) }) : {}),
    ...(d.backup ? buildBackupMethods({ engine: d.engine, layout: d.backup.layout, baseDbPath: d.backup.baseDbPath, logger: d.logger, isStopping: d.isStopping }) : {}),

    ...buildActivityMethods(d.activity, () => d.agents.list()),
    "agent.list": async () => ({ agents: d.agents.list().map((agentId) => ({ agentId, open: openAgents.has(agentId), activity: d.activity.get(agentId) })) }),
    "agent.open": async (p: AgentOpenParams) => {
      requireAgent(d.agents, p.agentId);
      if (!openAgents.has(p.agentId)) openAgents.set(p.agentId, await d.engine.open(p.agentId));
      return { agentId: p.agentId, open: true as const };
    },
    "agent.close": async (p: AgentCloseParams) => {
      const s = openAgents.get(p.agentId);
      if (s) { openAgents.delete(p.agentId); await s.close(); }
      return { agentId: p.agentId, open: false as const };
    },
    "agent.status": async (p: AgentStatusParams) => {
      const workspace = requireAgent(d.agents, p.agentId);
      const lastJobs = await d.engine.jobs.history(p.agentId, { limit: 5 });
      return { agentId: p.agentId, open: openAgents.has(p.agentId), activity: d.activity.get(p.agentId), workspace, lastJobs };
    },

    "jobs.list": async (p?: { kind?: "agent" | "system" | "all" }) => {
      if (p?.kind === "system") {
        return { jobs: d.systemJobs ? d.systemJobs.list() : [] };
      }
      if (p?.kind === "all") {
        return { jobs: [...d.engine.jobs.list(), ...(d.systemJobs ? d.systemJobs.list() : [])] };
      }
      return { jobs: d.engine.jobs.list() };
    },
    "jobs.run": async (p: JobsRunParams, ctx) => {
      if (d.systemJobs?.has(p.job)) {
        if (p.agentId !== undefined) {
          throw new RpcError("E_INVALID_PARAMS", "agentId is not allowed for system jobs", { detail: "agentId" });
        }
        const { record } = await d.systemJobs.run(p.job, (p as any).args, { trigger: "manual", signal: ctx.signal });
        return record as any;
      }
      if (!p.agentId) {
        throw new RpcError("E_INVALID_PARAMS", "agentId is required for agent jobs", { detail: "agentId" });
      }
      return runJob(p, ctx.signal);
    },
    "jobs.history": async (p: JobsHistoryParams) => {
      if (!p.agentId) {
        return {
          runs: d.systemJobs
            ? d.systemJobs.history({
                ...(p.job ? { job: p.job } : {}),
                ...(p.since !== undefined ? { since: p.since } : {}),
                ...(p.limit !== undefined ? { limit: p.limit } : {}),
              })
            : [],
        };
      }
      if (d.systemJobs?.has(p.job!)) {
        return { runs: [] };
      }
      requireAgent(d.agents, p.agentId);
      return {
        runs: await d.engine.jobs.history(p.agentId, {
          ...(p.job ? { job: p.job as JobName } : {}),
          ...(p.since !== undefined ? { since: p.since } : {}),
          ...(p.limit !== undefined ? { limit: p.limit } : {}),
        }),
      };
    },

    "models.list": async (p: ModelsListParams) => {
      if (!d.discovery) throw new RpcError("E_INTERNAL", "model discovery service unavailable");
      const result = await d.discovery.list(p ?? {});
      const reports = d.hostEvalHome ? await readHostEvalReports(d.hostEvalHome) : [];
      return { ...result, models: result.models.map(m => ({ ...m, toolUse: hostEvalGate([{ provider: m.provider, model: m.id }], reports).models[0]!.label })) };
    },
    "models.scan": async (p: ModelsScanParams, ctx) => {
      if (!d.systemJobs) throw new RpcError("E_INTERNAL", "system jobs unavailable");
      const args: Record<string, unknown> = {};
      if (p?.provider !== undefined) args.provider = p.provider;
      const { record, detail } = await d.systemJobs.run("models.scan", args, { trigger: "manual", signal: ctx.signal });
      return {
        startedAt: new Date(record.startedAt).toISOString(),
        finishedAt: new Date(record.finishedAt).toISOString(),
        providers: (detail as any) ?? [],
      };
    },
    "models.setOverride": async (p: ModelsSetOverrideParams) => {
      if (!d.discovery) throw new RpcError("E_INTERNAL", "model discovery service unavailable");
      if (!d.discovery.hasProfile(p.provider)) {
        throw new RpcError("E_INVALID_PARAMS", `unknown provider: ${p.provider}`, {
          reason: "unknown-provider",
          detail: "provider",
        });
      }
      try {
        return await d.discovery.setOverride(p as any);
      } catch (err) {
        mapDiscoveryError(err);
      }
    },
    "models.removeManual": async (p: ModelsRemoveManualParams) => {
      if (!d.discovery) throw new RpcError("E_INTERNAL", "model discovery service unavailable");
      if (!d.discovery.hasProfile(p.provider)) {
        throw new RpcError("E_INVALID_PARAMS", `unknown provider: ${p.provider}`, {
          reason: "unknown-provider",
          detail: "provider",
        });
      }
      try {
        return await d.discovery.removeManual(p.provider, p.id);
      } catch (err) {
        mapDiscoveryError(err);
      }
    },
    "budget.status": async (p: BudgetStatusParams) => {
      if (!d.budget) throw new RpcError("E_INTERNAL", "budget service unavailable");
      try {
        const st = d.budget.status(p?.agentId !== undefined ? { agentId: p.agentId } : {});
        return {
          timeZone: st.timeZone, now: iso(st.now),
          periods: st.periods.map((x) => ({ ...x, start: iso(x.start), end: iso(x.end) })),
          limits: st.limits,
        };
      } catch (err) { mapBudgetError(err); }
    },
    "egress.status": async () => {
      if (!d.egress) throw new RpcError("E_INTERNAL", "egress service unavailable");
      return d.egress.status();
    },
    "budget.set": async (p: BudgetSetParams) => {
      if (!d.budget) throw new RpcError("E_INTERNAL", "budget service unavailable");
      try {
        if (p.timeZone !== undefined) d.budget.setTimeZone(p.timeZone);
        const set = p.limit ? { limit: d.budget.setLimit(p.limit as Parameters<BudgetService["setLimit"]>[0]) } : {};
        return { timeZone: d.budget.timeZone(), ...set, limits: d.budget.limits() };
      } catch (err) { mapBudgetError(err); }
    },
    "models.acknowledge": async (_p: ModelsAcknowledgeParams) => {
      if (!d.discovery) throw new RpcError("E_INTERNAL", "model discovery service unavailable");
      try {
        return await d.discovery.acknowledge();
      } catch (err) {
        mapDiscoveryError(err);
      }
    },
    ...(d.identity ? buildIdentityMethods({ service: d.identity, isStopping: d.isStopping }) : {}),
  };
}
