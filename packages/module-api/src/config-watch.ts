import { readFileSync } from "node:fs";
import { connect, type CoreClient } from "./client.ts";
import { supervisorAddress, supervisorTokenPath } from "./paths.ts";

/** `config.changed` params (rpc.schema.json `$defs/notifications/config.changed`). */
export interface ConfigChanged {
  revision: string; previousRevision: string | null; changed: string[];
  restart: { live: string[]; core: boolean; modules: string[] };
  config: Record<string, unknown>; source: "set" | "file";
}

/** A `config.watch` subscription on the supervisor (spec §6.1, B7), shared by the core and by module processes. */
export interface ConfigWatch {
  /** The latest configuration: the `config.watch` snapshot, then each `config.changed`. */
  readonly config: Record<string, unknown>;
  readonly revision: string;
  onChange(fn: (c: ConfigChanged) => void): () => void;
  /** `config.set { changes }` on the same connection; resolves with its result. */
  set(changes: { key: string; value: unknown }[]): Promise<unknown>;
  close(): Promise<void>;
}

/** How long a `config.set` may take: it waits for a requested restart (stop budget plus ready timeout). */
const SET_TIMEOUT_MS = 120_000;

/** One attempt: read the token (the supervisor may have rotated it), connect, authenticate, `config.watch`. The whole
 *  attempt is bounded by `timeoutMs`; a connection that answers after that is closed. */
async function attempt(home: string, timeoutMs: number): Promise<{ client: CoreClient; result: { subscriptionId: string; config: Record<string, unknown>; revision: string } }> {
  const token = readFileSync(supervisorTokenPath(home), "utf8").trim();
  let timer: NodeJS.Timeout | undefined;
  let late = false;
  const work = (async () => {
    const client = await connect({ address: supervisorAddress(home), token, endpoint: "supervisor", connectTimeoutMs: timeoutMs, callTimeoutMs: SET_TIMEOUT_MS });
    if (late) { await client.close(); throw new Error("config.watch answered too late"); }
    try {
      const result = await client.call<{ subscriptionId: string; config: Record<string, unknown>; revision: string }>("config.watch", {});
      if (late) throw new Error("config.watch answered too late");
      return { client, result };
    } catch (e) { await client.close(); throw e; }
  })();
  try {
    return await Promise.race([work, new Promise<never>((_, rej) => { timer = setTimeout(() => { late = true; rej(new Error(`config.watch timed out after ${timeoutMs} ms`)); }, timeoutMs); })]);
  } finally { clearTimeout(timer); work.catch(() => {}); }
}

/** Subscribes to the supervisor's configuration (B7): `attempts` tries (default 3), each bounded by `connectTimeoutMs`
 *  (default 1000) and spaced so every attempt takes that long at least; rejects with the last error. */
export async function watchSupervisorConfig(o: { home: string; connectTimeoutMs?: number; attempts?: number }): Promise<ConfigWatch> {
  const timeoutMs = o.connectTimeoutMs ?? 1000;
  const attempts = Math.max(1, o.attempts ?? 3);
  let last: unknown = new Error("no attempt made");
  for (let i = 0; i < attempts; i++) {
    const t0 = performance.now();
    try {
      const { client, result } = await attempt(o.home, timeoutMs);
      return subscription(client, result);
    } catch (e) {
      last = e;
      const left = timeoutMs - (performance.now() - t0);
      if (i + 1 < attempts && left > 0) await new Promise((r) => setTimeout(r, left));
    }
  }
  throw last;
}

function subscription(client: CoreClient, first: { config: Record<string, unknown>; revision: string }): ConfigWatch {
  let config = first.config; let revision = first.revision;
  const listeners = new Set<(c: ConfigChanged) => void>();
  client.onNotification((method, params) => {
    if (method !== "config.changed") return;
    const c = params as ConfigChanged;
    config = c.config; revision = c.revision;
    for (const fn of [...listeners]) fn(c);
  });
  return {
    get config() { return config; },
    get revision() { return revision; },
    onChange(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    set: (changes) => client.call("config.set", { changes }),
    close: () => client.close(),
  };
}
