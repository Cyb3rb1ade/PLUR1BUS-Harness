import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { AuditEmitter } from "./audit.ts";
import type { Clock } from "./clock.ts";
import type { RateLimiter } from "./rate-limit.ts";
import { authorize, type RbacPrincipal } from "./rbac-bridge.ts";
import { readCookie, type Session, type SessionStore } from "./session.ts";

/** Reserved for a future PTY channel. Approvals already use SSE; no application messages are accepted. */
export const WS_PROTOCOL = "plur1bus-reserved";
export const WS_ACTION = "settings.write";
export interface WsLimits {
  maxFrameBytes: number; maxMessageBytes: number; maxBufferedBytes: number; maxConnections: number;
  ticketTtlMs: number; maxTicketsPerSession: number; pingIntervalMs: number; pongTimeoutMs: number; checkIntervalMs: number; authorizationTimeoutMs: number;
}
export const DEFAULT_WS_LIMITS: WsLimits = {
  maxFrameBytes: 16 * 1024, maxMessageBytes: 64 * 1024, maxBufferedBytes: 128 * 1024, maxConnections: 32,
  ticketTtlMs: 30_000, maxTicketsPerSession: 4, pingIntervalMs: 15_000, pongTimeoutMs: 10_000, checkIntervalMs: 1_000, authorizationTimeoutMs: 2_000,
};
export interface WsOptions {
  sessions: SessionStore; cookieName: string; clock: Clock; limiter: RateLimiter; /** Width of the address bucket (>1 when all clients share one address). */ ipScale?: number; audit: AuditEmitter;
  resolve(session: Session): Promise<{ rbac: RbacPrincipal; version: number } | undefined>;
  /** These callbacks must use the listener's exact configured authorities, including its bound port. */
  allowedHost(host: string): boolean; allowedOrigin(origin: string): boolean; limits?: Partial<WsLimits>;
}
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
function frame(op: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const h = Buffer.alloc(payload.length < 126 ? 2 : 4); h[0] = 0x80 | op;
  if (payload.length < 126) h[1] = payload.length; else { h[1] = 126; h.writeUInt16BE(payload.length, 2); }
  return Buffer.concat([h, payload]);
}
interface Peer { session: Session; userId: string; stop(code: number, reason: string): void }

export function createWsRoute(o: WsOptions) {
  const limits = { ...DEFAULT_WS_LIMITS, ...o.limits };
  for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid WebSocket limit: ${key}`);
  const tickets = new WeakMap<Session, Map<string, number>>();
  const peers = new Set<Peer>(); let closed = false;
  // Rejected handshakes must not let unauthenticated peers flood the audit sink. Bounded, credential-free keys.
  const deniedAudit = new Map<string, number>();
  const unsubscribe = o.sessions.onEnd(session => { tickets.delete(session); for (const p of peers) if (p.session === session) p.stop(1008, "session-ended"); });
  async function resolveBounded(session: Session) {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([o.resolve(session), new Promise<undefined>((_, reject) => {
        timer = setTimeout(() => reject(new Error("authorization timed out")), limits.authorizationTimeoutMs); timer.unref();
      })]);
    } finally { clearTimeout(timer); }
  }
  function issue(sessionId: string): { ticket: string; expiresAt: number } | undefined {
    const session = o.sessions.peek(sessionId); if (!session || session.mustRotate || closed) return undefined;
    const now = o.clock.now(); const entries = tickets.get(session) ?? new Map<string, number>();
    for (const [hash, exp] of entries) if (exp <= now) entries.delete(hash);
    while (entries.size >= limits.maxTicketsPerSession) entries.delete(entries.keys().next().value!);
    const ticket = randomBytes(32).toString("base64url"); const expiresAt = now + limits.ticketTtlMs;
    entries.set(digest(ticket), expiresAt); tickets.set(session, entries); return { ticket, expiresAt };
  }
  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    let actor = "anonymous";
    const deny = (status: number, reason: string) => {
      const auditKey = `${actor}\u0000${reason}`; const now = o.clock.now(); const previous = deniedAudit.get(auditKey);
      if (previous === undefined || now - previous >= 60_000) {
        deniedAudit.delete(auditKey); deniedAudit.set(auditKey, now);
        while (deniedAudit.size > 128) deniedAudit.delete(deniedAudit.keys().next().value!);
        o.audit.emit(status === 429 ? "auth.rate-limited" : "auth.denied", actor, "route:web.ws", { reason, class: "stream" });
      }
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\r\n`);
    };
    socket.on("error", () => {});
    try {
      if (closed) return deny(503, "shutdown");
      if (req.url !== "/ws" || req.method !== "GET") return deny(400, "target");
      if (!req.headers.host || !o.allowedHost(req.headers.host.toLowerCase())) return deny(421, "host");
      if (!req.headers.origin || !o.allowedOrigin(req.headers.origin.toLowerCase())) return deny(403, "origin");
      if (req.headers["sec-fetch-site"] !== undefined && req.headers["sec-fetch-site"] !== "same-origin" && req.headers["sec-fetch-site"] !== "none") return deny(403, "cross-site");
      const ip = (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
      if (!o.limiter.take("stream", `ip:${ip}`, o.ipScale ?? 1).ok) return deny(429, "rate-limit");
      const id = readCookie(req.headers.cookie, o.cookieName); const session = o.sessions.peek(id);
      if (!session || !id) return deny(401, "session");
      actor = session.principal.id;
      if (req.headers.authorization !== undefined) return deny(403, "session-only");
      if (!o.limiter.take("stream", `principal:${actor}`).ok) return deny(429, "rate-limit");
      const resolved = await resolveBounded(session);
      if (closed || socket.destroyed || !resolved || session.mustRotate || resolved.version !== session.authVersion || o.sessions.peek(id) !== session) return deny(401, "session-changed");
      if (authorize(resolved.rbac, WS_ACTION, { kind: "system" }).effect !== "allow") return deny(403, "role");
      const key = req.headers["sec-websocket-key"];
      if (req.headers.upgrade?.toLowerCase() !== "websocket" || !(req.headers.connection ?? "").toLowerCase().split(",").map(s => s.trim()).includes("upgrade") || req.headers["sec-websocket-version"] !== "13" || typeof key !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, "base64").length !== 16) return deny(400, "handshake");
      const protocols = (req.headers["sec-websocket-protocol"] ?? "").split(",").map(s => s.trim());
      if (protocols.length !== 2 || protocols[0] !== WS_PROTOCOL || !/^csrf\.[A-Za-z0-9_-]{43}$/.test(protocols[1]!)) return deny(403, "ticket");
      const entries = tickets.get(session); const hash = digest(protocols[1]!.slice(5)); const expiry = entries?.get(hash);
      entries?.delete(hash);
      if (expiry === undefined || expiry <= o.clock.now()) return deny(403, "ticket");
      if (peers.size >= limits.maxConnections) return deny(429, "connections");
      if (head.length > limits.maxBufferedBytes) return deny(400, "buffer-limit");
      const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${WS_PROTOCOL}\r\n\r\n`);
      let done = false; let buffer = Buffer.alloc(0); let fragmented = false; let messageBytes = 0;
      let lastPing = o.clock.now(); let pending: Buffer | undefined; let pingAt = 0; let checking = false;
      const stop = (code: number, reason: string) => {
        if (done) return; done = true; clearInterval(timer); peers.delete(peer);
        const payload = Buffer.alloc(2); payload.writeUInt16BE(code); socket.end(frame(8, payload));
        const destroy = setTimeout(() => socket.destroy(), 100); destroy.unref(); socket.once("close", () => clearTimeout(destroy));
        o.audit.emit("transport.ws.closed", actor, "route:web.ws", { reason, code });
      };
      const peer: Peer = { session, userId: resolved.rbac.userId, stop }; peers.add(peer);
      const data = (chunk: Buffer) => {
        if (done) return;
        if (buffer.length + chunk.length > limits.maxBufferedBytes) return stop(1009, "buffer-limit");
        buffer = Buffer.concat([buffer, chunk]);
        while (!done && buffer.length >= 2) {
          const first = buffer[0]!; const op = first & 15; const fin = (first & 128) !== 0; const second = buffer[1]!;
          if ((first & 112) !== 0 || (second & 128) === 0 || ![0, 1, 2, 8, 9, 10].includes(op)) return stop(1002, "frame");
          let len = second & 127; let offset = 2;
          if (len === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); offset = 4; if (len < 126) return stop(1002, "length"); }
          else if (len === 127) { if (buffer.length < 10) return; const n = buffer.readBigUInt64BE(2); if (n >> 63n) return stop(1002, "length"); if (n > BigInt(limits.maxFrameBytes)) return stop(1009, "frame-limit"); len = Number(n); offset = 10; if (len < 65536) return stop(1002, "length"); }
          if (len > limits.maxFrameBytes) return stop(1009, "frame-limit");
          if (op >= 8 && (!fin || len > 125)) return stop(1002, "control-frame");
          if (buffer.length < offset + 4 + len) return;
          const mask = buffer.subarray(offset, offset + 4); const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + len));
          for (let i = 0; i < len; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
          buffer = buffer.subarray(offset + 4 + len);
          if (op === 8) {
            if (len === 1) return stop(1002, "close-frame");
            if (len >= 2) {
              const code = payload.readUInt16BE(0);
              if (![1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014].includes(code) && !(code >= 3000 && code <= 4999)) return stop(1002, "close-code");
              try { new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(2)); } catch { return stop(1007, "close-reason"); }
            }
            return stop(1000, "client-close");
          }
          if (op === 9) { if (socket.writableLength > limits.maxBufferedBytes) return stop(1009, "write-limit"); socket.write(frame(10, payload)); continue; }
          if (op === 10) { if (pending?.equals(payload)) pending = undefined; continue; }
          if ((op === 0 && !fragmented) || (op !== 0 && fragmented)) return stop(1002, "fragment-order");
          messageBytes += len;
          if (messageBytes > limits.maxMessageBytes) return stop(1009, "message-limit");
          fragmented = !fin;
          if (fin) return stop(1003, "reserved-channel");
        }
      };
      const timer = setInterval(() => {
        if (done || checking) return; checking = true;
        void (async () => {
          const now = o.clock.now();
          if (o.sessions.peek(id) !== session || session.mustRotate) return stop(1008, "session-ended");
          const live = await resolveBounded(session);
          if (!live || live.version !== resolved.version || authorize(live.rbac, WS_ACTION, { kind: "system" }).effect !== "allow") return stop(1008, "rights-changed");
          if (done) return;
          if (pending && now - pingAt >= limits.pongTimeoutMs) return stop(1008, "pong-timeout");
          if (!pending && now - lastPing >= limits.pingIntervalMs) {
            pending = randomBytes(8); pingAt = now; lastPing = now; socket.write(frame(9, pending));
          }
        })().catch(() => stop(1008, "authorization-unavailable")).finally(() => { checking = false; });
      }, limits.checkIntervalMs); timer.unref();
      socket.on("data", data); socket.once("close", () => { done = true; peers.delete(peer); clearInterval(timer); });
      o.audit.emit("transport.ws.opened", actor, "route:web.ws");
      if (head.length) data(head);
    } catch { deny(503, "upgrade-unavailable"); }
  }
  return { issue, upgrade,
    revoke(userId: string) { for (const p of peers) if (p.userId === userId || p.session.principal.id === userId) p.stop(1008, "rights-changed"); },
    close() { closed = true; unsubscribe(); for (const p of peers) p.stop(1001, "shutdown"); },
  };
}
