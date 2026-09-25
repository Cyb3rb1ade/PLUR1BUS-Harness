import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { LineDecoder, LineTooLong, encodeLine } from "@plur1bus/module-api";
import { METHODS, validateParams, validateRequest, validateResult } from "@plur1bus/rpc-schema";
import type { HarnessLogger } from "../logger.ts";
import { RpcError } from "./errors.ts";

export const MAX_PENDING_BYTES = 16 * 1024 * 1024;

export interface CallContext { requestId: string; connectionId: string; signal: AbortSignal }
export type Handler = (params: any, ctx: CallContext) => Promise<unknown>;
export interface Subscription { id: string; connectionId: string; names?: string[]; agentId?: string }
export interface Hello { contract: string; rpc: string; instanceId: string; pid: number }
export interface RpcServer {
  listen(): Promise<void>; close(): Promise<void>;
  notify(method: string, params: object, filter?: (sub: Subscription) => boolean): void;
  subscriptions(): Subscription[];
}

interface Conn { id: string; sock: Socket; authed: boolean; dec: LineDecoder; inflight: Map<string | number, AbortController>; subs: Map<string, Subscription>; authTimer: NodeJS.Timeout | null }

export function createRpcServer(o: { address: string; token: string; hello: () => Hello; methods: Record<string, Handler>; logger: HarnessLogger; authIdleMs?: number }): RpcServer {
  const authIdleMs = o.authIdleMs ?? 30_000;
  const tokenBuf = Buffer.from(o.token, "utf8");
  const conns = new Map<string, Conn>();
  let server: Server | null = null;

  function writeToSocket(c: Conn, buf: Buffer): void {
    if (c.sock.destroyed) return;
    c.sock.write(buf);
    if (c.sock.writableLength > MAX_PENDING_BYTES) {
      o.logger.warn("client not reading, disconnecting", { connectionId: c.id, pending: c.sock.writableLength });
      c.sock.destroy();
    }
  }
  const send = (c: Conn, msg: unknown) => writeToSocket(c, encodeLine(msg));
  const errorReply = (c: Conn, id: unknown, e: RpcError) => send(c, { jsonrpc: "2.0", id: id ?? null, error: e.toJSON() });

  function tokenMatches(t: unknown): boolean {
    if (typeof t !== "string") return false;
    const b = Buffer.from(t, "utf8");
    return b.length === tokenBuf.length && timingSafeEqual(b, tokenBuf);
  }

  async function dispatch(c: Conn, msg: any): Promise<void> {
    const req = validateRequest(msg);
    if (!req.ok) return errorReply(c, msg?.id, new RpcError("E_INVALID_PARAMS", "invalid request", { reason: "invalid-request", detail: req.errors.join("; "), jsonrpcCode: -32600 }));
    const { id, method, params = {} } = msg;
    const log = o.logger.child({ requestId: String(id), connectionId: c.id, method });

    if (method === "core.auth") {
      const v = validateParams(method, params);
      if (!v.ok) { errorReply(c, id, new RpcError("E_INVALID_PARAMS", "invalid params", { detail: v.errors.join("; ") })); c.sock.destroy(); return; }
      if (!tokenMatches(params.token)) { errorReply(c, id, new RpcError("E_UNAUTHORIZED", "bad token", { reason: "bad-token" })); c.sock.destroy(); return; }
      c.authed = true;
      if (c.authTimer) { clearTimeout(c.authTimer); c.authTimer = null; }
      return send(c, { jsonrpc: "2.0", id, result: o.hello() });
    }
    if (!c.authed) return errorReply(c, id, new RpcError("E_UNAUTHORIZED", "authenticate first", { reason: "auth-required" }));

    if (method === "events.subscribe") {
      const v = validateParams(method, params); if (!v.ok) return errorReply(c, id, new RpcError("E_INVALID_PARAMS", "invalid params", { detail: v.errors.join("; ") }));
      const sub: Subscription = { id: randomUUID(), connectionId: c.id, ...(params.names ? { names: params.names } : {}), ...(params.agentId ? { agentId: params.agentId } : {}) };
      c.subs.set(sub.id, sub); return send(c, { jsonrpc: "2.0", id, result: { subscriptionId: sub.id } });
    }
    if (method === "events.unsubscribe") {
      const v = validateParams(method, params); if (!v.ok) return errorReply(c, id, new RpcError("E_INVALID_PARAMS", "invalid params", { detail: v.errors.join("; ") }));
      return send(c, { jsonrpc: "2.0", id, result: { removed: c.subs.delete(params.subscriptionId) } });
    }

    const handler = o.methods[method];
    if (!METHODS.includes(method) || !handler) return errorReply(c, id, new RpcError("E_INTERNAL", `method not found: ${method}`, { reason: "method-not-found", jsonrpcCode: -32601 }));
    const v = validateParams(method, params);
    if (!v.ok) return errorReply(c, id, new RpcError("E_INVALID_PARAMS", "invalid params", { detail: v.errors.join("; ") }));

    const ac = new AbortController(); c.inflight.set(id, ac);
    const t0 = performance.now();
    try {
      const result = await handler(params, { requestId: String(id), connectionId: c.id, signal: ac.signal });
      const rv = validateResult(method, result);
      if (!rv.ok) { log.error("result violates schema", { errors: rv.errors }); return errorReply(c, id, new RpcError("E_INTERNAL", "result violates schema", { reason: "result-schema" })); }
      send(c, { jsonrpc: "2.0", id, result });
      log.debug("ok", { ms: Math.round(performance.now() - t0) });
    } catch (e) {
      if (e instanceof RpcError) { log.info("rpc error", { error: e.error, reason: e.reason }); return errorReply(c, id, e); }
      log.error("handler failed", { err: e });
      errorReply(c, id, new RpcError("E_INTERNAL", "internal error", { reason: "handler-threw" }));
    } finally { c.inflight.delete(id); }
  }

  function onConnection(sock: Socket) {
    const c: Conn = { id: randomUUID(), sock, authed: false, dec: new LineDecoder(), inflight: new Map(), subs: new Map(), authTimer: null };
    conns.set(c.id, c);
    c.authTimer = setTimeout(() => { if (!c.authed) { o.logger.debug("auth idle timeout", { connectionId: c.id }); sock.destroy(); } }, authIdleMs);
    sock.on("data", (chunk) => {
      let msgs: unknown[];
      try { msgs = c.dec.push(chunk); }
      catch (e) {
        if (e instanceof LineTooLong) { errorReply(c, null, new RpcError("E_INVALID_PARAMS", e.message, { reason: "line-too-long" })); sock.destroy(); }
        else errorReply(c, null, new RpcError("E_INVALID_PARAMS", "parse error", { reason: "parse-error", jsonrpcCode: -32700 }));
        return;
      }
      for (const m of msgs) void dispatch(c, m);
    });
    sock.on("close", () => { if (c.authTimer) clearTimeout(c.authTimer); for (const ac of c.inflight.values()) ac.abort(new Error("connection closed")); conns.delete(c.id); });
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
    async close() {
      for (const c of conns.values()) c.sock.destroy();
      await new Promise<void>((res) => (server ? server.close(() => res()) : res()));
      if (process.platform !== "win32" && existsSync(o.address)) unlinkSync(o.address);
    },
    notify(method, params, filter) {
      const line = encodeLine({ jsonrpc: "2.0", method, params });
      for (const c of conns.values()) for (const sub of c.subs.values()) {
        if (sub.names && !sub.names.includes(method)) continue;
        if (sub.agentId && (params as any).agentId !== sub.agentId) continue;
        if (filter && !filter(sub)) continue;
        writeToSocket(c, line); break; // one delivery per connection
      }
    },
    subscriptions: () => [...conns.values()].flatMap((c) => [...c.subs.values()]),
  };
}
