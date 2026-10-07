import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import type { Engine, EngineStatus, HostServices, ModelsStatus } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type { HarnessConfig } from "@plur1bus/config-schema";
import { checkAdoptionNonce, createOrphanWatch, type OrphanWatch, type SecurePathOptions } from "@plur1bus/module-api";
import { RPC_VERSION, SCHEMA, buildCapabilities, precompileMethods, type CoreStatusResult, type JobsStatus, type ProcessState } from "@plur1bus/rpc-schema";
import { ActivityTracker } from "./activity.ts";
import { ADMIN_METHODS } from "./admin-ops.ts";
import { createAgentRegistry, type AgentRegistry } from "./agents.ts";
import { CORE_FEATURES } from "./capabilities.ts";
import { flattenPatch, openConfigSource, type ConfigSource } from "./config-source.ts";
import { assertEngineContract, bindEngine } from "./engine.ts";
import { buildEngineConfig } from "./engine-config.ts";
import { mapEngineEvent } from "./events-map.ts";
import { createHarnessHost } from "./host.ts";
import { acquireCoreLock } from "./lock.ts";
import { createLogger, type HarnessLogger, type Level } from "./logger.ts";
import { MEMORY_OP_METHODS } from "./memory-ops.ts";
import { coreAddress, layout, resolveHome, type Layout } from "./paths.ts";
import { createPlatformCapabilities } from "./platform.ts";
import { callerToPrincipal } from "./principal.ts";
import { startJournalReplay, type JournalReplay } from "./replay.ts";
import { RpcError } from "./rpc/errors.ts";
import { buildMethods } from "./rpc/methods.ts";
import { createRpcServer, type RpcServer } from "./rpc/server.ts";
import { sharedMemoryStatus } from "./shared-memory.ts";
import { projectModels, startWarmup, type Warmup } from "./warmup.ts";
import path from "node:path";
import { createCatalogStore, type CatalogStore } from "./discovery/catalog-store.ts";
import { defaultDiscoveryAdapters, type DiscoveryAdapters } from "./discovery/defaults.ts";
import { createModelsScanJob } from "./discovery/job.ts";
import { loadMetadataTable, reenrichCatalog } from "./discovery/metadata.ts";
import { createScanScheduler, type ScanScheduler } from "./discovery/scheduler.ts";
import { createDiscoveryService, type DiscoveryService } from "./discovery/service.ts";
import { createSystemJobs, type SystemJobs } from "./system-jobs/index.ts";
import { createMetrics, createMetricsServer, loadOrCreateMetricsToken, type Metrics, type MetricsServer } from "./metrics/index.ts";

/** G17: the replies a stop waits for before it closes the sockets. `memory.capture` is among them, so a stored reply
 *  is never cut off (the client would journal the text and the next core would store it a second time); the admin ops
 *  too, so an applied migration or a consumed vault nonce is never left unanswered. */
const DRAINED_METHODS = [...MEMORY_OP_METHODS, ...ADMIN_METHODS, "memory.capture"] as const;
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
}
type State = ProcessState & { since: number };

const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/; // rpc.schema.json $defs/AgentId
// engine.event's own name enum (rpc.schema.json): the deprecated verbatim forward never carries memory.proposal (G13).
const ENGINE_EVENT_NAMES: readonly string[] = (SCHEMA as any).$defs.notifications["engine.event"].properties.name.enum;

export interface CoreOptions {
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
  /** D112: model discovery adapters and options. */
  discovery?: Partial<DiscoveryAdapters> & {
    scheduler?: boolean;
    /** Test seam: custom catalog store for testing boot failures. Must not be set in production. */
    store?: CatalogStore;
  };
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
  const address = coreAddress(home);
  const startedAt = clock();
  const activity = new ActivityTracker(clock);
  let state: State = { state: "starting", since: startedAt };
  let server: RpcServer | null = null; let lock: { release(): void } | null = null;
  let engine: Engine | null = null; let logger: HarnessLogger | null = null; let agents: AgentRegistry | null = null;
  let journalBacklog = 0; let stopping: Promise<void> | null = null; let wroteRunFiles = false;
  let storeSchema: { current: string | null; expected: string } | null = null;
  let orphans: OrphanWatch | null = null;
  let source: ConfigSource | null = null;
  let warmup: Warmup | null = null;
  let scanScheduler: ScanScheduler | null = null;
  let replay: JournalReplay | null = null;
  let metricsHttp: MetricsServer | null = null;
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
      ...(source ? { config: { revision: source.revision(), source: source.source, restartPending: source.restartPending() } } : {}),
      deprecationsUsed: server?.deprecationsUsed() ?? [],
    };
  }

  async function start(): Promise<void> {
    for (const d of [l.state, l.run, l.logs, l.agents, l.models, l.journal, l.catalog, l.systemJobs]) mkdirSync(d, { recursive: true, mode: 0o700 });
    // B7: what the config source logs before the logger exists (it is built from the configuration) is kept and
    // written once it does.
    const early: [Level, string, Record<string, unknown> | undefined][] = [];
    const at = (lvl: Level) => (msg: string, fields?: Record<string, unknown>) => { if (logger) logger[lvl](msg, fields); else early.push([lvl, msg, fields]); };
    const cs = await openConfigSource({ layout: l, supervised: o.supervisorConfig !== undefined, logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") }, ...o.supervisorConfig });
    source = cs;
    const config = cs.current(); // the configuration the engine is built from (core-class keys)
    const cfg = () => cs.current();
    logger = o.logger ?? createLogger({ file: l.logFile("core"), level: config.core.logLevel, role: "core", maxBytes: config.logs.maxBytes, keep: config.logs.keep });
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
      if (next.core.logLevel !== prev.core.logLevel) log.setLevel(next.core.logLevel);
      if (next.logs.maxBytes !== prev.logs.maxBytes || next.logs.keep !== prev.logs.keep) log.setRotation({ maxBytes: next.logs.maxBytes, keep: next.logs.keep });
      if (next.supervisor.graceMs !== prev.supervisor.graceMs) watchedOrphans.setGraceMs(next.supervisor.graceMs);
      if (plan.changed.some((k) => k.startsWith("models.scan."))) scanScheduler?.replan();
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
      agents = registry;
      registry.list(); // trigger scaffold of initial agents via refresh()
      const engineConfig = buildEngineConfig(config, l);
      const unmapped = new Set<string>();
      const events = (name: string, payload: unknown) => {
        // ADR-016 §6: the harness-owned notification, projected onto its schema.
        const m = mapEngineEvent(name, payload);
        if (m) server?.notify(m.method, m.params, m.audience ? { audience: m.audience } : {});
        else if (!unmapped.has(name)) { unmapped.add(name); logger?.debug("unmapped engine event", { name }); }
        // G13: the deprecated verbatim forward, only to subscriptions that name engine.event.
        if (ENGINE_EVENT_NAMES.includes(name)) {
          const agentId = (payload as { agentId?: unknown } | null)?.agentId;
          server?.notify("engine.event", { name, ...(typeof agentId === "string" && AGENT_ID.test(agentId) ? { agentId } : {}), payload }, { optIn: true });
        }
      };
      const host = createHarnessHost({
        layout: l, logger, config, engineConfig, agents: registry, events, clock,
        // Offered only while a supervisor watch is live (M7: also after a later re-watch).
        mutateConfig: (patch: Record<string, unknown>) => cs.set(flattenPatch("engine", patch)) ?? Promise.reject(new Error("no supervisor to change the configuration")),
        canMutateConfig: () => cs.source === "supervisor",
      });
      o.inspectHost?.(host);
      const { startDelayMs, ...engineInternals } = o.testInternals ?? {};
      const eng = bindEngine(host, engineConfig, o.testInternals ? engineInternals : undefined); engine = eng;
      assertEngineContract(eng);
      const es = await eng.status();
      cacheEngineStatus(es);
      storeSchema = es.storeSchema;
      if (storeSchema.current !== null && storeSchema.current !== storeSchema.expected) {
        logger.warn("store schema differs from the engine's expected version; run `plur1bus admin migrate`", { current: storeSchema.current, expected: storeSchema.expected });
      }
      activity.onChange((agentId, a) => server?.notify("agent.activity", { agentId, activity: a }));

      const discDefaults = defaultDiscoveryAdapters({ logger });
      const discProfiles = o.discovery?.profiles ?? discDefaults.profiles;
      const discCredentials = o.discovery?.credentials ?? discDefaults.credentials;
      const discEvents = o.discovery?.events ?? discDefaults.events;
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

      const discSettings = () => ({
        enabled: (cfg() as any).models?.scan?.enabled ?? true,
        intervalHours: (cfg() as any).models?.scan?.intervalHours ?? 24,
      });
      const discRoles = () => (cfg() as any).modelRoles ?? {};

      const discovery = createDiscoveryService({
        store: catalogStore,
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
        ...(o.discovery?.scanners ? { scanners: o.discovery.scanners } : {}),
      });
      discovery.onChanged((e) => server?.notify("models.changed", e));

      const ledgerPath = path.join(l.systemJobs, "ledger.jsonl");
      const systemJobs = createSystemJobs({
        ledgerPath,
        clock: discClock,
        securePath: platform.securePath,
        logger,
        engineHasJob: (name) => eng.jobs.list().some((j) => j.name === name),
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

      const methods = buildMethods({
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
      });
      server = createRpcServer({
        address, token, hello: () => ({ contract: eng.contract, rpc: RPC_VERSION, instanceId, pid: process.pid, capabilities }), methods, logger,
        onConnectionClosed: (id) => orphans?.connectionClosed(id),
        onCall: (method, result) => metrics.rpcCall(method, result),
      });

      wroteRunFiles = true;
      writeFileSync(l.coreToken, token, { mode: 0o600 });
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
      logger.info("core ready", { instanceId, address, supervised: o.lifeline !== undefined });
      // Spec §6.3: the models load in the background, after `ready` (B8 measures the socket, not the models).
      recallWarmPending = true;
      warmup = startWarmup({
        engine: eng, logger, signal: shutdown.signal, onDone: () => refreshEngineStatus(),
        // H3-R23: a read-only pass per agent registered now (memory.list + rerank, never engine.recall); agents added
        // later are not warmed (their first recall pays the cold path). Not agent activity, emits no events.
        recallPath: {
          agents: () => registry.list(),
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
      // B2 (I2): the journal replays in the background once the socket accepts connections, so the CLI's captures go
      // live instead of journaling while it is read; drainJournal re-runs the pass for any line that still arrived
      // during one. A stop aborts it between lines (shutdown.signal).
      replay = startJournalReplay({
        dir: l.journal, agents: registry, engine: eng, logger, clock, signal: shutdown.signal,
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
      await step(log, "engine close", async () => { await engine?.close({ budgetMs: 5_000 }); }); engine = null;
      await step(log, "metrics close", async () => { await metricsHttp?.close(); }); metricsHttp = null;
      await step(log, "server close", async () => { await server?.close({ graceMs: 1000 }); }); server = null;
      await step(log, "lock release", () => { lock?.release(); }); lock = null;
      await step(log, "run files", () => removeRunFiles());
      state = { state: "stopped", since: clock(), reason: "start-failed" };
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
    rmSync(l.coreToken, { force: true }); rmSync(l.corePid, { force: true }); wroteRunFiles = false;
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
      await step(logger, "engine close", async () => { await engine?.close({ budgetMs: remaining() }); }, errors);
      await step(logger, "rpc drain", async () => {
        if (!server) return;
        const r = await server.drain({ methods: DRAINED_METHODS, budgetMs: remaining() });
        if (!r.drained) logger?.warn("memory ops still pending at close", { pending: r.pending });
      }, errors);
      await step(logger, "metrics close", async () => { await metricsHttp?.close(); metricsHttp = null; }, errors);
      await step(logger, "server close", async () => { await server?.close({ graceMs: 1000 }); }, errors);
      await step(logger, "lock release", () => { lock?.release(); lock = null; }, errors);
      await step(logger, "run files", () => removeRunFiles(), errors);
      setState({ state: "stopped", since: clock(), ...(errors.length ? { reason: "stop-step-failed" } : {}) });
      await step(logger, "log", () => logger?.info("core stopped", { instanceId, failedSteps: errors.length, ...(errors.length ? { firstError: errors[0] } : {}) }));
      if (!o.logger) await step(null, "logger close", () => logger?.close());
    })();
    return stopping;
  }

  return { start, stop, status, address, token, layout: l, currentConfig: () => source?.current() ?? null, metrics };
}
