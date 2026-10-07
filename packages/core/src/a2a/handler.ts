// The transport-neutral A2A endpoint (A2A Protocol 0.3.0):
//   GET  /a2a/<agent>/.well-known/agent-card.json
//   GET  /.well-known/agent-card.json          (only when defaultAgentId is set)
//   POST /a2a/<agent>/  JSON-RPC 2.0
//     message/send, message/stream, tasks/get, tasks/cancel, tasks/resubscribe,
//     tasks/pushNotificationConfig/{set,get,list,delete}
// Inbound only; no outbound A2A client lives here. Order of checks, all fail closed:
// route -> address rate -> authentication -> peer rate -> agent+action authorisation -> size/type -> parse -> method.
import type { Egress } from "../egress/service.ts";
import type { AuditSink } from "../rbac/audit.ts";
import type { ChatProvider } from "../session/provider.ts";
import { buildAgentCard, DEFAULT_CARD_FEATURES } from "./card.ts";
import { sseLines } from "./events.ts";
import { PartError, parseParts } from "./parts.ts";
import { authorizePeer, resolvePeer, validAgentId, validatePeers, type A2aPeer } from "./policy.ts";
import { createEgressPushTransport, parsePushConfig, PushDispatcher, PushError, type PushTransport } from "./push.ts";
import { Buckets, type RateClock } from "./rate.ts";
import { TaskError, TaskStore, type Scheduler } from "./tasks.ts";
import { createProviderTurnPort, type A2aTurnPort } from "./turn-port.ts";
import {
  DEFAULT_LIMITS, RPC, type A2aAction, type A2aAgentSource, type A2aCardFeatures, type A2aLimits, type A2aPeerConfig,
} from "./types.ts";

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
export interface A2aHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** When set, the HTTP adapter writes this as `text/event-stream` (no Content-Length) and closes when it ends. */
  stream?: AsyncIterable<string>;
}

export type VerifyBearer = (token: string) => A2aPeer | undefined | Promise<A2aPeer | undefined>;

export interface A2aHandlerOptions {
  peers: readonly A2aPeerConfig[];
  agents: A2aAgentSource;
  /** Base URL peers reach this server under (the card's `url`). Loopback only in this slice. */
  advertisedBaseUrl: string;
  provider: () => ChatProvider | null;
  /** When set, drives the session turn-loop instead of the ChatProvider seam. */
  turns?: A2aTurnPort;
  clock?: RateClock; scheduler?: Scheduler; audit?: AuditSink; version?: string;
  limits?: Partial<A2aLimits>;
  /** Overrides the default `{ streaming: true, pushNotifications: true }`. */
  features?: Partial<A2aCardFeatures>;
  /**
   * Replaces `resolvePeer` when set. The Agent Card still declares http-bearer `peerKey`; a missing/invalid
   * token is 401 and never starts a turn.
   */
  verifyBearer?: VerifyBearer;
  /** When set, `GET /.well-known/agent-card.json` serves this agent's card (RFC 8615 origin path). */
  defaultAgentId?: string;
  /** Egress policy used to admit push URLs and pin delivery (SSRF). */
  egress?: Egress;
  /** Test seam: a complete push dispatcher. Overrides `egress` / `pushTransport`. */
  push?: PushDispatcher;
  /** Test seam: HTTP POST + `decide` used to build a dispatcher when `push` is omitted. */
  pushTransport?: PushTransport;
}
export interface A2aHandler { handle(req: A2aHttpRequest): Promise<A2aHttpResponse>; readonly limits: A2aLimits; readonly tasks: TaskStore }

const METHOD_ACTION: Readonly<Record<string, A2aAction>> = {
  "message/send": "task.send",
  "message/stream": "task.send",
  "tasks/get": "task.read",
  "tasks/cancel": "task.cancel",
  "tasks/resubscribe": "task.read",
  "tasks/pushNotificationConfig/set": "task.push",
  "tasks/pushNotificationConfig/get": "task.push",
  "tasks/pushNotificationConfig/list": "task.push",
  "tasks/pushNotificationConfig/delete": "task.push",
};
const SECURITY_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const SSE_HEADERS = { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "Connection": "keep-alive", "X-Content-Type-Options": "nosniff" };
const ROUTE = /^\/a2a\/([^/]+)\/(\.well-known\/agent-card\.json)?$/;
const ROOT_CARD = "/.well-known/agent-card.json";

const http = (status: number, body: unknown, extra: Record<string, string> = {}): A2aHttpResponse => ({ status, headers: { ...SECURITY_HEADERS, ...extra }, body: JSON.stringify(body) });
const httpError = (status: number, reason: string, extra: Record<string, string> = {}): A2aHttpResponse => http(status, { error: reason }, extra);
const rpcOk = (id: unknown, result: unknown): A2aHttpResponse => http(200, { jsonrpc: "2.0", id, result });
const rpcErr = (id: unknown, code: number, message: string, reason?: string): A2aHttpResponse =>
  http(200, { jsonrpc: "2.0", id, error: { code, message, ...(reason ? { data: { reason } } : {}) } });
const rpcSse = (id: unknown, results: AsyncIterable<unknown>): A2aHttpResponse => ({
  status: 200, headers: { ...SSE_HEADERS }, body: "", stream: sseLines(id, results),
});

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const ID_LIMIT = 128;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const safeId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= ID_LIMIT && !CONTROL.test(v);

const denyAllPush: PushTransport = {
  async decide() { return { allowed: false, reason: "host-not-allowed", message: "push notifications need an egress policy" }; },
  async post() { return { status: 0 }; },
};

export function createA2aHandler(o: A2aHandlerOptions): A2aHandler {
  validatePeers(o.peers);
  const limits: A2aLimits = { ...DEFAULT_LIMITS, ...o.limits };
  const clock: RateClock = o.clock ?? { now: () => Date.now() };
  const peerRate = new Buckets(limits.peerRatePerMinute, clock);
  const addrRate = new Buckets(limits.addressRatePerMinute, clock);
  const failRate = new Buckets(limits.failedAuthPerMinute, clock);
  const version = o.version ?? "0.1.0";
  const features: A2aCardFeatures = { ...DEFAULT_CARD_FEATURES, ...o.features };
  const audit = (action: string, user: string, target: string, detail: Record<string, unknown>): void => {
    try { o.audit?.append({ at: clock.now(), actor: { user, host: "a2a" }, action, target, detail }); } catch { /* the refusal stands */ }
  };
  const turns = o.turns ?? createProviderTurnPort(o.provider);
  const push = o.push ?? new PushDispatcher({
    transport: o.pushTransport ?? (o.egress ? createEgressPushTransport(o.egress) : denyAllPush),
    scheduler: o.scheduler ?? { set: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; }, clear: (h) => clearTimeout(h as NodeJS.Timeout) },
    clock, maxAttempts: limits.pushMaxAttempts, backoffMs: limits.pushBackoffMs,
  });
  const tasks = new TaskStore({
    turns, clock: () => clock.now(), ...(o.scheduler ? { scheduler: o.scheduler } : {}),
    maxLivePerPeer: limits.maxLiveTasksPerPeer, maxStored: limits.maxStoredTasks, retentionMs: limits.retentionMs,
    replyTimeoutMs: limits.replyTimeoutMs, maxHistory: limits.maxHistoryLength,
    maxStreamConnectionsPerPeer: limits.maxStreamConnectionsPerPeer,
    onEvent: (e) => audit(`a2a.task.${e.type}`, `a2a-peer:${e.peerId}`, e.taskId, { agent: e.agentId, state: e.state }),
    push,
  });

  async function handle(req: A2aHttpRequest): Promise<A2aHttpResponse> {
    let path = req.path;
    if (path === ROOT_CARD) {
      if (!o.defaultAgentId || !validAgentId(o.defaultAgentId)) return httpError(404, "not-found");
      path = `/a2a/${o.defaultAgentId}/.well-known/agent-card.json`;
    }
    const m = ROUTE.exec(path);
    if (!m || !validAgentId(m[1]!)) return httpError(404, "not-found");
    const agentId = m[1]!; const isCard = m[2] !== undefined;
    if (isCard ? req.method !== "GET" : req.method !== "POST") return httpError(405, "method-not-allowed", { Allow: isCard ? "GET" : "POST" });

    const ar = addrRate.take(req.remote);
    if (!ar.ok) { audit("a2a.rate-limited", "anonymous", req.path, { scope: "address" }); return httpError(429, "rate-limited", { "Retry-After": String(ar.retryAfterSec) }); }

    if (!failRate.has(req.remote)) { audit("a2a.rate-limited", "anonymous", req.path, { scope: "failed-auth" }); return httpError(429, "rate-limited", { "Retry-After": "60" }); }
    const auth = req.headers.authorization;
    const bearer = auth !== undefined && /^Bearer [\x21-\x7e]{1,512}$/.test(auth) ? auth.slice(7) : undefined;
    const peer: A2aPeer | undefined = bearer === undefined ? undefined : (o.verifyBearer ? await o.verifyBearer(bearer) : resolvePeer(o.peers, bearer));
    if (!peer) {
      failRate.take(req.remote);
      audit("a2a.unauthenticated", "anonymous", req.path, { reason: bearer === undefined ? "no-credential" : "bad-credential" });
      return httpError(401, "unauthenticated", { "WWW-Authenticate": "Bearer" });
    }
    const user = `a2a-peer:${peer.peerId}`;
    const pr = peerRate.take(peer.peerId);
    if (!pr.ok) { audit("a2a.rate-limited", user, req.path, { scope: "peer" }); return httpError(429, "rate-limited", { "Retry-After": String(pr.retryAfterSec) }); }

    const info = o.agents(agentId);
    const gate = (action: A2aAction): A2aHttpResponse | undefined => {
      const d = authorizePeer(o.peers, peer, action, agentId, info);
      if (d.effect === "allow") return undefined;
      audit("a2a.denied", user, agentId, { action, reason: d.reason });
      return d.reason === "action-not-granted" ? httpError(403, "forbidden") : httpError(404, "not-found");
    };

    if (isCard) {
      const denied = gate("card.read"); if (denied) return denied;
      return http(200, buildAgentCard(agentId, info!, o.advertisedBaseUrl, version, features));
    }

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
    if (Array.isArray(msg)) return rpcErr(null, RPC.invalidRequest, "batch requests are not supported", "batch");
    if (!isObj(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string" || !(typeof msg.id === "string" || typeof msg.id === "number")) return rpcErr(null, RPC.invalidRequest, "invalid request");
    const id = msg.id; const method = msg.method;
    const action = Object.hasOwn(METHOD_ACTION, method) ? METHOD_ACTION[method]! : undefined;
    if (!action) return rpcErr(id, RPC.methodNotFound, "method not found");
    if ((method === "message/stream" || method === "tasks/resubscribe") && features.streaming !== true) {
      return rpcErr(id, RPC.unsupportedOperation, "streaming is not supported", "not-implemented");
    }
    if (method.startsWith("tasks/pushNotificationConfig") && features.pushNotifications !== true) {
      return rpcErr(id, RPC.pushNotSupported, "push notifications are not supported");
    }
    const denied = gate(action);
    if (denied) return rpcErr(id, RPC.invalidRequest, denied.status === 403 ? "not permitted" : "not found", denied.status === 403 ? "forbidden" : "not-found");
    const params = msg.params;
    try {
      if (method === "message/send") return rpcOk(id, await send(peer, agentId, params));
      if (method === "message/stream") {
        const t = await send(peer, agentId, params);
        if (!isObj(t) || typeof t.id !== "string") return rpcErr(id, RPC.invalidAgentResponse, "invalid agent response");
        return rpcSse(id, tasks.subscribe(t.id, peer.peerId, agentId));
      }
      if (method === "tasks/resubscribe") {
        if (!isObj(params) || !safeId(params.id)) return rpcErr(id, RPC.invalidParams, "params.id is required");
        return rpcSse(id, tasks.resubscribe(params.id, peer.peerId, agentId));
      }
      if (method.startsWith("tasks/pushNotificationConfig/")) return await pushMethod(peer, agentId, method, id, params);
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
    if (message.taskId !== undefined && !safeId(message.taskId)) throw new Invalid("message.taskId is invalid");
    if (message.contextId !== undefined && !safeId(message.contextId)) throw new Invalid("message.contextId is invalid");
    const { parts, text } = parseParts(message.parts, limits);
    let pushCfg;
    const configuration = isObj(params.configuration) ? params.configuration : undefined;
    if (configuration && configuration.pushNotificationConfig !== undefined) {
      if (features.pushNotifications !== true) throw new PushError("not-supported", "push notifications are not supported");
      pushCfg = parsePushConfig(configuration.pushNotificationConfig);
      await tasks.admitPush(pushCfg.url);
    }
    const t = tasks.start({
      peerId: peer.peerId, agentId, text, parts, messageId: message.messageId,
      ...(typeof message.contextId === "string" ? { contextId: message.contextId } : {}),
      ...(typeof message.taskId === "string" ? { taskId: message.taskId } : {}),
      ...(pushCfg ? { push: pushCfg } : {}),
    });
    const blocking = configuration?.blocking === true;
    if (!blocking) return t;
    await tasks.settled(t.id);
    return tasks.get(t.id, peer.peerId, agentId);
  }

  async function pushMethod(peer: A2aPeer, agentId: string, method: string, id: unknown, params: unknown): Promise<A2aHttpResponse> {
    if (!isObj(params)) throw new Invalid("params are required");
    const taskId = safeId(params.taskId) ? params.taskId : safeId(params.id) ? params.id : undefined;
    if (!taskId) throw new Invalid("task id is required");
    if (method === "tasks/pushNotificationConfig/set") {
      const cfg = parsePushConfig(params.pushNotificationConfig);
      await tasks.admitPush(cfg.url);
      return rpcOk(id, tasks.setPush(taskId, peer.peerId, agentId, cfg));
    }
    if (method === "tasks/pushNotificationConfig/get") {
      const configId = safeId(params.pushNotificationConfigId) ? params.pushNotificationConfigId : undefined;
      return rpcOk(id, tasks.getPush(taskId, peer.peerId, agentId, configId));
    }
    if (method === "tasks/pushNotificationConfig/list") return rpcOk(id, tasks.listPush(taskId, peer.peerId, agentId));
    if (method === "tasks/pushNotificationConfig/delete") {
      if (!safeId(params.pushNotificationConfigId)) throw new Invalid("pushNotificationConfigId is required");
      return rpcOk(id, tasks.deletePush(taskId, peer.peerId, agentId, params.pushNotificationConfigId));
    }
    return rpcErr(id, RPC.methodNotFound, "method not found");
  }

  const fail = (id: unknown, e: unknown): A2aHttpResponse => {
    if (e instanceof Invalid) return rpcErr(id, RPC.invalidParams, e.message, e.reason);
    if (e instanceof PartError) {
      if (e.code === "content-type") return rpcErr(id, RPC.contentTypeNotSupported, e.message);
      if (e.code === "too-large") return rpcErr(id, RPC.invalidParams, e.message, e.message.includes("file") ? "file-too-large" : e.message.includes("data") ? "data-too-large" : "text-too-large");
      if (e.code === "too-many") return rpcErr(id, RPC.invalidParams, e.message, "too-many-parts");
      return rpcErr(id, RPC.invalidParams, e.message);
    }
    if (e instanceof PushError) {
      if (e.code === "not-supported") return rpcErr(id, RPC.pushNotSupported, e.message);
      if (e.code === "denied") return rpcErr(id, RPC.invalidParams, e.message, "push-url-denied");
      if (e.code === "not-found") return rpcErr(id, RPC.taskNotFound, e.message);
      return rpcErr(id, RPC.invalidParams, e.message);
    }
    if (e instanceof TaskError) {
      switch (e.code) {
        case "not-found": return rpcErr(id, RPC.taskNotFound, "task not found");
        case "not-cancelable": return rpcErr(id, RPC.taskNotCancelable, e.message);
        case "too-many": return rpcErr(id, RPC.limit, e.message, "task-limit");
        case "no-provider": return rpcErr(id, RPC.internal, "the agent is not available", "no-provider");
        case "unsupported": return rpcErr(id, RPC.unsupportedOperation, e.message);
        case "invalid": return rpcErr(id, RPC.invalidParams, e.message);
      }
    }
    return rpcErr(id, RPC.internal, "internal error");
  };

  return { handle, limits, tasks };
}

class Invalid extends Error { readonly reason: string | undefined; constructor(m: string, reason?: string) { super(m); this.reason = reason; } }
