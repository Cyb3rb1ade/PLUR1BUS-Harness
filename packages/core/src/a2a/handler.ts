// The transport-neutral A2A endpoint: `GET /a2a/<agent>/.well-known/agent-card.json` and `POST /a2a/<agent>/` (JSON-RPC 2.0:
// `message/send`, `tasks/get`, `tasks/cancel`). Inbound only; no outbound call exists here. Order of checks, all fail closed:
// route -> address rate -> authentication -> peer rate -> agent+action authorisation -> size/type -> parse -> method.
import type { AuditSink } from "../rbac/audit.ts";
import type { ChatProvider } from "../session/provider.ts";
import { buildAgentCard } from "./card.ts";
import { authorizePeer, resolvePeer, validAgentId, validatePeers, type A2aPeer } from "./policy.ts";
import { Buckets, type RateClock } from "./rate.ts";
import { TaskError, TaskStore, type Scheduler } from "./tasks.ts";
import { DEFAULT_LIMITS, RPC, type A2aAction, type A2aAgentSource, type A2aLimits, type A2aPeerConfig } from "./types.ts";

export class BodyTooLarge extends Error { constructor() { super("body too large"); this.name = "BodyTooLarge"; } }

export interface A2aHttpRequest {
  method: string;
  /** Origin-form path without the query string. */
  path: string;
  /** Lower-case header names. */
  headers: Readonly<Record<string, string | undefined>>;
  remote: string;
  /** Reads the body, rejecting with `BodyTooLarge` once it passes `limit` bytes. Called only after authentication. */
  readBody(limit: number): Promise<Buffer>;
}
export interface A2aHttpResponse { status: number; headers: Record<string, string>; body: string }

export interface A2aHandlerOptions {
  peers: readonly A2aPeerConfig[];
  agents: A2aAgentSource;
  /** Base URL peers reach this server under (the card's `url`). Loopback only in A2A1. */
  advertisedBaseUrl: string;
  provider: () => ChatProvider | null;
  clock?: RateClock; scheduler?: Scheduler; audit?: AuditSink; version?: string;
  limits?: Partial<A2aLimits>;
}
export interface A2aHandler { handle(req: A2aHttpRequest): Promise<A2aHttpResponse>; readonly limits: A2aLimits; readonly tasks: TaskStore }

const METHOD_ACTION: Readonly<Record<string, A2aAction>> = { "message/send": "task.send", "tasks/get": "task.read", "tasks/cancel": "task.cancel" };
const SECURITY_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const ROUTE = /^\/a2a\/([^/]+)\/(\.well-known\/agent-card\.json)?$/;

const http = (status: number, body: unknown, extra: Record<string, string> = {}): A2aHttpResponse => ({ status, headers: { ...SECURITY_HEADERS, ...extra }, body: JSON.stringify(body) });
const httpError = (status: number, reason: string, extra: Record<string, string> = {}): A2aHttpResponse => http(status, { error: reason }, extra);
const rpcOk = (id: unknown, result: unknown): A2aHttpResponse => http(200, { jsonrpc: "2.0", id, result });
const rpcErr = (id: unknown, code: number, message: string, reason?: string): A2aHttpResponse =>
  http(200, { jsonrpc: "2.0", id, error: { code, message, ...(reason ? { data: { reason } } : {}) } });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const ID_LIMIT = 128;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const safeId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= ID_LIMIT && !CONTROL.test(v);

export function createA2aHandler(o: A2aHandlerOptions): A2aHandler {
  validatePeers(o.peers);
  const limits: A2aLimits = { ...DEFAULT_LIMITS, ...o.limits };
  const clock: RateClock = o.clock ?? { now: () => Date.now() };
  const peerRate = new Buckets(limits.peerRatePerMinute, clock);
  const addrRate = new Buckets(limits.addressRatePerMinute, clock);
  const failRate = new Buckets(limits.failedAuthPerMinute, clock);
  const version = o.version ?? "0.1.0";
  const audit = (action: string, user: string, target: string, detail: Record<string, unknown>): void => {
    try { o.audit?.append({ at: clock.now(), actor: { user, host: "a2a" }, action, target, detail }); } catch { /* the refusal stands */ }
  };
  const tasks = new TaskStore({
    provider: o.provider, clock: () => clock.now(), ...(o.scheduler ? { scheduler: o.scheduler } : {}),
    maxLivePerPeer: limits.maxLiveTasksPerPeer, maxStored: limits.maxStoredTasks, retentionMs: limits.retentionMs,
    replyTimeoutMs: limits.replyTimeoutMs, maxHistory: limits.maxHistoryLength,
    onEvent: (e) => audit(`a2a.task.${e.type}`, `a2a-peer:${e.peerId}`, e.taskId, { agent: e.agentId, state: e.state }),
  });

  async function handle(req: A2aHttpRequest): Promise<A2aHttpResponse> {
    const m = ROUTE.exec(req.path);
    // RULING: there is no root `/.well-known/agent-card.json`: a card exists per agent, under its own base path.
    if (!m || !validAgentId(m[1]!)) return httpError(404, "not-found");
    const agentId = m[1]!; const isCard = m[2] !== undefined;
    if (isCard ? req.method !== "GET" : req.method !== "POST") return httpError(405, "method-not-allowed", { Allow: isCard ? "GET" : "POST" });

    const ar = addrRate.take(req.remote);
    if (!ar.ok) { audit("a2a.rate-limited", "anonymous", req.path, { scope: "address" }); return httpError(429, "rate-limited", { "Retry-After": String(ar.retryAfterSec) }); }

    // Authentication. A remote that keeps failing is refused before any key is compared (brute-force guard).
    if (!failRate.has(req.remote)) { audit("a2a.rate-limited", "anonymous", req.path, { scope: "failed-auth" }); return httpError(429, "rate-limited", { "Retry-After": "60" }); }
    const auth = req.headers.authorization;
    const bearer = auth !== undefined && /^Bearer [\x21-\x7e]{1,512}$/.test(auth) ? auth.slice(7) : undefined;
    const peer: A2aPeer | undefined = bearer === undefined ? undefined : resolvePeer(o.peers, bearer);
    if (!peer) {
      failRate.take(req.remote);
      audit("a2a.unauthenticated", "anonymous", req.path, { reason: bearer === undefined ? "no-credential" : "bad-credential" });
      return httpError(401, "unauthenticated", { "WWW-Authenticate": "Bearer" });
    }
    const user = `a2a-peer:${peer.peerId}`;
    const pr = peerRate.take(peer.peerId);
    if (!pr.ok) { audit("a2a.rate-limited", user, req.path, { scope: "peer" }); return httpError(429, "rate-limited", { "Retry-After": String(pr.retryAfterSec) }); }

    const info = o.agents(agentId);
    // The authoritative check for the route: the agent must be exposed and granted to this peer, or it does not exist for it.
    const gate = (action: A2aAction): A2aHttpResponse | undefined => {
      const d = authorizePeer(o.peers, peer, action, agentId, info);
      if (d.effect === "allow") return undefined;
      audit("a2a.denied", user, agentId, { action, reason: d.reason });
      return d.reason === "action-not-granted" ? httpError(403, "forbidden") : httpError(404, "not-found");
    };

    if (isCard) {
      const denied = gate("card.read"); if (denied) return denied;
      return http(200, buildAgentCard(agentId, info!, o.advertisedBaseUrl, version));
    }

    // JSON-RPC. The agent must be reachable for *some* action before the body is read at all.
    if (info === undefined || info.optIn !== true || !Object.hasOwn(o.peers.find((p) => p.id === peer.peerId)!.grants, agentId)) {
      audit("a2a.denied", user, agentId, { action: "rpc", reason: info === undefined ? "unknown-agent" : info.optIn !== true ? "agent-not-exposed" : "peer-not-granted-agent" });
      return httpError(404, "not-found");
    }
    const ct = (req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
    if (ct !== "application/json") return httpError(415, "unsupported-media-type");
    const declared = req.headers["content-length"];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limits.maxBodyBytes)) {
      audit("a2a.too-large", user, agentId, { bytes: declared });
      return httpError(413, "body-too-large", { Connection: "close" });
    }
    let raw: Buffer;
    try { raw = await req.readBody(limits.maxBodyBytes); }
    catch (e) {
      if (e instanceof BodyTooLarge) { audit("a2a.too-large", user, agentId, { limit: limits.maxBodyBytes }); return httpError(413, "body-too-large", { Connection: "close" }); }
      return httpError(400, "unreadable-body");
    }
    if (raw.length > limits.maxBodyBytes) return httpError(413, "body-too-large", { Connection: "close" });
    let msg: unknown;
    try { msg = JSON.parse(raw.toString("utf8")); } catch { return rpcErr(null, RPC.parse, "parse error"); }
    // RULING: JSON-RPC batches are refused (ADR-008's cap of 30 is not needed by any known peer); one call per request.
    if (Array.isArray(msg)) return rpcErr(null, RPC.invalidRequest, "batch requests are not supported", "batch");
    if (!isObj(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string" || !(typeof msg.id === "string" || typeof msg.id === "number")) return rpcErr(null, RPC.invalidRequest, "invalid request");
    const id = msg.id; const method = msg.method;
    const action = Object.hasOwn(METHOD_ACTION, method) ? METHOD_ACTION[method]! : undefined;
    if (!action) {
      if (method.startsWith("message/stream") || method.startsWith("tasks/pushNotificationConfig") || method === "tasks/resubscribe") return rpcErr(id, RPC.unsupportedOperation, "operation not supported", "not-implemented");
      return rpcErr(id, RPC.methodNotFound, "method not found");
    }
    const denied = gate(action);
    if (denied) return rpcErr(id, RPC.invalidRequest, denied.status === 403 ? "not permitted" : "not found", denied.status === 403 ? "forbidden" : "not-found");
    const params = msg.params;
    try {
      if (method === "message/send") return rpcOk(id, await send(peer, agentId, params));
      if (!isObj(params) || !safeId(params.id)) return rpcErr(id, RPC.invalidParams, "params.id is required");
      if (method === "tasks/get") {
        const h = params.historyLength;
        if (h !== undefined && !(Number.isInteger(h) && (h as number) >= 0)) return rpcErr(id, RPC.invalidParams, "historyLength must be a non-negative integer");
        return rpcOk(id, tasks.get(params.id, peer.peerId, agentId, h as number | undefined));
      }
      return rpcOk(id, tasks.cancel(params.id, peer.peerId, agentId));
    } catch (e) { return fail(id, e); }
  }

  async function send(peer: A2aPeer, agentId: string, params: unknown): Promise<unknown> {
    if (!isObj(params) || !isObj(params.message)) throw new Invalid("params.message is required");
    const message = params.message;
    if (message.role !== "user") throw new Invalid("message.role must be user");
    if (!safeId(message.messageId)) throw new Invalid("message.messageId is required");
    // RULING: A2A1 tasks are single-turn: a follow-up on an existing task (`taskId`) is an unsupported operation.
    if (message.taskId !== undefined) throw new Unsupported("task follow-ups are not supported");
    if (message.contextId !== undefined && !safeId(message.contextId)) throw new Invalid("message.contextId is invalid");
    if (!Array.isArray(message.parts) || message.parts.length === 0) throw new Invalid("message.parts must be a non-empty array");
    if (message.parts.length > limits.maxParts) throw new Invalid("too many parts", "too-many-parts");
    let text = "";
    for (const p of message.parts) {
      if (!isObj(p) || typeof p.kind !== "string") throw new Invalid("invalid part");
      if (p.kind !== "text") throw new Unsupported("only text parts are accepted", "content-type");
      if (typeof p.text !== "string") throw new Invalid("text part needs a text string");
      text += (text === "" ? "" : "\n") + p.text;
      if (Buffer.byteLength(text, "utf8") > limits.maxTextBytes) throw new Invalid("message text is too large", "text-too-large");
    }
    if (text.trim() === "") throw new Invalid("message text is empty", "text-empty");
    const t = tasks.start({ peerId: peer.peerId, agentId, text, messageId: message.messageId, ...(typeof message.contextId === "string" ? { contextId: message.contextId } : {}) });
    const blocking = isObj(params.configuration) && params.configuration.blocking === true;
    if (!blocking) return t;
    await tasks.settled(t.id);
    return tasks.get(t.id, peer.peerId, agentId);
  }

  const fail = (id: unknown, e: unknown): A2aHttpResponse => {
    if (e instanceof Invalid) return rpcErr(id, RPC.invalidParams, e.message, e.reason);
    if (e instanceof Unsupported) return e.reason === "content-type" ? rpcErr(id, RPC.contentTypeNotSupported, e.message) : rpcErr(id, RPC.unsupportedOperation, e.message);
    if (e instanceof TaskError) {
      switch (e.code) {
        case "not-found": return rpcErr(id, RPC.taskNotFound, "task not found");
        case "not-cancelable": return rpcErr(id, RPC.taskNotCancelable, e.message);
        case "too-many": return rpcErr(id, RPC.limit, e.message, "task-limit");
        case "no-provider": return rpcErr(id, RPC.internal, "the agent is not available", "no-provider");
      }
    }
    return rpcErr(id, RPC.internal, "internal error");
  };

  return { handle, limits, tasks };
}

class Invalid extends Error { readonly reason: string | undefined; constructor(m: string, reason?: string) { super(m); this.reason = reason; } }
class Unsupported extends Error { readonly reason: string | undefined; constructor(m: string, reason?: string) { super(m); this.reason = reason; } }
