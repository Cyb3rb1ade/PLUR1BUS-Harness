import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { defaults, migrate, validate } from "@plur1bus/config-schema";
import { RPC_VERSION, buildCapabilities, type ModuleStatus, type ProcessState } from "@plur1bus/rpc-schema";
import { checkAdoptionNonce } from "./adoption.ts";
import { connect, type CoreClient } from "./client.ts";
import { watchSupervisorConfig, type ConfigWatch } from "./config-watch.ts";
import { createControlServer, type ControlServer } from "./control-server.ts";
import { acquireExclusiveLock, type ExclusiveLock } from "./lock.ts";
import { createLogger, type HarnessLogger } from "./logger.ts";
import { validateManifest, type ModuleManifest } from "./manifest.ts";
import { createOrphanWatch } from "./orphan-watch.ts";
import { coreAddress, corePidPath, coreTokenPath, moduleAddress, moduleRunFiles, runDir, supervisorTokenPath } from "./paths.ts";
import { RpcError } from "./rpc-error.ts";
import { createSecurePath } from "./secure-path.ts";
import { readRecordedPid, readRunToken } from "./trust.ts";

/** What a module may log through: the harness logger without its lifecycle controls. */
export type HarnessLikeLogger = Pick<HarnessLogger, "debug" | "info" | "warn" | "error" | "child">;

export interface ModuleContext {
  name: string; home: string; instanceId: string;
  /** Aborted when the module starts to stop. */
  signal: AbortSignal;
  logger: HarnessLikeLogger;
  /** `modules.<name>` of the running configuration (the supervisor's, or config.json's when there is none); `{}`
   *  before the first snapshot and when the section is absent. */
  config(): Record<string, unknown>;
  /** Called with the new `modules.<name>` whenever it changes; returns the unsubscribe. */
  onConfig(fn: (c: Record<string, unknown>) => void): () => void;
  /** When the manifest needs the core: the connected client, or null while it (re)connects (a fresh `run/core.token`
   *  per attempt, backoff 250 ms doubling to 5 s). Always null otherwise. */
  core(): CoreClient | null;
  /** Replaces `module.status.detail`. */
  setDetail(d: Record<string, unknown>): void;
}
export interface ModuleDefinition { start(ctx: ModuleContext): Promise<{ stop(o: { budgetMs: number }): Promise<void> }> }

/** The features `module.auth` advertises. */
export const MODULE_FEATURES = ["adoption", "lifelines"] as const;

/** Exit codes: 2 = usage or manifest (never retried by the supervisor as a transient failure), 3 = the lock is held
 *  by another instance (retried); a lock file that cannot be opened is 1, like any other start failure. */
const EXIT_MANIFEST = 2;
const EXIT_LOCKED = 3;
const EXIT_FAILED = 1;
/** A `module.shutdown` without budgetMs, SIGTERM and the grace expiry give the module this long to stop. */
const DEFAULT_STOP_BUDGET_MS = 10_000;
const CORE_BACKOFF_MS = { first: 250, max: 5_000 };
const REWATCH_MS = { first: 1_000, max: 30_000 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Config = Record<string, any>;

function fail(code: number, msg: string): never {
  process.stderr.write(`module: ${msg}\n`);
  process.exit(code);
}

/** config.json as it is (never written): the defaults when it is missing; `invalid` with the reasons otherwise. */
function readConfigFile(home: string): { config: Config } | { invalid: string } {
  const file = path.join(home, "config.json");
  if (!existsSync(file)) return { config: defaults() as Config };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (e) { return { invalid: `not JSON: ${(e as Error).message}` }; }
  const r = validate(migrate(raw).config);
  return r.ok ? { config: r.config as Config } : { invalid: r.errors.join("; ") };
}

/** The module's running configuration (B7): the supervisor's `config.watch` when supervised (falling back to
 *  config.json, re-watching with backoff after a lost watch), config.json otherwise. */
function openConfig(o: { home: string; supervised: boolean; log: (lvl: "info" | "warn", msg: string, f?: Record<string, unknown>) => void; onChange: (next: Config) => void }) {
  let current: Config = defaults() as Config;
  let watch: ConfigWatch | null = null;
  let closed = false;
  let rewatchTimer: NodeJS.Timeout | null = null; let rewatchDelay = REWATCH_MS.first;
  let chain: Promise<void> = Promise.resolve();

  const apply = (next: unknown, from: string) => {
    const v = validate(next);
    if (!v.ok) { o.log("warn", "configuration is invalid; ignored", { from, errors: v.errors }); return; }
    current = v.config as Config;
    o.onChange(current);
  };
  const fromFile = () => {
    const r = readConfigFile(o.home);
    if ("invalid" in r) o.log("warn", "config.json is invalid; keeping the running configuration", { errors: r.invalid });
    else apply(r.config, "file");
  };
  const follow = (w: ConfigWatch) => {
    const old = watch; watch = w;
    rewatchDelay = REWATCH_MS.first;
    w.onChange((c) => { if (watch === w) apply(c.config, "supervisor"); });
    w.onClose(() => {
      if (watch !== w || closed) return;
      watch = null;
      o.log("warn", "supervisor configuration watch lost; reading config.json and re-watching");
      fromFile();
      scheduleRewatch();
    });
    apply(w.config, "supervisor");
    void old?.close();
  };
  const tryWatch = (attempts: number) => (chain = chain.then(async () => {
    if (closed) return;
    try {
      const w = await watchSupervisorConfig({ home: o.home, attempts });
      if (closed) { await w.close(); return; }
      follow(w);
    } catch (e) {
      if (!watch) { o.log("warn", "supervisor configuration unavailable; reading config.json", { err: (e as Error).message }); fromFile(); scheduleRewatch(); }
    }
  }));
  function scheduleRewatch(): void {
    if (closed || rewatchTimer) return;
    rewatchTimer = setTimeout(() => { rewatchTimer = null; void tryWatch(1); }, rewatchDelay);
    rewatchTimer.unref();
    rewatchDelay = Math.min(rewatchDelay * 2, REWATCH_MS.max);
  }

  return {
    async open(): Promise<void> { if (o.supervised) await tryWatch(3); else fromFile(); },
    current: () => current,
    /** After an adoption: the adopting supervisor may run another configuration (B7). */
    resubscribe: () => { if (o.supervised || watch) void tryWatch(1); },
    async close(): Promise<void> { closed = true; if (rewatchTimer) clearTimeout(rewatchTimer); await watch?.close(); watch = null; },
  };
}

/** The reconnecting client to the core (a module whose manifest needs it). */
function openCoreLink(home: string, log: HarnessLogger) {
  let client: CoreClient | null = null; let closed = false;
  let timer: NodeJS.Timeout | null = null; let delay = CORE_BACKOFF_MS.first;
  const schedule = () => {
    if (closed || timer) return;
    timer = setTimeout(() => { timer = null; void attempt(); }, delay);
    timer.unref();
    delay = Math.min(delay * 2, CORE_BACKOFF_MS.max);
  };
  async function attempt(): Promise<void> {
    if (closed) return;
    try {
      const token = readRunToken(home, coreTokenPath(home)); // a fresh token: the core rewrites it on every start; run/ is checked first (M2)
      const pid = readRecordedPid(corePidPath(home)); // S11: on Windows the connect is refused without it
      const c = await connect({ address: coreAddress(home), token, endpoint: "core", connectTimeoutMs: 1000, ...(pid === undefined ? {} : { expectedServerPid: pid }) });
      if (closed) { await c.close(); return; }
      client = c; delay = CORE_BACKOFF_MS.first;
      log.info("core connected", { instanceId: c.hello.instanceId });
      c.onClose(() => {
        if (client === c) client = null;
        if (!closed) { log.info("core connection lost; reconnecting"); schedule(); }
      });
    } catch (e) {
      log.debug("core connect failed", { err: (e as Error).message });
      schedule();
    }
  }
  void attempt();
  return {
    get: () => client,
    async close(): Promise<void> { closed = true; if (timer) clearTimeout(timer); const c = client; client = null; await c?.close(); },
  };
}

/**
 * Runs a module process (B9): `--home <p> --module <name> [--lifeline stdin] [--instance <uuid>]`.
 *   1. reads and validates `modules/<name>/module.json` (its `name` must be `<name>`): exit 2 otherwise;
 *   2. takes `run/module-<name>.lock`: exit 3 while another instance holds it;
 *   3. opens the configuration (the supervisor's `config.watch` with `--lifeline stdin`, else config.json);
 *   4. `def.start(ctx)`; 5. writes `run/module-<name>.{token,pid}` (owner only); 6. listens on the module address;
 *   7. watches the lifeline (stdin): losing it orphans the module, which keeps running for `supervisor.graceMs`, then
 *      stops and exits 0 unless `module.adopt` re-attached it first.
 * `module.shutdown`, SIGTERM and SIGINT stop the module within the budget, remove the run files and exit 0 (1 when the
 * module's own stop threw). The log is `logs/module-<name>.log` (JSON lines, rotated by `logs.*`).
 */
export async function runModule(def: ModuleDefinition, argv: string[] = process.argv.slice(2)): Promise<never> {
  // Under a supervisor stdout and stderr are pipes it reads; a dead supervisor must not crash the module with EPIPE.
  for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
  let values: { home?: string; module?: string; lifeline?: string; instance?: string };
  try {
    ({ values } = parseArgs({ args: argv, options: { home: { type: "string" }, module: { type: "string" }, lifeline: { type: "string" }, instance: { type: "string" } }, strict: true }));
  } catch (e) { return fail(EXIT_MANIFEST, (e as Error).message); }
  if (!values.home || !values.module) return fail(EXIT_MANIFEST, "--home and --module are required");
  if (values.lifeline !== undefined && values.lifeline !== "stdin") return fail(EXIT_MANIFEST, `--lifeline accepts only stdin, got ${values.lifeline}`);
  if (values.instance !== undefined && !UUID.test(values.instance)) return fail(EXIT_MANIFEST, `--instance must be a UUID, got ${values.instance}`);
  const home = path.resolve(values.home); const name = values.module;
  const instanceId = (values.instance ?? randomUUID()).toLowerCase();

  // 1. The manifest. Its apiVersion is the supervisor's to judge (B12): this runtime runs what it was started with.
  const manifestPath = path.join(home, "modules", name, "module.json");
  let manifest: ModuleManifest;
  {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(manifestPath, "utf8")); } catch (e) { return fail(EXIT_MANIFEST, `manifest unreadable: ${manifestPath}: ${(e as Error).message}`); }
    const v = validateManifest(raw);
    if (!v.ok) return fail(EXIT_MANIFEST, `manifest invalid: ${manifestPath}: ${v.errors.join("; ")}`);
    if (v.manifest.name !== name) return fail(EXIT_MANIFEST, `manifest name ${JSON.stringify(v.manifest.name)} is not the module ${JSON.stringify(name)}`);
    manifest = v.manifest;
  }

  // 2. The single-instance lock.
  const files = moduleRunFiles(home, name);
  mkdirSync(runDir(home), { recursive: true, mode: 0o700 });
  let lock: ExclusiveLock | null;
  try { lock = acquireExclusiveLock(files.lock, { instanceId }); } catch (e) { return fail(EXIT_FAILED, `lock unavailable: ${files.lock}: ${(e as Error).message}`); }
  if (!lock) return fail(EXIT_LOCKED, `another instance of ${name} holds ${files.lock}`);

  // 3. The configuration, then the log (built from it).
  const clock = Date.now; const startedAt = clock();
  let log: HarnessLogger | null = null;
  const early: ["info" | "warn", string, Record<string, unknown> | undefined][] = [];
  const configListeners = new Set<(c: Record<string, unknown>) => void>();
  let section: Record<string, unknown> = {};
  let sectionJson = "{}";
  const sectionOf = (c: Config): Record<string, unknown> => {
    const s = c.modules?.[name];
    return s && typeof s === "object" && !Array.isArray(s) ? s : {};
  };
  let orphans: ReturnType<typeof createOrphanWatch> | null = null;
  const config = openConfig({
    home, supervised: values.lifeline === "stdin",
    log: (lvl, msg, f) => { if (log) log[lvl](msg, f); else early.push([lvl, msg, f]); },
    onChange: (c) => {
      log?.setRotation({ maxBytes: c.logs.maxBytes, keep: c.logs.keep });
      orphans?.setGraceMs(c.supervisor.graceMs);
      const next = sectionOf(c); const json = JSON.stringify(next);
      if (json === sectionJson) return;
      section = next; sectionJson = json;
      log?.info("module configuration changed");
      for (const fn of [...configListeners]) { try { fn(section); } catch (err) { log?.error("onConfig listener threw", { err }); } }
    },
  });
  await config.open();
  const cfg = config.current();
  const logger = createLogger({ file: path.join(home, "logs", `module-${name}.log`), level: "info", role: `module-${name}`, maxBytes: cfg.logs.maxBytes, keep: cfg.logs.keep });
  log = logger;
  for (const [lvl, msg, f] of early.splice(0)) logger[lvl](msg, f);
  const securePath = createSecurePath({ logger, runDir: runDir(home) });
  securePath(runDir(home), { mode: 0o700 });

  // State and status.
  let state: ProcessState & { since: number } = { state: "starting", since: startedAt };
  let beforeOrphan: (ProcessState & { since: number }) | null = null;
  let detail: Record<string, unknown> | null = null;
  const needsCore = manifest.needs.includes("core");
  const coreLink = needsCore ? openCoreLink(home, logger) : null;
  const status = (): ModuleStatus => ({
    process: state, name: manifest.name, version: manifest.version, apiVersion: manifest.apiVersion, instanceId, pid: process.pid,
    uptimeMs: Math.max(0, Math.round(clock() - startedAt)),
    core: coreLink ? (coreLink.get() ? "connected" : "reconnecting") : "not-needed",
    ...(detail ? { detail } : {}),
  });

  // Stop: the one path for module.shutdown, SIGTERM/SIGINT and the grace expiry.
  const shutdown = new AbortController();
  let handle: { stop(o: { budgetMs: number }): Promise<void> } | null = null;
  let server: ControlServer | null = null;
  let wroteRunFiles = false;
  let stopping = false;
  const stop = async (why: string, budgetMs = DEFAULT_STOP_BUDGET_MS, o: { failed?: boolean } = {}): Promise<never> => {
    if (stopping) { logger.info("stop already in progress", { why }); return new Promise<never>(() => {}); }
    stopping = true;
    state = { state: "stopping", since: clock() };
    logger.info("module stopping", { why, budgetMs });
    orphans?.dispose();
    shutdown.abort(new Error(`module stopping: ${why}`));
    // The budget covers the whole stop (M3): the module's own stop, then closing the core link, the config watch and
    // the server (whose grace for peers that keep their side open is cut to what is left). Only the run files, the
    // lock and the log (synchronous, instant) come after the deadline.
    const t0 = performance.now();
    const left = () => Math.max(0, budgetMs - (performance.now() - t0));
    const within = async (what: string, work: Promise<unknown>): Promise<void> => {
      let timer: NodeJS.Timeout | undefined;
      const inTime = await Promise.race([work.then(() => true), new Promise<boolean>((res) => { timer = setTimeout(() => res(false), left()); })]);
      clearTimeout(timer);
      if (!inTime) logger.warn(`${what} overran the stop budget`, { budgetMs });
    };
    let failed = o.failed === true;
    if (handle) {
      const h = handle;
      await within("module stop", Promise.resolve().then(() => h.stop({ budgetMs })).catch((err: unknown) => { failed = true; logger.error("module stop failed", { err }); }));
    }
    const step = async (what: string, fn: () => unknown) => { try { await fn(); } catch (err) { logger.error(`stop step failed: ${what}`, { err }); } };
    await within("closing", Promise.all([
      step("core link", () => coreLink?.close()),
      step("config watch", () => config.close()),
      step("server close", () => server?.close({ graceMs: Math.min(1000, left()) })),
    ]));
    await step("run files", () => { if (wroteRunFiles) { rmSync(files.token, { force: true }); rmSync(files.pid, { force: true }); } });
    await step("lock release", () => lock?.release());
    state = { state: "stopped", since: clock() };
    logger.info("module stopped", { instanceId });
    await logger.close();
    process.exit(failed ? 1 : 0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));

  // The lifeline (S4): created now so the grace follows config changes; stdin is watched once the module listens.
  orphans = createOrphanWatch({
    graceMs: cfg.supervisor.graceMs, clock,
    onOrphaned: (since) => {
      if (state.state !== "ready" && state.state !== "degraded") return;
      beforeOrphan = state; state = { state: "orphaned", since };
      logger.warn("lifeline lost, module orphaned", { graceMs: config.current().supervisor.graceMs });
    },
    onReattached: () => {
      if (state.state !== "orphaned") return;
      state = { ...(beforeOrphan ?? { state: "ready" }), since: clock() }; beforeOrphan = null;
      logger.info("lifeline re-attached");
    },
    onGraceExpired: () => { logger.warn("orphan grace expired, stopping"); void stop("lifeline grace expired"); },
  });
  const watchedOrphans = orphans;

  // 4. The module itself.
  const ctx: ModuleContext = {
    name, home, instanceId, signal: shutdown.signal, logger,
    config: () => section,
    onConfig: (fn) => { configListeners.add(fn); return () => { configListeners.delete(fn); }; },
    core: () => coreLink?.get() ?? null,
    setDetail: (d) => { detail = { ...d }; },
  };
  try {
    handle = await def.start(ctx);
  } catch (err) {
    logger.error("module start failed", { err });
    await coreLink?.close(); await config.close(); lock.release(); await logger.close();
    process.exit(1);
  }

  // 5 + 6. Run files, then the control endpoint.
  const token = randomBytes(32).toString("hex");
  const hello = () => ({ rpc: RPC_VERSION, instanceId, pid: process.pid, module: { name: manifest.name, version: manifest.version, apiVersion: manifest.apiVersion }, capabilities: buildCapabilities(MODULE_FEATURES, "module") });
  server = createControlServer({
    address: moduleAddress(home, name), token, hello, logger,
    onConnectionClosed: (id) => watchedOrphans.connectionClosed(id),
    handlers: {
      "module.status": async () => status(),
      "module.adopt": async (p: { nonce: string }, c) => {
        if (stopping) throw new RpcError("E_NOT_AVAILABLE", "module is stopping", { reason: "stopping" });
        const check = checkAdoptionNonce(supervisorTokenPath(home), p.nonce);
        if (!check.ok) {
          logger.warn("adoption refused", { connectionId: c.connectionId, tokenFile: check.tokenFile });
          throw new RpcError("E_UNAUTHORIZED", "adoption refused", { reason: "adopt-nonce" });
        }
        watchedOrphans.watchConnection(c.connectionId);
        logger.info("adopted", { connectionId: c.connectionId, state: state.state });
        config.resubscribe();
        return { status: status() };
      },
      "module.shutdown": async (p: { budgetMs?: number }) => {
        // Deferred so the reply is written before the server closes its connections.
        setImmediate(() => void stop("module.shutdown", p.budgetMs));
        return { accepted: true };
      },
    },
  });
  try {
    wroteRunFiles = true;
    writeFileSync(files.token, token, { mode: 0o600 });
    writeFileSync(files.pid, `${process.pid} ${instanceId}\n`, { mode: 0o600 });
    securePath(files.token); securePath(files.pid);
    await server.listen();
  } catch (err) {
    logger.error("module listen failed", { err });
    return stop("listen failed", DEFAULT_STOP_BUDGET_MS, { failed: true });
  }
  state = { state: "ready", since: clock() };
  logger.info("module ready", { name, version: manifest.version, instanceId, supervised: values.lifeline === "stdin" });

  // 7. The lifeline.
  if (values.lifeline === "stdin") watchedOrphans.watchStream(process.stdin);
  return new Promise<never>(() => {});
}
