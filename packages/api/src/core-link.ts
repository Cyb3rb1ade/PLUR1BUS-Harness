import { connect, coreAddress, corePidPath, coreTokenPath, readRecordedPid, readRunToken, type ConnectOptions, type CoreClient } from "@plur1bus/module-api";
import type { CoreRpc } from "./core-rpc.ts";

export interface CoreLinkOptions {
  /** Test seam; default module-api's `connect`. */
  connect?: (o: ConnectOptions) => Promise<CoreClient>;
  readToken?: (home: string) => string; readPid?: (home: string) => number | undefined;
  log?: { debug(msg: string, f?: Record<string, unknown>): void; info(msg: string, f?: Record<string, unknown>): void };
}

/** A `CoreRpc` over the core's local endpoint that connects on the first call, shares one connection between
 *  concurrent callers and connects again after the core went away (a core restart rewrites `run/core.token`, so the
 *  token is read afresh for every connection). A failed connect is the caller's error; there is no retry loop here,
 *  the next request simply tries again. */
export function createCoreLink(home: string, o: CoreLinkOptions = {}): CoreRpc & { close(): Promise<void> } {
  const doConnect = o.connect ?? connect;
  const readToken = o.readToken ?? ((h: string) => readRunToken(h, coreTokenPath(h)));
  const readPid = o.readPid ?? ((h: string) => readRecordedPid(corePidPath(h)));
  let client: CoreClient | undefined; let pending: Promise<CoreClient> | undefined; let closed = false;

  async function get(): Promise<CoreClient> {
    if (closed) throw new Error("the core link is closed");
    if (client) return client;
    pending ??= (async () => {
      const pid = readPid(home);
      const c = await doConnect({ address: coreAddress(home), token: readToken(home), endpoint: "core", connectTimeoutMs: 1000, ...(pid === undefined ? {} : { expectedServerPid: pid }) });
      c.onClose(() => { if (client === c) client = undefined; o.log?.info("core connection lost"); });
      client = c; o.log?.info("core connected", { instanceId: c.hello.instanceId });
      return c;
    })().finally(() => { pending = undefined; });
    return pending;
  }

  return {
    async call<T = unknown>(method: string, params?: object): Promise<T> { return (await get()).call<T>(method, params); },
    async close() { closed = true; const c = client; client = undefined; await c?.close(); },
  };
}
