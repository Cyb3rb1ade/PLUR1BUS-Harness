import { join } from "node:path";
import { delegatedLink } from "./delegated-link.ts";
import { connect, coreAddress, corePidPath, coreTokenPath, readRecordedPid, readRunToken, type ConnectOptions, type CoreClient } from "@plur1bus/module-api";
import type { CoreRpc } from "./core-rpc.ts";

export interface CoreLinkOptions {
  /** Test seam; default module-api's `connect`. */
  connect?: (o: ConnectOptions) => Promise<CoreClient>;
  readApiToken?: (home: string) => string;
  readToken?: (home: string) => string; readPid?: (home: string) => number | undefined;
  log?: { debug(msg: string, f?: Record<string, unknown>): void; info(msg: string, f?: Record<string, unknown>): void };
}

/** A `CoreRpc` over the core's local endpoint that connects on the first call, shares one connection between
 *  concurrent callers and connects again after the core went away (a core restart rewrites `run/core.token`, so the
 *  token is read afresh for every connection). A failed connect is the caller's error; there is no retry loop here,
 *  the next request simply tries again. */
export function createCoreLink(home: string, o: CoreLinkOptions = {}): CoreRpc & { close(): Promise<void>; subscribePeople(listener: (id: string) => void): () => void } {
  const delegated = delegatedLink(home, o);
  const doConnect = o.connect ?? connect;
  const readToken = o.readToken ?? ((h: string) => readRunToken(h, coreTokenPath(h)));
  const readPid = o.readPid ?? ((h: string) => readRecordedPid(corePidPath(h)));
  let service: CoreClient | undefined; let servicePending: Promise<CoreClient> | undefined; let serviceToken: string | undefined; const peopleListeners = new Set<(id: string) => void>();
  let client: CoreClient | undefined; let pending: Promise<CoreClient> | undefined; let closed = false;

  async function get(): Promise<CoreClient> {
    if (closed) throw new Error("the core link is closed");
    if (client) return client;
    pending ??= (async () => {
      const pid = readPid(home);
      const c = await doConnect({ address: coreAddress(home), token: readToken(home), endpoint: "core", connectTimeoutMs: 1000, ...(pid === undefined ? {} : { expectedServerPid: pid }) });
      // `close()` came while this connection was being made: it must not outlive the link, nor serve the call that raced it.
      if (closed) { await c.close().catch(() => {}); throw new Error("the core link is closed"); }
      c.onClose(() => { if (client === c) client = undefined; o.log?.info("core connection lost"); });
      client = c; o.log?.info("core connected", { instanceId: c.hello.instanceId });
      return c;
    })().finally(() => { pending = undefined; });
    return pending;
  }

  async function getService(): Promise<CoreClient> {
    if (closed) throw new Error("closed");
    const token = o.readApiToken?.(home) ?? readRunToken(home, join(home, "run", "api-delegation.token"));
    if (service && serviceToken !== token) { const previous = service; service = undefined; await previous.close(); }
    if (service) return service;
    servicePending ??= (async () => {
      const pid = readPid(home);
      const c = await doConnect({ address: coreAddress(home), token: readToken(home), endpoint: "core", api: { clientId: "harness-api", token }, connectTimeoutMs: 1000, handshakeTimeoutMs: 1000, ...(pid ? { expectedServerPid: pid } : {}) });
      if (closed) { await c.close(); throw new Error("closed"); }
      c.onNotification((name, params) => { if (name === "api.account.changed" && typeof (params as { userId?: unknown })?.userId === "string") for (const listener of peopleListeners) listener((params as { userId: string }).userId); });
      c.onClose(() => { if (service === c) service = undefined; });
      await c.call("events.subscribe", { names: ["api.account.changed"] }); service = c; serviceToken = token; return c;
    })().finally(() => { servicePending = undefined; });
    return servicePending;
  }
  return {
    subscribePeople(listener: (id: string) => void) { peopleListeners.add(listener); void getService().catch(() => {}); return () => { peopleListeners.delete(listener); }; },
    async serviceCall<T>(method: string, params: object = {}) {
      if (!new Set(["admin.api.person.resolve", "admin.api.invite.validate", "user.invite.redeem"]).has(method)) throw new Error("API service operation refused");
      return (await getService()).call<T>(method, params);
    },
    callAs: delegated.callAs, subscribeAs: delegated.subscribeAs,
    async call<T = unknown>(method: string, params?: object): Promise<T> { return (await get()).call<T>(method, params); },
    async close() { closed = true; const c = client; client = undefined; await c?.close(); await service?.close(); await delegated.close(); },
  };
}
