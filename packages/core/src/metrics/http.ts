// `GET /metrics`: a read-only, loopback-only, token-protected HTTP endpoint for the Prometheus text format.
//
// - Bound to a loopback address only (a non-loopback `host` is refused at construction).
// - `GET`/`HEAD` on exactly `/metrics`; everything else is 404/405. Nothing is ever written or changed.
// - `Authorization: Bearer <token>` only (never a query parameter: URLs end up in logs), compared in constant time.
// - The Host header must be a loopback name (DNS-rebinding defence) and the peer must be a loopback address.
// - Repeated failures lock the client out for a while (fake-clock testable).
// - RBAC: the token is turned into a principal with scopes by the `MetricsAccess` port; `metrics.read` is required.
//   // RULING: main has no RBAC layer yet (no RPC_RULES/policy.ts), so the port's default grants one token exactly
//   // `metrics.read`; a later RBAC change implements `MetricsAccess` against its policy.
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { HarnessLogger } from "./logger-port.ts";

export const METRICS_SCOPE = "metrics.read";
const MIN_TOKEN_CHARS = 32;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 60_000;
const LOCKOUT_MS = 60_000;
const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

export interface MetricsPrincipal { principal: string; scopes: readonly string[] }
/** The authorization port: a token to the principal it stands for, or null when it is unknown. */
export interface MetricsAccess { authorize(token: string): MetricsPrincipal | null }

export interface MetricsServerOptions {
  token: string;
  /** TCP port; 0 picks a free one (tests). */
  port: number;
  /** Loopback address only (default 127.0.0.1). */
  host?: string;
  render: () => string;
  logger: HarnessLogger;
  access?: MetricsAccess;
  clock?: () => number;
}
export interface MetricsServer { listen(): Promise<{ host: string; port: number }>; close(): Promise<void> }

function isLoopbackAddress(a: string | undefined): boolean {
  if (!a) return false;
  const v = a.startsWith("::ffff:") ? a.slice(7) : a;
  if (isIP(v) === 4) return v.split(".")[0] === "127";
  return v === "::1";
}
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Host header → loopback name? `127.0.0.1[:p]`, `localhost[:p]`, `[::1][:p]`. */
function loopbackHost(h: string | undefined): boolean {
  if (!h) return false;
  const m = /^(\[[0-9a-fA-F:]+\]|[^:]+)(?::\d{1,5})?$/.exec(h.trim());
  if (!m) return false;
  const name = m[1]!.toLowerCase();
  return name === "localhost" || name === "[::1]" || (isIP(name) === 4 && name.startsWith("127."));
}

export function createMetricsServer(o: MetricsServerOptions): MetricsServer {
  const host = o.host ?? "127.0.0.1";
  if (!(isIP(host) !== 0 && isLoopbackAddress(host))) throw new Error(`metrics endpoint must bind a loopback address, not ${JSON.stringify(host)}`);
  if (typeof o.token !== "string" || o.token.length < MIN_TOKEN_CHARS) throw new Error(`metrics token must be at least ${MIN_TOKEN_CHARS} characters`);
  const clock = o.clock ?? Date.now;
  const tokenDigest = sha(o.token);
  const access: MetricsAccess = o.access ?? { authorize: (t) => (timingSafeEqual(sha(t), tokenDigest) ? { principal: "metrics-reader", scopes: [METRICS_SCOPE] } : null) };
  // Failures per peer address (loopback has few of them); bounded so a flood cannot grow it.
  const failures = new Map<string, { times: number[]; lockedUntil: number }>();
  let server: Server | null = null;

  function reply(res: ServerResponse, status: number, body: string, headers: Record<string, string | number> = {}, head = false): void {
    res.writeHead(status, {
      "content-type": status === 200 ? CONTENT_TYPE : "text/plain; charset=utf-8",
      "content-length": Buffer.byteLength(body), "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers,
    });
    res.end(head ? undefined : body);
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const peer = req.socket.remoteAddress;
    if (!isLoopbackAddress(peer) || !loopbackHost(req.headers.host)) return reply(res, 403, "forbidden\n");
    const method = req.method ?? "";
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/metrics") return reply(res, 404, "not found\n");
    if (method !== "GET" && method !== "HEAD") return reply(res, 405, "method not allowed\n", { allow: "GET, HEAD" });

    const now = clock();
    const f = failures.get(peer!) ?? { times: [], lockedUntil: 0 };
    if (f.lockedUntil > now) return reply(res, 429, "too many failed attempts\n", { "retry-after": Math.ceil((f.lockedUntil - now) / 1000) });

    const m = /^Bearer ([^\s]+)$/.exec(req.headers.authorization ?? "");
    const granted = m ? access.authorize(m[1]!) : null;
    if (!granted) {
      f.times = f.times.filter((t) => now - t < FAILURE_WINDOW_MS); f.times.push(now);
      if (f.times.length >= MAX_FAILURES) { f.lockedUntil = now + LOCKOUT_MS; f.times = []; o.logger.warn("metrics endpoint locked after repeated failures"); }
      if (failures.size < 1024) failures.set(peer!, f);
      return reply(res, 401, "unauthorized\n", { "www-authenticate": 'Bearer realm="plur1bus-metrics"' });
    }
    failures.delete(peer!);
    if (!granted.scopes.includes(METRICS_SCOPE)) return reply(res, 403, "forbidden\n");
    let body: string;
    try { body = o.render(); } catch (err) { o.logger.error("metrics render failed", { err }); return reply(res, 500, "internal error\n"); }
    reply(res, 200, body, {}, method === "HEAD");
  }

  return {
    async listen() {
      const s = createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 5_000, keepAliveTimeout: 5_000 }, handle);
      s.maxHeadersCount = 50;
      server = s;
      await new Promise<void>((res, rej) => { s.once("error", rej); s.listen(o.port, host, () => { s.off("error", rej); res(); }); });
      const a = s.address();
      if (!a || typeof a === "string") throw new Error("metrics endpoint has no TCP address");
      o.logger.info("metrics endpoint listening", { host, port: a.port });
      return { host, port: a.port };
    },
    async close() {
      const s = server; server = null;
      if (!s) return;
      await new Promise<void>((res) => { s.close(() => res()); s.closeAllConnections(); });
    },
  };
}
