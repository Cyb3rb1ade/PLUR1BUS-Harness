// A small RFC 6455 client on node:http(s). Why not the global WebSocket: it cannot set the vendor key headers on every
// runtime and it hides the HTTP status of a refused handshake, which the unified error codes need (401 -> auth,
// 429 -> rate_limited with Retry-After). No dependency; tests use a local fake server or an injected factory.
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
export type WsFactory = (url: string, init: { headers?: Record<string, string>; signal?: AbortSignal; provider?: string; secrets?: readonly string[] }) => Promise<WsLike>;

export const WS_OPEN = 1;
export const WS_CLOSED = 3;
const MAX_PAYLOAD = 16 * 1024 * 1024;
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

class NodeWebSocket implements WsLike {
  readyState = WS_OPEN;
  private readonly sock: Duplex;
  private buf: Buffer = Buffer.alloc(0);
  private frag: Buffer[] = [];
  private fragOpcode = 0;
  private readonly listeners: { message: Array<(e: { data: string | Uint8Array }) => void>; close: Array<(e: { code: number; reason: string }) => void>; error: Array<(e: { message: string }) => void> } = { message: [], close: [], error: [] };
  private closeSent = false;
  private closed = false;

  constructor(sock: Duplex, head: Buffer) {
    this.sock = sock;
    sock.on("data", (d: Buffer) => this.onData(d));
    sock.on("close", () => this.finish(1006, ""));
    sock.on("error", (e: Error) => { for (const l of this.listeners.error) l({ message: e.name }); this.finish(1006, ""); });
    if (head.length > 0) queueMicrotask(() => this.onData(head));
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
      queueMicrotask(() => { for (const m of held) for (const l of this.listeners.message) l(m); });
    }
    if (type === "close" && this.pendingClose) {
      const c = this.pendingClose;
      this.pendingClose = undefined;
      queueMicrotask(() => listener(c as never));
    }
  }

  send(data: string | Uint8Array): void {
    if (this.readyState !== WS_OPEN) throw new VoiceProviderError("closed", "websocket is closed");
    this.frame(typeof data === "string" ? 1 : 2, typeof data === "string" ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  }

  close(code = 1000, reason = ""): void {
    if (this.closeSent || this.closed) return;
    this.closeSent = true;
    this.readyState = 2;
    const r = Buffer.from(reason);
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code);
    r.copy(p, 2);
    try { this.frame(8, p); } catch { /* socket gone */ }
    // Give the peer a moment to echo the close, then drop the socket without a wall-clock dependency in tests:
    // end() flushes our close frame and the peer's echo (or FIN) completes the shutdown.
    this.sock.end();
  }

  private frame(opcode: number, payload: Buffer): void {
    const mask = randomBytes(4);
    let head: Buffer;
    if (payload.length < 126) head = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    else if (payload.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 0x80 | 126; head.writeUInt16BE(payload.length, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] = masked[i]! ^ mask[i % 4]!;
    this.sock.write(Buffer.concat([head, mask, masked]));
  }

  private onData(d: Buffer): void {
    this.buf = this.buf.length === 0 ? d : Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      let len = this.buf[1]! & 0x7f;
      let off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; const big = this.buf.readBigUInt64BE(2); if (big > BigInt(MAX_PAYLOAD)) return this.protocolError(1009); len = Number(big); off = 10; }
      if (len > MAX_PAYLOAD) return this.protocolError(1009);
      if (this.buf.length < off + len) return;
      const payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      if (opcode === 8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
        if (!this.closeSent) { this.closeSent = true; try { this.frame(8, Buffer.from(payload.subarray(0, 2))); } catch { /* gone */ } }
        this.sock.end();
        this.finish(code, reason);
        return;
      }
      if (opcode === 9) { try { this.frame(10, Buffer.from(payload)); } catch { /* gone */ } continue; }
      if (opcode === 10) continue;
      if (opcode === 0 || opcode === 1 || opcode === 2) {
        if (opcode !== 0) { this.fragOpcode = opcode; this.frag = []; }
        this.frag.push(Buffer.from(payload));
        if (fin) {
          const whole = Buffer.concat(this.frag);
          this.frag = [];
          const data = this.fragOpcode === 1 ? whole.toString("utf8") : new Uint8Array(whole);
          if (this.listeners.message.length === 0) this.pendingMessages.push({ data });
          else for (const l of this.listeners.message) l({ data });
        }
        continue;
      }
      return this.protocolError(1002);
    }
  }

  private protocolError(code: number): void {
    this.close(code, "protocol error");
    this.sock.destroy();
    this.finish(code, "protocol error");
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = WS_CLOSED;
    if (this.listeners.close.length === 0) this.pendingClose = { code, reason };
    else for (const l of this.listeners.close) l({ code, reason });
  }
}

export const defaultWsFactory: WsFactory = (url, init) => {
  const provider = init.provider ?? "websocket";
  const u = assertSecureTransport(url, provider);
  const secure = u.protocol === "wss:";
  if (init.signal?.aborted) return Promise.reject(abortedError(provider));
  return new Promise<WsLike>((resolve, reject) => {
    const key = randomBytes(16).toString("base64");
    const req = (secure ? httpsRequest : httpRequest)({
      protocol: secure ? "https:" : "http:", hostname: u.hostname.replace(/^\[|\]$/g, ""), port: u.port || (secure ? 443 : 80), path: `${u.pathname}${u.search}`, method: "GET",
      headers: { ...init.headers, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key },
    });
    let settled = false;
    const done = (fn: () => void) => { if (settled) return; settled = true; init.signal?.removeEventListener("abort", onAbort); fn(); };
    const onAbort = () => { req.destroy(); done(() => reject(abortedError(provider))); };
    init.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("upgrade", (res: IncomingMessage, sock: Duplex, head: Buffer) => {
      const expect = createHash("sha1").update(key + GUID).digest("base64");
      if (res.headers["sec-websocket-accept"] !== expect) { sock.destroy(); return done(() => reject(new VoiceProviderError("bad_response", `${provider}: bad websocket handshake`, { provider }))); }
      done(() => resolve(new NodeWebSocket(sock, head)));
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
}

export async function openSocket(o: OpenSocketOptions): Promise<WsLike> {
  assertSecureTransport(o.url, o.provider);
  if (o.signal?.aborted) throw abortedError(o.provider);
  const init: Parameters<WsFactory>[1] = { provider: o.provider, secrets: o.secrets ?? [] };
  if (o.headers) init.headers = o.headers;
  if (o.signal) init.signal = o.signal;
  return (o.factory ?? defaultWsFactory)(o.url, init);
}

export function parseJsonFrame(data: unknown, provider: string): Record<string, unknown> {
  const text = typeof data === "string" ? data : data instanceof Uint8Array ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8") : undefined;
  if (text === undefined) throw new VoiceProviderError("bad_response", `${provider}: unsupported frame type`, { provider });
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* fallthrough */ }
  throw new VoiceProviderError("bad_response", `${provider}: frame is not a JSON object`, { provider });
}
