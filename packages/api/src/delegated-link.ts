import { WEB_EVENT_NAMES } from "./events-route.ts";
import { join } from "node:path";
import { connect, coreAddress, corePidPath, coreTokenPath, supervisorAddress, supervisorPidPath, supervisorTokenPath, readRecordedPid, readRunToken, type ApiDelegation, type ApiPrincipal, type ConnectOptions, type CoreClient } from "@plur1bus/module-api";
import type { CoreRpc } from "./core-rpc.ts";

/** Session-keyed authenticated connections preserve connection-bound notifications and cannot mix simultaneous callers. */
export function delegatedLink(home: string, o: { connect?: (o: ConnectOptions) => Promise<CoreClient>; readToken?: (home: string) => string; readPid?: (home: string) => number | undefined; readApiToken?: (home: string) => string } = {}): Required<Pick<CoreRpc, "callAs" | "subscribeAs">> & { close(): Promise<void> } {
  const peers = new Map<string, { pending: Promise<CoreClient>; delegation: ApiDelegation; touched: number; active: number; watchers: number; ready: boolean }>();
  let closed = false;
  const sweep = setInterval(() => {
    for (const [key, peer] of peers) if (peer.ready && peer.active === 0 && peer.watchers === 0 && Date.now() - peer.touched > 300_000) {
      peers.delete(key); void peer.pending.then(c => c.close()).catch(() => {});
    }
  }, 30_000); sweep.unref();
  async function get(principal: ApiPrincipal, endpoint: "core" | "supervisor", connectionKey = "default"): Promise<CoreClient> {
    if (closed) throw new Error("closed");
    const key = `${endpoint}:${principal.kind}:${principal.userId}:${connectionKey}`;
    let peer = peers.get(key);
    if (peer) { peer.delegation.principal = structuredClone(principal); peer.touched = Date.now(); return peer.pending; }
    if (peers.size >= 128) throw new Error("API peer limit");
    const api: ApiDelegation = { clientId: "harness-api", token: o.readApiToken?.(home) ?? readRunToken(home, join(home, "run", "api-delegation.token")), principal: structuredClone(principal) };
    const pid = endpoint === "core" && o.readPid ? o.readPid(home) : readRecordedPid(endpoint === "core" ? corePidPath(home) : supervisorPidPath(home));
    const pending = (o.connect ?? connect)({ address: endpoint === "core" ? coreAddress(home) : supervisorAddress(home), token: endpoint === "core" && o.readToken ? o.readToken(home) : readRunToken(home, endpoint === "core" ? coreTokenPath(home) : supervisorTokenPath(home)), api, endpoint, connectTimeoutMs: 1000, handshakeTimeoutMs: 1000, callTimeoutMs: 300_000, ...(pid ? { expectedServerPid: pid } : {}) });
    peer = { pending, delegation: api, touched: Date.now(), active: 0, watchers: 0, ready: false }; peers.set(key, peer);
    try {
      const c = await pending;
      if (closed) { await c.close(); throw new Error("closed"); }
      peer.ready = true;
      c.onClose(() => { if (peers.get(key)?.pending === pending) peers.delete(key); });
      return c;
    } catch (e) { if (peers.get(key)?.pending === pending) peers.delete(key); throw e; }
  }
  return {
    async callAs<T>(method: string, params: object, principal: ApiPrincipal, endpoint: "core" | "supervisor", connectionKey = "default") {
      const c = await get(principal, endpoint, connectionKey); const peer = peers.get(`${endpoint}:${principal.kind}:${principal.userId}:${connectionKey}`)!; peer.active++;
      try { return await c.call<T>(method, params); }
      catch (e) {
        if ((e as { error?: unknown })?.error === "E_UNAUTHORIZED") {
          peers.delete(`${endpoint}:${principal.kind}:${principal.userId}:${connectionKey}`); await c.close().catch(() => {});
        }
        throw e;
      } finally { peer.active--; peer.touched = Date.now(); }
    },
    async subscribeAs(principal, listener, closedStream, connectionKey = "default") {
      const c = await get(principal, "core", connectionKey);
      const peer = peers.get(`core:${principal.kind}:${principal.userId}:${connectionKey}`)!; peer.watchers++;
      const off = c.onNotification((m, p, delivery) => { if (delivery) listener(m, p, delivery); });
      const offClose = c.onClose(closedStream);
      let sub: { subscriptionId: string };
      try { sub = await c.call("events.subscribe", { names: [...WEB_EVENT_NAMES] }); }
      catch (e) { peer.watchers--; off(); offClose(); throw e; }
      let detached = false;
      return () => { if (detached) return; detached = true; peer.watchers--; peer.touched = Date.now(); off(); offClose(); void c.call("events.unsubscribe", sub).catch(() => {}); };
    },
    async close() { closed = true; clearInterval(sweep); const all = [...peers.values()]; peers.clear(); await Promise.allSettled(all.map(async p => (await p.pending).close())); },
  };
}
