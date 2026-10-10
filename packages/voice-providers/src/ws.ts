// A small RFC 6455 client on node:http(s). Why not the global WebSocket: it hides the HTTP status of a refused
// handshake, which the unified error codes need (401 -> auth, 429 -> rate_limited with Retry-After). No dependency;
// tests use a local fake server or an injected factory.
//
// Hardening (everything the server sends is untrusted): total message size cap across fragments (1009), RSV bits,
// masked server frames, fragmentation state, control frames (fin, <=125 bytes) and opcodes (1002), UTF-8 validation of
// the assembled text message and of close reasons (1007), a close timeout, a ping keepalive with a dead-peer deadline,
// and listener exceptions that never escape into the socket's data event (they become an error event and a 1011 close).
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import { VoiceProviderError, abortedError, errorFromStatus } from "./errors.ts";
import { assertSecureTransport } from "./util.ts";

export interface WsLike {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (ev: { data: string | Uint8Array }) => void): void;
  addEventListener(type: "close", listener: (ev: { code: number; reason: string }) => void): void;
  addEventListener(type: "error", listener: (ev: { message: string }) => void): void;
  readonly readyState: number;
}

/** Limits and timers of the built-in client. All optional; the defaults suit the realtime voice protocols. */
export interface WsLimits {
  /** Largest complete message (sum over fragments). Default 4 MiB. */
  maxMessageBytes?: number;
  /** How long we wait for the peer to finish the close handshake before dropping the socket. Default 5000. */
  closeTimeoutMs?: number;
  /** Idle time before a keepalive ping. 0 turns the keepalive off. Default 20000. */
  pingIntervalMs?: number;
  /** How long a ping may stay unanswered (no bytes at all from the peer) before the peer counts as dead. Default 10000. */
  pongTimeoutMs?: number;
}
export interface WsTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface WsInit {
  /** Host integration: vetted DNS lookup, preserving original TLS hostname. */
  lookup?: import("node:http").RequestOptions["lookup"];
  headers?: Record<string, string>;
  signal?: AbortSignal;
  provider?: string;
  secrets?: readonly string[];
  limits?: WsLimits;
  /** Test seam: timers for the close timeout and the keepalive. */
  timers?: WsTimers;
}
export type WsFactory = (url: string, init: WsInit) => Promise<WsLike>;

export const WS_OPEN = 1;
export const WS_CLOSING = 2;
export const WS_CLOSED = 3;
const DEFAULT_LIMITS = { maxMessageBytes: 4 * 1024 * 1024, closeTimeoutMs: 5000, pingIntervalMs: 20_000, pongTimeoutMs: 10_000 } as const;
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_CONTROL_PAYLOAD = 125;
const RESERVED_HEADERS = new Set(["connection", "upgrade", "host", "content-length"]);

const realTimers: WsTimers = {
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Close codes a peer may put on the wire (RFC 6455 section 7.4): 1005, 1006 and 1015 are local-only. */
function validCloseCode(code: number): boolean {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
}

type Utf8 = TextDecoder;
const strictUtf8 = (): Utf8 => new TextDecoder("utf-8", { fatal: true });

class NodeWebSocket implements WsLike {
  readyState = WS_OPEN;
  private readonly sock: Duplex;
  private readonly lim: Required<WsLimits>;
  private readonly timers: WsTimers;
  private chunks: Buffer[] = [];
  private chunkBytes = 0;
  private frag: Buffer[] = [];
  private fragBytes = 0;
  /** Opcode of the data message being assembled; 0 when none. */
  private fragOpcode = 0;
  private readonly listeners: { message: Array<(e: { data: string | Uint8Array }) => void>; close: Array<(e: { code: number; reason: string }) => void>; error: Array<(e: { message: string }) => void> } = { message: [], close: [], error: [] };
  private closeSent = false;
  private closed = false;
  private listenerFailed = false;
  private closeTimer: unknown;
  private pingTimer: unknown;
  private pongTimer: unknown;

  constructor(sock: Duplex, head: Buffer, limits: WsLimits | undefined, timers: WsTimers | undefined) {
    this.sock = sock;
    this.lim = { ...DEFAULT_LIMITS, ...limits };
    this.timers = timers ?? realTimers;
    sock.on("data", (d: Buffer) => this.onData(d));
    sock.on("close", () => { this.clearCloseTimer(); this.finish(1006, ""); });
    sock.on("error", () => { this.emit(this.listeners.error, { message: "socket_error" }); this.finish(1006, ""); });
    if (head.length > 0) queueMicrotask(() => this.onData(head));
    this.armPing();
  }

  // Events that arrive before the first listener of their type exists are held and replayed, so a frame the server
  // sends right after the handshake is never lost between `open` and the caller's addEventListener.
  private pendingMessages: Array<{ data: string | Uint8Array }> = [];
  private pendingClose: { code: number; reason: string } | undefined;

  addEventListener(type: "message" | "close" | "error", listener: (ev: never) => void): void {
    (this.listeners[type] as Array<(ev: never) => void>).push(listener);
    if (type === "message" && this.pendingMessages.length > 0) {
      const held = this.pendingMessages;
      this.pendingMessages = [];
      queueMicrotask(() => { for (const m of held) this.emit(this.listeners.message, m); });
    }
    if (type === "close" && this.pendingClose) {
      const c = this.pendingClose;
      this.pendingClose = undefined;
      queueMicrotask(() => this.emit([listener as (e: { code: number; reason: string }) => void], c));
    }
  }

  send(data: string | Uint8Array): void {
    if (this.readyState !== WS_OPEN) throw new VoiceProviderError("closed", "websocket is closed");
    this.frame(typeof data === "string" ? 1 : 2, typeof data === "string" ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  }

  close(code = 1000, reason = ""): void {
    if (this.closeSent || this.closed) return;
    this.sendClose(code, reason);
    this.readyState = WS_CLOSING;
    // The peer's close frame (or the end of the connection) completes the shutdown; a peer that never answers is
    // dropped by the timer.
    this.armCloseTimer();
    this.sock.end();
  }

  private sendClose(code: number, reason: string): void {
    this.closeSent = true;
    // A control frame carries at most 125 bytes: 2 for the code, the rest for the reason (cut on a character boundary).
    let r = Buffer.from(reason);
    if (r.length > MAX_CONTROL_PAYLOAD - 2) r = Buffer.from(r.subarray(0, MAX_CONTROL_PAYLOAD - 2).toString("utf8").replace(/�+$/, ""));
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code);
    r.copy(p, 2);
    this.frame(8, p);
  }

  private frame(opcode: number, payload: Buffer): void {
    if (this.closed || this.sock.destroyed || !this.sock.writable) return;
    const mask = randomBytes(4);
    let head: Buffer;
    if (payload.length < 126) head = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    else if (payload.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 0x80 | 126; head.writeUInt16BE(payload.length, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] = masked[i]! ^ mask[i % 4]!;
    this.sock.write(Buffer.concat([head, mask, masked]));
  }

  // ---- input ----

  private onData(d: Buffer): void {
    if (this.closed) return;
    this.alive();
    this.chunks.push(d);
    this.chunkBytes += d.length;
    this.parse();
  }

  /** First `n` buffered bytes without consuming them (fewer when less is buffered). */
  private peek(n: number): Buffer {
    const first = this.chunks[0];
    if (first && first.length >= n) return first;
    return Buffer.concat(this.chunks, Math.min(n, this.chunkBytes));
  }
  private take(n: number): Buffer {
    const first = this.chunks[0]!;
    if (first.length >= n) {
      this.chunks[0] = first.subarray(n);
      if (this.chunks[0]!.length === 0) this.chunks.shift();
      this.chunkBytes -= n;
      return first.subarray(0, n);
    }
    const all = Buffer.concat(this.chunks);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.chunks = rest.length > 0 ? [rest] : [];
    this.chunkBytes -= n;
    return out;
  }

  private parse(): void {
    for (;;) {
      if (this.closed || this.chunkBytes < 2) return;
      const h = this.peek(10);
      const b0 = h[0]!;
      const b1 = h[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      if ((b0 & 0x70) !== 0) return this.fail(1002, "reserved bits");
      if ((b1 & 0x80) !== 0) return this.fail(1002, "masked server frame");
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (h.length < 4) return; len = h.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (h.length < 10) return;
        const big = h.readBigUInt64BE(2);
        if (big > BigInt(this.lim.maxMessageBytes)) return this.fail(1009, "message too big");
        len = Number(big);
        off = 10;
      }
      const control = opcode >= 8;
      if (control) {
        if (opcode > 10 || !fin || len > MAX_CONTROL_PAYLOAD) return this.fail(1002, "bad control frame");
      } else if (opcode === 0) {
        if (this.fragOpcode === 0) return this.fail(1002, "unexpected continuation");
      } else if (opcode === 1 || opcode === 2) {
        if (this.fragOpcode !== 0) return this.fail(1002, "data frame inside a fragmented message");
      } else return this.fail(1002, "unknown opcode");
      if (!control && this.fragBytes + len > this.lim.maxMessageBytes) return this.fail(1009, "message too big");
      if (this.chunkBytes < off + len) return;
      const payload = this.take(off + len).subarray(off);
      if (control) { this.onControl(opcode, payload); continue; }
      this.onMessageFrame(opcode, fin, payload);
    }
  }

  private onControl(opcode: number, payload: Buffer): void {
    if (opcode === 9) {
      if (!this.closeSent) this.frame(10, Buffer.from(payload));
      return;
    }
    if (opcode === 10) return;
    // close
    if (payload.length === 1) return this.fail(1002, "bad close payload");
    let code = 1005;
    let reason = "";
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      if (!validCloseCode(code)) return this.fail(1002, "bad close code");
      try { reason = strictUtf8().decode(payload.subarray(2)); } catch { return this.fail(1007, "bad close reason"); }
    }
    if (!this.closeSent) {
      try { this.sendClose(code === 1005 ? 1000 : code, ""); } catch { /* gone */ }
      this.readyState = WS_CLOSING;
    }
    this.armCloseTimer();
    this.sock.end();
    this.finish(code, reason);
  }

  private onMessageFrame(opcode: number, fin: boolean, payload: Buffer): void {
    if (opcode !== 0) { this.fragOpcode = opcode; this.frag = []; this.fragBytes = 0; }
    this.frag.push(Buffer.from(payload));
    this.fragBytes += payload.length;
    if (!fin) return;
    const whole = this.frag.length === 1 ? this.frag[0]! : Buffer.concat(this.frag);
    const wasText = this.fragOpcode === 1;
    this.frag = [];
    this.fragBytes = 0;
    this.fragOpcode = 0;
    let data: string | Uint8Array;
    if (wasText) {
      try { data = strictUtf8().decode(whole); } catch { return this.fail(1007, "invalid utf-8"); }
    } else data = new Uint8Array(whole);
    // Once we have sent our close frame the session is winding down: late data is not handed to anyone.
    if (this.closeSent) return;
    if (this.listeners.message.length === 0) this.pendingMessages.push({ data });
    else this.emit(this.listeners.message, { data });
  }

  /** Fail the connection (RFC 6455 section 7.1.7): close frame with the code, then the socket goes down. */
  private fail(code: number, reason: string): void {
    if (this.closed) return;
    if (!this.closeSent) { try { this.sendClose(code, reason); } catch { /* gone */ } }
    this.readyState = WS_CLOSING;
    this.armCloseTimer();
    this.sock.end();
    this.chunks = [];
    this.chunkBytes = 0;
    this.finish(code, reason);
  }

  // ---- listeners ----

  /** Call listeners so that none can throw into the socket's data event. A throwing listener ends the session. */
  private emit<T>(list: Array<(e: T) => void>, ev: T): void {
    for (const l of [...list]) {
      try { l(ev); } catch { this.onListenerThrow(); }
    }
  }
  private onListenerThrow(): void {
    if (this.listenerFailed) return;
    this.listenerFailed = true;
    for (const l of [...this.listeners.error]) { try { l({ message: "listener_error" }); } catch { /* ignore */ } }
    this.close(1011, "listener error");
  }

  // ---- timers ----

  private armCloseTimer(): void {
    if (this.closeTimer !== undefined) return;
    this.closeTimer = this.timers.setTimeout(() => {
      this.closeTimer = undefined;
      this.sock.destroy();
      this.finish(1006, "close timeout");
    }, this.lim.closeTimeoutMs);
  }
  private clearCloseTimer(): void {
    if (this.closeTimer !== undefined) { this.timers.clearTimeout(this.closeTimer); this.closeTimer = undefined; }
  }
  private armPing(): void {
    if (this.lim.pingIntervalMs <= 0 || this.closed || this.closeSent) return;
    if (this.pingTimer !== undefined) this.timers.clearTimeout(this.pingTimer);
    this.pingTimer = this.timers.setTimeout(() => {
      this.pingTimer = undefined;
      if (this.closed || this.closeSent) return;
      this.frame(9, randomBytes(4));
      this.pongTimer = this.timers.setTimeout(() => {
        this.pongTimer = undefined;
        this.sock.destroy();
        this.finish(1006, "dead peer");
      }, this.lim.pongTimeoutMs);
    }, this.lim.pingIntervalMs);
  }
  /** Any bytes from the peer prove it is alive: drop the dead-peer deadline and restart the ping clock. */
  private alive(): void {
    if (this.pongTimer !== undefined) { this.timers.clearTimeout(this.pongTimer); this.pongTimer = undefined; }
    this.armPing();
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = WS_CLOSED;
    for (const t of [this.pingTimer, this.pongTimer]) if (t !== undefined) this.timers.clearTimeout(t);
    this.pingTimer = undefined;
    this.pongTimer = undefined;
    if (this.sock.destroyed) this.clearCloseTimer();
    if (this.listeners.close.length === 0) this.pendingClose = { code, reason };
    else this.emit(this.listeners.close, { code, reason });
  }
}

export const defaultWsFactory: WsFactory = (url, init) => {
  const provider = init.provider ?? "websocket";
  let u: URL;
  try { u = assertSecureTransport(url, provider); } catch (e) { return Promise.reject(e); }
  const secure = u.protocol === "wss:";
  if (init.signal?.aborted) return Promise.reject(abortedError(provider));
  return new Promise<WsLike>((resolve, reject) => {
    const key = randomBytes(16).toString("base64");
    // Caller headers first, minus the ones the protocol owns (case-insensitive), then ours.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) if (!RESERVED_HEADERS.has(k.toLowerCase()) && !k.toLowerCase().startsWith("sec-websocket-")) headers[k] = v;
    Object.assign(headers, { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key });
    const req = (secure ? httpsRequest : httpRequest)({
      protocol: secure ? "https:" : "http:", hostname: u.hostname.replace(/^\[|\]$/g, ""), port: u.port || (secure ? 443 : 80), path: `${u.pathname}${u.search}`, method: "GET", headers, ...(init.lookup ? { lookup: init.lookup } : {}),
    });
    let settled = false;
    const done = (fn: () => void) => { if (settled) return; settled = true; init.signal?.removeEventListener("abort", onAbort); fn(); };
    const onAbort = () => { req.destroy(); done(() => reject(abortedError(provider))); };
    init.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("upgrade", (res: IncomingMessage, sock: Duplex, head: Buffer) => {
      const bad = (): void => { sock.destroy(); done(() => reject(new VoiceProviderError("bad_response", `${provider}: bad websocket handshake`, { provider }))); };
      const expect = createHash("sha1").update(key + GUID).digest("base64");
      if (res.headers["sec-websocket-accept"] !== expect) return bad();
      if (String(res.headers["upgrade"] ?? "").toLowerCase() !== "websocket") return bad();
      if (!/(^|,)\s*upgrade\s*(,|$)/i.test(String(res.headers["connection"] ?? ""))) return bad();
      // Nothing was offered, so nothing may be selected.
      if (res.headers["sec-websocket-extensions"] !== undefined || res.headers["sec-websocket-protocol"] !== undefined) return bad();
      done(() => resolve(new NodeWebSocket(sock, head, init.limits, init.timers)));
    });
    req.on("response", (res: IncomingMessage) => {
      // Not an upgrade: the handshake was refused. Map the status; never echo the body.
      const retry = res.headers["retry-after"];
      res.resume();
      done(() => reject(errorFromStatus(res.statusCode ?? 0, provider, "", Array.isArray(retry) ? retry[0] : retry, init.secrets ?? [])));
    });
    req.on("error", () => done(() => reject(new VoiceProviderError("network", `${provider}: could not open socket`, { provider, secrets: init.secrets ?? [] }))));
    req.end();
  });
};

export interface OpenSocketOptions {
  provider: string;
  url: string;
  headers?: Record<string, string>;
  factory?: WsFactory;
  signal?: AbortSignal;
  secrets?: readonly string[];
  limits?: WsLimits;
  timers?: WsTimers;
}

export async function openSocket(o: OpenSocketOptions): Promise<WsLike> {
  assertSecureTransport(o.url, o.provider);
  if (o.signal?.aborted) throw abortedError(o.provider);
  const init: WsInit = { provider: o.provider, secrets: o.secrets ?? [] };
  if (o.headers) init.headers = o.headers;
  if (o.signal) init.signal = o.signal;
  if (o.limits) init.limits = o.limits;
  if (o.timers) init.timers = o.timers;
  return (o.factory ?? defaultWsFactory)(o.url, init);
}

export function parseJsonFrame(data: unknown, provider: string): Record<string, unknown> {
  const text = typeof data === "string" ? data : data instanceof Uint8Array ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8") : undefined;
  if (text === undefined) throw new VoiceProviderError("upstream_protocol", `${provider}: unsupported frame type`, { provider });
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* fallthrough */ }
  throw new VoiceProviderError("upstream_protocol", `${provider}: frame is not a JSON object`, { provider });
}

/** The unified error for a socket that ended with a close code the service chose or the protocol layer forced. */
export function closeError(provider: string, code: number): VoiceProviderError {
  if (code === 1008) return new VoiceProviderError("auth", `${provider}: connection refused by the service (policy, ${code})`, { provider });
  if (code === 1002 || code === 1003 || code === 1007 || code === 1009) return new VoiceProviderError("upstream_protocol", `${provider}: connection closed by a protocol violation (${code})`, { provider });
  return new VoiceProviderError("network", `${provider}: connection closed (${code})`, { provider });
}

/** Anything a codec or handler threw on a frame, mapped to the one error that says "the service sent something we cannot use". */
export function upstreamProtocolError(provider: string): VoiceProviderError {
  return new VoiceProviderError("upstream_protocol", `${provider}: unexpected frame from the service`, { provider });
}
