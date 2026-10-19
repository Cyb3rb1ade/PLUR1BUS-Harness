import { bindClientContext } from "./client-principal.ts";
import { bindApiPrincipal, verifyApiDelegation, type ApiPrincipal } from "./api-principal.ts";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { METHODS_BY_SERVER, buildCapabilities, validateParams, validateRequest, validateResult, type Deprecation, type RpcServerRole } from "@plur1bus/rpc-schema";
import { LineDecoder, encodeLine } from "./framing.ts";
import type { HarnessLogger } from "./logger.ts";
import { RpcError } from "./rpc-error.ts";

/** Per-client queued-write limit; clients exceeding it are disconnected. */
export const MAX_PENDING_BYTES = 16 * 1024 * 1024;
/** Bound notifications waiting for an asynchronous identity lookup, before bytes can be queued. */
export const MAX_PENDING_NOTIFICATIONS = 1024;

/** Context passed to each RPC handler invocation. */
export interface CallContext { requestId: string; connectionId: string; signal: AbortSignal }
/** Async handler for one RPC method; parameters have already passed schema validation. */
export type Handler = (params: any, ctx: CallContext) => Promise<unknown>;
/** One active event subscription registered by an authenticated connection. */
export interface Subscription { id: string; connectionId: string; names?: string[]; agentId?: string }
/** Result of waiting for selected method calls to finish. */
export interface DrainResult { drained: boolean; pending: number }
/** Optional notification delivery filters. */
export type AudienceTarget = string | { connectionId: string } | { personId: string } | { agentId: string };
export interface NotifyOptions { audience?: readonly AudienceTarget[]; optIn?: boolean }
/** Operations and diagnostics exposed by a running RPC server. */
export interface RpcServer {
  /** Starts listening at the configured local endpoint. */
  listen(): Promise<void>;
  /** Resolves once every dispatch of a listed method that started before the call has written its reply (success or
   *  error), or after `budgetMs` with `drained: false` and the number still pending. */
  drain(o: { methods: readonly string[]; budgetMs: number }): Promise<DrainResult>;
  /** Ends every socket (a queued reply is still flushed), destroys the ones still open after `graceMs` (default 1000),
   *  closes the listener and removes the POSIX socket file. Idempotent. */
  close(o?: { graceMs?: number }): Promise<void>;
  /** With an audience, sends only to matching connections/persons, RBAC-visible agent targets, or legacy agent-filtered subscriptions.
   *  Without an audience, sends a notification to every subscription it matches, at most once per connection. A subscription with `names`
   *  gets only those; `optIn` delivers only to subscriptions whose `names` include `method` (never to a no-names one).
   *  Typed agent targets reach unfiltered local owner subscriptions too; API delivery requires `canReadAgent`.
   *  A subscription with `agentId` needs that id in `audience` when one is given, otherwise `params.agentId === agentId`. */
  notify(method: string, params: object, opts?: NotifyOptions): void;
  subscriptions(): Subscription[];
  /** Deprecated methods/notifications used at least once since start (ADR-016 §5, S13), as `method:<name>`/
   *  `notification:<name>`, sorted; for `core.status.deprecationsUsed` and `1staid check`'s `api.deprecations`. */
  deprecationsUsed(): string[];
  /** Open client connections now (authenticated or not), for the metrics endpoint. */
  connectionCount(): number;
}

// ADR-016 §5 / G13: the schema's deprecated surface, computed once per serving role; each name is warned about once
// per process.
type DeprecatedSurface = Record<"method" | "notification", Map<string, Deprecation>>;
const deprecatedByRole = new Map<RpcServerRole, DeprecatedSurface>();
function deprecatedOf(role: RpcServerRole): DeprecatedSurface {
  let d = deprecatedByRole.get(role);
  if (!d) {
    const caps = buildCapabilities([], role);
    const pick = (entries: Record<string, { deprecated?: Deprecation }>) => new Map(Object.entries(entries).flatMap(([name, e]) => (e.deprecated ? [[name, e.deprecated] as const] : [])));
    d = { method: pick(caps.methods), notification: pick(caps.notifications) };
    deprecatedByRole.set(role, d);
  }
  return d;
}
const warnedDeprecated = new Set<string>();
function warnIfDeprecated(logger: HarnessLogger, role: RpcServerRole, kind: "method" | "notification", name: string): void {
  const d = deprecatedOf(role)[kind].get(name);
  const key = `${kind}:${name}`;
  if (!d || warnedDeprecated.has(key)) return;
  warnedDeprecated.add(key);
  logger.warn("deprecated surface used", { kind, name, since: d.since, removeAfter: d.removeAfter, replacement: d.replacement });
}

interface Dispatch { method: string; done: Promise<void>; settled: boolean }
interface Conn { clientToken?: string; api?: ApiPrincipal | null; id: string; sock: Socket; authed: boolean; dec: LineDecoder; inflight: Map<string | number, AbortController>; subs: Map<string, Subscription>; authTimer: NodeJS.Timeout | null; closing: boolean; notifications: Promise<void>; pendingNotifications: number }

/** Endpoint, handshake, handlers, and lifecycle hooks for {@link createRpcServer}. */
export interface RpcServerOptions {
  /** The role this process serves (default `core`): its handshake is `<server>.auth`, and only the methods whose
   *  `x-server` is `server` are dispatched (any other is method-not-found). */
  server?: RpcServerRole;
  /** Credential registered for harness-api; regular endpoint tokens cannot delegate. */
  apiToken?: string;
  /** Scoped IPC client token. Revalidated on every call (revocation/expiry/rights are live). */
  authorizeClient?: (token: string, method: string, params: unknown) => Promise<ApiPrincipal>;
  apiPrincipalOf?: (principal: ApiPrincipal) => ApiPrincipal | null | Promise<ApiPrincipal | null>;
  onApiAuthenticated?: (id: string, principal: ApiPrincipal | null) => void;
  apiPersonOfConnection?: (id: string, principal: ApiPrincipal) => Promise<string | null>;
  /** Current RBAC visibility, resolved by the owner of the agent registry; absent denies API agent events. */
  canReadAgent?: (ctx: CallContext, agentId: string) => boolean | Promise<boolean>;
  address: string; token: string;
  /** The handshake's result. */
  hello: () => object;
  /** Implementations for methods served by this process; each method is schema-checked. */
  methods: Record<string, Handler>; logger: HarnessLogger; authIdleMs?: number;
  /** Called once per connection after its socket has closed (an adopted lifeline, S4). */
  onConnectionClosed?: (connectionId: string) => void;
  /** Trusted identity lookup for person audiences. Missing or failed lookup denies delivery. Never request text. */
  personOfConnection?: (connectionId: string) => string | null | undefined | Promise<string | null | undefined>;
  /** Called once per authenticated, schema-known request after its reply (or error) was written: the method name
   *  and `"ok"` or the RPC error code. Never sees params or results (the metrics counters, D3). */
  onCall?: (method: string, result: string, ms: number) => void;
}

/** The NDJSON JSON-RPC server of every harness process that serves RPC (the core and each module, H3B-R12): the
 *  `<role>.auth` handshake against the process token (constant-time), the auth idle timeout, request and params
 *  validation against rpc.schema.json, result validation, the per-connection subscriptions, and a graceful close. */
export function createRpcServer(o: RpcServerOptions): RpcServer {
  const role: RpcServerRole = o.server ?? "core";
  const authMethod = `${role}.auth`;
  const served = new Set(METHODS_BY_SERVER[role]);
  const authIdleMs = o.authIdleMs ?? 30_000;
  const tokenBuf = Buffer.from(o.token, "utf8");
  const conns = new Map<string, Conn>();
  const dispatches = new Set<Dispatch>(); // handler calls whose reply is not written yet (drain() waits on these)
  let server: Server | null = null;
  let closing: Promise<void> | null = null;

  function writeToSocket(c: Conn, buf: Buffer): void {
    if (c.sock.destroyed || c.sock.writableEnded) return;
    c.sock.write(buf);
    if (c.sock.writableLength > MAX_PENDING_BYTES) {
      o.logger.warn("client not reading, disconnecting", { connectionId: c.id, pending: c.sock.writableLength });
      c.sock.destroy();
    }
  }
  const send = (c: Conn, msg: unknown) => writeToSocket(c, encodeLine(msg));
  const errorReply = (c: Conn, id: unknown, e: RpcError) => send(c, { jsonrpc: "2.0", id: id ?? null, error: e.toJSON() });
  /** Send a final error, then close. destroy() right after write() drops the pending reply on Windows named pipes. */
  function replyAndClose(c: Conn, id: unknown, e: RpcError): void {
    if (c.closing) return;
    errorReply(c, id, e);
    c.closing = true;
    c.sock.end();
    setTimeout(() => c.sock.destroy(), 1000).unref();
  }

  function tokenMatches(t: unknown): boolean {
    if (typeof t !== "string") return false;
    const b = Buffer.from(t, "utf8");
    return b.length === tokenBuf.length && timingSafeEqual(b, tokenBuf);
  }

  async function dispatch(c: Conn, msg: any): Promise<void> {
    let delegated: ApiPrincipal | null | undefined;
    const authDelegation = msg?.method === authMethod ? msg?.params?.api : undefined;
    if (c.clientToken !== undefined && (msg?.api !== undefined || msg?.params?.api !== undefined)) return errorReply(c, msg?.id, new RpcError("E_DENIED", "scoped clients cannot delegate"));
    const hasApi = msg && typeof msg === "object" && (Object.hasOwn(msg, "api") || authDelegation !== undefined);
    if (hasApi) {
      try { delegated = verifyApiDelegation(msg.api ?? authDelegation, o.apiToken); }
      catch (e) { return errorReply(c, msg?.id, e as RpcError); }
      msg = { ...msg }; delete msg.api;
    } else if (c.api !== undefined) return errorReply(c, msg?.id, new RpcError("E_UNAUTHORIZED", "API principal required", { reason: "api-principal-required" }));
    if (c.api !== undefined && (c.api?.userId !== delegated?.userId || c.api?.kind !== delegated?.kind))
      return errorReply(c, msg?.id, new RpcError("E_UNAUTHORIZED", "API connection identity cannot change", { reason: "api-identity-change" }));
    const req = validateRequest(msg);
    if (!req.ok) return errorReply(c, msg?.id, new RpcError("E_INVALID_PARAMS", "invalid request", { reason: "invalid-request", detail: req.errors.join("; "), jsonrpcCode: -32600 }));
    const { id, method, params = {} } = msg;
    const log = o.logger.child({ requestId: String(id), connectionId: c.id, method });

    if (method === authMethod) {
      if (c.clientToken !== undefined) { replyAndClose(c, id, new RpcError("E_DENIED", "scoped identity cannot change")); return; }
      const v = validateParams(method, params);
      if (!v.ok) { replyAndClose(c, id, new RpcError("E_INVALID_PARAMS", "invalid params", { detail: v.errors.join("; ") })); return; }
      if (!tokenMatches(params.token)) {
        if (hasApi || !o.authorizeClient || typeof params.token !== "string") { replyAndClose(c, id, new RpcError("E_UNAUTHORIZED", "bad token", { reason: "bad-token" })); return; }
        try { await o.authorizeClient(params.token, method, params); c.clientToken = params.token; }
        catch { replyAndClose(c, id, new RpcError("E_UNAUTHORIZED", "client not approved", { reason: "client-token" })); return; }
      } else if (c.clientToken !== undefined) { replyAndClose(c, id, new RpcError("E_DENIED", "scoped identity cannot change")); return; }
      c.authed = true;
      if (hasApi) { c.api = delegated ?? null; o.onApiAuthenticated?.(c.id, c.api); }
      if (c.authTimer) { clearTimeout(c.authTimer); c.authTimer = null; }
      let principal: ApiPrincipal | null = null;
      try { principal = hasApi && delegated ? await o.apiPrincipalOf?.(delegated) ?? null : null; }
      catch { return replyAndClose(c, id, new RpcError("E_UNAUTHORIZED", "API identity unavailable", { reason: "no-principal" })); }
      return send(c, { jsonrpc: "2.0", id, result: { ...o.hello(), ...(hasApi ? { apiPrincipal: principal } : {}) } });
    }
    if (!c.authed) return errorReply(c, id, new RpcError("E_UNAUTHORIZED", "authenticate first", { reason: "auth-required" }));
    if (hasApi && c.api === undefined) return errorReply(c, id, new RpcError("E_UNAUTHORIZED", "delegate at handshake", { reason: "api-handshake-required" }));
    if (hasApi) { c.api = delegated ?? null; o.onApiAuthenticated?.(c.id, c.api); }
    warnIfDeprecated(o.logger, role, "method", method);

    if (c.clientToken !== undefined && method.startsWith("events.")) return errorReply(c, id, new RpcError("E_DENIED", "scoped client subscriptions are unavailable"));
    if (method === "events.subscribe" && served.has(method)) {
      const v = validateParams(method, params); if (!v.ok) return errorReply(c, id, new RpcError("E_INVALID_PARAMS", "invalid params", { detail: v.errors.join("; ") }));
      const ctx: CallContext = { requestId: String(id), connectionId: c.id, signal: new AbortController().signal };
      if (c.api !== undefined) bindApiPrincipal(ctx, c.api);
      try {
        // The shared server owns subscriptions, but the process owns RBAC and audits.
        await o.methods["events.subscribe"]?.(params, ctx);
        if (params.agentId && !await canRead(c, params.agentId)) throw new RpcError("E_DENIED", "agent events denied", { reason: "object-right-required" });
      } catch (e) { return errorReply(c, id, e instanceof RpcError ? e : new RpcError("E_DENIED", "event subscription denied", { reason: "resolver-failed" })); }
      if (c.closing || conns.get(c.id) !== c) return;
      for (const name of new Set<string>(params.names ?? [])) warnIfDeprecated(o.logger, role, "notification", name);
      const sub: Subscription = { id: randomUUID(), connectionId: c.id, ...(params.names ? { names: params.names } : {}), ...(params.agentId ? { agentId: params.agentId } : {}) };
      c.subs.set(sub.id, sub); return send(c, { jsonrpc: "2.0", id, result: { subscriptionId: sub.id } });
    }
    if (method === "events.unsubscribe" && served.has(method)) {
      const v = validateParams(method, params); if (!v.ok) return errorReply(c, id, new RpcError("E_INVALID_PARAMS", "invalid params", { detail: v.errors.join("; ") }));
      return send(c, { jsonrpc: "2.0", id, result: { removed: c.subs.delete(params.subscriptionId) } });
    }

    const handler = o.methods[method];
    if (!served.has(method) || !handler) return errorReply(c, id, new RpcError("E_INTERNAL", `method not found: ${method}`, { reason: "method-not-found", jsonrpcCode: -32601 }));
    const v = validateParams(method, params);
    if (!v.ok) { try { o.onCall?.(method, "E_INVALID_PARAMS", 0); } catch { /* metrics only */ } return errorReply(c, id, new RpcError("E_INVALID_PARAMS", "invalid params", { detail: v.errors.join("; ") })); }

    const ac = new AbortController(); c.inflight.set(id, ac);
    let markWritten!: () => void;
    const d: Dispatch = { method, done: new Promise<void>((res) => { markWritten = res; }), settled: false };
    dispatches.add(d);
    const t0 = performance.now();
    let outcome = "E_INTERNAL";
    try {
      const ctx = { requestId: String(id), connectionId: c.id, signal: ac.signal };
      if (c.api !== undefined) bindApiPrincipal(ctx, delegated ?? null);
      if (c.clientToken !== undefined) { const principal = await o.authorizeClient!(c.clientToken, method, params); bindApiPrincipal(ctx, principal); bindClientContext(ctx); }
      const result = await handler(params, ctx);
      const rv = validateResult(method, result);
      if (!rv.ok) { log.error("result violates schema", { errors: rv.errors }); return errorReply(c, id, new RpcError("E_INTERNAL", "result violates schema", { reason: "result-schema" })); }
      send(c, { jsonrpc: "2.0", id, result });
      outcome = "ok";
      log.debug("ok", { ms: Math.round(performance.now() - t0) });
    } catch (e) {
      if (e instanceof RpcError) { outcome = e.error; log.info("rpc error", { error: e.error, reason: e.reason }); return errorReply(c, id, e); }
      log.error("handler failed", { reason: "handler-threw" });
      errorReply(c, id, new RpcError("E_INTERNAL", "internal error", { reason: "handler-threw" }));
    } finally {
      try { o.onCall?.(method, outcome, performance.now() - t0); } catch { /* a metrics hook never affects a reply */ }
      c.inflight.delete(id);
      d.settled = true; dispatches.delete(d); markWritten(); // the reply (result or error) has been written above
    }
  }

  async function canRead(c: Conn, agentId: string): Promise<boolean> {
    if (!o.canReadAgent) return c.api === undefined; // standalone local IPC remains owner-only
    const ctx: CallContext = { requestId: "event-audience", connectionId: c.id, signal: new AbortController().signal };
    if (c.api !== undefined) bindApiPrincipal(ctx, c.api);
    try { return await o.canReadAgent(ctx, agentId); } catch { return false; }
  }

  function onConnection(sock: Socket) {
    const c: Conn = { id: randomUUID(), sock, authed: false, dec: new LineDecoder(), inflight: new Map(), subs: new Map(), authTimer: null, closing: false, notifications: Promise.resolve(), pendingNotifications: 0 };
    conns.set(c.id, c);
    c.authTimer = setTimeout(() => { if (!c.authed) { o.logger.debug("auth idle timeout", { connectionId: c.id }); sock.destroy(); } }, authIdleMs);
    sock.on("data", (chunk) => {
      if (c.closing) return;
      // Each line is parsed on its own: the valid requests of this chunk are served, only the broken line gets the
      // parse error (a valid request next to a garbled one used to be dropped and its client waited for a timeout).
      const { values, bad, tooLong } = c.dec.decode(chunk);
      for (const m of values) void dispatch(c, m);
      for (let i = 0; i < bad.length; i++) errorReply(c, null, new RpcError("E_INVALID_PARAMS", "parse error", { reason: "parse-error", jsonrpcCode: -32700 }));
      if (tooLong) replyAndClose(c, null, new RpcError("E_INVALID_PARAMS", tooLong.message, { reason: "line-too-long" }));
    });
    sock.on("close", () => {
      if (c.authTimer) clearTimeout(c.authTimer);
      for (const ac of c.inflight.values()) ac.abort(new Error("connection closed"));
      conns.delete(c.id);
      try { o.onConnectionClosed?.(c.id); } catch (err) { o.logger.error("onConnectionClosed failed", { connectionId: c.id, err }); }
    });
    sock.on("error", (e) => o.logger.debug("socket error", { connectionId: c.id, err: e }));
  }

  return {
    async listen() {
      if (process.platform !== "win32") {
        mkdirSync(dirname(o.address), { recursive: true, mode: 0o700 }); chmodSync(dirname(o.address), 0o700);
        if (existsSync(o.address)) {
          // A socket file may be stale (SIGKILLed core) or live (another server). Only a stale one is removed.
          const alive = await new Promise<boolean>((res) => { const s = createConnection(o.address); s.once("connect", () => { s.destroy(); res(true); }); s.once("error", () => res(false)); });
          if (alive) throw new Error(`address in use: ${o.address}`);
          unlinkSync(o.address);
        }
      }
      server = createServer(onConnection);
      await new Promise<void>((res, rej) => { server!.once("error", rej); server!.listen(o.address, () => { server!.off("error", rej); res(); }); });
      if (process.platform !== "win32") chmodSync(o.address, 0o600);
      o.logger.info("rpc listening", { address: o.address });
    },
    async drain({ methods, budgetMs }) {
      const waiting = [...dispatches].filter((d) => methods.includes(d.method));
      if (waiting.length === 0) return { drained: true, pending: 0 };
      let timer: NodeJS.Timeout | undefined;
      // Not unref'ed: a stop() awaiting the drain must keep the process alive for the budget it granted.
      const expired = new Promise<false>((res) => { timer = setTimeout(() => res(false), Math.max(0, budgetMs)); });
      const drained = await Promise.race([Promise.all(waiting.map((d) => d.done)).then(() => true as const), expired]);
      clearTimeout(timer);
      return { drained, pending: waiting.filter((d) => !d.settled).length };
    },
    close({ graceMs = 1000 } = {}) {
      if (closing) return closing;
      closing = (async () => {
        const listener = server; server = null;
        // Stop accepting first; the callback fires once every connection below has closed.
        const listenerClosed = new Promise<void>((res) => (listener ? listener.close(() => res()) : res()));
        // end(), never destroy() right away: destroy() drops a reply still queued for the socket (always on Windows
        // named pipes, and anywhere for a reply larger than the socket buffer). A peer that never closes its side is
        // destroyed after the grace period.
        for (const c of conns.values()) {
          c.closing = true;
          if (c.authTimer) { clearTimeout(c.authTimer); c.authTimer = null; }
          c.sock.end();
          setTimeout(() => c.sock.destroy(), graceMs).unref();
        }
        await listenerClosed;
        if (process.platform !== "win32" && existsSync(o.address)) unlinkSync(o.address);
      })();
      return closing;
    },
    notify(method, params, opts = {}) {

      // Capture the audience before asynchronous identity lookup; a caller cannot widen it later.
      const audience = opts.audience?.map(target => typeof target === "string" ? target : { ...target });
      for (const c of conns.values()) {
        if (!c.authed || c.closing || audience?.length === 0) continue;
        const eligible = [...c.subs.values()].filter(sub => opts.optIn ? sub.names?.includes(method) : !sub.names || sub.names.includes(method));
        if (!eligible.length) continue;
        if (c.pendingNotifications >= MAX_PENDING_NOTIFICATIONS) { c.sock.destroy(); continue; }
        c.pendingNotifications++;
        // Serialise identity/rights lookups per connection to preserve generation order.
        c.notifications = c.notifications.then(async () => {
          if (!c.authed || c.closing || conns.get(c.id) !== c) return;
          const serviceNotice = c.api === null && method === "api.account.changed" && audience?.some(t => typeof t === "object" && "connectionId" in t && t.connectionId === c.id);
          let personId: string | null | undefined;
          if (!serviceNotice && (c.api !== undefined || audience?.some(t => typeof t === "object" && "personId" in t))) {
            personId = c.api !== undefined ? (c.api ? await o.apiPersonOfConnection?.(c.id, c.api) : null) : await o.personOfConnection?.(c.id);
            if (c.api !== undefined && !personId) return;
          }
          const agentTargets = audience?.flatMap(t => typeof t === "object" && "agentId" in t ? [t.agentId] : []) ?? [];
          const visible = new Set<string>();
          for (const agentId of agentTargets) if (await canRead(c, agentId)) visible.add(agentId);
          // Even a legacy emission without explicit audience cannot bypass current agent rights.
          const paramAgent = (params as { agentId?: unknown }).agentId;
          if (typeof paramAgent === "string" && !agentTargets.length && !await canRead(c, paramAgent)) return;
          if (!c.authed || c.closing || conns.get(c.id) !== c) return;
          for (const sub of eligible) {
            if (c.subs.get(sub.id) !== sub) continue;
            if (audience !== undefined) {
              const matches = audience.some(target => typeof target === "string"
                ? target === c.id || (sub.agentId !== undefined && target === sub.agentId)
                : "connectionId" in target ? target.connectionId === c.id
                : "agentId" in target ? visible.has(target.agentId) && (!sub.agentId || sub.agentId === target.agentId)
                : personId !== null && personId !== undefined && target.personId === personId);
              if (!matches) continue;
              if (sub.agentId && !(audience.some(t => typeof t === "string" ? t === sub.agentId : "agentId" in t && t.agentId === sub.agentId)
                || paramAgent === sub.agentId)) continue;
            } else if (c.api !== undefined && method !== "core.state") continue;
            else if (sub.agentId && paramAgent !== sub.agentId) continue;
            const line = encodeLine({ jsonrpc: "2.0", method, params,
              ...(c.api !== undefined ? { audience: audience ?? null, connectionId: c.id } : {}) });
            writeToSocket(c, line); break;
          }
        }).catch(() => {}).finally(() => { c.pendingNotifications--; }); // failed lookup denies this event, never subsequent events

      }
    },
    subscriptions: () => [...conns.values()].flatMap((c) => [...c.subs.values()]),
    deprecationsUsed: () => [...warnedDeprecated].sort(),
    connectionCount: () => conns.size,
  };
}
