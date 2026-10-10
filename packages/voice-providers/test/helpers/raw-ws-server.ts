// A raw TCP server that does the RFC 6455 handshake by hand and then writes whatever bytes the test says, so the
// client's frame validation can be driven with hostile input. Loopback only. No sleeps: tests await observable events.
import { createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface ClientFrame { fin: boolean; opcode: number; masked: boolean; payload: Buffer }

export interface RawPeer {
  readonly frames: ClientFrame[];
  readonly headers: Record<string, string>;
  /** Write bytes to the client as they are. */
  write(bytes: Buffer): void;
  /** A well-formed unmasked server frame. */
  send(opcode: number, payload: Buffer | string, opts?: { fin?: boolean; rsv?: number; masked?: boolean }): void;
  /** Resolves once `count` client frames (any opcode) arrived. */
  waitFrames(count: number): Promise<void>;
  /** Resolves with the first client frame matching `opcode` that arrived after `from`. */
  waitOpcode(opcode: number, from?: number): Promise<ClientFrame>;
  waitClosed(): Promise<void>;
  end(): void;
  readonly socket: Socket;
  readonly closed: boolean;
}

export interface RawServer {
  url: string;
  peers: RawPeer[];
  /** Resolves with the next peer that completes the handshake. */
  nextPeer(): Promise<RawPeer>;
  close(): Promise<void>;
}

export interface RawServerOptions {
  /** Extra headers on the 101 response (for example Sec-WebSocket-Extensions). */
  upgradeHeaders?: Record<string, string>;
  /** Wrong Sec-WebSocket-Accept. */
  badAccept?: boolean;
  /** Reply with this status instead of upgrading. */
  status?: number;
  statusHeaders?: Record<string, string>;
}

export function frameBytes(opcode: number, payload: Buffer | string, opts: { fin?: boolean; rsv?: number; masked?: boolean } = {}): Buffer {
  const p = typeof payload === "string" ? Buffer.from(payload) : payload;
  const fin = opts.fin ?? true;
  const b0 = (fin ? 0x80 : 0) | ((opts.rsv ?? 0) << 4) | opcode;
  const m = opts.masked ? 0x80 : 0;
  let head: Buffer;
  if (p.length < 126) head = Buffer.from([b0, m | p.length]);
  else if (p.length < 65536) { head = Buffer.alloc(4); head[0] = b0; head[1] = m | 126; head.writeUInt16BE(p.length, 2); }
  else { head = Buffer.alloc(10); head[0] = b0; head[1] = m | 127; head.writeBigUInt64BE(BigInt(p.length), 2); }
  if (!opts.masked) return Buffer.concat([head, p]);
  const key = Buffer.from([1, 2, 3, 4]);
  const body = Buffer.from(p);
  for (let i = 0; i < body.length; i++) body[i] = body[i]! ^ key[i % 4]!;
  return Buffer.concat([head, key, body]);
}

export function closePayload(code: number, reason = ""): Buffer {
  const r = Buffer.from(reason);
  const p = Buffer.alloc(2 + r.length);
  p.writeUInt16BE(code);
  r.copy(p, 2);
  return p;
}

export async function startRawServer(opts: RawServerOptions = {}): Promise<RawServer> {
  const peers: RawPeer[] = [];
  const waiting: Array<(p: RawPeer) => void> = [];
  let claimed = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer((sock) => {
    sock.setNoDelay(true);
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    let head = Buffer.alloc(0);
    let upgraded = false;
    const frames: ClientFrame[] = [];
    let waiters: Array<() => void> = [];
    let buf = Buffer.alloc(0);
    let closed = false;
    const notify = () => { const w = waiters; waiters = []; for (const f of w) f(); };
    const headers: Record<string, string> = {};
    const peer: RawPeer = {
      frames, headers, socket: sock,
      get closed() { return closed; },
      write: (b) => { if (!sock.destroyed && sock.writable) sock.write(b); },
      send: (opcode, payload, o) => peer.write(frameBytes(opcode, payload, o)),
      async waitFrames(count) { while (frames.length < count && !closed) await new Promise<void>((r) => waiters.push(r)); },
      async waitOpcode(opcode, from = 0) {
        for (;;) {
          const f = frames.slice(from).find((x) => x.opcode === opcode);
          if (f) return f;
          if (closed) throw new Error(`socket closed before opcode ${opcode} arrived`);
          await new Promise<void>((r) => waiters.push(r));
        }
      },
      async waitClosed() { while (!closed) await new Promise<void>((r) => waiters.push(r)); },
      end: () => sock.end(),
    };
    sock.on("close", () => { closed = true; notify(); });
    sock.on("data", (d: Buffer) => {
      if (!upgraded) {
        head = Buffer.concat([head, d]);
        const idx = head.indexOf("\r\n\r\n");
        if (idx < 0) return;
        const text = head.subarray(0, idx).toString("utf8");
        const rest = head.subarray(idx + 4);
        for (const line of text.split("\r\n").slice(1)) { const c = line.indexOf(":"); if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim(); }
        if (opts.status !== undefined) {
          const extra = Object.entries(opts.statusHeaders ?? {}).map(([k, v]) => `${k}: ${v}\r\n`).join("");
          sock.write(`HTTP/1.1 ${opts.status} Refused\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`);
          sock.end();
          return;
        }
        const accept = opts.badAccept ? "AAAAAAAAAAAAAAAAAAAAAAAAAAA=" : createHash("sha1").update(`${headers["sec-websocket-key"]}${GUID}`).digest("base64");
        const extra = Object.entries(opts.upgradeHeaders ?? {}).map(([k, v]) => `${k}: ${v}\r\n`).join("");
        sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${extra}\r\n`);
        upgraded = true;
        peers.push(peer);
        const w = waiting.shift();
        if (w) w(peer);
        if (rest.length === 0) return;
        d = rest;
      }
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) break;
        const fin = (buf[0]! & 0x80) !== 0;
        const opcode = buf[0]! & 0x0f;
        const masked = (buf[1]! & 0x80) !== 0;
        let len = buf[1]! & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const total = off + (masked ? 4 : 0) + len;
        if (buf.length < total) break;
        const payload = Buffer.from(buf.subarray(off + (masked ? 4 : 0), total));
        if (masked) { const key = buf.subarray(off, off + 4); for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ key[i % 4]!; }
        buf = buf.subarray(total);
        frames.push({ fin, opcode, masked, payload });
        notify();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}/`,
    peers,
    nextPeer: () => { const p = peers[claimed]; if (p) { claimed++; return Promise.resolve(p); } return new Promise((r) => { waiting.push((x) => { claimed++; r(x); }); }); },
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}
