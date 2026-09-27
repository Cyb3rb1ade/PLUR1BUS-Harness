import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import type { Engine, EngineStatus, HostServices, ModelsStatus } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type { HarnessConfig } from "@plur1bus/config-schema";
import { RPC_VERSION, SCHEMA, buildCapabilities, type CoreStatusResult, type JobsStatus, type ProcessState } from "@plur1bus/rpc-schema";
import { ActivityTracker } from "./activity.ts";
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
import { createOrphanWatch, type OrphanWatch } from "./orphan-watch.ts";
import { coreAddress, layout, resolveHome, type Layout } from "./paths.ts";
import { createPlatformCapabilities } from "./platform.ts";
import { callerToPrincipal } from "./principal.ts";
import { startJournalReplay, type JournalReplay } from "./replay.ts";
import { RpcError } from "./rpc/errors.ts";
import { buildMethods } from "./rpc/methods.ts";
import { createRpcServer, type RpcServer } from "./rpc/server.ts";
import { sharedMemoryStatus } from "./shared-memory.ts";
import { projectModels, startWarmup, type Warmup } from "./warmup.ts";

/** G17: the replies a stop waits for before it closes the sockets. `memory.capture` is among them, so a stored reply
 *  is never cut off (the client would journal the text and the next core would store it a second time). */
const DRAINED_METHODS = [...MEMORY_OP_METHODS, "memory.capture"] as const;
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
  /** Test seam: sees the HostServices the engine is given. */
  inspectHost?: (host: HostServices) => void;
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

const HEX64 = /^[0-9a-f]{64}$/; // both sides are lower-cased before the comparison
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
  let replay: JournalReplay | null = null;
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
    for (const d of [l.state, l.run, l.logs, l.agents, l.models, l.journal]) mkdirSync(d, { recursive: true, mode: 0o700 });
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
    const platform = createPlatformCapabilities({ logger: log });
    platform.securePath(l.run, { mode: 0o700 });
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
        logger.warn("store schema differs from the engine's expected version; migration arrives with 2a-H3", { current: storeSchema.current, expected: storeSchema.expected });
      }
      activity.onChange((agentId, a) => server?.notify("agent.activity", { agentId, activity: a }));

      const methods = buildMethods({
        engine: eng, config: cfg, agents: registry, activity, logger, status, clock, journalBacklog: () => journalBacklog, captureSignal: shutdown.signal,
        isStopping: () => state.state === "stopping" || state.state === "stopped",
        // Deferred so the core.shutdown reply is written before the server closes its connections.
        shutdown: (budgetMs) => {
          setImmediate(() => { if (o.onShutdownRequested) o.onShutdownRequested(budgetMs); else void stop(budgetMs !== undefined ? { budgetMs } : {}); });
        },
        adopt,
      });
      server = createRpcServer({
        address, token, hello: () => ({ contract: eng.contract, rpc: RPC_VERSION, instanceId, pid: process.pid, capabilities }), methods, logger,
        onConnectionClosed: (id) => orphans?.connectionClosed(id),
      });

      wroteRunFiles = true;
      writeFileSync(l.coreToken, token, { mode: 0o600 });
      writeFileSync(l.corePid, `${process.pid} ${instanceId}\n`, { mode: 0o600 }); // S6
      platform.securePath(l.coreToken); platform.securePath(l.corePid);
      await server.listen();
      // Test seam (Task 2 review M2), honoured only with PLUR1BUS_ALLOW_TEST_INTERNALS=1: holds the listening core in
      // `starting`, so the lifeline paths before ready (grace expired while starting, adoption before ready) stay testable.
      if (typeof startDelayMs === "number" && process.env.PLUR1BUS_ALLOW_TEST_INTERNALS === "1") await new Promise((r) => setTimeout(r, startDelayMs));
      const ready: State = { state: "ready", since: clock() };
      // A lifeline lost during the engine start orphaned the core before it was ready; its grace may already have run out.
      if (orphans.orphanedSince !== null) { beforeOrphan = ready; setState({ state: "orphaned", since: orphans.orphanedSince }); }
      else setState(ready);
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
        onRecallDone: () => { recallWarmPending = false; refreshEngineStatus(); },
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
    let expected: string | null = null;
    try { expected = readFileSync(l.supervisorToken, "utf8").trim().toLowerCase(); } catch { /* missing: refused below */ }
    const given = nonce.toLowerCase();
    const ok = expected !== null && HEX64.test(expected) && HEX64.test(given) && timingSafeEqual(Buffer.from(given, "utf8"), Buffer.from(expected, "utf8"));
    if (!ok) {
      logger?.warn("adoption refused", { connectionId, tokenFile: expected === null ? "missing" : HEX64.test(expected) ? "present" : "malformed" });
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
      await step(logger, "server close", async () => { await server?.close({ graceMs: 1000 }); }, errors);
      await step(logger, "lock release", () => { lock?.release(); lock = null; }, errors);
      await step(logger, "run files", () => removeRunFiles(), errors);
      setState({ state: "stopped", since: clock(), ...(errors.length ? { reason: "stop-step-failed" } : {}) });
      await step(logger, "log", () => logger?.info("core stopped", { instanceId, failedSteps: errors.length, ...(errors.length ? { firstError: errors[0] } : {}) }));
      if (!o.logger) await step(null, "logger close", () => logger?.close());
    })();
    return stopping;
  }

  return { start, stop, status, address, token, layout: l, currentConfig: () => source?.current() ?? null };
}
