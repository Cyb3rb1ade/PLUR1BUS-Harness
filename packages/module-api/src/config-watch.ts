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
  /** The latest configuration: the `config.watch` snapshot, then each `config.changed` (also those that arrived
   *  before a listener was registered). */
  readonly config: Record<string, unknown>;
  readonly revision: string;
  onChange(fn: (c: ConfigChanged) => void): () => void;
  /** Called once when the subscription's connection ends (the supervisor died, dropped it, or close() was called). */
  onClose(fn: () => void): () => void;
  /** `config.set { changes }` on the same connection; resolves with its result. */
  set(changes: { key: string; value: unknown }[]): Promise<unknown>;
  close(): Promise<void>;
}

/** How long a `config.set` may take: it waits for a requested restart (stop budget plus ready timeout). */
const SET_TIMEOUT_MS = 120_000;

type WatchResult = { subscriptionId: string; config: Record<string, unknown>; revision: string };

/** One attempt: read the token (the supervisor may have rotated it), connect, authenticate, `config.watch`. The whole
 *  attempt is bounded by `timeoutMs`; a connection that answers after that is closed. Every `config.changed` is
 *  buffered from before the `config.watch` call on (I1): one that arrives right behind the reply, in the same read,
 *  is dispatched before any caller could register a listener. */
async function attempt(home: string, timeoutMs: number): Promise<ConfigWatch> {
  const token = readFileSync(supervisorTokenPath(home), "utf8").trim();
  let timer: NodeJS.Timeout | undefined;
  let late = false;
  const work = (async () => {
    const client = await connect({ address: supervisorAddress(home), token, endpoint: "supervisor", connectTimeoutMs: timeoutMs, callTimeoutMs: SET_TIMEOUT_MS });
    if (late) { await client.close(); throw new Error("config.watch answered too late"); }
    const buffered: ConfigChanged[] = [];
    const stopBuffering = client.onNotification((method, params) => { if (method === "config.changed") buffered.push(params as ConfigChanged); });
    try {
      const result = await client.call<WatchResult>("config.watch", {});
      if (late) throw new Error("config.watch answered too late");
      return subscription(client, result, buffered, stopBuffering);
    } catch (e) { stopBuffering(); await client.close(); throw e; }
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
      return await attempt(o.home, timeoutMs);
    } catch (e) {
      last = e;
      const left = timeoutMs - (performance.now() - t0);
      if (i + 1 < attempts && left > 0) await new Promise((r) => setTimeout(r, left));
    }
  }
  throw last;
}

/** The pushes of `buffered` that follow the snapshot `revision`: from the one whose `previousRevision` is it on, or
 *  (when none links to it) every one that is not the snapshot itself. The reply is queued before any notification on
 *  the connection, so a buffered push is never older than the snapshot. */
function after(buffered: ConfigChanged[], revision: string): ConfigChanged[] {
  const i = buffered.findIndex((c) => c.previousRevision === revision);
  return i >= 0 ? buffered.slice(i) : buffered.filter((c) => c.revision !== revision);
}

function subscription(client: CoreClient, first: WatchResult, buffered: ConfigChanged[], stopBuffering: () => void): ConfigWatch {
  let config = first.config; let revision = first.revision;
  const listeners = new Set<(c: ConfigChanged) => void>();
  const take = (c: ConfigChanged) => {
    config = c.config; revision = c.revision;
    for (const fn of [...listeners]) { try { fn(c); } catch { /* a listener never breaks the others */ } }
  };
  client.onNotification((method, params) => { if (method === "config.changed") take(params as ConfigChanged); });
  stopBuffering();
  for (const c of after(buffered, first.revision)) take(c); // no listener yet: they only advance config/revision
  return {
    get config() { return config; },
    get revision() { return revision; },
    onChange(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    onClose: (fn) => client.onClose(fn),
    set: (changes) => client.call("config.set", { changes }),
    close: () => client.close(),
  };
}
