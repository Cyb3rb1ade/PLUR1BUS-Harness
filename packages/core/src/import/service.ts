import { previewImport, type ImportPreview } from "./preview.ts";
/** Live Core source capabilities, immutable planning, preflight tickets and the independent skills path. */
import { createHash, randomUUID } from "node:crypto";
import { apiPrincipal, apiTransport, isClientContext } from "@plur1bus/module-api";
import { validateParams, type AdminImportDetectParams, type AdminImportPlanParams, type AdminImportPlanResult,
  type AdminImportPreflightParams, type AdminImportPreflightResult, type AdminImportSkillsParams,
  type AdminImportSkillsResult, type ImportConflict, type ImportSource } from "@plur1bus/rpc-schema";
import { authorize } from "../rbac/authorize.ts";
import type { PrincipalResolver } from "../rbac/guard.ts";
import type { Principal } from "../rbac/types.ts";
import type { CallContext, Handler } from "../rpc/server.ts";
import { RpcError } from "../rpc/errors.ts";
import type { SecretStore } from "../secrets/store.ts";
import type { AuditSink } from "../rbac/audit.ts";
import { checkValue } from "../secrets/types.ts";
import { acquireLease } from "../secrets/acquisition.ts";
import type { ImportConfigPort, ImportStoreProbe } from "./execution.ts";
import type { ImportedExtensionPort } from "./extensions-import.ts";
import { createImportRecords, type ImportPlanRecord } from "./maintenance-records.ts";
import { preflightImport } from "./maintenance-preflight.ts";
import { fingerprintImportTarget } from "./target-fingerprint.ts";
import { readMaintenanceJournal } from "./maintenance-journal.ts";
import { normalizedRoots, type MutationRoot } from "./maintenance-files.ts";
import type { ImportProgress } from "./maintenance-types.ts";
import { importSkills } from "./skills-import.ts";
import { renderSkills } from "./skills-render.ts";
import type { SourceRegistry } from "./source-registry.ts";
import type { ImportSecretBinding, ImportSourceSecrets } from "./source-secrets.ts";
import { listWslDistros } from "./wsl.ts";
import { ImportError } from "./types.ts";
import { fileConflictId, resolveImportOptions } from "./plan-options.ts";
import { sourceStoreModel, assertStoreModelsAvailable, type SourceStoreModel } from "./source-store-model.ts";
import { currentStoreTarget, sourceStoreConfig } from "./source-store-transfer.ts";
import { sourceAgentId } from "./source-view.ts";
import { lstat } from "node:fs/promises";
import { buildEngineConfig } from "../engine-config.ts";
import { layout } from "../paths.ts";
import { validate } from "@plur1bus/config-schema";
import { requireSelectedStoreTransfer } from "./selected-store.ts";

export interface ImportTargetPreflight {
  roots: MutationRoot[];
  coldBytes: number;
  availableBytes: number;
  writable: boolean;
  foreignLock: boolean;
  completeCoverage: boolean;
  exclusiveWriter: boolean;
}

export interface ImportServiceOptions {
  home: string;
  sources: SourceRegistry;
  config: ImportConfigPort;
  target(): Promise<ImportTargetPreflight>;
  store(): Promise<{ supported: boolean }>;
  model(model: string, licenceId: string | undefined, principal: Principal):
    Promise<{ present: boolean; licenceAccepted: boolean }>;
  secrets: Pick<SecretStore, "status">;
  sourceSecrets: ImportSourceSecrets;
  audit: AuditSink;
  extensionPort?: ImportedExtensionPort;
  storeProbe?: ImportStoreProbe;
  sourceStoreProbe?: (source: Source, candidate: SourceStoreModel, config: object, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  progress?: (event: ImportProgress, principal: Principal) => void;
}

type Source = Awaited<ReturnType<SourceRegistry["get"]>>;
type Preview = ImportPreview;
const denied = () => new ImportError("E_DENIED", "import-person-required", "Import requires a human administrator");
const conflict = (reason: string) => new ImportError("E_CONFLICT", reason, "Import plan changed or needs a decision");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function gate(principal: Principal | null, action: "imports.read" | "imports.manage"): asserts principal is Principal {
  if (!principal || principal.kind !== "person" || !["owner", "admin"].includes(principal.role)
    || authorize(principal, action, { kind: "system" }).effect !== "allow") throw denied();
}

function ownerSecrets(principal: Principal, requested?: boolean): void {
  if (requested && principal.role !== "owner") {
    throw new ImportError("E_DENIED", "secret-owner-required", "Secret import requires Owner");
  }
}

function params(method: string, value: unknown): void {
  if (!validateParams(method, value).ok) throw new ImportError("E_INVALID_PARAMS", "import-params-invalid", "Import parameters are invalid");
}

/** A remote stepped-up web session is still remote; trust level alone never grants server filesystem paths. */
export function importFreePathsAllowed(principal: Principal, ctx: CallContext): boolean {
  return principal.role === "owner" || principal.role === "admin" && (apiTransport(ctx) === "loopback"
    || apiPrincipal(ctx) === undefined && !isClientContext(ctx));
}

function conflicts(report: Preview): ImportConflict[] {
  return report.agents.flatMap(agent => agent.files.filter(file => file.action === "conflict")
    .map(file => ({ id: fileConflictId(report.sourceType, agent.sourceId, file.targetFile), entity: "agent" as const,
      itemId: digest([report.sourceType, agent.sourceId, file.targetFile]), choices: ["skip", "rename", "replace"] as
        ["skip", "rename", "replace"] })));
}

/** Construction acquires no secret values or foreign source and starts no maintenance operation. */
export function createImportService(options: ImportServiceOptions) {
  const now = options.now ?? Date.now;
  const records = createImportRecords(options.home, { now });
  const prepared = new Map<string, { binding: ImportSecretBinding; expiresAt: number }>();
  let closed = false;
  const ensureOpen = () => {
    if (closed) throw new ImportError("E_NOT_AVAILABLE", "import-unavailable", "Import service is unavailable");
  };
  const sourceFor = async (plan: ImportPlanRecord, principal: Principal) => {
    // An immutable current owner-bound plan outlives the public source-selection capability.
    const source = await options.sources.get(plan.sourceId, principal, true);
    if (source.record.sourceSha256 !== plan.sourceSha256 || source.record.snapshotId !== plan.snapshotId
      || source.record.sourceType !== plan.sourceType) {
      throw conflict("source-changed");
    }
    return source;
  };
  const preview = async (source: Source, settings: ImportPlanRecord["options"], signal?: AbortSignal,
    storeConflict: ImportPlanRecord["options"]["onConflict"] | null = settings.onConflict): Promise<Preview> => {
    const report = await previewImport({ home: options.home, source, settings, config: options.config, storeConflict,
      ...(options.storeProbe ? { storeProbe: options.storeProbe } : {}), ...(signal ? { signal } : {}) });
    if (report.errors.length) throw new ImportError("E_INVALID_PARAMS", "entity-failed", "Import source is invalid");
    if (settings.adoptStoreId && settings.adoptStrategy !== "re-embed") {
      const { onConflict: _fileConflict, ...selected } = settings;
      requireSelectedStoreTransfer(report, { ...selected, ...(storeConflict ? { onConflict: storeConflict } : {}) });
    }
    return report;
  };
  return {
    recordAudit(principal: Principal | null, method: string, phase: "started" | "completed" | "denied" | "failed",
      value: unknown, reason?: string): void {
      const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
      const detail: Record<string, unknown> = { phase };
      for (const key of ["runId", "planId", "sourceId"]) {
        if (typeof raw[key] === "string" && /^[a-f0-9-]{36}$/.test(raw[key])) detail[key] = raw[key];
      }
      if (typeof raw.ok === "boolean") detail.ok = raw.ok;
      if (reason && /^[a-z0-9-]{1,64}$/.test(reason)) detail.reason = reason;
      if (raw.counts && typeof raw.counts === "object" && !Array.isArray(raw.counts)) {
        const counts = raw.counts as Record<string, unknown>;
        detail.counts = Object.fromEntries(["agents", "skills", "memories", "stores", "channels", "extensions", "secrets",
          "total", "imported", "adopted", "renamed", "replaced", "skipped", "refused", "failed"]
          .filter(key => Number.isSafeInteger(counts[key]) && (counts[key] as number) >= 0).map(key => [key, counts[key]]));
      }
      try {
        options.audit.append({ at: now(), actor: { user: principal?.userId || "anonymous", host: "local" },
          action: method.replace(/^admin\./, ""), target: String(detail.runId ?? detail.planId ?? "import"), detail });
      } catch {
        throw new RpcError("E_STORAGE", "Import audit is unavailable", { reason: "audit-unavailable" });
      }
    },
    async detect(source: ImportSource, principal: Principal | null, signal?: AbortSignal, freePaths = false) {
      ensureOpen();
      gate(principal, "imports.read");
      if (["path", "wsl", "ssh"].includes(source.kind) && principal.role !== "owner" && !freePaths
        && !options.sources.approves(source, principal)) throw denied();
      return options.sources.detect(source, principal, signal);
    },
    async discover(source: ImportSource, principal: Principal | null, signal?: AbortSignal, freePaths = false) {
      ensureOpen();
      gate(principal, "imports.read");
      if (["path", "wsl", "ssh"].includes(source.kind) && principal.role !== "owner" && !freePaths
        && !options.sources.approves(source, principal) && !await options.sources.approvesDiscoveryRoot(source, principal)) throw denied();
      return options.sources.discover(source, principal, signal);
    },
    async wslList(principal: Principal | null) {
      ensureOpen();
      gate(principal, "imports.read");
      return { available: process.platform === "win32", distros: (await listWslDistros()).slice(0, 256) };
    },
    async plan(input: AdminImportPlanParams, principal: Principal | null, signal?: AbortSignal, freePaths = false):
      Promise<AdminImportPlanResult> {
      ensureOpen();
      gate(principal, "imports.manage");
      params("admin.import.plan", input);
      const settings = structuredClone(input.options ?? {});
      ownerSecrets(principal, settings.migrateSecrets);
      if (settings.maps?.length && principal.role !== "owner" && !freePaths
        && !options.sources.approvesMaps(settings.maps, principal)) throw denied();
      let source = await options.sources.get(input.sourceId, principal);
      if (settings.maps?.length) {
        const mapped = await options.sources.map(source.record.id, settings.maps, principal, signal);
        source = mapped.source;
        settings.maps = mapped.maps;
      }
      settings.agentIds ??= source.view.agents.map(agent => agent.id);
      const ids = new Set(source.view.agents.map(agent => agent.id));
      if (settings.agentIds?.some(id => !ids.has(id)) || new Set(settings.agentIds).size !== settings.agentIds?.length
        && settings.agentIds !== undefined) throw conflict("source-agent-invalid");
      const config = await options.config.get();
      let sourceEmbedding: SourceStoreModel | undefined;
      if (settings.adoptStrategy === "re-embed") {
        if (!settings.adoptStoreId || !options.sourceStoreProbe) throw conflict("source-store-required");
        sourceEmbedding = sourceStoreModel(source.read.report, settings.adoptStoreId);
        if (!settings.agentIds.includes(sourceAgentId(source.record.sourceType, sourceEmbedding.agentId))) throw conflict("source-store-agent-invalid");
        sourceStoreConfig(config.config, sourceEmbedding);
        settings.reembed ??= { model: currentStoreTarget(config.config, options.home) };
        await assertStoreModelsAvailable(sourceEmbedding, settings.reembed,
          (model, licence) => options.model(model, licence, principal));
        const cfg = validate(config.config); if (!cfg.ok) throw conflict("config-invalid");
        const storeRoot = String(buildEngineConfig(cfg.config, layout(options.home)).baseDbPath);
        if (settings.onConflict !== "replace" && await lstat(storeRoot).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return undefined;
        })) throw conflict("store-conflict-unanswered");
        await options.sourceStoreProbe(source, sourceEmbedding, config.config, signal);
      }
      const { conflicts: _answers, ...unchosen } = settings;
      const [report, target] = await Promise.all([preview(source, { ...unchosen, onConflict: "skip" }, signal, settings.onConflict ?? null), options.target()]);
      const found = conflicts(report);
      const answers = new Map(settings.conflicts?.map(answer => [answer.id, answer.choice]));
      if (answers.size !== (settings.conflicts?.length ?? 0) || [...answers.keys()].some(id => !found.some(item => item.id === id))) {
        throw conflict("conflict-answer-invalid");
      }
      const unresolvedConflicts = settings.onConflict ? 0 : found.filter(item => !answers.has(item.id)).length;
      const selected = resolveImportOptions(source, settings);
      const agentIds = new Set(selected.sourceAgentIds);
      const selectedStores = source.read.report.plur1bus.stores.filter(store => selected.sourceStoreIds
        ? selected.sourceStoreIds.includes(store.storeId) : store.kind !== "agent" || !!store.agentId && agentIds.has(store.agentId));
      const counts = { ...source.view.counts, agents: report.agents.length,
        skills: source.read.skills.filter(skill => skill.agentId === null || agentIds.has(skill.agentId)).length,
        memories: report.agents.reduce((sum, agent) => sum + (agent.memory?.totalCards ?? 0), 0), stores: selectedStores.length };
      const { record, sha256 } = await records.putPlan({ ownerId: principal.userId, sourceId: source.record.id,
        snapshotId: source.record.snapshotId, sourceType: source.record.sourceType, sourceSha256: source.record.sourceSha256,
        ...(source.record.sourceSnapshots ? { sourceSnapshots: source.record.sourceSnapshots } : {}),
        ...(sourceEmbedding ? { sourceEmbedding } : {}),
        configRevision: config.revision, options: settings, roots: target.roots,
        importBytes: source.metadata.files.reduce((sum, file) => sum + file.size, 0), coldBytes: target.coldBytes,
        entities: Object.values(counts).reduce((sum, count) => sum + count, 0)
          + (settings.reembed ? selectedStores.reduce((sum, store) => sum + (store.rows ?? 0), 0) : 0), unresolvedConflicts });
      return { planId: record.id, runId: record.runId, sourceType: record.sourceType, sourceSha256: record.sourceSha256,
        planSha256: sha256, expiresAt: record.expiresAt, counts, conflicts: found,
        warnings: source.view.warnings, requiresSecretOwner: settings.migrateSecrets === true };
    },
    async preflight(input: AdminImportPreflightParams, principal: Principal | null, signal?: AbortSignal):
      Promise<AdminImportPreflightResult> {
      ensureOpen();
      gate(principal, "imports.manage");
      params("admin.import.preflight", input);
      const rollback = input.operation === "rollback";
      const { record: plan, sha256 } = await records.readPlan(input.planId, principal.userId, undefined, rollback);
      const preflightSignal = AbortSignal.any([AbortSignal.timeout(600_000), ...(signal ? [signal] : [])]);
      ownerSecrets(principal, plan.options.migrateSecrets);
      let source: Source | undefined;
      let values: Map<string, Buffer> | undefined;
      let models: Promise<{ present: boolean; licenceAccepted: boolean }> | undefined;
      const modelProof = (model: string, licence?: string) => models ??= (async () => {
        const target = await options.model(model, licence, principal);
        if (!plan.sourceEmbedding || plan.sourceEmbedding.model === model) return target;
        const original = await options.model(plan.sourceEmbedding.model, undefined, principal);
        return { present: target.present && original.present, licenceAccepted: target.licenceAccepted && original.licenceAccepted };
      })();
      try {
      const result = await preflightImport({ planId: plan.id, runId: plan.runId, sourceSha256: plan.sourceSha256,
        unresolvedConflicts: rollback ? 0 : plan.unresolvedConflicts, migrateSecrets: !rollback && plan.options.migrateSecrets === true,
        importBytes: plan.importBytes, coldBytes: plan.coldBytes, entities: plan.entities,
        ...(!rollback && plan.options.reembed ? { reembed: plan.options.reembed } : {}) }, {
        sourceFingerprint: async () => {
          if (rollback) return plan.sourceSha256;
          source = await sourceFor(plan, principal);
          return source.record.sourceSha256;
        },
        dryRun: async () => {
          if (rollback) return { readable: true, parsed: true, configValid: true };
          const current = await sourceFor(plan, principal);
          if (plan.sourceEmbedding) {
            if (!plan.options.reembed || !options.sourceStoreProbe
              || digest(sourceStoreModel(current.read.report, plan.sourceEmbedding.storeId)) !== digest(plan.sourceEmbedding)) throw conflict("source-changed");
            const proof = await modelProof(plan.options.reembed.model, plan.options.reembed.licenceId);
            if (proof.present && proof.licenceAccepted) await options.sourceStoreProbe(current, plan.sourceEmbedding,
              (await options.config.get()).config, preflightSignal);
          }
          const report = await preview(current, plan.options, preflightSignal);
          return { readable: true, parsed: report.errors.length === 0, configValid: true };
        },
        storage: async () => {
          const target = await options.target();
          return { ...target, completeCoverage: target.completeCoverage
            && digest(normalizedRoots(target.roots)) === digest(plan.roots),
            foreignLock: target.foreignLock || !rollback && (await options.config.get()).revision !== plan.configRevision };
        },
        store: options.store, model: modelProof,
        secrets: async () => {
          const state = await options.secrets.status({ kind: "core" });
          const available = ["keyring", "file"].includes(state.backend) && state.secrets !== undefined
            && process.env.PLUR1BUS_SECRETS_KEYRING !== "memory";
          if (!available) return { available: false };
          const captured = source ?? await sourceFor(plan, principal);
          values = await acquireLease(() => options.sources.collectSecrets(captured.record.id, principal, preflightSignal,
            resolveImportOptions(captured, plan.options).sourceAgentIds, true),
          entries => { for (const bytes of entries.values()) bytes.fill(0); entries.clear(); }, preflightSignal);
          const present = new Set(state.secrets!.map(item => item.name));
          for (const [name, bytes] of values) {
            checkValue(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
            if (present.has(name)) { bytes.fill(0); values.delete(name); }
          }
          return { available: true };
        },
      }, { signal: preflightSignal });
      if (!result.ok) return result;
      signal?.throwIfAborted();
      const targetSha256 = await acquireLease(() => fingerprintImportTarget(options.home, plan.roots, preflightSignal),
        () => {}, preflightSignal);
      if (rollback) {
        const journal = readMaintenanceJournal(options.home, plan.runId);
        if (journal.phase !== "committed" || journal.targetSha256 !== targetSha256) {
          return { ...result, ok: false, issues: [{ code: "E_CONFLICT", reason: "target-changed" }] };
        }
      }
      const ticket = await records.putPreflight({ ownerId: principal.userId, planId: plan.id, runId: plan.runId,
        planSha256: sha256, sourceSha256: plan.sourceSha256, targetSha256, operation: rollback ? "rollback" : "apply" });
      if (!rollback && plan.options.migrateSecrets) {
          if (!values) throw new ImportError("E_NOT_AVAILABLE", "source-secret-unavailable", "Source secret lease is unavailable");
          const binding = { ownerId: principal.userId, planId: plan.id, planSha256: sha256, preflightId: ticket.id };
          options.sourceSecrets.prepare({ ...binding, entries: values, expiresAt: Date.parse(ticket.expiresAt) });
          for (const [id, prior] of prepared) if (prior.expiresAt <= now()) prepared.delete(id);
          prepared.set(ticket.id, { binding, expiresAt: Date.parse(ticket.expiresAt) });
      }
      return { ...result, preflightId: ticket.id, expiresAt: ticket.expiresAt };
      } finally { for (const bytes of values?.values() ?? []) bytes.fill(0); }
    },
    async skills(input: AdminImportSkillsParams, principal: Principal | null, signal?: AbortSignal):
      Promise<AdminImportSkillsResult> {
      ensureOpen();
      gate(principal, "imports.manage");
      params("admin.import.skills", input);
      const source = await options.sources.get(input.sourceId, principal);
      const report = await importSkills({ home: options.home, source: source.root, reader: source.reader,
        sourceType: source.record.sourceType, apply: input.apply ?? false, enable: input.enable ?? false,
        onConflict: input.onConflict ?? "skip", maxBytes: 16 * 1024 * 1024, runId: randomUUID(),
        ...(signal ? { signal } : {}), ...(options.progress ? { onProgress: (event: ImportProgress) =>
          options.progress!(event, principal) } : {}) }, renderSkills);
      const counts = { total: report.skills.length, imported: 0, adopted: 0, renamed: 0, replaced: 0, skipped: 0, refused: 0, failed: 0 };
      for (const skill of report.skills) if (skill.outcome !== "planned") counts[skill.outcome]++;
      return { runId: report.runId, sourceType: report.sourceType, mode: report.mode,
        status: report.mode === "apply" ? "completed" : "planned", counts,
        skills: report.skills.map(({ id, targetId, action, outcome, enabled, reason }) => ({ id, targetId, action, outcome,
          enabled, reason: reason && /^[a-z0-9,-]{1,256}$/.test(reason) ? reason : reason ? "skill-import-failed" : null })),
        warnings: report.warnings.map(() => ({ code: "E_SOURCE_UNSUPPORTED", reason: "source-warning" })),
        errors: report.errors.map(() => ({ code: "E_IMPORT_FAILED", reason: "skill-import-failed" })) };
    },
    async binding(planId: string, preflightId: string): Promise<ImportSecretBinding | undefined> {
      if (closed) return undefined;
      const found = prepared.get(preflightId);
      if (!found || found.expiresAt <= now() || found.binding.planId !== planId) return undefined;
      return { ...found.binding };
    },
    close(): void { closed = true; prepared.clear(); options.sourceSecrets.close(); },
  };
}

export type ImportService = ReturnType<typeof createImportService>;

/** Handler inputs never contain a principal, locality stamp, target configuration or backend handle. */
export function buildImportMethods(service: ImportService, resolve: PrincipalResolver): Record<string, Handler> {
  const wrap = (method: string, run: (params: any, principal: Principal | null, ctx: CallContext) => unknown): Handler =>
    async (input, ctx) => {
      let principal: Principal | null = null;
      try {
        principal = await resolve(ctx, method, input) ?? null;
        service.recordAudit(principal, method, "started", input);
        const result = await run(input, principal, ctx);
        service.recordAudit(principal, method, "completed", result);
        return result;
      }
      catch (error) {
        const code = error instanceof RpcError ? error.error : error instanceof ImportError ? error.code : "E_IMPORT_FAILED";
        const reason = error instanceof RpcError || error instanceof ImportError ? error.reason : "import-unavailable";
        service.recordAudit(principal, method, code === "E_DENIED" ? "denied" : "failed", input, reason);
        if (error instanceof RpcError) throw error;
        const safe = error instanceof ImportError;
        throw new RpcError(safe ? error.code : "E_IMPORT_FAILED", "Import operation is unavailable", {
          reason: safe && /^[a-z0-9-]{1,64}$/.test(error.reason) ? error.reason : "import-unavailable",
        });
      }
    };
  return {
    "admin.import.detect": wrap("admin.import.detect", (input: AdminImportDetectParams, principal, ctx) =>
      (input.discover ? service.discover : service.detect)(input.source, principal, ctx.signal,
        !!principal && importFreePathsAllowed(principal, ctx))),
    "admin.import.wsl.list": wrap("admin.import.wsl.list", (_input, principal) => service.wslList(principal)),
    "admin.import.plan": wrap("admin.import.plan", (input: AdminImportPlanParams, principal, ctx) =>
      service.plan(input, principal, ctx.signal, !!principal && importFreePathsAllowed(principal, ctx))),
    "admin.import.preflight": wrap("admin.import.preflight", (input: AdminImportPreflightParams, principal, ctx) =>
      service.preflight(input, principal, ctx.signal)),
    "admin.import.skills": wrap("admin.import.skills", (input: AdminImportSkillsParams, principal, ctx) =>
      service.skills(input, principal, ctx.signal)),
  };
}
