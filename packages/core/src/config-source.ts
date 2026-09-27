import { restartPlan, validate, type HarnessConfig } from "@plur1bus/config-schema";
import { watchSupervisorConfig, type ConfigWatch } from "@plur1bus/module-api";
import { loadConfig } from "./config-load.ts";
import type { HarnessLogger } from "./logger.ts";
import type { Layout } from "./paths.ts";

type Plan = ReturnType<typeof restartPlan>;
type Log = Pick<HarnessLogger, "debug" | "info" | "warn" | "error">;

/** Where the core's configuration comes from (B7): the supervisor's `config.watch` (then every `config.changed`), or
 *  config.json read once when no supervisor answers. */
export interface ConfigSource {
  current(): HarnessConfig;
  readonly source: "supervisor" | "file";
  /** The supervisor's revision of `current()`; null for the file. */
  revision(): string | null;
  /** Whether `current()` differs from the configuration the core started with in a `core`-class key. */
  restartPending(): boolean;
  /** Called after each accepted change, with the restart plan from `prev` to `next`. */
  onChange(fn: (prev: HarnessConfig, next: HarnessConfig, plan: Plan) => void): () => void;
  /** `config.watch` again (a new supervisor adopted the core); the difference is applied like a change. Never rejects. */
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
  /** B7: `config.watch` attempts (default 3), each bounded by `connectTimeoutMs` (default 1000). */
  attempts?: number; connectTimeoutMs?: number;
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
  const listeners = new Set<(prev: HarnessConfig, next: HarnessConfig, plan: Plan) => void>();
  let watch: ConfigWatch | null = null; let unlisten: (() => void) | null = null;
  let current: HarnessConfig; let revision: string | null = null; let closed = false;

  /** A supervisor snapshot or push, or null (logged) when it fails the schema. */
  const accept = (config: Record<string, unknown>, rev: string, what: string): HarnessConfig | null => {
    const r = validate(config);
    if (r.ok) return r.config;
    log?.warn(`${what} is invalid; ignored`, { revision: rev, errors: r.errors });
    return null;
  };
  let builtWith: HarnessConfig; let pending = false; // recomputed per change, so core.status stays cheap (B11)
  const apply = (next: HarnessConfig, rev: string) => {
    const prev = current; current = next; revision = rev;
    pending = restartPlan(builtWith, next).restart.core;
    const plan = restartPlan(prev, next);
    if (plan.changed.length === 0) return;
    for (const fn of [...listeners]) {
      try { fn(prev, next, plan); } catch (err) { log?.error("config change listener failed", { err }); }
    }
  };
  const follow = (w: ConfigWatch) => {
    watch = w;
    unlisten = w.onChange((c) => {
      const next = accept(c.config, c.revision, "pushed configuration");
      if (next) apply(next, c.revision);
    });
  };
  const subscribe = async (): Promise<ConfigWatch | null> => {
    try {
      return await watchSupervisorConfig({ home: o.layout.home, ...(o.attempts !== undefined ? { attempts: o.attempts } : {}), ...(o.connectTimeoutMs !== undefined ? { connectTimeoutMs: o.connectTimeoutMs } : {}) });
    } catch (err) {
      log?.warn("supervisor configuration unavailable; reading config.json", { err });
      return null;
    }
  };

  let first: { w: ConfigWatch; config: HarnessConfig } | null = null;
  if (o.supervised) {
    const w = await subscribe();
    const config = w ? accept(w.config, w.revision, "supervisor configuration") : null;
    if (w && config) first = { w, config };
    else if (w) await w.close();
  }
  if (first) { current = first.config; revision = first.w.revision; follow(first.w); }
  else current = loadConfig(o.layout.configPath).config; // ConfigInvalid propagates: the core exits 2 (B18)
  builtWith = current;

  return {
    current: () => current,
    get source() { return watch ? "supervisor" as const : "file" as const; },
    revision: () => revision,
    restartPending: () => pending,
    onChange(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    async resubscribe() {
      if (closed) return;
      const w = await subscribe();
      const next = w ? accept(w.config, w.revision, "supervisor configuration") : null;
      if (!w || !next || closed) { await w?.close(); return; }
      const old = watch; unlisten?.(); watch = null;
      await old?.close().catch(() => {});
      follow(w);
      log?.info("configuration re-watched", { revision: w.revision, previousRevision: revision });
      apply(next, w.revision);
    },
    set(changes) {
      if (!watch) return null;
      return watch.set(changes).then(() => undefined);
    },
    async close() {
      closed = true; unlisten?.();
      const w = watch; watch = null;
      await w?.close().catch(() => {});
    },
  };
}
