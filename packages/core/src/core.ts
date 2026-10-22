import { buildEngineTestSurface, createEngineTestDiagnostics } from "./rpc/engine-test-surface.ts";
import { engineModelEndpoints } from "./composition/embedding-policy.ts";
import { hermesClientAuth } from "./rpc/hermes-client-auth.ts";
import { authorize } from "./rbac/authorize.ts";
import { buildEmbeddingSelectionSurface } from "./rpc/embedding-selection-surface.ts";
import { creationDigest } from "./agents/saga.ts";
import { LicenceLedger } from "./licences/ledger.ts";
import { buildLicenceSurface, LICENCE_RULES } from "./rpc/licence-surface.ts";
import { buildChatSurface } from "./rpc/chat-surface.ts";
import { apiAdmission } from "./rpc/api-admission.ts";
import { apiIdentities } from "./rpc/api-identity.ts";
import { buildDoctorMethods } from "./doctor-report.ts";
import { buildVoiceSessionMethods } from "./rpc/voice-session-surface.ts";
import { createAuthSecretStore } from "./auth/secret-store.ts";
import { createWriter } from "./logs/writer.ts";
import { createD111Events } from "./discovery/events-logger.ts";
import { createPinnedClient } from "./discovery/http.ts";
import type { DiscoveryProviderDefinition } from "./discovery/real-adapters.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import type { Engine, EngineStatus, HostServices, ModelsStatus } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type { HarnessConfig } from "@plur1bus/config-schema";
import { apiPrincipal, checkAdoptionNonce, createOrphanWatch, type OrphanWatch, type SecurePathOptions } from "@plur1bus/module-api";
import { RPC_VERSION, SCHEMA, buildCapabilities, precompileMethods, type CoreStatusResult, type JobsStatus, type ProcessState } from "@plur1bus/rpc-schema";
import { ActivityTracker } from "./activity.ts";
import { ADMIN_METHODS } from "./admin-ops.ts";
import { BACKUP_METHODS } from "./backup-ops.ts";
import { reapplyTombstonesAfterRestore, type LoadEngineReapply } from "./restore-reapply.ts";
import { createMigrationDriver, type MigrationDriver } from "./embedding-migrate/driver.ts";
import { createEnginePort } from "./embedding-migrate/engine-port.ts";
import { buildReembedMethods, REEMBED_METHODS } from "./embedding-migrate/rpc.ts";
import { createStateStore } from "./embedding-migrate/state.ts";
import { createConfigSwitchPort } from "./embedding-migrate/switch.ts";
import { reembedBatchBudget } from "./embedding-migrate/budget.ts";
import { blockRemote, reembedTargetPolicy, targetFromSpec } from "./embedding-migrate/target.ts";
import { createAgentRegistry, type AgentRegistry } from "./agents.ts";
import { CORE_FEATURES } from "./capabilities.ts";
import { flattenPatch, openConfigSource, type ConfigSource } from "./config-source.ts";
import { assertEngineContract, bindEngine } from "./engine.ts";
import { buildEngineConfig, checkEngineConfigLicences, checkEngineEgress } from "./engine-config.ts";
import { isLocalEndpoint, localEndpoints, localOnlyFor } from "./privacy/local-only.ts";
import { localOnlyCheck } from "./privacy/doctor.ts";
import { emailAuthChecks } from "./channels/email-auth-check.ts";
import { mapEngineEvent } from "./events-map.ts";
import { createHarnessHost } from "./host.ts";
import { acquireCoreLock } from "./lock.ts";
import { type HarnessLogger, type Level } from "./logger.ts";
import { CURATION_METHODS } from "./memory-curation.ts";
import { MEMORY_OP_METHODS, requireAgent } from "./memory-ops.ts";
import { coreAddress, layout, resolveHome, type Layout } from "./paths.ts";
import { createPlatformCapabilities } from "./platform.ts";
import type { A1MemoryOperations } from "./dreams/producer.ts";
import { AGENT_CONTEXT_CLI, callerToPrincipal } from "./principal.ts";
import { startJournalReplay, type JournalReplay } from "./replay.ts";
import { RpcError } from "./rpc/errors.ts";
import { buildMethods } from "./rpc/methods.ts";
import { buildProjectBoardSurface, deliverBoardChange } from "./rpc/project-board-surface.ts";
import { buildCollabSurface } from "./rpc/collab-surface.ts";
import { buildIdentitySurface } from "./rpc/identity-surface.ts";
import { AdminStore } from "./identity/admin-store.ts";
import { deriveUserPrincipal } from "./identity/principals.ts";
import { AgentLifecycle } from "./agents/lifecycle.ts";
import { activeAgents, lifecycleAdmission, lifecycleEngine } from "./agents/admission.ts";
import { registerAgentConfig, unregisterAgentConfig } from "./agents/config.ts";
import { readConfigFile, writeConfigAtomic } from "./config-load.ts";
import { agentCreation, agentReferenceErrors } from "./agents/create.ts";
import { agentRequiredSecrets } from "./agents/secrets.ts";
import { buildAgentCreationSurface, AGENT_CREATION_RULES } from "./rpc/agent-create-surface.ts";
import { exportAgent } from "./agents/export.ts";
import { agentExportSigner, exportSecretCanaries } from "./agents/signing.ts";
import { buildAdminSurface } from "./rpc/admin-surface.ts";
import { deliverBreakglassNotice } from "./rpc/breakglass-notices.ts";
import { openInbox, lateInboxPort, type InboxComposition } from "./composition/inbox.ts";
import { alwaysGrantsToInbox, approvalToInbox, jobFailedToInbox, pairingToInbox, channelToInbox, breakglassToInbox, buildInboxSurface, deliverInboxChange } from "./inbox/index.ts";
import { sessionUsage } from "./rpc/session-usage.ts";
import { breakglassMemory } from "./rpc/breakglass-memory.ts";
import { sessionWriteAccess } from "./rpc/session-access.ts";
import { memoryCallerAccess } from "./rpc/memory-caller-access.ts";
import { sessionTranscriptSurface } from "./rpc/session-overview.ts";
import { UserJobs } from "./user-jobs/index.ts";
import { attachUserJobMethods } from "./user-jobs/rpc.ts";
import { createBreakGlass } from "./rbac/break-glass.ts";
import { userPrincipalHash, validIdentity } from "./principal.ts";
import { buildAuthSurface } from "./rpc/auth-surface.ts";
import { buildChannelSurface } from "./rpc/channel-surface.ts";
import { openTurnComposition, type TurnComposition, type CompositionOptions } from "./composition/index.ts";
import type { ChatProvider } from "./session/provider.ts";
import { createLogsMethods } from "./logs/index.ts";
import { type SessionService } from "./session/service.ts";
import { LOCAL_OWNER, createJsonlAuditSink, guardMethods, type AuditSink, type PrincipalResolver } from "./rbac/index.ts";
import { authenticatedPrincipal } from "./rbac/guard.ts";
import { createRpcServer, type CallContext, type RpcServer } from "./rpc/server.ts";
import { sharedMemoryStatus } from "./shared-memory.ts";
import { projectModels, startWarmup, type Warmup } from "./warmup.ts";
import path from "node:path";
import { createEgress } from "./egress/index.ts";
import type { SearxngWebSearch } from "./sidecars/web-search.ts";
import { createConfiguredWebSearch } from "./sidecars/web-search-router.ts";
import { WebFailure } from "./tools/web/failure.ts";
import { createBudgetService, type BudgetService } from "./budget/index.ts";
import { createCoreSecretStore } from "./secrets/runtime.ts";
import { createCatalogStore, type CatalogStore } from "./discovery/catalog-store.ts";
import { defaultDiscoveryAdapters, type DiscoveryAdapters } from "./discovery/defaults.ts";
import { createModelsScanJob } from "./discovery/job.ts";
import { loadMetadataTable, reenrichCatalog } from "./discovery/metadata.ts";
import { loadReasoningTable, resolveReasoning } from "./discovery/reasoning.ts";
import { createScanScheduler, type ScanScheduler } from "./discovery/scheduler.ts";
import { createDiscoveryService, type DiscoveryService } from "./discovery/service.ts";
import { createDreams, forgetRemovedAgent, readCandidateMemory, type Dreams } from "./dreams/index.ts";
import { createSystemJobs, type SystemJobs } from "./system-jobs/index.ts";
import { createMetrics, createMetricsServer, loadOrCreateMetricsToken, type Metrics, type MetricsServer } from "./metrics/index.ts";
import { createAuditWriter } from "./identity/audit.ts";
import { createAuditChain, teeAuditSinks, type AuditChain } from "./audit/chain.ts";
import { createIdentityService, type IdentityService } from "./identity/service.ts";
import { approvalsDbPath } from "./approvals/db.ts";
import { secretStoreKeySource, secretStoreSigningKeySource } from "./approvals/keys.ts";
import { armApprovalsIntegrity, createApprovalsIntegrityJob } from "./approvals/integrity-job.ts";
import { createPermissionNotifier, type PermissionNotifier } from "./approvals/notify.ts";
import { grantRecordOf } from "./approvals/wire.ts";
import { openChannelSwitchboard } from "./channels/core-host.ts";
import type { Switchboard } from "./channels/switchboard.ts";
import { createPermissionRuntime, type PermissionRuntime } from "./approvals/runtime.ts";
import type { ApprovalService } from "./approvals/service.ts";
import { createPolicyAudit } from "./policy/audit.ts";
import { connectionSurface, type ConnectionAttestation } from "./rbac/connection-surface.ts";
import { createAttestationService, helperFromEnv, type Attester, type HelperSpec } from "./attestation/index.ts";

/** G17: the replies a stop waits for before it closes the sockets. `memory.capture` is among them, so a stored reply
 *  is never cut off (the client would journal the text and the next core would store it a second time); the admin ops
 *  too, so an applied migration or a consumed vault nonce is never left unanswered. */
const DRAINED_METHODS = [...MEMORY_OP_METHODS, ...CURATION_METHODS, ...ADMIN_METHODS, ...BACKUP_METHODS, ...REEMBED_METHODS, "memory.capture", "approval.decide", "approval.cancel", "grant.create", "grant.revoke"] as const;
/** `core.status` is synchronous (B11 < 5 ms) and engine.status() is not. `engine.models` is read fresh on every call
 *  from the synchronous `engine.models.status()`. Only the async `EngineStatus` parts (`degraded`, from which
 *  `engine.ready` follows) are cached, stale-while-revalidate: a call finding the copy older than STATUS_CACHE_MS
 *  answers from it and starts one background refresh, so the next call sees the result. While a model probe runs
 *  the copy is refreshed every WARMING_REFRESH_MS as well (spec §6.3, S7). */
const STATUS_CACHE_MS = 1000;
const WARMING_REFRESH_MS = 250;
/** H3B-R2: the longest a stop waits for the journal replay's capture in flight; never more than half its budget, so
 *  the engine close keeps the rest (the whole stop stays inside the budget: plan criterion 4, the supervisor's kill
 *  deadline at budget + stop grace). */
const REPLAY_STOP_WAIT_MS = 5000;

export interface Core {
  start(): Promise<void>;
  stop(o?: { budgetMs?: number }): Promise<void>;
  status(): CoreStatusResult;
  readonly address: string; readonly token: string; readonly layout: Layout;
  /** The configuration the core runs now (B7); null before start() has read it. */
  currentConfig(): HarnessConfig | null;
  /** D3: the metric sinks (`turn`, `providerError`); the session and provider code record into them. */
  readonly metrics: Metrics;
  /** D109: the approval service (opens `state/approvals.sqlite` on first use). Rejects E_NOT_AVAILABLE before start() and after stop(). */
  approvalService(): Promise<ApprovalService>;
  /** In-process composition port; no collab RPC or RBAC surface is added. */
  collaboration(): import("./collab/service.ts").Collab | null;
}
type State = ProcessState & { since: number };

const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/; // rpc.schema.json $defs/AgentId
// engine.event's own name enum (rpc.schema.json): the deprecated verbatim forward never carries memory.proposal (G13).
const ENGINE_EVENT_NAMES: readonly string[] = (SCHEMA as any).$defs.notifications["engine.event"].properties.name.enum;

export interface CoreOptions {
  /** Inbox retention per person (defaults: 90 days, 1000 entries). */
  inbox?: { maxAgeDays?: number; maxEntries?: number };
  home?: string; instanceId?: string; testInternals?: Record<string, unknown>; clock?: () => number; logger?: HarnessLogger;
  /** Called (after the reply is written) when a client sends `core.shutdown`, in place of calling stop() directly.
   *  bin.ts routes it through the same stop-and-exit path as SIGTERM, so the process exits after an RPC stop too. */
  onShutdownRequested?: (budgetMs: number | undefined) => void;
  /** Supervised mode (S4): the spawner's end of this stream is the core's lifeline, watched once the core is ready.
   *  bin.ts passes process.stdin for `--lifeline stdin`. */
  lifeline?: NodeJS.ReadableStream;
  /** Called when the core has been orphaned for `supervisor.graceMs`, in place of calling stop() directly. */
  onOrphanGraceExpired?: () => void;
  /** B7 (H3B-R8): load the configuration from the supervisor's `config.watch` (falling back to config.json), and
   *  follow its `config.changed`. bin.ts sets it for `--lifeline stdin`; absent, the core reads config.json once. */
  supervisorConfig?: { attempts?: number; connectTimeoutMs?: number };
  /** Test seam: options for the host's `securePath` (platform, execFile, ...), to drive the Windows ACL step on any host. */
  securePathOptions?: Omit<SecurePathOptions, "logger" | "runDir">;
  /** Test seam: sees the HostServices the engine is given. */
  inspectHost?: (host: HostServices) => void;
  /** Test seam: the engine's tombstone re-apply a backup restore's marker asks for (restore-reapply.ts); default: the engine's `lib/tombstone-reapply.js`, when it has one. */
  tombstoneReapply?: LoadEngineReapply;
  /** Legacy injected provider seam, adapted through composition; absent, configured provider definitions supply the pipeline. */
  chatProvider?: ChatProvider;
  composition?: CompositionOptions;
  /** M3 RBAC: who a call is made by, and where refusals are audited. Default: the token-authenticated local connection
   *  is the installation owner (R8) and refusals go to `<home>/logs/audit.log`. */
  rbac?: {
    resolve?: PrincipalResolver; audit?: AuditSink;
    /** Trusted person-directory lookup for scheduled work. Null means deleted/inactive; never supplied by RPC params. */
    resolvePerson?: (personId: string) => import("./rbac/types.ts").Principal | null;
    /** D109 §5: a server-side fact about a connection (desktop app, CLI on a TTY, fresh step-up) that raises a person to T3. Without it a token connection is T1 (#192); see rbac/connection-surface.ts. */
    attest?: (ctx: CallContext) => ConnectionAttestation | undefined;
  };
  /**
   * Issue #192 option C: one OS confirmation (Touch ID / Windows Hello / UAC consent / polkit) lifts a single approval of an
   * unattested local connection from T1 to T2. `helper` is the native `plur1bus-attest` binary (default: `PLUR1BUS_ATTEST_BIN`,
   * pinned, none in container mode; `null` = none); `attester` replaces the whole service (tests). No helper: attestation is
   * "unavailable" and every decision stays at its T1 limits.
   */
  attestation?: { helper?: HelperSpec | null; attester?: Attester };
  /** D112: model discovery adapters and options. */
  discovery?: Partial<DiscoveryAdapters> & {
    request?: typeof import("node:http").request;
    resolver?: import("./tools/web/guard.ts").Resolver;
    scheduler?: boolean;
    /** Test seam: custom catalog store for testing boot failures. Must not be set in production. */
    store?: CatalogStore;
  };
  /** M1b-3: the dreaming scheduler (ADR-009). `scheduler` forces it on or off; RULING: unset, it runs unless the core
   *  runs with test internals, so the system and soak tests never meet an importance- or cron-triggered dream. */
  dreams?: { scheduler?: boolean; clock?: import("./discovery/ports.ts").Clock; defaultTimezone?: string };
}

/** E4 `EngineStatus.jobs` onto the closed `$defs/JobsStatus` wire shape, flattened on purpose (ruling H3-R6): the
 *  breaker becomes `breakerOpen`, a last run keeps `outcome`, `reason` and `finishedAt`. */
function projectJobs(jobs: EngineStatus["jobs"] | undefined): JobsStatus | null {
  if (!jobs || !Array.isArray(jobs.agents)) return null;
  return {
    ledger: jobs.ledger === "ok" ? "ok" : "unavailable",
    agents: jobs.agents.map((a) => ({
      agentId: a.agentId, running: [...a.running], breakerOpen: a.breaker?.open === true, unreadableLines: a.unreadableLines,
      lastRuns: Object.fromEntries(Object.entries(a.lastRuns).flatMap(([job, r]) => (r
        ? [[job, { outcome: r.outcome, ...(typeof r.reason === "string" ? { reason: r.reason } : {}), finishedAt: Math.round(r.finishedAt) }]]
        : []))),
    })),
  };
}

/** The caller the CLI sends (crates/plur1bus/src/identity.rs: host name, OS user), so the recall-path warm-up reads
 *  as the CLI principal. */
function cliCaller(): { channel: "cli"; accountId: string; userId: string } {
  let user = "";
  try { user = userInfo().username; } catch { /* no passwd entry */ }
  return { channel: "cli", accountId: hostname() || "localhost", userId: user || "user" };
}

export function createCore(o: CoreOptions): Core {
  const home = resolveHome({ ...(o.home ? { home: o.home } : {}) });
  const l = layout(home); const clock = o.clock ?? Date.now;
  const instanceId = o.instanceId ?? randomUUID();
  const token = randomBytes(32).toString("hex");
  const apiToken = randomBytes(32).toString("hex");
  const address = coreAddress(home);
  const startedAt = clock();
  let activityCapacity = () => 1000;
  const activity = new ActivityTracker(clock, () => activityCapacity());
  let state: State = { state: "starting", since: startedAt };
  let server: RpcServer | null = null; let lock: { release(): void } | null = null;
  let engine: Engine | null = null; let logger: HarnessLogger | null = null; let agents: AgentRegistry | null = null;
  let journalBacklog = 0; let stopping: Promise<void> | null = null; let wroteRunFiles = false;
  let storeSchema: { current: string | null; expected: string } | null = null;
  let orphans: OrphanWatch | null = null;
  let source: ConfigSource | null = null;
  let reembed: MigrationDriver | null = null;
  let warmup: Warmup | null = null;
  let scanScheduler: ScanScheduler | null = null;
  let discoveryWriter: ReturnType<typeof createWriter> | null = null;
  let unsubscribeDiscoveryRedaction: (() => void) | null = null;
  let unsubscribeCoreRedaction: (() => void) | null = null;
  const closeLogRedaction = () => {
    unsubscribeDiscoveryRedaction?.(); unsubscribeDiscoveryRedaction = null;
    unsubscribeCoreRedaction?.(); unsubscribeCoreRedaction = null;
  };
  let coreWriter: Pick<ReturnType<typeof createWriter>, "updateLevels" | "currentLevels"> | null = null;
  let dreams: Dreams | null = null;
  let dreamsError: string | undefined;
  let inbox: InboxComposition | null = null; const inboxPort = lateInboxPort(() => inbox?.service ?? null);
  let modelLicences: LicenceLedger | null = null;
  let adminPeople: AdminStore | null = null; let agentLifecycle: AgentLifecycle | null = null;
  let identity: IdentityService | null = null; // M3: humans, linked channel identities and pairing (`state/identity.sqlite`)
  let budget: BudgetService | null = null;
  let auditChain: AuditChain | null = null;
  let replay: JournalReplay | null = null;
  let webSearch: SearxngWebSearch | null = null;
  let metricsHttp: MetricsServer | null = null;
  let userJobs: UserJobs | null = null;
  let userJobsTimer: ReturnType<typeof setInterval> | null = null;
  let sessions: SessionService | null = null;
  let turnComposition: TurnComposition | null = null;
  let permissions: PermissionRuntime | null = null; // D109: grants + approvals (`state/approvals.sqlite`), opened on first use
  let permissionNotifier: PermissionNotifier | null = null;
  let switchboard: Switchboard | null = null; // R3: the channel adapters (Discord, Slack, Matrix, Signal, E-mail), started and stopped by `channels.<id>.enabled`
  let engineStatus: EngineStatus | null = null; let engineStatusAt = 0; // performance.now() of the cached copy
  let statusRefresh: Promise<void> | null = null; let warmingTimer: NodeJS.Timeout | null = null;
  // H3-R22/R23: true from the start of the warm-up until its recall-path pass ends; engine.ready waits for it.
  let recallWarmPending = false;
  let statusClosed = false; // set by stop() and by a failed start: no refresh may re-arm the timer afterwards
  let beforeOrphan: State | null = null; // the state an orphaned core returns to on adoption
  let graceExpiredWhileStarting = false;
  // R19: the only signal a capture observes. Aborted at the start of stop(); never a client's disconnect or a wait timer.
  const shutdown = new AbortController();
  const capabilities = buildCapabilities(CORE_FEATURES, "core");
  const metrics = createMetrics({
    connections: () => server?.connectionCount() ?? 0,
    health: () => { const s = status(); return { ready: s.engine.ready, journalBacklog: s.journalBacklog ?? 0, agents: s.agents.length, uptimeSeconds: s.uptimeMs / 1000 }; },
  });

  const setState = (s: State) => { state = s; server?.notify("core.state", { process: s }); };
  /** The state behind an `orphaned`: orphaned is about the lifeline, not the engine's health. */
  const healthState = (): State => (state.state === "orphaned" && beforeOrphan ? beforeOrphan : state);

  const warmingNow = (s: EngineStatus) => s.models.embedder.warming || s.models.reranker.warming;
  function cacheEngineStatus(s: EngineStatus): void {
    if (statusClosed) return;
    engineStatus = s; engineStatusAt = performance.now();
    if (warmingTimer || stopping) return;
    // Polled while a probe runs, or until the first warm-up answered, so `models-warming` → null shows promptly.
    if (warmingNow(s) || (warmup !== null && s.degraded?.reason === "models-warming")) {
      warmingTimer = setTimeout(() => { warmingTimer = null; refreshEngineStatus(); }, WARMING_REFRESH_MS);
      warmingTimer.unref();
    }
  }
  /** One engine.status() at a time; engine.status() never rejects, a closed engine is left to the stop path. */
  function refreshEngineStatus(): void {
    const eng = engine;
    if (!eng || statusRefresh || stopping || statusClosed) return;
    statusRefresh = eng.status()
      .then((s) => { if (!stopping) cacheEngineStatus(s); }) // cacheEngineStatus ignores it once statusClosed
      .catch((err: unknown) => { logger?.debug("engine status refresh failed", { err }); })
      .finally(() => { statusRefresh = null; });
  }

  function status(): CoreStatusResult {
    if (engineStatus && performance.now() - engineStatusAt > STATUS_CACHE_MS) refreshEngineStatus();
    const es = engineStatus;
    const d = es?.degraded ?? null;
    let models: ModelsStatus | null = es?.models ?? null;
    try { if (engine && !statusClosed) models = engine.models.status(); } catch { /* keep the cached copy */ }
    const degraded = d ? { reason: d.reason, capability: d.capability, ...(typeof d.detail === "string" ? { detail: d.detail } : {}) }
      : recallWarmPending ? { reason: "models-warming", capability: "recall" } : null;
    const sharedMemory = sharedMemoryStatus(es);
    const jobs = projectJobs(es?.jobs);
    return {
      process: state, contract: engine?.contract ?? "", rpc: RPC_VERSION, instanceId, pid: process.pid, uptimeMs: Math.max(0, Math.round(clock() - startedAt)),
      engine: {
        // S7: `process` is the core's own health; the engine is ready only once its models are (degraded === null).
        ready: healthState().state === "ready" && es !== null && degraded === null, degraded,
        ...(models ? { models: projectModels(models) } : {}),
        ...(sharedMemory ? { sharedMemory } : {}),
        ...(storeSchema ? { storeSchema } : {}),
      },
      agents: (agents?.list() ?? []).map((agentId) => ({ agentId, activity: activity.get(agentId) })),
      // E4: the engine reads the journal through the host capability; the replay's count when it reports none.
      journalBacklog: es?.journal ? es.journal.entries : journalBacklog,
      ...(replay ? { journalReplay: replay.status() } : {}),
      ...(jobs ? { jobs } : {}),
      ...(webSearch ? { webSearch: webSearch.status() } : {}),
      ...(source ? { config: { revision: source.revision(), source: source.source, restartPending: source.restartPending() } } : {}),
      deprecationsUsed: server?.deprecationsUsed() ?? [],
    };
  }

  let hostClients: ReturnType<typeof hermesClientAuth> | null = null;
  async function start(): Promise<void> {
    for (const d of [l.state, l.run, l.logs, l.agents, l.models, l.journal, l.catalog, l.systemJobs]) mkdirSync(d, { recursive: true, mode: 0o700 });
    // B7: what the config source logs before the logger exists (it is built from the configuration) is kept and
    // written once it does.
    const early: [Level, string, Record<string, unknown> | undefined][] = [];
    const at = (lvl: Level) => (msg: string, fields?: Record<string, unknown>) => { if (logger) logger[lvl](msg, fields); else early.push([lvl, msg, fields]); };
    const cs = await openConfigSource({ layout: l, supervised: o.supervisorConfig !== undefined, logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") }, ...o.supervisorConfig });
    activityCapacity = () => cs.current().activity?.maxEntries ?? 1000;
    source = cs;
    const config = cs.current(); // the configuration the engine is built from (core-class keys)
    const cfg = () => cs.current();
    const createdLog = o.logger ? null : (await import("./logs/bootstrap.ts")).createCoreLog({ dir: l.logs, role: "core", source: { kind: "harness", id: "core", version: "0.1.0" }, levels: { defaultLevel: config.core.logLevel }, maxBytes: config.logs.maxBytes, keep: config.logs.keep, now: clock });
    logger = o.logger ?? createdLog!;
    if (createdLog) coreWriter = createdLog;
    const log = logger;
    for (const [lvl, msg, fields] of early.splice(0)) log[lvl](msg, fields);
    // S11: run/ holds the tokens; on Windows chmod is no permission, so the user-SID ACL goes on through icacls.
    const platform = createPlatformCapabilities({ logger: log, runDir: l.run, ...o.securePathOptions });
    const runSecured = platform.securePath(l.run, { mode: 0o700 });
    // Audit M3: fail closed, supervised or not. run/ is where the token goes; when its ACL could not be set (icacls
    // blocked or failing on a home outside the user's private profile), the token would inherit whatever the parent
    // directory allows. A supervisor's own run/ ACL (HB5) reaches the core only through PLUR1BUS_RUN_ACL=inherited,
    // which the supervisor exports to its children only when its DACL took; securePath honours it above (no tool is
    // run, `applied: true`), so a refusal here means nobody secured run/. A supervisor whose secure_run_dir failed
    // exports nothing and deliberately falls back to the children's own securePath (plan H3b-b, Review Focus 5), so
    // the core must not assume the supervisor owns run/: supervised, it exits and the supervisor restarts it.
    if (!runSecured.applied && runSecured.reason === "acl-tool-unavailable") {
      const supervised = o.lifeline !== undefined || o.supervisorConfig !== undefined;
      const msg = "refusing to start: the access control list of run/ could not be restricted to this user (icacls failed or is blocked" + (supervised ? ", and the supervisor did not secure run/ either (no PLUR1BUS_RUN_ACL=inherited)" : "") + "), so the core would write its token into a directory that other accounts may read; fix icacls or use a private PLUR1BUS_HOME";
      log.error(msg, { run: l.run, supervised });
      throw new Error(msg);
    }
    platform.securePath(l.catalog, { mode: 0o700 });
    platform.securePath(l.systemJobs, { mode: 0o700 });
    // M2: the secret store. Nothing is probed or opened here (the keychain is first touched by a `secret.*` call).
    const egress = createEgress({ config: () => cs.current().egress, now: clock, ...(o.discovery?.resolver ? { resolver: o.discovery.resolver } : {}) });
    const secretStore = createCoreSecretStore({ layout: l, securePath: platform.securePath, fileFallback: () => cs.current().secrets.fileFallback.enabled, clock, logger: log });
    // Every secret value the store writes, rotates, reveals or leases is masked in the core log from that moment on.
    if (createdLog) { unsubscribeCoreRedaction?.(); unsubscribeCoreRedaction = secretStore.redaction.subscribe((value, info) => createdLog.registerSecret(value, info)); }
    // web.search (D95): the SearXNG sidecar plus the keyed providers (Brave, Tavily, Exa), chosen per agent from `modules.web-search`.
    // The sidecar's destination is configuration (sidecars.searxng) or the address the container layer injected; the keyed
    // providers go through the egress policy and read their key from the secret store per call. The trace carries lengths,
    // counts and failure codes, never a query or a key.
    webSearch = createConfiguredWebSearch({
      config: () => { const c = cs.current(); return { sidecars: c.sidecars, modules: c.modules, egress: c.egress }; }, env: process.env, now: clock, ...(o.discovery?.resolver ? { resolver: o.discovery.resolver } : {}),
      readSecret: async name => {
        try { const lease = await secretStore.lease({ kind: "core" }, name, { purpose: "web-search", profileId: "web-search", ttlMs: 5000 }); try { return lease.value; } finally { secretStore.revokeLease({ kind: "core" }, lease.leaseId); } }
        catch (e) { if (e && typeof e === "object" && "code" in e && e.code === "not-found") return null; throw new WebFailure("provider-failed", "the search API key could not be read from the secret store"); }
      },
      trace: (e) => log.debug("web.search", { provider: e.provider ?? "none", queryChars: e.queryChars, results: e.results ?? 0, ms: e.ms, ...(e.error ? { error: e.error } : {}) }),
    });
    orphans = createOrphanWatch({
      graceMs: config.supervisor.graceMs, clock,
      onOrphaned: (since) => {
        // A lifeline lost while starting is applied once the core is ready; one lost while stopping is irrelevant.
        if (state.state !== "ready" && state.state !== "degraded") return;
        beforeOrphan = state;
        setState({ state: "orphaned", since });
        log.warn("lifeline lost, core orphaned", { graceMs: cfg().supervisor.graceMs });
      },
      onReattached: () => {
        if (state.state === "starting") { graceExpiredWhileStarting = false; return; } // an adoption before ready is a live lifeline
        if (state.state !== "orphaned") return;
        const back = beforeOrphan ?? { state: "ready" as const, since: clock() }; beforeOrphan = null;
        setState({ ...back, since: clock() });
        log.info("lifeline re-attached", { state: back.state });
      },
      onGraceExpired: () => {
        if (state.state === "starting") { graceExpiredWhileStarting = true; return; } // acted on once the core is ready
        if (state.state !== "orphaned") return;
        graceExpired();
      },
    });
    const graceExpired = () => {
      log.warn("orphan grace expired, stopping", { graceMs: cfg().supervisor.graceMs });
      if (o.onOrphanGraceExpired) o.onOrphanGraceExpired(); else void stop();
    };
    // Watched from the start (S4), so an adoption during the engine start replaces the spawner's stdin, never the reverse.
    if (o.lifeline) orphans.watchStream(o.lifeline);
    // Spec §6.1 live keys: applied as they arrive. `core.recall.*`, `core.capture.waitMs`, `core.shutdownBudgetMs` and
    // `agents` are read per use; a `core`-class change waits for the supervisor's restart (restartPending).
    const watchedOrphans = orphans;
    cs.onChange((prev, next, plan) => {
      if(plan.changed.some(k=>k==="privacy"||k.startsWith("privacy.")||/^agents\.[^.]+\.privacy(?:\.|$)/.test(k)))server?.notify("chat.models.changed",{at:clock(),reason:"privacy"});
      if (next.core.logLevel !== prev.core.logLevel) log.setLevel(next.core.logLevel);
      if (next.logs.maxBytes !== prev.logs.maxBytes || next.logs.keep !== prev.logs.keep) log.setRotation({ maxBytes: next.logs.maxBytes, keep: next.logs.keep });
      if (next.supervisor.graceMs !== prev.supervisor.graceMs) watchedOrphans.setGraceMs(next.supervisor.graceMs);
      if (plan.changed.some((k) => k.startsWith("models.scan.") || k === "providers" || k.startsWith("providers.") || k === "privacy" || k.startsWith("privacy."))) scanScheduler?.replan();
      // An agent that left the configuration loses its dream schedule at once (forgetAgent refuses one the registry still lists).
      for (const id of Object.keys(prev.agents)) if (!Object.hasOwn(next.agents, id)) forgetRemovedAgent(dreams?.scheduler, id, log);
      if (discoveryWriter) discoveryWriter.updateLevels({ ...discoveryWriter.currentLevels(), defaultLevel: next.core.logLevel });
      discoveryWriter?.setRotation({ maxBytes: next.logs.maxBytes, keep: next.logs.keep });
      log.info("configuration changed", { revision: cs.revision(), changed: plan.changed, restartPending: cs.restartPending() });
      log.debug("live keys applied", { keys: plan.restart.live });
    });
    try {
      lock = acquireCoreLock(l.coreLock, instanceId);
      // Under the supervisor the agents follow its configuration; on its own the core follows config.json's edits.
      // Decided per call (M7): a core that fell back to the file and later re-watched switches over, and back.
      const supervised = createAgentRegistry({ config: cfg }, l, logger);
      const fromFile = createAgentRegistry({ path: l.configPath }, l, logger);
      const pick = <T>(f: (r: AgentRegistry) => T): T => {
        if (cs.source === "supervisor") return f(supervised);
        try { return f(fromFile); } catch { return f(supervised); } // no readable config.json: what runs
      };
      const registry: AgentRegistry = {
        list: () => pick((r) => r.list()), has: (id) => pick((r) => r.has(id)),
        scaffold: (id) => supervised.scaffold(id), workspaceOf: (id) => pick((r) => r.workspaceOf(id)),
      };
      const lifecycle = new AgentLifecycle({ path: path.join(l.state, "agent-lifecycle.sqlite") }); agentLifecycle = lifecycle;
      const executionRegistry = activeAgents(registry, lifecycle);
      agents = registry;
      registry.list(); // trigger scaffold of initial agents via refresh()
      const engineConfig = buildEngineConfig(config, l);
      checkEngineConfigLicences(engineConfig,l);
      // Preflight feedback; host.fetch also enforces the live egress policy on every request.
      await checkEngineEgress(engineConfig, egress, (message, fields) => log.warn(message, fields));
      const unmapped = new Set<string>();
      const events = (name: string, payload: unknown) => {
        // ADR-016 §6: the harness-owned notification, projected onto its schema.
        const m = mapEngineEvent(name, payload);
        if (m) server?.notify(m.method, m.params, m.audience ? { audience: m.audience.map(agentId => ({ agentId })) } : {});
        else if (!unmapped.has(name)) { unmapped.add(name); logger?.debug("unmapped engine event", { name }); }
        // G13: the deprecated verbatim forward, only to subscriptions that name engine.event.
        if (ENGINE_EVENT_NAMES.includes(name)) {
          const agentId = (payload as { agentId?: unknown } | null)?.agentId;
          server?.notify("engine.event", { name, ...(typeof agentId === "string" && AGENT_ID.test(agentId) ? { agentId } : {}), payload }, { optIn: true });
        }
      };
      const engineTestDiagnostics = createEngineTestDiagnostics();
      const host = createHarnessHost({
        onPortFailure: engineTestDiagnostics.observe,
        layout: l, logger, config, currentConfig: cfg, engineConfig, agents: executionRegistry, events, clock, egress, secrets: secretStore,
        // Offered only while a supervisor watch is live (M7: also after a later re-watch).
        mutateConfig: (patch: Record<string, unknown>) => cs.set(flattenPatch("engine", patch)) ?? Promise.reject(new Error("no supervisor to change the configuration")),
        canMutateConfig: () => cs.source === "supervisor",
      });
      o.inspectHost?.(host);
      // A backup restore left rows that may hold memories forgotten since: re-apply the committed tombstones before the engine
      // is built and before the socket listens, so before the first recall. Never throws; a gap leaves the marker and a warning.
      await reapplyTombstonesAfterRestore({ layout: l, baseDbPath: String(engineConfig.baseDbPath), logger, ...(o.tombstoneReapply ? { load: o.tombstoneReapply } : {}) });
      const { startDelayMs, ...engineInternals } = o.testInternals ?? {};
      const eng = lifecycleEngine(bindEngine(host, engineConfig, o.testInternals ? engineInternals : undefined), lifecycle); engine = eng;
      assertEngineContract(eng);
      const es = await eng.status();
      cacheEngineStatus(es);
      storeSchema = es.storeSchema;
      if (storeSchema.current !== null && storeSchema.current !== storeSchema.expected) {
        logger.warn("store schema differs from the engine's expected version; run `plur1bus admin migrate`", { current: storeSchema.current, expected: storeSchema.expected });
      }
      activity.onChange((agentId, a) => server?.notify("agent.activity", { agentId, activity: a }, { audience: [{ agentId }] }));

      const discDefaults = defaultDiscoveryAdapters({ logger, runtime: {
        definitions: () => o.composition?.definitions ?? Object.fromEntries(Object.entries(cfg().providers).filter(([, value]) => !!value && typeof value === "object" && "wireFormat" in value)) as Record<string, DiscoveryProviderDefinition>,
        store: createAuthSecretStore(secretStore), egress, now: clock, credentialProvider: definition => turnComposition?.discoveryCredentials(definition), openai: () => turnComposition?.openai.auth,
      } });
      discoveryWriter = createWriter({ dir: l.logs, role: "core", source: { kind: "harness", id: "discovery", version: "0.1.0" }, levels: { defaultLevel: config.core.logLevel }, now: clock, maxBytes: config.logs.maxBytes, keep: config.logs.keep });
      unsubscribeDiscoveryRedaction?.();
      unsubscribeDiscoveryRedaction = secretStore.redaction.subscribe((value, info) => discoveryWriter?.registerSecret(value, info));
      const discProfiles = o.discovery?.profiles ?? discDefaults.profiles;
      const discCredentials = o.discovery?.credentials ?? discDefaults.credentials;
      const discEvents = o.discovery?.events ?? createD111Events(discoveryWriter);
      const discClock = o.discovery?.clock ?? discDefaults.clock;
      const discRng = o.discovery?.rng ?? discDefaults.rng;
      const curatedTable = loadMetadataTable();
      const catalogStore = o.discovery?.store ?? createCatalogStore({
        path: l.catalogModels,
        tableRevision: curatedTable.revision,
        clock: discClock,
        securePath: platform.securePath,
        logger,
      });
      const loadRes = catalogStore.load();
      if (loadRes.file.tableRevision !== curatedTable.revision) {
        const vendorOf = (p: string) => discProfiles.list().find((x) => x.id === p)?.vendor;
        try {
          await catalogStore.mutate((c) => ({
            next: reenrichCatalog(c, curatedTable, vendorOf, logger ?? undefined),
            result: null,
          }));
        } catch {
          logger.warn("model.catalog.reenrich_failed");
        }
      }

      // M2 L8: the budget service. A store that cannot be opened (e.g. written by a newer core) must not take the
      // memory core down: budget.* then answers E_INTERNAL and callers that need a check fail closed.
      try {
        budget = createBudgetService({
          path: path.join(l.state, "budget.sqlite"), clock: { now: clock }, securePath: platform.securePath,
          events: (e) => logger?.warn(e.kind, { ...e }),
        });
      } catch (e) { logger.error("budget store unavailable", { err: e }); budget = null; }

      const discSettings = () => ({
        enabled: (cfg() as any).models?.scan?.enabled ?? true,
        intervalHours: (cfg() as any).models?.scan?.intervalHours ?? 24,
      });
      const discRoles = () => (cfg() as any).modelRoles ?? {};

      const discovery = createDiscoveryService({
        store: catalogStore,
        makeClient: options => createPinnedClient({ ...options, egress, ...(o.discovery?.request ? { request: o.discovery.request } : {}) }),
        profiles: discProfiles,
        credentials: discCredentials,
        events: discEvents,
        clock: discClock,
        rng: discRng,
        table: curatedTable,
        roles: discRoles,
        settings: discSettings,
        logger,
        onScanned: (p) => scanScheduler?.onScanned(p),
        // privacy.localOnly: cloud models stay in the list, marked locked, so the person sees why they cannot be chosen.
        modelLocked: (_provider, profile) => localOnlyFor(cfg()) && !(profile !== undefined && isLocalEndpoint(profile.baseUrl, localEndpoints(cfg()))),
        ...(o.discovery?.scanners ? { scanners: o.discovery.scanners } : {}),
      });
      discovery.onChanged((e) => server?.notify("models.changed", e));
      // Per-chat model choice: reasoning per model from the scan's API hint, else the curated table (cached per catalog change).
      const reasoningTable = loadReasoningTable();
      let catalogIndex: Map<string, import("./discovery/types.ts").CatalogModel> | null = null;
      discovery.onChanged(() => { catalogIndex = null; });
      const catalogEntry = (provider: string, model: string) => (catalogIndex ??= new Map(catalogStore.read().models.map(m => [JSON.stringify([m.provider, m.id]), m]))).get(JSON.stringify([provider, model]));
      const profileOf = (provider: string) => discProfiles.list().find(p => p.id === provider);
      const chatModels = {
        reasoning: (provider: string, model: string) => resolveReasoning({ vendor: profileOf(provider)?.vendor, id: model, api: catalogEntry(provider, model)?.api?.reasoning }, reasoningTable),
        catalog: (provider: string, model: string) => { const e = catalogEntry(provider, model); return e ? { displayName: e.displayName, status: e.status } : undefined; },
        endpoint: (provider: string) => profileOf(provider)?.baseUrl,
      };

      const ledgerPath = path.join(l.systemJobs, "ledger.jsonl");
      const systemJobs = createSystemJobs({
        ledgerPath,
        clock: discClock,
        securePath: platform.securePath,
        logger,
        engineHasJob: (name) => eng.jobs.list().some((j) => j.name === name),
        onFailed: run => jobFailedToInbox(inboxPort, run),
      });
      systemJobs.register(createModelsScanJob(discovery, discSettings));

      scanScheduler = createScanScheduler({
        service: discovery,
        store: catalogStore,
        systemRun: async (provider, trigger, signal) => {
          return await systemJobs.run("models.scan", { provider }, { trigger, signal });
        },
        clock: discClock,
        rng: discRng,
        settings: discSettings,
        logger,
      });

      // B5: the hash-chained audit file (logs/audit-chain*.jsonl). The core's own writers tee into it besides audit.log.
      auditChain = createAuditChain({ dir: l.logs, securePath: (p) => platform.securePath(p) });
      const chain = auditChain;
      // Startup check: report-only. A broken or unreadable chain is logged (finding codes, files, line and seq numbers: no record content)
      // and never blocks the core from starting; `plur1bus audit verify` and the append refusals carry the enforcement.
      try {
        const startupAudit = chain.verify();
        if (!startupAudit.ok) log.error("audit chain integrity findings at startup", { findings: startupAudit.findings, findingsTotal: startupAudit.findingsTotal });
      } catch (e) {
        log.error("audit chain could not be verified at startup", { reason: e instanceof Error ? e.message : String(e) });
      }
      const identityLog = createAuditWriter({ file: path.join(l.logs, "audit.log"), securePath: platform.securePath, clock });
      identity = createIdentityService({
        dbPath: path.join(l.state, "identity.sqlite"), clock,
        audit: (e) => {
          identityLog(e); pairingToInbox(inboxPort, e);
          chain.append({ at: clock(), actor: e.actor ?? { user: "core", host: "core" }, action: e.action, target: e.target, detail: e.detail });
        },
      });

      // D109: who a connection is, where policy lines go, and the permission stores (opened on first use, so the keychain is not touched at start).
      const people = new AdminStore({ path: path.join(l.state, "admin.sqlite"), ownerId: LOCAL_OWNER.userId }); adminPeople = people;
      inbox = openInbox({ stateDir: l.state, clock, retention: { maxAgeDays: o.inbox?.maxAgeDays ?? config.inbox.retention.days, maxEntries: o.inbox?.maxEntries ?? config.inbox.retention.maxEntries }, admins: () => people.users().filter(u => !u.disabled && (u.role === "owner" || u.role === "admin")).map(u => u.id), legacyNotices: () => people.allNotices(),
        onPublished: kind => metrics.inboxPublished(kind), log: (m, f) => log.warn(m, f),
        onChange: c => { void deliverInboxChange(c, { subscriptions: () => server?.subscriptions() ?? [], principalOf: async id => resolvePrincipal({ requestId: "inbox", connectionId: id, signal: shutdown.signal }, "inbox.count", {}), notify: (m, p, opts) => { if (!shutdown.signal.aborted) server?.notify(m, p, opts); } }).catch(() => { log.debug("inbox event withheld"); }); } });
      const originalResolver: PrincipalResolver = o.rbac?.resolve ?? (() => LOCAL_OWNER);
      hostClients = hermesClientAuth(l.home, people, clock);
      const apiIdentity = apiIdentities(p => {
        if (!people.resolvePerson(p.userId)) return null;
        const current = o.rbac?.resolvePerson ? o.rbac.resolvePerson(p.userId) : { ...p, kind: "person" as const };
        if (!current || current.userId !== p.userId || current.kind !== "person") return null;
        return { ...people.resolve(current), kind: p.kind, ...(p.tokenScopes ? { tokenScopes: p.tokenScopes } : {}) };
      });
      const resolvePrincipal: PrincipalResolver = async (ctx, method, params) => {
        const forwarded = apiPrincipal(ctx);
        if (forwarded && people.person(forwarded.userId)?.disabled) throw new RpcError("E_DENIED", "person is disabled", { reason: "person-disabled" });
        const api = apiIdentity.resolve(ctx);
        if (api !== undefined) return api;
        const who = await originalResolver(ctx, method, params); return who && who.kind === "person" && people.person(who.userId)?.disabled ? null : who ? people.resolve(who) : who;
      };
      const rbacAudit = o.rbac?.audit ?? teeAuditSinks(createJsonlAuditSink(path.join(l.logs, "audit.log"), { securePath: (p) => platform.securePath(p) }), chain);
      const notifier = createPermissionNotifier({
        subscriptions: () => server?.subscriptions() ?? [], notify: (m, p, opts) => server?.notify(m, p, opts),
        principalOf: async (connectionId, method) => resolvePrincipal({ requestId: "notify", connectionId, signal: shutdown.signal }, method, {}),
        grantRecordOf: (id, person) => permissions?.current()?.grants.inspect({ person }).find((v) => v.grant.id === id),
        now: clock, log: (msg, fields) => log.debug(msg, fields),
      });
      permissionNotifier = notifier;
      const board = switchboard = openChannelSwitchboard({
        layout: l, config: cs, secrets: secretStore, identity: () => identity, personActive: id => !people.person(id)?.disabled, sessions: () => sessions, agents: registry, permissions: () => permissions,
        clock, log: { info: (m, f) => log.info(m, f), warn: (m, f) => { channelToInbox(inboxPort, m, f); log.warn(m, f); }, error: (m, f) => log.error(m, f) },
      });
      permissions = createPermissionRuntime({
        maxGrantDays: () => cfg().approvals?.maxGrantDays ?? 90,
        // The switchboard sees approval requests next to the RPC notifier: a channel chat shows its own prompt.
        dbPath: approvalsDbPath(l.home), keys: secretStoreKeySource(secretStore), signing: secretStoreSigningKeySource(secretStore), clock: { now: clock }, events: { emit: (n, p) => { notifier.events.emit(n, p); board.approvalEvents.emit(n, p); approvalToInbox(inboxPort, n, p); } },
        audit: createPolicyAudit({ sink: rbacAudit, clock: { now: clock }, redactor: secretStore.redaction.redactor() }), securePath: platform.securePath,
        onOpen: (p) => {
          p.grants.setNotify((change, grant, state) => notifier.grantChanged(change, grantRecordOf(grant, state)));
          alwaysGrantsToInbox(inboxPort, p.grants.inspect().map((v) => v.grant), clock());
        },
      });
      const perms = permissions;
      // No store yet: nothing to verify, so no start run (and no ledger row); the first scheduled run is a day away.
      const approvalsStorePresent = existsSync(approvalsDbPath(l.home));
      systemJobs.register(createApprovalsIntegrityJob({
        clock: { now: clock },
        deferFirstRun: !approvalsStorePresent,
        present: () => existsSync(approvalsDbPath(l.home)),
        verify: async () => (await perms.open()).service.verify(),
        onOk: () => {
          const p = perms.current();
          if (!p) return;
          p.grants.announceDue();
          alwaysGrantsToInbox(inboxPort, p.grants.inspect().map(v => v.grant), clock());
        },
      }));
      if (approvalsStorePresent) void systemJobs.run("approvals.integrity", {}, { trigger: "harness" }).catch(err => log.warn("approvals.integrity at start failed", { err }));
      armApprovalsIntegrity(systemJobs, {
        now: clock,
        setTimer: (fn, ms) => {
          const t = setTimeout(() => { void fn(); }, ms);
          t.unref?.();
          return t;
        },
      });
      try { turnComposition = await openTurnComposition({ home: l.home, systemJobs, mediaHostFetchReady: typeof host.fetch === "function", supervised: o.supervisorConfig !== undefined, config: cfg, engine: eng, agents: executionRegistry, memoryAgents: registry, logger: log,
        voiceConfigSource: changes => cs.set(changes), inbox: inboxPort, resolvePrincipal, resolveCollaborationPerson: id => people.resolvePerson(id), secrets: secretStore, egress, permissions: perms, audit: rbacAudit, identity, clock, signal: shutdown.signal, webSearch: webSearch.search,
        // D109 §5: the submitting connection's approver and surface, derived by the core; a non-person can still chat (tool-less or
        // grant-covered turns) and is refused with a typed error only when a call needs a person's approval.
        approver: async (ctx, params) => { const principal = await resolvePrincipal(ctx, "session.submit", params); return { person: principal && principal.kind === "person" ? principal.userId : null, surface: connectionSurface({ principal, now: clock(), attestation: o.rbac?.attest?.(ctx) }) }; },
        isStopping: () => state.state === "stopping" || state.state === "stopped", notify: (method, params, opts) => {
          const event=(params as {event?:{sessionId?:string}}).event;
          const session=event?.sessionId?sessions?.forSession(event.sessionId).store.getSession(event.sessionId):null;
          const person=session?personOf(session.owner):undefined;
          server?.notify(method,params,person?{...opts,audience:[{personId:person}]}:opts);
        },
        onStoredCapture: agentId => dreams?.scheduler.recordCapture(agentId), ...(o.chatProvider ? { provider: o.chatProvider } : {}),
        ...(o.composition ? { options: o.composition } : {}), chatModels,
      });
      sessions = turnComposition.sessions; } catch (e) { logger.error("session composition unavailable", { err: e }); sessions = null; }


      // M2: the re-embedding migration (plan/run/status/abort); its switch is one config.set on the supervisor.
      const reembedEnginePort = createEnginePort(eng);
      const migration = createMigrationDriver({
        engine: reembedEnginePort, store: createStateStore(l.state), logger: log,
        switchPort: createConfigSwitchPort({ layout: l, config: { current: () => cs.current(), set: (c) => cs.set(c) } }),
        // A cloud target: the turn call budget pauses the run at a hard token limit.
        budget: () => { const b = turnComposition?.budget; return b ? reembedBatchBudget(b) : null; },
        // Before a run continues: the rules may have changed since the plan (privacy.localOnly, acknowledgment, egress).
        admitRun: async (c) => {
          const t = targetFromSpec({ provider: c.target.provider, model: c.target.model, dimensions: c.target.dimensions, ...blockRemote(c) }, { ...reembedTargetPolicy(cfg()), ...(c.remote?.privacyAck ? { privacyAck: c.remote.privacyAck } : {}) });
          if (t.ok && !t.local) await checkEngineEgress({ embedding: t.block }, egress, (message, fields) => log.warn(message, fields));
        },
      });
      reembed = migration;
      const identityService = identity;
      const ownership = (a: import("./rbac/types.ts").Principal, params?: unknown): string[] => {
        const canonical = deriveUserPrincipal(a.userId);
        let linked: string[] = []; try { linked = identityService.resolvePrincipals(canonical); } catch { /* bootstrap owner has no identity row */ }
        const caller = (params as { caller?: import("@plur1bus/rpc-schema").CallerIdentity } | undefined)?.caller;
        if (caller && (caller.channel !== "cli" || !validIdentity(caller.userId) || !validIdentity(caller.accountId))) throw new RpcError("E_DENIED", "caller identity is not valid", { reason: "principal-invalid" });
        // Existing local CLI sessions use the OS caller hash. Only the installation token owner gets that compatibility path.
        return [...new Set([canonical, ...linked, ...(a.userId === LOCAL_OWNER.userId && caller?.channel === "cli" ? [userPrincipalHash(caller)] : [])])];
      };
      const personOf = (owner: string): string | undefined => {
        for (const id of new Set([LOCAL_OWNER.userId, ...people.users().map(u => u.id), ...identityService.list({}).humans.map(h => h.id)]))
          if (ownership({ userId: id, role: people.role(id), kind: "person" }).includes(owner)) return id;
        return undefined;
      };
      const breakglass = createBreakGlass({ clock, audit: rbacAudit, requireNotification: true,
        limits: () => cfg().breakglass ?? { reasonMinChars: 10, reasonMaxChars: 500, maxWindowMinutes: 60 },
        notify: notice => {
          people.notice(notice); breakglassToInbox(inboxPort, notice);
          void deliverBreakglassNotice(notice, { subscriptions: () => server?.subscriptions() ?? [], principalOf: async id => resolvePrincipal({ requestId: "notice", connectionId: id, signal: shutdown.signal }, "breakglass.notices", {}), notify: (m,p,options) => server?.notify(m,p,options), stopped: () => shutdown.signal.aborted }).catch(() => { log.debug("break-glass live notice withheld; durable inbox retained"); });
        },
      });
      // The one break-glass registry: a lapsed grant is unusable at once, and its `break-glass.expired` audit line is written by whoever asks next or, when
      // nobody does, by this timer (it used to be the API's second registry's). A failing audit sink keeps the grant listed; the next sweep retries.
      const breakglassSweep = setInterval(() => { if (!shutdown.signal.aborted) try { breakglass.sweep(); } catch { log.debug("break-glass sweep postponed"); } }, 30_000);
      breakglassSweep.unref(); shutdown.signal.addEventListener("abort", () => clearInterval(breakglassSweep), { once: true });
      const signer = agentExportSigner(secretStore);
      const licenceLedger = modelLicences = new LicenceLedger(path.join(l.state, "model-licences.sqlite"), rbacAudit, clock);
      const reservedAgents = new Map<string, Awaited<ReturnType<typeof eng.open>>>();
      const creation = agentCreation({ config: cfg, layout: l, clock, audit: rbacAudit,
        people: () => [...new Set([LOCAL_OWNER.userId, ...people.users().map(u => u.id), ...identityService.list({}).humans.map(h => h.id)])],
        setRight: (id, userId, right) => people.setRight(id, userId, right),
        clearRights: id => { for (const { userId } of people.rights(id)) people.setRight(id, userId, null); },
        ready: id => { lifecycle.set(id,{ paused:false }); },
        isDeleted: id => lifecycle.state(id).deleted,
        setDeleted: (id, deleted) => { lifecycle.set(id, deleted ? { deleted: true, archived: true } : { deleted: false, archived: false, paused: false }); },
        reserve: async id => { lifecycle.set(id,{ paused:true }); const store = await eng.open(id); reservedAgents.set(id, store); },
        release: async id => { const store = reservedAgents.get(id); if (store) { await store.close(); reservedAgents.delete(id); } },
        removeConfig: async (id, expected) => {
          if (o.supervisorConfig !== undefined) {
            if (cs.source !== "supervisor") throw new RpcError("E_NOT_AVAILABLE", "supervisor configuration unavailable");
            await unregisterAgentConfig(l, id, expected);
          } else {
            const latest = readConfigFile(l.configPath), agents = { ...latest.agents };
            if (agents[id] && creationDigest(agents[id]) !== creationDigest(expected)) throw new RpcError("E_CONFLICT", "agent config changed during provisioning");
            delete agents[id];
            writeConfigAtomic(l.configPath, { ...latest, agents });
          }
          await cs.resubscribe();
        },
        secrets: async () => (await secretStore.list({ kind: "owner", id: "core" })).map(s => s.name),
        requiredSecrets: agent => agentRequiredSecrets(cfg(), agent),
        pause: id => { lifecycle.set(id, { paused: true }); },
        set: async (id, agent) => {
          if (o.supervisorConfig !== undefined) {
            if (cs.source !== "supervisor") throw new RpcError("E_NOT_AVAILABLE", "supervisor configuration unavailable");
            await registerAgentConfig(l, id, agent);
          } else {
            const latest = readConfigFile(l.configPath);
            if (Object.hasOwn(latest.agents, id)) throw new RpcError("E_AGENT_EXISTS", "agent already exists");
            const errors = agentReferenceErrors(latest, agent);
            if (errors.length) throw new RpcError("E_INVALID_PARAMS", errors[0]!.message, { detail: errors[0]!.field });
            writeConfigAtomic(l.configPath, { ...latest, agents: { ...latest.agents, [id]: agent } });
          }
          await cs.resubscribe();
        },
        importMemory: async (id, cards, hash, who) => {
          if (!cards.length) return;
          const p = callerToPrincipal({ channel: "cli", accountId: "admin-import", userId: who.userId }, id, l.workspaceDir(id)).principal;
          p.user = deriveUserPrincipal(who.userId);
          const result = await eng.memory.import({ agentId: id, principal: p, cards: cards.map((c: any) => ({ idempotencyKey: `${hash}:${c.id}`, text: c.text, scope: c.scope, provenance: "imported", sourceRef: `agent-export:${hash}`, ...(typeof c.createdAt === "number" ? { createdAt: c.createdAt } : {}) })) }, p, { origin: "system", background: false });
          if (result.rejected) throw new RpcError("E_STORAGE", "memory cards were rejected");
        },
      });
      await creation.recover();
      const adminSurface = buildAdminSurface({ onAgentDeleted: id => forgetRemovedAgent(dreams?.scheduler, id, log), rightsChanged: userId => { server?.notify("api.account.changed", { userId }, { audience: apiIdentity.services().map(connectionId => ({ connectionId })) }); }, people, lifecycle, identity: identityService, sessions: () => sessions?.store ?? null, breakglass, ownership, clock, audit: rbacAudit, sessionUsage: ids => sessionUsage(path.join(l.state, "budget.sqlite"), ids),
        agents: () => cfg().agents,
        export: async (id, who) => {
          const root = l.agentDir(id), workspace = registry.workspaceOf(id);
          if (!workspace) throw new RpcError("E_NOT_FOUND", "agent workspace not found");
          const principal = callerToPrincipal({ channel: "cli", accountId: "admin-export", userId: who.userId }, id, workspace).principal;
          principal.user = deriveUserPrincipal(who.userId);
          const memory = await eng.memory.list({ since: 0, limit: 100 }, principal, { origin: "user", background: false });
          if (memory.truncated) throw new RpcError("E_NOT_AVAILABLE", "engine memory listing is truncated", { reason: "memory-export-truncated" });
          return exportAgent({ root, agentId: id, config: cfg().agents[id], memories: memory.items, rights: Object.fromEntries(people.rights(id).map(r => [r.userId, r.right])), requiredSecrets: agentRequiredSecrets(cfg(), cfg().agents[id]!), signer, secrets: await exportSecretCanaries(secretStore) });
        },
        // No `erase`: the pinned engine has no hard-erasure API. The handler records/refuses before any mutation.
      });
      userJobs = new UserJobs({
        path: path.join(l.state, "user-jobs.sqlite"), clock, audit: rbacAudit,
        isStopping: () => shutdown.signal.aborted,
        agentExists: id => registry.has(id) && !lifecycle.state(id).deleted, agents: () => registry.list().filter(id => !lifecycle.state(id).deleted),
        resolve: personId => {
          if (people.person(personId)?.disabled) return null;
          if (o.rbac?.resolvePerson) { const current = o.rbac.resolvePerson(personId); return current ? people.resolve(current) : null; }
          if (personId !== LOCAL_OWNER.userId && !identityService.list({}).humans.some(h => h.id === personId)) return null;
          return people.resolve({ kind: "person", userId: personId, role: people.role(personId, personId === LOCAL_OWNER.userId ? "owner" : "member") });
        },
        displayName: id => identityService.list({}).humans.find(h => h.id === id)?.displayName ?? id,
        budgetBlocked: agentId => !budget || budget.status({ agentId }).limits.some(limit => limit.state === "hard"),
        onRecorded: run => log.info("recurring job completed", { jobId: run.jobId, runAs: run.runAs, trigger: run.trigger, outcome: run.outcome }),
        notify: run => {
          const draft = { kind: "job-failed" as const, severity: "warning" as const, titleKey: "inbox.jobFailed", params: { job: run.job, reason: run.outcome }, ref: { route: "/recurring", objectId: run.jobId }, dedupeKey: `user-job:${run.runId}` };
          inboxPort.publish({ ...draft, audience: "admins" });
          if (run.outcome === "skipped_no_rights") inboxPort.publish({ ...draft, userId: run.runAs });
        },
        submitTurn: async (job, person) => {
          if (!sessions) return "failed";
          if (!executionRegistry.has(job.agentId)) return "skipped_agent_inactive";
          const session = sessions.store.createSession({ kind: "direct", agentId: job.agentId, owner: deriveUserPrincipal(person.userId), scope: "user", title: job.name });
          const handle = sessions.runner.submit({ session, caller: { channel: "cli", accountId: "recurring", userId: person.userId }, text: job.prompt, approver: { person: person.userId, surface: 0 }, recurring: { jobId: job.id, jobName: job.name, runAs: person.userId, trigger: "recurring" } });
          const result = await handle.done;
          const outcome = result.error === "approval-timeout" ? "approval_timeout" : result.state === "completed" ? "completed" : result.error === "budget-exceeded" ? "skipped_budget" : "failed";
          return outcome;
        },
      });
      const rawMethods = {
        ...buildMethods({
        engine: eng, config: cfg, agents: registry, activity, logger, status, clock, journalBacklog: () => journalBacklog, captureSignal: shutdown.signal,
        isStopping: () => state.state === "stopping" || state.state === "stopped",
        // Deferred so the core.shutdown reply is written before the server closes its connections.
        shutdown: (budgetMs) => {
          setImmediate(() => { if (o.onShutdownRequested) o.onShutdownRequested(budgetMs); else void stop(budgetMs !== undefined ? { budgetMs } : {}); });
        },
        adopt,
        // B15: an applied admin.migrate changes the store's marker; core.status reads it from here.
        onMigrated: async () => {
          const s = await eng.status();
          storeSchema = s.storeSchema;
          cacheEngineStatus(s);
        },
        systemJobs,
        discovery,
        dreams: () => dreams?.scheduler ?? null,
        dreamsError: () => dreamsError,
        identity,
        backup: { layout: l, baseDbPath: String(engineConfig.baseDbPath) },
        auditChain,
        reembed: buildReembedMethods({ driver: migration, isStopping: () => state.state === "stopping" || state.state === "stopped", logger: log, targetPolicy: () => reembedTargetPolicy(cfg()), egress }),
        ...(budget ? { budget } : {}),
        egress,
        // Every connection that passed `core.auth` holds `run/core.token`, which only this OS user can read: it is the
        // owner. There is no weaker caller on this socket today; per-connection principals arrive with M3's users and
        // D109's surface trust, and this is the one place they plug in. The store refuses anything but `owner`, and an owner
        // that carries a `surface` must have `MIN_SECRET_SURFACE` to write, delete or reveal: the level is the connection's own
        // (T1 for a token connection, which is where the CLI and the web UI arrive; an attestation can only raise it).
        secrets: { store: secretStore, principalOf: async (ctx, method, params) => {
          const p = await resolvePrincipal(ctx, method, params);
          return p?.kind === "person" && p.role === "owner" ? { kind: "owner", id: p.userId, surface: connectionSurface({ principal: p, now: clock(), attestation: o.rbac?.attest?.(ctx) }) } : { kind: "agent" };
        } },
        permissions: {
          permissions: () => perms.open(), principalOf: resolvePrincipal, clock,
          surfaceOf: (principal, ctx) => connectionSurface({ principal, now: clock(), attestation: o.rbac?.attest?.(ctx) }),
          requireOsConfirmation: () => cfg().approvals?.requireOsConfirmation ?? true,
          attester: o.attestation?.attester ?? createAttestationService({ helper: o.attestation?.helper !== undefined ? o.attestation.helper : helperFromEnv(process.env), audit: createPolicyAudit({ sink: rbacAudit, clock: { now: clock }, redactor: secretStore.redaction.redactor() }), now: clock }),
          requireAgent: (agentId) => { requireAgent(registry, agentId); }, notify: { grantChanged: notifier.grantChanged, confirmationChanged: notifier.confirmationChanged },
          onGrantsInspected: (grants, now) => alwaysGrantsToInbox(inboxPort, grants, now),
        },
        }),
        ...(sessions?.methods ?? {}),
        ...(turnComposition?.surfaceMethods ?? {}),
        ...(turnComposition?.voice.v3.methods ?? {}),
        ...buildVoiceSessionMethods({ config: cfg, broker: () => turnComposition?.voice.broker, hasAgent: id => registry.has(id), clock, audit: rbacAudit,
          surface: (principal, ctx) => connectionSurface({ principal, now: clock(), attestation: o.rbac?.attest?.(ctx) }) }),
        ...buildInboxSurface(() => inbox?.service ?? null),
        ...buildProjectBoardSurface(() => turnComposition?.collab ?? null, event => { void deliverBoardChange(event, () => turnComposition?.collab ?? null, { subscriptions: () => server?.subscriptions() ?? [], resolve: async connectionId => resolvePrincipal({ requestId: "board-event", connectionId, signal: shutdown.signal }, "project.card.list", {}), notify: (m, p, opts) => { if (!shutdown.signal.aborted) server?.notify(m, p, opts); } }).catch(() => { log.debug("project board event withheld"); }); }),
        ...buildCollabSurface(() => turnComposition?.collab ?? null, id => registry.has(id)),
        ...buildIdentitySurface(() => identity),
        ...(await import("./rpc/device-surface.ts")).createDeviceSurface({ state: l.state, clock, signal: shutdown.signal, revoked: userId => server?.notify("api.account.changed", {userId}, {audience:apiIdentity.services().map(connectionId=>({connectionId}))}), personVersion: id => { const p=people.person(id); return p && !p.disabled ? p.version : null; }, audit: rbacAudit, securePath: p => platform.securePath(p), notifyTrust: (event,owners) => server?.notify("devices.trust.next",event,{audience:owners.map(personId=>({personId}))}) }),
        ...adminSurface,
        ...buildEngineTestSurface({ embedding: eng.embedding, config: () => engineConfig, diagnostics: engineTestDiagnostics }),
        ...buildLicenceSurface(licenceLedger,cfg),
        ...buildEmbeddingSelectionSurface({ ledger:licenceLedger, currentModel:() => String((engineConfig.embedding as any).local.model), migration, port:reembedEnginePort, audit:rbacAudit, clock }),
        ...sessionTranscriptSurface({ sessions: () => sessions?.store ?? null, lookup: id => sessions?.forSession(id).store ?? null, breakglass, ownership, personOf }),
        ...buildAuthSurface(() => turnComposition?.openai.auth ?? null),
        ...buildAgentCreationSurface(creation),
        ...buildChannelSurface({ config: cfg, source: cs, secrets: secretStore, identity: () => identity, registry: () => switchboard?.view ?? null, audit: rbacAudit, clock }),
        // D4 / D111: logs.query / logs.tail / logs.levels over <home>/logs; RBAC-guarded below (RPC_RULES).
        ...createLogsMethods({
          dir: l.logs, signal: shutdown.signal, redactor: secretStore.redaction.redactor(),
          ...(coreWriter ? { writer: {
            currentLevels: () => coreWriter!.currentLevels(),
            updateLevels(s) { coreWriter?.updateLevels(s); discoveryWriter?.updateLevels(s); },
          } } : {}),
          audit: rbacAudit, now: clock,
          actor: (ctx) => { try { const p = authenticatedPrincipal(ctx); return { user: p.userId, host: "rpc" }; } catch { return { user: "unknown", host: "rpc" }; } },
        }),
      };
      Object.assign(rawMethods, buildChatSurface({ sessions: () => sessions, models: () => turnComposition?.chatModels ?? null, agents: executionRegistry, audit: rbacAudit, now: clock, approver: async (ctx,p) => { const who = await resolvePrincipal(ctx,"chat.submit",p); return { person: who?.kind === "person" ? who.userId : null, surface: connectionSurface({ principal: who, now: clock(), attestation: o.rbac?.attest?.(ctx) }) }; } }));
      Object.assign(rawMethods, sessionWriteAccess({ methods: rawMethods, sessions: () => sessions?.store ?? null, lookup: id => sessions?.forSession(id).store ?? null, ownership, validateCaller: true }));
      const listAgents = rawMethods["agent.list"], agentStatus = rawMethods["agent.status"];
      rawMethods["agent.list"] = async (p, ctx) => { const r = await listAgents!(p,ctx) as { agents: { agentId: string }[] }; return { ...r, agents: r.agents.filter(a => !lifecycle.state(a.agentId).deleted).map(a => ({ ...a, lifecycle: lifecycle.state(a.agentId) })) }; };
      rawMethods["agent.status"] = async (p, ctx) => { if (lifecycle.state(p.agentId).deleted) throw new RpcError("E_NOT_FOUND", "agent not found"); return { ...await agentStatus!(p,ctx) as object, lifecycle: lifecycle.state(p.agentId) }; };
      Object.assign(rawMethods, breakglassMemory({ methods: rawMethods, engine: eng, identity: identityService, breakglass, workspace: id => registry.workspaceOf(id) }));
      // The other caller-taking memory ops (forget, correct, share, state, propose, proposals.*) act as the principal derived from `caller`: bind it to the authenticated person like memory.list/show and session.*.
      Object.assign(rawMethods, memoryCallerAccess({ methods: rawMethods, ownership, resolve: resolvePrincipal }));
      let initialDoctorCheck: (() => Promise<unknown>) | undefined;
      Object.assign(rawMethods, buildDoctorMethods({ home: l.home, clock, sandboxRequired: () => cfg().tools.sandbox.required, redactor: secretStore.redaction.redactor({ pii: true }), capabilityStatus: () => turnComposition?.capabilities.status(), miningStatus: () => turnComposition?.mining.status(), compositionChecks: () => (turnComposition?.refusedProviders ?? []).map(r => ({ id: `providers.${r.provider.toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 80)}`, status: "fail" as const, summary: `turn provider ${r.provider} refused (${r.code}): ${r.reason}` })), scheduleInitial: start => { initialDoctorCheck = start; }, coreChecks: () => [localOnlyCheck(cfg()), ...emailAuthChecks(cfg())] }));
      Object.assign(rawMethods, attachUserJobMethods({ ...rawMethods }, userJobs, resolvePrincipal));
      // events.subscribe is handled in the shared transport; this guard still supplies its admission/audit.
      rawMethods["events.subscribe"] = async () => ({});
      const methods = guardMethods(apiAdmission(lifecycleAdmission(rawMethods, lifecycle, id => sessions?.forSession(id).store.getSession(id)?.agentId), resolvePrincipal), { resolve: resolvePrincipal, audit: rbacAudit, now: clock, rules: { ...AGENT_CREATION_RULES, ...LICENCE_RULES } });
      const subscribe = methods["events.subscribe"]!;
      methods["events.subscribe"] = async (p, ctx) => {
        // The API's credential-only control link watches account revocations, never agent events.
        if (apiPrincipal(ctx) === null && p.agentId === undefined && Array.isArray(p.names) && p.names.length === 1 && p.names[0] === "api.account.changed") return {};
        return subscribe(p, ctx);
      };
      server = createRpcServer({
        canReadAgent: async (ctx, agentId) => authorize(await resolvePrincipal(ctx, "events.subscribe", { agentId }), "agent.read", { kind: "agent", agentId }, { now: clock() }).effect === "allow",
        address, token, apiToken, authorizeClient: hostClients.authorize, apiPrincipalOf: apiIdentity.forwarded, onApiAuthenticated: apiIdentity.authenticated, apiPersonOfConnection: async (connectionId, p) => { const who = apiIdentity.resolve({ requestId: "audience", connectionId, signal: shutdown.signal }); return who?.kind === "person" && who.userId === p.userId ? who.userId : null; }, personOfConnection: async connectionId => { const p = await resolvePrincipal({ requestId: "audience", connectionId, signal: shutdown.signal }, "events.subscribe", {}); return p?.kind === "person" ? p.userId : null; }, hello: () => ({ contract: eng.contract, rpc: RPC_VERSION, instanceId, pid: process.pid, capabilities }), methods, logger,
        onConnectionClosed: (id) => { apiIdentity.closed(id); orphans?.connectionClosed(id); void turnComposition?.voice.v3.connectionClosed(id); },
        onCall: (method, result) => metrics.rpcCall(method, result),
      });

      wroteRunFiles = true;
      writeFileSync(l.coreToken, token, { mode: 0o600 });
      writeFileSync(path.join(l.run, "api-delegation.token"), apiToken, { mode: 0o600 });
      platform.securePath(path.join(l.run, "api-delegation.token"));
      // A private, credential-free description of the bound endpoints lets Rust reject unsafe live transitions.
      const engineModelsPath = path.join(l.run, "engine-models.json");
      const endpoints = engineModelEndpoints(engineConfig as Record<string, unknown>).map(e => {
        let endpoint: string | null = null;
        try { if (e.endpoint) endpoint = new URL(e.endpoint).origin; } catch { /* unknown is fail closed */ }
        return { role: e.role, endpoint };
      });
      writeFileSync(engineModelsPath, JSON.stringify({ version: 1, pid: process.pid, instanceId, endpoints }), { mode: 0o600 });
      platform.securePath(engineModelsPath);
      writeFileSync(l.corePid, `${process.pid} ${instanceId}\n`, { mode: 0o600 }); // S6
      platform.securePath(l.coreToken); platform.securePath(l.corePid);
      await server.listen();
      if (config.metrics.enabled) {
        // D3: a metrics endpoint that cannot start (port taken) never keeps the core from starting.
        try {
          const mh = createMetricsServer({ token: loadOrCreateMetricsToken(path.join(l.state, "metrics.token"), platform.securePath), port: config.metrics.port, render: () => metrics.render(), logger });
          await mh.listen(); metricsHttp = mh;
        } catch (err) { logger.warn("metrics endpoint unavailable", { err }); }
      }
      // Test seam (Task 2 review M2), honoured only with PLUR1BUS_ALLOW_TEST_INTERNALS=1: holds the listening core in
      // `starting`, so the lifeline paths before ready (grace expired while starting, adoption before ready) stay testable.
      if (typeof startDelayMs === "number" && process.env.PLUR1BUS_ALLOW_TEST_INTERNALS === "1") await new Promise((r) => setTimeout(r, startDelayMs));
      const ready: State = { state: "ready", since: clock() };
      // A lifeline lost during the engine start orphaned the core before it was ready; its grace may already have run out.
      if (orphans.orphanedSince !== null) { beforeOrphan = ready; setState({ state: "orphaned", since: orphans.orphanedSince }); }
      else setState(ready);
      if (o.discovery?.scheduler !== false) scanScheduler.start();
      // M1b-3: a dreams store that cannot open must not take the memory service down; `dreams.*` then answers not-available.
      try {
        // A1 is optional until the Controller pins Engine contract 1.17.0.
        // These are public host operations under the agent's existing principal,
        // never calls made by a model or a background AgentContext.
        const dreamMemory = eng.memory as typeof eng.memory & A1MemoryOperations;
        const dreamContext = { origin: "system", background: false } as const;
        const dreamPrincipal = (agentId: string) => {
          const ws = executionRegistry.workspaceOf(agentId);
          if (!ws) throw new Error(`dreams agent workspace unavailable: ${agentId}`);
          return callerToPrincipal(cliCaller(), agentId, ws).principal;
        };
        dreams = createDreams({
          engine: eng, layout: l, clock: o.dreams?.clock ?? discClock, logger, agents: executionRegistry, securePath: platform.securePath,
          // Agent-private public cards plus A1's persistent recall counters when
          // available. Missing A1 keeps promotion closed, never maintenance. A
          // truncated corpus fails closed after the independent jobs ran.
          candidateMemory: {
            async list(agentId) {
              const ws = executionRegistry.workspaceOf(agentId);
              if (!ws) return [];
              return readCandidateMemory(query => dreamMemory.list(query, dreamPrincipal(agentId), dreamContext));
            },
            ...(typeof dreamMemory.stats === "function" ? {
              stats: (agentId: string, ids: readonly string[]) => dreamMemory.stats!(ids, dreamPrincipal(agentId), dreamContext),
            } : {}),
            ...(typeof dreamMemory.promote === "function" ? {
              promote: (agentId: string, ids: readonly string[]) => dreamMemory.promote!({ ids }, dreamPrincipal(agentId), dreamContext),
            } : {}),
          },
          ...(o.dreams?.defaultTimezone ? { scheduler: { defaultTimezone: o.dreams.defaultTimezone } } : {}),
        });
        if (o.dreams?.scheduler ?? o.testInternals === undefined) void dreams.start().catch((err) => logger?.error("dreaming scheduler failed to start", { err }));
      } catch (err) { dreams = null; dreamsError = String((err as Error)?.message ?? err).slice(0, 300); logger.error("dreaming scheduler unavailable", { err }); }
      logger.info("core ready", { instanceId, address, supervised: o.lifeline !== undefined });
      void initialDoctorCheck?.().catch(() => {});
      const runUserJobs = () => { if (userJobs && !shutdown.signal.aborted) void userJobs.tick().catch(() => log.warn("recurring scheduler failed")); };
      userJobsTimer = setInterval(runUserJobs, 30_000); userJobsTimer.unref(); runUserJobs();
      // Spec §6.3: the models load in the background, after `ready` (B8 measures the socket, not the models).
      recallWarmPending = true;
      warmup = startWarmup({
        engine: eng, logger, signal: shutdown.signal, onDone: () => refreshEngineStatus(),
        // H3-R23: a read-only pass per agent registered now (memory.list + rerank, never engine.recall); agents added
        // later are not warmed (their first recall pays the cold path). Not agent activity, emits no events.
        recallPath: {
          agents: () => executionRegistry.list(),
          principal: (agentId) => {
            const ws = registry.workspaceOf(agentId);
            return ws ? callerToPrincipal(cliCaller(), agentId, ws).principal : null;
          },
        },
        // The memory ops' RPC validators compile here, not in the first client call's end-to-end budget (spec §6.4).
        onRecallDone: () => {
          try { precompileMethods(["memory.recall", "memory.capture"]); } catch (err) { logger?.debug("rpc validator warm-up failed", { err }); }
          recallWarmPending = false; refreshEngineStatus();
        },
      });
      try { await switchboard?.start(); } catch (e) { logger.error("channels did not start", { err: e }); } // a channel problem never stops the core
      // B2 (I2): the journal replays in the background once the socket accepts connections, so the CLI's captures go
      // live instead of journaling while it is read; drainJournal re-runs the pass for any line that still arrived
      // during one. A stop aborts it between lines (shutdown.signal).
      replay = startJournalReplay({
        dir: l.journal, agents: executionRegistry, engine: eng, logger, clock, signal: shutdown.signal,
        // The cached engine status predates the replay (its journal count included the lines just replayed).
        onDone: (r) => { journalBacklog = r.kept; refreshEngineStatus(); },
      });
      refreshEngineStatus(); // the probes now run: `warming` starts the WARMING_REFRESH_MS poll
      if (graceExpiredWhileStarting && state.state === "orphaned") graceExpired();
    } catch (e) {
      // Cleanup never replaces the original start error.
      const log = logger;
      log.error("core start failed", { err: e });
      shutdown.abort(new Error("core start failed"));
      statusClosed = true; warmup?.abort(); if (warmingTimer) { clearTimeout(warmingTimer); warmingTimer = null; }
      orphans?.dispose();
      await step(log, "config watch", async () => { await source?.close(); });
      await step(log, "channels stop", async () => { await switchboard?.stop(); }); switchboard = null;
      if (userJobsTimer) { clearInterval(userJobsTimer); userJobsTimer = null; }
      await step(log, "sessions close", async () => { await turnComposition?.close(); turnComposition = null; }); sessions = null;
      await userJobs?.drain(); userJobs?.close(); userJobs = null;
      await step(log, "permissions close", async () => { permissionNotifier?.close(); await permissions?.close(); }); permissions = null; permissionNotifier = null;
      await step(log, "budget close", () => { budget?.close(); budget = null; });
      await step(log, "engine close", async () => { await engine?.close({ budgetMs: 5_000 }); }); engine = null;
      await step(log, "metrics close", async () => { await metricsHttp?.close(); }); metricsHttp = null;
      await step(log, "admin stores close", () => { inbox?.close(); inbox = null; modelLicences?.close(); modelLicences = null; adminPeople?.close(); adminPeople = null; hostClients?.close(); hostClients = null; agentLifecycle?.close(); agentLifecycle = null; });
      await step(log, "identity close", () => { identity?.close(); identity = null; });
      await step(log, "server close", async () => { await server?.close({ graceMs: 1000 }); }); server = null;
      await step(log, "lock release", () => { lock?.release(); }); lock = null;
      await step(log, "run files", () => removeRunFiles());
      state = { state: "stopped", since: clock(), reason: "start-failed" };
      await step(log, "discovery logger close", () => { closeLogRedaction(); discoveryWriter?.close(); discoveryWriter = null; });
      if (!o.logger) await step(null, "logger close", () => log.close());
      throw e;
    }
  }

  /** `core.adopt` (S3, S4): the nonce must equal the current run/supervisor.token, compared in constant time. */
  function adopt(nonce: string, connectionId: string): CoreStatusResult {
    if (state.state === "stopping" || state.state === "stopped") throw new RpcError("E_NOT_AVAILABLE", "core is stopping", { reason: "stopping" });
    const check = checkAdoptionNonce(l.supervisorToken, nonce);
    if (!check.ok) {
      logger?.warn("adoption refused", { connectionId, tokenFile: check.tokenFile });
      throw new RpcError("E_UNAUTHORIZED", "adoption refused", { reason: "adopt-nonce" });
    }
    orphans?.watchConnection(connectionId);
    logger?.info("adopted", { connectionId, state: state.state });
    // B7: the adopting supervisor may run another configuration than the one this core follows.
    void source?.resubscribe();
    return status();
  }

  function removeRunFiles(): void {
    if (!wroteRunFiles) return; // a refused core never touches the running core's token and pid
    rmSync(path.join(l.run, "engine-models.json"), { force: true }); rmSync(l.coreToken, { force: true }); rmSync(path.join(l.run, "api-delegation.token"), { force: true }); rmSync(l.corePid, { force: true }); wroteRunFiles = false;
  }

  /** Runs one shutdown step: a failure is logged and collected, never propagated. */
  async function step(log: HarnessLogger | null, name: string, fn: () => unknown, errors?: unknown[]): Promise<void> {
    try { await fn(); } catch (err) { errors?.push(err); try { log?.error(`stop step failed: ${name}`, { err }); } catch { /* logger gone */ } }
  }

  function stop(so: { budgetMs?: number } = {}): Promise<void> { // not async: every call returns the one settled promise
    if (stopping) return stopping;
    stopping = (async () => {
      const t0 = performance.now(); const budgetMs = so.budgetMs ?? 30_000;
      const remaining = () => Math.max(0, budgetMs - (performance.now() - t0));
      // G17: from here on isStopping() refuses new memory ops; the engine drains its side, then the server waits (in
      // what is left of the budget) for those replies to be written before it ends the sockets.
      setState({ state: "stopping", since: clock() });
      statusClosed = true;
      scanScheduler?.stop();
      // Dreams stop before the engine closes under them; a run the engine cannot interrupt gets a bounded wait.
      await step(logger, "dreams", async () => {
        const d = dreams; dreams = null;
        if (!d) return;
        let timer: NodeJS.Timeout | null = null;
        await Promise.race([d.stop(), new Promise<void>((res) => { timer = setTimeout(res, Math.min(5_000, budgetMs / 4)); })]);
        if (timer) clearTimeout(timer);
      });
      warmup?.abort(); // first: the warm-up's wait ends before the engine closes under it
      if (warmingTimer) { clearTimeout(warmingTimer); warmingTimer = null; }
      shutdown.abort(new Error("core stopping"));
      orphans?.dispose(); // closing connections from here on is the stop itself, not a lost lifeline
      const errors: unknown[] = [];
      await step(logger, "config watch", async () => { await source?.close(); }, errors);
      // H3B-R2: the abort acts between lines; the capture in flight gets a bounded wait before the engine closes. A
      // replay still running then leaves its `.replaying-<pid>` file for the next start, and logs nothing more.
      await step(logger, "journal replay", async () => {
        if (!replay) return;
        let timer: NodeJS.Timeout | null = null;
        const waited = await Promise.race([
          replay.done.then(() => true),
          new Promise<boolean>((res) => { timer = setTimeout(() => res(false), Math.min(REPLAY_STOP_WAIT_MS, budgetMs / 2)); }),
        ]);
        if (timer) clearTimeout(timer);
        if (!waited) logger?.warn("journal replay still running at stop; its file stays for the next start", { replayed: replay.status().replayed });
        replay.abandon(); // after a finished replay only detaches its logger
      }, errors);
      // M1b-2c: the shutdown abort above ends running turns (failed, `aborted`); they finish their writes before the engine closes.
      await step(logger, "channels stop", async () => { await switchboard?.stop(); switchboard = null; }, errors); // adapters first: no inbound message may reach a closing session store
      if (userJobsTimer) { clearInterval(userJobsTimer); userJobsTimer = null; }
      await step(logger, "sessions close", async () => { await turnComposition?.close(); turnComposition = null; sessions = null; }, errors);
      // A re-embedding run in flight ends at its next batch boundary (aborted, resumable) before the engine closes under it.
      await step(logger, "re-embedding run", async () => { await reembed?.stop(Math.min(REPLAY_STOP_WAIT_MS, budgetMs / 2)); }, errors);
      await step(logger, "engine close", async () => { await engine?.close({ budgetMs: remaining() }); }, errors);
      await step(logger, "admin stores close", () => { inbox?.close(); inbox = null; modelLicences?.close(); modelLicences = null; adminPeople?.close(); adminPeople = null; hostClients?.close(); hostClients = null; agentLifecycle?.close(); agentLifecycle = null; }, errors);
      await userJobs?.drain(); userJobs?.close(); userJobs = null;
      await step(logger, "identity close", () => { identity?.close(); identity = null; }, errors);
      await step(logger, "budget close", () => { budget?.close(); budget = null; }, errors);
      await step(logger, "rpc drain", async () => {
        if (!server) return;
        const r = await server.drain({ methods: DRAINED_METHODS, budgetMs: remaining() });
        if (!r.drained) logger?.warn("memory ops still pending at close", { pending: r.pending });
      }, errors);
      // After the drain: a decision in flight is answered before the database closes; calls still waiting end as not approved.
      await step(logger, "permissions close", async () => { permissionNotifier?.close(); await permissions?.close(); }, errors);
      await step(logger, "metrics close", async () => { await metricsHttp?.close(); metricsHttp = null; }, errors);
      await step(logger, "server close", async () => { await server?.close({ graceMs: 1000 }); }, errors);
      await step(logger, "lock release", () => { lock?.release(); lock = null; }, errors);
      await step(logger, "run files", () => removeRunFiles(), errors);
      setState({ state: "stopped", since: clock(), ...(errors.length ? { reason: "stop-step-failed" } : {}) });
      await step(logger, "log", () => logger?.info("core stopped", { instanceId, failedSteps: errors.length, ...(errors.length ? { firstError: errors[0] } : {}) }));
      await step(logger, "discovery logger close", () => { closeLogRedaction(); discoveryWriter?.close(); discoveryWriter = null; });
      if (!o.logger) await step(null, "logger close", () => logger?.close());
    })();
    return stopping;
  }

  const approvalService = async (): Promise<ApprovalService> => {
    if (!permissions) throw new RpcError("E_NOT_AVAILABLE", "the core is not running", { reason: "stopping" });
    return (await permissions.open()).service;
  };
  return { start, stop, status, address, token, layout: l, currentConfig: () => source?.current() ?? null, metrics, approvalService, collaboration: () => turnComposition?.collab ?? null };
}
