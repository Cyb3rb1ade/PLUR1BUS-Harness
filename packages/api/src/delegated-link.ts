import { WEB_EVENT_NAMES } from "./events-route.ts";
import { join } from "node:path";
import { connect, coreAddress, corePidPath, coreTokenPath, supervisorAddress, supervisorPidPath, supervisorTokenPath, readRecordedPid, readRunToken, type ApiDelegation, type ApiPrincipal, type ConnectOptions, type CoreClient } from "@plur1bus/module-api";
import type { CoreRpc } from "./core-rpc.ts";
import { authorize } from "./rbac-bridge.ts";
import { validateNotification, validateParams, validateResult } from "@plur1bus/rpc-schema";

/** Session-keyed authenticated connections preserve connection-bound notifications and cannot mix simultaneous callers. */
export function delegatedLink(home: string, o: { connect?: (o: ConnectOptions) => Promise<CoreClient>; readToken?: (home: string) => string; readPid?: (home: string) => number | undefined; readApiToken?: (home: string) => string; now?: () => number } = {}): Required<Pick<CoreRpc, "callAs" | "subscribeAs" | "subscribeImportAs">> & { close(): Promise<void>; observeApiCredential(token: string): void } {
  const peers = new Map<string, { pending: Promise<CoreClient>; delegation: ApiDelegation; touched: number; active: number; watchers: number; ready: boolean }>();
  interface RunCredential { token: string; userId: string; principalKey: string; connectionKey: string; runId: string; expiresAt: number; peers: Set<string> }
  const runCredentials = new Map<string, RunCredential>(), now = o.now ?? Date.now;
  const runKey = (principal: ApiPrincipal, connection: string, runId: string) => JSON.stringify([principal.kind, principal.userId, connection, runId]);
  const principalKey = (principal: ApiPrincipal) => JSON.stringify([principal.kind, principal.role, principal.tokenScopes ? [...principal.tokenScopes].sort() : null]);
  function dropRun(key: string): void {
    const credential = runCredentials.get(key); if (!credential) return; runCredentials.delete(key);
    for (const peerKey of credential.peers) {
      const peer = peers.get(peerKey); if (!peer || peer.delegation.token !== credential.token) continue;
      peers.delete(peerKey); void peer.pending.then(client => client.close()).catch(() => {});
    }
  }
  function observeApiCredential(token: string): void {
    for (const [key, credential] of runCredentials) if (credential.token !== token) dropRun(key);
  }
  function liveCredential(): string {
    const token = o.readApiToken?.(home) ?? readRunToken(home, join(home, "run", "api-delegation.token"));
    observeApiCredential(token); return token;
  }
  function runCredential(principal: ApiPrincipal, connection: string, runId?: string): { key: string; value: RunCredential } | undefined {
    if (authorize(principal, "imports.manage", { kind: "system" }).effect !== "allow") return undefined;
    const matches = [...runCredentials].filter(([key, value]) => {
      if (value.expiresAt <= now()) { dropRun(key); return false; }
      return value.userId === principal.userId && value.connectionKey === connection && value.principalKey === principalKey(principal) && (runId === undefined || runId === value.runId);
    });
    return matches.length === 1 ? { key: matches[0]![0], value: matches[0]![1] } : undefined;
  }
  function rememberRun(principal: ApiPrincipal, connection: string, runId: string, token: string, peerKey: string): void {
    if (authorize(principal, "imports.manage", { kind: "system" }).effect !== "allow") return;
    try { if (liveCredential() !== token) return; } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return; }
    for (const [key, value] of runCredentials) if (value.expiresAt <= now()) dropRun(key);
    const key = runKey(principal, connection, runId), prior = runCredentials.get(key);
    if (prior) return; if (runCredentials.size >= 32) return;
    runCredentials.set(key, { token, userId: principal.userId, principalKey: principalKey(principal), connectionKey: connection, runId, expiresAt: now() + 4500000, peers: new Set([peerKey]) });
  }
  let closed = false;
  const sweep = setInterval(() => {
    for (const [key, credential] of runCredentials) if (credential.expiresAt <= now()) dropRun(key);
    for (const [key, peer] of peers) if (peer.ready && peer.active === 0 && peer.watchers === 0 && Date.now() - peer.touched > 300_000 && ![...runCredentials.values()].some(credential => credential.peers.has(key))) {
      peers.delete(key); void peer.pending.then(c => c.close()).catch(() => {});
    }
  }, 30_000); sweep.unref();
  async function getWithCredential(principal: ApiPrincipal, endpoint: "core" | "supervisor", currentToken: string, connectionKey = "default", transport?: ApiDelegation["transport"]): Promise<CoreClient> {
    if (closed) throw new Error("closed");
    const key = `${endpoint}:${principal.kind}:${principal.userId}:${connectionKey}${transport ? `:${transport}` : ""}`;
    let peer = peers.get(key);
    // Config writes can restart the Core while the supervisor socket stays open. Retire before sending, never replay a write.
    if (peer && peer.delegation.token !== currentToken) { peers.delete(key); void peer.pending.then(c => c.close()).catch(() => {}); peer = undefined; }
    if (peer) { peer.delegation.principal = structuredClone(principal); peer.touched = Date.now(); return peer.pending; }
    if (peers.size >= 128) throw new Error("API peer limit");
    const api: ApiDelegation = { clientId: "harness-api", token: currentToken, principal: structuredClone(principal), ...(transport ? { transport } : {}) };
    const pid = endpoint === "core" && o.readPid ? o.readPid(home) : readRecordedPid(endpoint === "core" ? corePidPath(home) : supervisorPidPath(home));
    const pending = (o.connect ?? connect)({ address: endpoint === "core" ? coreAddress(home) : supervisorAddress(home), token: endpoint === "core" && o.readToken ? o.readToken(home) : readRunToken(home, endpoint === "core" ? coreTokenPath(home) : supervisorTokenPath(home)), api, endpoint, connectTimeoutMs: 1000, handshakeTimeoutMs: 1000, callTimeoutMs: 300_000, ...(pid ? { expectedServerPid: pid } : {}) });
    peer = { pending, delegation: api, touched: Date.now(), active: 0, watchers: 0, ready: false }; peers.set(key, peer);
    try {
      const c = await pending;
      if (closed) { await c.close(); throw new Error("closed"); }
      peer.ready = true;
      c.onClose(() => {
        // A retired SSE connection may finish closing after another peer has reused this key.
        if (peers.get(key)?.pending !== pending) return;
        peers.delete(key);
        for (const [run, credential] of runCredentials) if (credential.peers.has(key)) dropRun(run);
      });
      return c;
    } catch (e) { if (peers.get(key)?.pending === pending) peers.delete(key); throw e; }
  }
  async function get(principal: ApiPrincipal, endpoint: "core" | "supervisor", connectionKey = "default", transport?: ApiDelegation["transport"]): Promise<CoreClient> {
    return getWithCredential(principal, endpoint, liveCredential(), connectionKey, transport);
  }
  async function getForRun(principal: ApiPrincipal, scope: string, connection: string, runId?: string): Promise<CoreClient> {
    const binding = runCredential(principal, connection, runId); let token: string;
    try { token = liveCredential(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" || !binding || runCredentials.get(binding.key) !== binding.value) throw error;
      token = binding.value.token;
    }
    const client = await getWithCredential(principal, "supervisor", token, scope);
    if (binding && runCredentials.get(binding.key) === binding.value && binding.value.token === token) binding.value.peers.add(`supervisor:${principal.kind}:${principal.userId}:${scope}`);
    return client;
  }
  function watchExtensions(principal: ApiPrincipal, listener: Parameters<NonNullable<CoreRpc["subscribeAs"]>>[1], closedStream: () => void, connectionKey: string): () => void {
    if (authorize(principal, "extensions.read", { kind: "system" }).effect !== "allow") return () => {};
    const scope = `${connectionKey}:extensions`, key = `supervisor:${principal.kind}:${principal.userId}:${scope}`;
    let detached = false, retry: NodeJS.Timeout | undefined, current: { client: CoreClient; peer: NonNullable<ReturnType<typeof peers.get>>; off(): void } | undefined;
    const attach = async (): Promise<void> => {
      let client: CoreClient | undefined, peer: NonNullable<ReturnType<typeof peers.get>> | undefined, off: (() => void) | undefined;
      try {
        client = await get(principal, "supervisor", scope);
        if (detached || closed) { await client.close(); return; }
        peer = peers.get(key)!; peer.watchers++;
        off = client.onNotification((method, params, delivery) => {
          if (!detached && method === "ext.changed") listener(method, params, delivery ?? { audience: [{ personId: principal.userId }], connectionId: scope });
        });
        await client.call("ext.watch", {});
        if (detached || closed) { off(); peer.watchers--; if (peers.get(key) === peer) peers.delete(key); await client.close(); return; }
        const offClose = client.onClose(() => { if (!detached) closedStream(); });
        current = { client, peer, off: () => { off!(); offClose(); } };
      } catch (error) {
        off?.(); if (peer) peer.watchers--;
        if (peer && peers.get(key) === peer) peers.delete(key);
        await client?.close().catch(() => {});
        if (detached || closed) return;
        if (["E_DENIED", "E_UNAUTHORIZED"].includes((error as { error?: string }).error ?? "")) { closedStream(); return; }
        // Core events remain useful while the supervisor restarts. Retry only this private extension feed.
        retry = setTimeout(() => { void attach(); }, 1000); retry.unref();
      }
    };
    void attach();
    return () => {
      if (detached) return; detached = true; clearTimeout(retry);
      if (current) { current.off(); current.peer.watchers--; if (peers.get(key) === current.peer) peers.delete(key); void current.client.close().catch(() => {}); }
    };
  }
  return {
    observeApiCredential,
    async subscribeImportAs(principal, runId, listener, closedStream, connectionKey = "default") {
      if (authorize(principal, "imports.manage", { kind: "system" }).effect !== "allow") throw new Error("import progress denied");
      const scope = `${connectionKey}:maintenance:${runId}`, key = `supervisor:${principal.kind}:${principal.userId}:${scope}`;
      const client = await getForRun(principal, scope, connectionKey, runId), peer = peers.get(key)!; peer.watchers++;
      const off = client.onNotification((method, params) => {
        if (method === "import.progress" && (params as { runId?: unknown } | null)?.runId === runId && Buffer.byteLength(JSON.stringify(params)) <= 4096 && validateNotification(method, params).ok) listener(params);
      });
      const offClose = client.onClose(closedStream);
      try { const result = await client.call<{run:{state:string}}>("admin.import.status", { runId }); if (["completed", "aborted", "failed"].includes(result.run.state)) { const held = runCredential(principal, connectionKey, runId); if (held) dropRun(held.key); } } // native status registers only this verified person/run/connection
      catch (error) { const held = runCredential(principal, connectionKey, runId); if (held && ["E_DENIED", "E_UNAUTHORIZED", "E_NOT_FOUND"].includes((error as {error?:string})?.error ?? "")) dropRun(held.key); peer.watchers--; off(); offClose(); if (peers.get(key) === peer) peers.delete(key); await client.close(); throw error; }
      let detached = false;
      return () => { if (detached) return; detached = true; peer.watchers--; off(); offClose(); const held = runCredential(principal, connectionKey, runId); held?.value.peers.delete(key); if (peers.get(key) === peer) peers.delete(key); void client.close().catch(() => {}); };
    },
    async callAs<T>(method: string, params: object, principal: ApiPrincipal, endpoint: "core" | "supervisor", connectionKey = "default", transport?: ApiDelegation["transport"]) {
      const key = `${endpoint}:${principal.kind}:${principal.userId}:${connectionKey}${transport ? `:${transport}` : ""}`;
      const maintenanceRead = endpoint === "supervisor" && ["admin.import.status", "admin.import.abort", "admin.import.runs"].includes(method) && validateParams(method, params).ok;
      const requestedRun = method === "admin.import.runs" ? undefined : (params as {runId?:string}).runId;
      const c = maintenanceRead ? await getForRun(principal, connectionKey, connectionKey, requestedRun) : await get(principal, endpoint, connectionKey, transport); const peer = peers.get(key)!; peer.active++;
      try {
        const result = await c.call<T>(method, params);
        if (endpoint === "supervisor" && ["admin.import.apply", "admin.import.rollback"].includes(method) && validateResult(method, result).ok) rememberRun(principal, connectionKey, (result as {runId:string}).runId, peer.delegation.token, key);
        if (method === "admin.import.status" && ["completed", "aborted", "failed"].includes((result as {run?:{state?:string}})?.run?.state ?? "")) { const held = runCredential(principal, connectionKey, requestedRun); if (held) dropRun(held.key); }
        return result;
      }
      catch (e) {
        if (maintenanceRead && ["E_DENIED", "E_UNAUTHORIZED", "E_NOT_FOUND"].includes((e as {error?:string})?.error ?? "")) { const held = runCredential(principal, connectionKey, requestedRun); if (held) dropRun(held.key); }
        if ((e as { error?: unknown })?.error === "E_UNAUTHORIZED") {
          peers.delete(key); await c.close().catch(() => {});
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
      try { sub = await c.call("events.subscribe", { names: [...WEB_EVENT_NAMES].filter(name => name !== "ext.changed") }); }
      catch (e) { peer.watchers--; off(); offClose(); throw e; }
      const offExtensions = watchExtensions(principal, listener, closedStream, connectionKey);
      let detached = false;
      return () => { if (detached) return; detached = true; offExtensions(); peer.watchers--; peer.touched = Date.now(); off(); offClose(); void c.call("events.unsubscribe", sub).catch(() => {}); };
    },
    async close() { closed = true; clearInterval(sweep); for (const key of runCredentials.keys()) dropRun(key); const all = [...peers.values()]; peers.clear(); await Promise.allSettled(all.map(async p => (await p.pending).close())); },
  };
}
