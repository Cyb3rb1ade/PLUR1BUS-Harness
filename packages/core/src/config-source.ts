import { restartPlan, validate, type HarnessConfig } from "@plur1bus/config-schema";
import { watchSupervisorConfig, type ConfigWatch } from "@plur1bus/module-api";
import { loadConfig, readConfigFile } from "./config-load.ts";
import type { HarnessLogger } from "./logger.ts";
import type { Layout } from "./paths.ts";

type Plan = ReturnType<typeof restartPlan>;
type Log = Pick<HarnessLogger, "debug" | "info" | "warn" | "error">;

/** Where the core's configuration comes from (B7): the supervisor's `config.watch` (then every `config.changed`), or
 *  config.json when no supervisor answers (at start, or after the watch was lost). */
export interface ConfigSource {
  current(): HarnessConfig;
  /** `supervisor` while a watch is live; `file` otherwise. */
  readonly source: "supervisor" | "file";
  /** The supervisor's revision of `current()`; null for the file. */
  revision(): string | null;
  /** Whether `current()` differs from the configuration the core started with in a `core`-class key. */
  restartPending(): boolean;
  /** Called after each accepted change, with the restart plan from `prev` to `next`. */
  onChange(fn: (prev: HarnessConfig, next: HarnessConfig, plan: Plan) => void): () => void;
  /** `config.watch` again now (a new supervisor adopted the core); the difference is applied like a change. When no
   *  supervisor answers, config.json is read instead and re-watching goes on with backoff. Never rejects. */
  resubscribe(): Promise<void>;
  /** `config.set` on the supervisor; null while the configuration is the file. */
  set(changes: { key: string; value: unknown }[]): Promise<void> | null;
  close(): Promise<void>;
}

export interface ConfigSourceOptions {
  layout: Layout;
  /** Look the supervisor up first (the core runs with `--lifeline stdin`); otherwise read the file only. */
  supervised: boolean;
  logger?: Log;
  /** B7: `config.watch` attempts at start (default 3), each bounded by `connectTimeoutMs` (default 1000). */
  attempts?: number; connectTimeoutMs?: number;
  /** M1: re-watch backoff after a lost or missing watch (default 1000 ms doubling up to 30 000 ms). */
  rewatchMs?: { initial: number; max: number };
}

/** The leaves of `patch` as `config.set` changes under `prefix`; arrays and non-objects are leaves. */
export function flattenPatch(prefix: string, patch: Record<string, unknown>): { key: string; value: unknown }[] {
  const out: { key: string; value: unknown }[] = [];
  const walk = (path: string, v: unknown) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) { for (const [k, x] of Object.entries(v)) walk(`${path}.${k}`, x); return; }
    out.push({ key: path, value: v });
  };
  for (const [k, v] of Object.entries(patch)) walk(`${prefix}.${k}`, v);
  return out;
}

export async function openConfigSource(o: ConfigSourceOptions): Promise<ConfigSource> {
  const log = o.logger;
  const backoff = o.rewatchMs ?? { initial: 1000, max: 30_000 };
  const listeners = new Set<(prev: HarnessConfig, next: HarnessConfig, plan: Plan) => void>();
  let watch: ConfigWatch | null = null; let detach: (() => void) | null = null;
  let current: HarnessConfig; let revision: string | null = null; let closed = false;
  let builtWith: HarnessConfig; let pending = false; // recomputed per change, so core.status stays cheap (B11)
  let retryTimer: NodeJS.Timeout | null = null; let retryDelay = backoff.initial;
  let chain: Promise<void> = Promise.resolve(); // re-watches run one at a time

  /** A supervisor snapshot or push, or null (logged) when it fails the schema. */
  const accept = (config: Record<string, unknown>, rev: string, what: string): HarnessConfig | null => {
    const r = validate(config);
    if (r.ok) return r.config;
    log?.warn(`${what} is invalid; ignored`, { revision: rev, errors: r.errors });
    return null;
  };
  const apply = (next: HarnessConfig, rev: string | null) => {
    const prev = current; current = next; revision = rev;
    pending = restartPlan(builtWith, next).restart.core;
    const plan = restartPlan(prev, next);
    if (plan.changed.length === 0) return;
    for (const fn of [...listeners]) {
      try { fn(prev, next, plan); } catch (err) { log?.error("config change listener failed", { err }); }
    }
  };
  /** Makes `w` the live watch: its pushes are applied from now on, then whatever it holds now (the snapshot plus any
   *  push that arrived before this listener, I1) is applied if it differs from what runs. */
  const follow = (w: ConfigWatch): boolean => {
    const next = accept(w.config, w.revision, "supervisor configuration");
    if (!next) return false;
    detach?.();
    watch = w;
    const offChange = w.onChange((c) => {
      const pushed = accept(c.config, c.revision, "pushed configuration");
      if (pushed) apply(pushed, c.revision);
    });
    const offClose = w.onClose(() => { if (watch === w) lost(); });
    detach = () => { offChange(); offClose(); };
    retryDelay = backoff.initial;
    apply(next, w.revision);
    return true;
  };
  /** M1: the watch connection ended. What runs now is config.json, and re-watching starts. */
  const lost = () => {
    detach?.(); detach = null; watch = null;
    if (closed) return;
    log?.warn("supervisor configuration watch lost; reading config.json and re-watching", { revision });
    readFile();
    scheduleRetry();
  };
  /** Applies config.json (never written here); an unreadable or invalid file keeps what runs. */
  const readFile = () => {
    try { apply(readConfigFile(o.layout.configPath), null); }
    catch (err) { log?.warn("config.json unreadable; the running configuration stays", { err }); }
  };
  const scheduleRetry = () => {
    if (closed || retryTimer || watch) return;
    const delay = retryDelay; retryDelay = Math.min(backoff.max, retryDelay * 2);
    retryTimer = setTimeout(() => { retryTimer = null; void rewatch(false); }, delay);
    retryTimer.unref();
  };
  const tryWatch = async (attempts?: number): Promise<ConfigWatch | null> => {
    try {
      return await watchSupervisorConfig({ home: o.layout.home, ...(attempts !== undefined ? { attempts } : {}), ...(o.connectTimeoutMs !== undefined ? { connectTimeoutMs: o.connectTimeoutMs } : {}) });
    } catch {
      return null;
    }
  };
  /** One re-watch. On success the new watch is followed before the old one is closed (I1); on failure config.json is
   *  read (when no watch is live) and re-watching goes on with backoff. */
  const rewatch = (explicit: boolean): Promise<void> => {
    chain = chain.then(async () => {
      if (closed) return;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      const w = await tryWatch(1);
      if (closed) { await w?.close(); return; }
      if (w) {
        const old = watch;
        const from = revision;
        if (!follow(w)) { await w.close(); if (!watch) scheduleRetry(); return; }
        log?.info("configuration re-watched", { revision: w.revision, previousRevision: from });
        if (old && old !== w) await old.close().catch(() => {});
        return;
      }
      if (explicit) log?.warn("supervisor configuration re-watch failed", { live: watch !== null });
      if (!watch) { readFile(); scheduleRetry(); }
    });
    return chain;
  };

  let first: ConfigWatch | null = null;
  if (o.supervised) {
    first = await tryWatch(o.attempts);
    if (!first) log?.warn("supervisor configuration unavailable; reading config.json", {});
  }
  const snapshot = first ? accept(first.config, first.revision, "supervisor configuration") : null;
  if (first && !snapshot) { await first.close(); first = null; }
  current = snapshot ?? loadConfig(o.layout.configPath).config; // ConfigInvalid propagates: the core exits 2 (B18)
  builtWith = current;
  if (first) follow(first);
  else if (o.supervised) scheduleRetry(); // M1: a supervised core that missed the start window keeps trying

  return {
    current: () => current,
    get source() { return watch ? "supervisor" as const : "file" as const; },
    revision: () => revision,
    restartPending: () => pending,
    onChange(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    resubscribe: () => rewatch(true),
    set(changes) {
      if (!watch) return null;
      return watch.set(changes).then(() => undefined);
    },
    async close() {
      closed = true;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      detach?.(); detach = null;
      const w = watch; watch = null;
      await w?.close().catch(() => {});
    },
  };
}
