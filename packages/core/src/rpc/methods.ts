import type { CheckpointResult, Deferral, Degraded, Engine, JobName, JobRun, Principal, RecallResult } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type { HarnessConfig } from "@plur1bus/config-schema";
import type {
  AgentCloseParams, AgentOpenParams, AgentStatusParams, CallerIdentity, CoreAdoptParams, CoreShutdownParams, CoreStatusResult, JobsHistoryParams, JobsRunParams,
  MemoryCaptureParams, MemoryCaptureResult, MemoryCheckpointParams, MemoryCheckpointResult, MemoryRecallParams, MemoryRecallResult,
  ModelsAcknowledgeParams, ModelsListParams, ModelsRemoveManualParams, ModelsScanParams, ModelsSetOverrideParams,
} from "@plur1bus/rpc-schema";
import type { ActivityTracker } from "../activity.ts";
import { buildAdminMethods } from "../admin-ops.ts";
import type { AgentRegistry } from "../agents.ts";
import { joinBlocks } from "../join.ts";
import type { HarnessLogger } from "../logger.ts";
import { buildMemoryOpMethods, requireAgent } from "../memory-ops.ts";
import { AGENT_CONTEXT_CLI, callerToPrincipal } from "../principal.ts";
import { CatalogError } from "../discovery/overrides.ts";
import { CatalogWriteError } from "../discovery/catalog-store.ts";
import { RpcError } from "./errors.ts";
import type { Handler } from "./server.ts";

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
  /** D112: harness-side system jobs registry. */
  systemJobs?: import("../system-jobs/index.ts").SystemJobs;
  /** D112: model discovery service. */
  discovery?: import("../discovery/service.ts").DiscoveryService;
  /** M2: the `admin.reembed.*` handlers (embedding-migrate/rpc.ts), when the core built a migration driver. */
  reembed?: Record<string, Handler>;
}

function identity(d: MethodDeps, caller: CallerIdentity, agentId: string): { principal: Principal; degraded: Degraded | null } {
  return callerToPrincipal(caller, agentId, requireAgent(d.agents, agentId));
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
      const { principal, degraded } = identity(d, p.caller, p.agentId);
      const hardMs = p.budget?.hardMs ?? d.config().core.recall.hardBudgetMs;
      const softMs = p.budget?.softMs ?? d.config().core.recall.softBudgetMs;
      const capChars = p.budget?.capChars ?? d.config().core.recall.capChars;
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
        const out = serializeRecall(r, p.joined === true, capChars);
        return degraded && !out.degraded ? { ...out, degraded } : out;
      } finally { d.activity.idle(p.agentId); }
    },

    // R19: a capture is never lost because of the wait. Its signal is the core's shutdown signal only — not the
    // connection (a client disconnect never aborts it) and not the waitMs timer (which bounds the reply, not the work).
    "memory.capture": async (p: MemoryCaptureParams): Promise<MemoryCaptureResult> => {
      // A capture the core cannot take because it is stopping is refused as core-unavailable, never answered as the
      // engine's "not captured": the client (the CLI's memory add) then journals it for the next core (Task 12 soak).
      if (d.isStopping()) throw coreStopping();
      const { principal } = identity(d, p.caller, p.agentId);
      d.activity.set(p.agentId, { state: "capturing" });
      const handle = d.engine.capture({
        agentId: p.agentId, principal, agent: AGENT_CONTEXT_CLI, messages: p.messages, incognito: false, // the engine fails closed on anything but an explicit false
        signal: d.captureSignal,
        ...(p.sessionKey ? { sessionKey: p.sessionKey } : {}), ...(p.runId ? { runId: p.runId } : {}),
      });
      const settle = handle.done
        .then((r) => { d.logger.info("capture done", { agentId: p.agentId, captureId: handle.id, stored: r.stored, skipped: r.skipped, reason: r.reason }); return r; })
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

    ...buildMemoryOpMethods({ engine: d.engine, agents: d.agents, logger: d.logger, isStopping: d.isStopping }),
    ...buildAdminMethods({ engine: d.engine, agents: d.agents, logger: d.logger, isStopping: d.isStopping, onMigrated: d.onMigrated, signal: d.captureSignal }),
    ...(d.reembed ?? {}),

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
      return await d.discovery.list(p ?? {});
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
    "models.acknowledge": async (_p: ModelsAcknowledgeParams) => {
      if (!d.discovery) throw new RpcError("E_INTERNAL", "model discovery service unavailable");
      try {
        return await d.discovery.acknowledge();
      } catch (err) {
        mapDiscoveryError(err);
      }
    },
  };
}
