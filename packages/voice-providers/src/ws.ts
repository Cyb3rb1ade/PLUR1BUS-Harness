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

  private closeTimeoutTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private deadPeerTimer: NodeJS.Timeout | undefined;

  constructor(sock: Duplex, head: Buffer, pingIntervalMs = 30000, pingTimeoutMs = 10000) {
    this.sock = sock;
    sock.on("data", (d: Buffer) => this.onData(d));
    sock.on("close", () => this.finish(1006, ""));
    sock.on("error", (e: Error) => {
      for (const l of this.listeners.error) {
        try { l({ message: e.name }); } catch { /* guard listener */ }
      }
      this.finish(1006, "");
    });
    if (pingIntervalMs > 0) {
      this.pingTimer = setInterval(() => {
        if (this.readyState !== WS_OPEN) return;
        try { this.frame(9, Buffer.alloc(0)); } catch { /* ignore */ }
        if (!this.deadPeerTimer && pingTimeoutMs > 0) {
          this.deadPeerTimer = setTimeout(() => {
            this.protocolError(1006, "dead peer timeout");
          }, pingTimeoutMs);
        }
      }, pingIntervalMs);
    }
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
      queueMicrotask(() => {
        for (const m of held) {
          for (const l of this.listeners.message) {
            try { l(m); } catch { /* guard listener */ }
          }
        }
      });
    }
    if (type === "close" && this.pendingClose) {
      const c = this.pendingClose;
      this.pendingClose = undefined;
      queueMicrotask(() => {
        try { listener(c as never); } catch { /* guard listener */ }
      });
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
    this.sock.end();
    if (!this.closeTimeoutTimer) {
      this.closeTimeoutTimer = setTimeout(() => {
        this.sock.destroy();
        this.finish(1006, "close timeout");
      }, 500);
    }
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
      const rsv = b0 & 0x70;
      if (rsv !== 0) return this.protocolError(1002, "RSV bits must be 0");
      const opcode = b0 & 0x0f;
      const isControl = opcode >= 8;
      let len = this.buf[1]! & 0x7f;
      let off = 2;
      if (isControl) {
        if (!fin) return this.protocolError(1002, "control frame cannot be fragmented");
        if (len > 125) return this.protocolError(1002, "control frame payload > 125");
      }
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; const big = this.buf.readBigUInt64BE(2); if (big > BigInt(MAX_PAYLOAD)) return this.protocolError(1009, "payload too large"); len = Number(big); off = 10; }
      if (len > MAX_PAYLOAD) return this.protocolError(1009, "payload too large");
      if (this.buf.length < off + len) return;
      const payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      if (opcode === 8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        let reason = "";
        if (payload.length > 2) {
          const reasonBuf = payload.subarray(2);
          try {
            const dec = new TextDecoder("utf-8", { fatal: true });
            reason = dec.decode(reasonBuf);
          } catch {
            return this.protocolError(1007, "invalid utf8 in close reason");
          }
        }
        if (!this.closeSent) { this.closeSent = true; try { this.frame(8, Buffer.from(payload.subarray(0, 2))); } catch { /* gone */ } }
        this.sock.end();
        this.finish(code, reason);
        return;
      }
      if (opcode === 9) {
        try { this.frame(10, Buffer.from(payload)); } catch { /* gone */ }
        continue;
      }
      if (opcode === 10) {
        if (this.deadPeerTimer) {
          clearTimeout(this.deadPeerTimer);
          this.deadPeerTimer = undefined;
        }
        continue;
      }
      if (opcode === 0 || opcode === 1 || opcode === 2) {
        if (opcode !== 0) {
          this.fragOpcode = opcode;
          this.frag = [];
        } else if (this.fragOpcode === 0) {
          return this.protocolError(1002, "unexpected continuation frame");
        }
        let totalFrag = 0;
        for (const fb of this.frag) totalFrag += fb.length;
        if (totalFrag + payload.length > MAX_PAYLOAD) return this.protocolError(1009, "fragmented payload too large");
        this.frag.push(Buffer.from(payload));
        if (fin) {
          const whole = Buffer.concat(this.frag);
          this.frag = [];
          const origOpcode = this.fragOpcode;
          this.fragOpcode = 0;
          let data: string | Uint8Array;
          if (origOpcode === 1) {
            try {
              const dec = new TextDecoder("utf-8", { fatal: true });
              data = dec.decode(whole);
            } catch {
              return this.protocolError(1007, "invalid utf8 in text frame");
            }
          } else {
            data = new Uint8Array(whole);
          }
          if (this.listeners.message.length === 0) this.pendingMessages.push({ data });
          else {
            for (const l of this.listeners.message) {
              try { l({ data }); } catch { /* guard listener */ }
            }
          }
        }
        continue;
      }
      return this.protocolError(1002, "unsupported opcode");
    }
  }

  private protocolError(code: number, reason = "protocol error"): void {
    this.close(code, reason);
    this.sock.destroy();
    this.finish(code, reason);
  }

  private finish(code: number, reason: string): void {
    if (this.closeTimeoutTimer) { clearTimeout(this.closeTimeoutTimer); this.closeTimeoutTimer = undefined; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = undefined; }
    if (this.deadPeerTimer) { clearTimeout(this.deadPeerTimer); this.deadPeerTimer = undefined; }
    if (this.closed) return;
    this.closed = true;
    this.readyState = WS_CLOSED;
    if (this.listeners.close.length === 0) this.pendingClose = { code, reason };
    else {
      for (const l of this.listeners.close) {
        try { l({ code, reason }); } catch { /* guard listener */ }
      }
    }
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
