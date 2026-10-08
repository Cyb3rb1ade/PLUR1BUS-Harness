// A local fake vendor: HTTP routes plus a minimal RFC 6455 WebSocket server on one port-0 listener. No network,
// no wall-clock waits: tests await explicit events.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

export const SENTINEL_KEY = "sk-test-SENTINEL-0123456789abcdef";

/** Synthetic audio: a 440 Hz sine as pcm16 little-endian mono. */
export function sinePcm16(samples: number, sampleRate = 16000, freq = 440): Uint8Array {
  const out = new Uint8Array(samples * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < samples; i++) v.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 12000), true);
  return out;
}

export class FakeSocket {
  readonly received: Array<string | Uint8Array> = [];
  private waiters: Array<() => void> = [];
  closedWith: number | undefined;
  private readonly sock: Duplex;
  readonly req: IncomingMessage;
  constructor(sock: Duplex, req: IncomingMessage) {
    this.sock = sock;
    this.req = req;
    let buf = Buffer.alloc(0);
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const f = parseFrame(buf);
        if (!f) break;
        buf = buf.subarray(f.used);
        if (f.opcode === 8) { this.closedWith = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005; this.rawSend(8, f.payload); sock.end(); this.notify(); break; }
        if (f.opcode === 9) { this.rawSend(10, f.payload); continue; }
        this.received.push(f.opcode === 1 ? f.payload.toString("utf8") : new Uint8Array(f.payload));
        this.notify();
      }
    });
    sock.on("close", () => { if (this.closedWith === undefined) this.closedWith = 1006; this.notify(); });
    sock.on("error", () => {});
  }
  private notify(): void { const w = this.waiters; this.waiters = []; for (const f of w) f(); }
  /** Resolves when `count` frames arrived (or the socket closed). */
  async waitFor(count: number): Promise<void> {
    while (this.received.length < count && this.closedWith === undefined) await new Promise<void>((r) => this.waiters.push(r));
  }
  async waitClosed(): Promise<number> {
    while (this.closedWith === undefined) await new Promise<void>((r) => this.waiters.push(r));
    return this.closedWith;
  }
  json(i: number): any { return JSON.parse(String(this.received[i])); }
  jsonFrames(): any[] { return this.received.filter((x): x is string => typeof x === "string").map((s) => JSON.parse(s)); }
  send(value: unknown): void { this.rawSend(1, Buffer.from(typeof value === "string" ? value : JSON.stringify(value))); }
  close(code = 1000): void { const p = Buffer.alloc(2); p.writeUInt16BE(code); this.rawSend(8, p); this.sock.end(); }
  private rawSend(opcode: number, payload: Buffer): void {
    if (this.sock.destroyed || !this.sock.writable) return;
    let head: Buffer;
    if (payload.length < 126) head = Buffer.from([0x80 | opcode, payload.length]);
    else if (payload.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(payload.length, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
    this.sock.write(Buffer.concat([head, payload]));
  }
}

function parseFrame(buf: Buffer): { opcode: number; payload: Buffer; used: number } | undefined {
  if (buf.length < 2) return undefined;
  const opcode = buf[0]! & 0x0f;
  const masked = (buf[1]! & 0x80) !== 0;
  let len = buf[1]! & 0x7f;
  let off = 2;
  if (len === 126) { if (buf.length < 4) return undefined; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return undefined; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  const maskLen = masked ? 4 : 0;
  if (buf.length < off + maskLen + len) return undefined;
  const payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
  if (masked) { const m = buf.subarray(off, off + 4); for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ m[i % 4]!; }
  return { opcode, payload, used: off + maskLen + len };
}

export interface RecordedRequest { method: string; url: string; headers: IncomingMessage["headers"]; body: Buffer }
export interface FakeVendorHandlers {
  http?: (req: RecordedRequest, res: ServerResponse) => void | Promise<void>;
  /** Called for each accepted socket; return nothing. */
  ws?: (socket: FakeSocket) => void;
  /** Reject the upgrade with this status instead of accepting. */
  rejectUpgrade?: (req: IncomingMessage) => number | undefined;
}
export interface FakeVendor {
  port: number;
  httpUrl: string;
  wsUrl: string;
  requests: RecordedRequest[];
  sockets: FakeSocket[];
  close(): Promise<void>;
}

export async function startFakeVendor(h: FakeVendorHandlers): Promise<FakeVendor> {
  const requests: RecordedRequest[] = [];
  const sockets: FakeSocket[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rec = { method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers, body: Buffer.concat(chunks) };
      requests.push(rec);
      if (!h.http) { res.statusCode = 404; res.end(); return; }
      Promise.resolve(h.http(rec, res)).catch(() => { if (!res.headersSent) res.statusCode = 500; res.end(); });
    });
  });
  server.on("upgrade", (req, sock: Duplex) => {
    const rej = h.rejectUpgrade?.(req);
    if (rej !== undefined) { sock.write(`HTTP/1.1 ${rej} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); sock.end(); return; }
    const key = String(req.headers["sec-websocket-key"]);
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const s = new FakeSocket(sock, req);
    sockets.push(s);
    h.ws?.(s);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    port, httpUrl: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}`, requests, sockets,
    close: () => new Promise<void>((r) => { for (const s of sockets) s.close(); server.closeAllConnections(); server.close(() => r()); }),
  };
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}
