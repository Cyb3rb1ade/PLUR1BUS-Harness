import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { isIP, type Socket } from "node:net";
import type { HarnessLogger } from "@plur1bus/module-api";
import { systemClock, type Clock } from "./clock.ts";
import type { CoreRpc } from "./core-rpc.ts";
import { ApiError, errorBody, errors } from "./errors.ts";
import { securityHeaders } from "./headers.ts";
import { DEFAULT_RATE_CLASSES, RateLimiter, type RateClasses } from "./rate-limit.ts";
import { redactFields } from "./redact.ts";
import { buildHandlers, COOKIE_NAME, COOKIE_NAME_TLS, CSRF_HEADER, ROUTES, type Handler, type RouteSpec } from "./routes.ts";
import { DEFAULT_SESSION_LIMITS, OWNER, ownerTokenVerifier, readCookie, SessionStore, type SessionLimits } from "./session.ts";

export interface ApiLimits {
  maxBodyBytes: number; handlerTimeoutMs: number; healthTimeoutMs: number;
  requestTimeoutMs: number; headersTimeoutMs: number; keepAliveTimeoutMs: number; maxConnections: number; maxHeaderBytes: number;
}
export const DEFAULT_LIMITS: ApiLimits = {
  maxBodyBytes: 64 * 1024, handlerTimeoutMs: 10_000, healthTimeoutMs: 2_000,
  requestTimeoutMs: 15_000, headersTimeoutMs: 10_000, keepAliveTimeoutMs: 5_000, maxConnections: 128, maxHeaderBytes: 16 * 1024,
};

export type ApiLogger = Pick<HarnessLogger, "debug" | "info" | "warn" | "error">;
const noopLogger: ApiLogger = { debug() {}, info() {}, warn() {}, error() {} };

export interface ApiServerOptions {
  core: CoreRpc;
  /** The owner credential `POST /api/v1/session` checks (ruling R2). At least 32 characters. */
  ownerToken: string;
  /** Loopback only (ruling R7); anything else is refused. Default `127.0.0.1`. */
  host?: string; port?: number;
  /** A PEM key and certificate: the listener is then HTTPS, the cookie `Secure`, HSTS is sent. */
  tls?: { key: string | Buffer; cert: string | Buffer };
  logger?: ApiLogger; clock?: Clock;
  limits?: Partial<ApiLimits>; rateClasses?: RateClasses; sessionLimits?: SessionLimits;
}

export interface ApiServer {
  listen(): Promise<{ host: string; port: number; url: string }>;
  close(): Promise<void>;
  readonly server: Server;
}

/** The address to bind for a loopback host, or a refusal. `localhost` is pinned to 127.0.0.1 so it cannot resolve
 *  somewhere else. Fail closed: exposure beyond loopback is D35's, not this slice's (ruling R7). */
export function loopbackBind(host: string): string {
  if (host === "localhost") return "127.0.0.1";
  const family = isIP(host);
  if ((family === 4 && host.startsWith("127.")) || (family === 6 && host === "::1")) return host;
  throw new Error(`the API binds loopback only (127.0.0.0/8, ::1, localhost); refusing ${JSON.stringify(host)}`);
}

const REASONS: Record<number, string> = { 200: "OK", 400: "Bad Request", 408: "Request Timeout", 431: "Request Header Fields Too Large" };

function drain(req: IncomingMessage, cap: number): void {
  let seen = 0;
  req.on("data", (c: Buffer) => { seen += c.length; if (seen > cap) req.destroy(); });
  req.on("error", () => {});
  req.resume();
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0; let done = false;
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > limit) { done = true; reject(errors.tooLarge(limit)); return; }
      chunks.push(c);
    });
    req.on("end", () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on("error", (e) => { if (!done) { done = true; reject(e); } });
    req.on("aborted", () => { if (!done) { done = true; reject(errors.badRequest("aborted", "the request was aborted")); } });
  });
}

function parseJson(raw: Buffer): unknown {
  if (raw.length === 0) throw errors.badRequest("body", "a JSON body is required");
  try { return JSON.parse(raw.toString("utf8")); } catch { throw errors.badRequest("json", "the body is not valid JSON"); }
}

export function createApiServer(o: ApiServerOptions): ApiServer {
  const bindHost = loopbackBind(o.host ?? "127.0.0.1");
  const verifyOwner = ownerTokenVerifier(o.ownerToken);
  if ((o.tls && !(o.tls.key && o.tls.cert))) throw new Error("tls needs both key and cert");
  const tls = o.tls !== undefined;
  const clock = o.clock ?? systemClock;
  const limits: ApiLimits = { ...DEFAULT_LIMITS, ...o.limits };
  const base = o.logger ?? noopLogger;
  // Whatever a call site passes, credential-named fields never reach the sink.
  const log: ApiLogger = {
    debug: (m, f) => base.debug(m, f && (redactFields(f) as Record<string, unknown>)),
    info: (m, f) => base.info(m, f && (redactFields(f) as Record<string, unknown>)),
    warn: (m, f) => base.warn(m, f && (redactFields(f) as Record<string, unknown>)),
    error: (m, f) => base.error(m, f && (redactFields(f) as Record<string, unknown>)),
  };
  const sessions = new SessionStore(clock, o.sessionLimits ?? DEFAULT_SESSION_LIMITS);
  const limiter = new RateLimiter(clock, o.rateClasses ?? DEFAULT_RATE_CLASSES);
  const handlers = buildHandlers({ core: o.core, sessions, verifyOwner, clock, tls, principal: OWNER, healthTimeoutMs: limits.healthTimeoutMs, log });
  const cookieName = tls ? COOKIE_NAME_TLS : COOKIE_NAME;
  const secHeaders = securityHeaders(tls);
  const byPath = new Map<string, Map<string, { spec: RouteSpec; handler: Handler }>>();
  for (const spec of ROUTES) {
    const handler = handlers[spec.id]; if (!handler) throw new Error(`no handler for route ${spec.id}`);
    const m = byPath.get(spec.path) ?? new Map(); m.set(spec.method, { spec, handler }); byPath.set(spec.path, m);
  }

  let allowedHosts = new Set<string>(); let allowedOrigins = new Set<string>();

  const send = (res: ServerResponse, status: number, body: object, extra: Record<string, string> = {}): void => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    if (res.headersSent) { res.end(); return; }
    res.writeHead(status, { ...secHeaders, "Content-Type": "application/json; charset=utf-8", "Content-Length": payload.length, ...extra });
    res.end(payload);
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const t0 = process.hrtime.bigint();
    const ip = (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
    let routeId = "-"; let principalId: string | undefined; let status = 500;
    try {
      const host = req.headers.host?.toLowerCase();
      if (!host || !allowedHosts.has(host)) throw errors.misdirected();
      const target = req.url ?? "";
      if (!target.startsWith("/")) throw errors.badRequest("target", "the request target must be an origin-form path");
      const path = target.split("?", 1)[0]!;
      // Cross-origin browsers: an Origin we did not issue, or a fetch that is not same-origin, is refused (ruling R6). This runs
      // before the rate limiter: a hostile page shares the browser's loopback IP, and its refused requests must not drain the
      // owner's login and read buckets (review F1).
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedOrigins.has(origin.toLowerCase())) throw errors.forbidden("origin");
      const site = req.headers["sec-fetch-site"];
      if (site !== undefined && site !== "same-origin" && site !== "none") throw errors.forbidden("cross-site");
      const methods = byPath.get(path); const route = methods?.get(req.method ?? "");
      const cls = route?.spec.rate ?? "read";
      const ipVerdict = limiter.take(cls, `ip:${ip}`);
      if (!ipVerdict.ok) throw errors.rateLimited(ipVerdict.retryAfterSec);
      if (!methods) throw errors.notFound();
      if (!route) throw errors.methodNotAllowed([...methods.keys()]);
      const { spec, handler } = route; routeId = spec.id;

      const declared = req.headers["content-length"];
      if (declared !== undefined) {
        const n = Number(declared);
        if (!/^\d+$/.test(declared) || !Number.isSafeInteger(n)) throw errors.badRequest("content-length", "invalid Content-Length");
        if (n > limits.maxBodyBytes) { drain(req, limits.maxBodyBytes * 4 + 65_536); throw errors.tooLarge(limits.maxBodyBytes); }
      }

      let sessionId: string | undefined; let session; 
      if (spec.auth === "session") {
        sessionId = readCookie(req.headers.cookie, cookieName);
        session = sessions.get(sessionId);
        if (!session) throw errors.unauthenticated();
        principalId = session.principal.id;
        const pv = limiter.take(cls, `principal:${principalId}`);
        if (!pv.ok) throw errors.rateLimited(pv.retryAfterSec);
        if (spec.csrf && !sessions.consumeCsrf(sessionId!, req.headers[CSRF_HEADER] as string | undefined)) throw errors.forbidden("csrf", "a valid one-time CSRF token is required");
      }

      let body: unknown;
      if (spec.requestBody) {
        const ct = (req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
        if (ct !== "application/json") throw errors.unsupportedMedia();
        body = parseJson(await readBody(req, limits.maxBodyBytes));
      } else if (declared !== undefined && declared !== "0") {
        await readBody(req, limits.maxBodyBytes); // counted against the limit, then ignored
      }

      let timer: NodeJS.Timeout | undefined;
      const out = await Promise.race([
        Promise.resolve(handler({ principal: session?.principal, session, sessionId, body })),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(errors.timeout()), limits.handlerTimeoutMs); }),
      ]).finally(() => clearTimeout(timer));
      status = out.status ?? spec.successStatus;
      send(res, status, out.body, out.headers);
    } catch (e) {
      let err: ApiError;
      if (e instanceof ApiError) err = e;
      else { err = errors.internal(); log.error("unhandled error", { route: routeId, error: e instanceof Error ? `${e.name}: ${e.message}` : "non-error thrown" }); }
      status = err.status;
      send(res, err.status, errorBody(err), err.headers);
    } finally {
      log.info("request", { method: req.method, route: routeId, status, ip, principal: principalId, ms: Number((process.hrtime.bigint() - t0) / 1_000_000n) });
    }
  }

  const serverOptions = { maxHeaderSize: limits.maxHeaderBytes, requestTimeout: limits.requestTimeoutMs, headersTimeout: Math.min(limits.headersTimeoutMs, limits.requestTimeoutMs), keepAliveTimeout: limits.keepAliveTimeoutMs,
    // Node checks request/header timeouts only on this interval (default 30 s), so it must be shorter than they are.
    connectionsCheckingInterval: Math.max(25, Math.min(1000, Math.floor(Math.min(limits.requestTimeoutMs, limits.headersTimeoutMs) / 4))) };
  const server: Server = o.tls ? createHttpsServer({ ...serverOptions, key: o.tls.key, cert: o.tls.cert }, (q, r) => { void handle(q, r); }) : createHttpServer(serverOptions, (q, r) => { void handle(q, r); });
  server.maxConnections = limits.maxConnections;

  // Requests Node rejects before a handler runs (malformed, header overflow, request timeout) still get the headers and
  // the error/1 body; without a listener Node would write its own bare response.
  server.on("clientError", (err: NodeJS.ErrnoException, socket: Socket) => {
    if (!socket.writable || socket.destroyed) { socket.destroy(); return; }
    const status = err.code === "ERR_HTTP_REQUEST_TIMEOUT" ? 408 : err.code === "HPE_HEADER_OVERFLOW" ? 431 : 400;
    const e = status === 408 ? errors.timeout("request-timeout") : new ApiError(status, "E_INVALID_PARAMS", "malformed request", { reason: status === 431 ? "headers-too-large" : "malformed-request" });
    const payload = JSON.stringify(errorBody(e));
    const head = Object.entries({ ...secHeaders, "Content-Type": "application/json; charset=utf-8", "Content-Length": String(Buffer.byteLength(payload)), Connection: "close" }).map(([k, v]) => `${k}: ${v}`).join("\r\n");
    socket.end(`HTTP/1.1 ${status === 408 ? 408 : status} ${REASONS[status] ?? "Error"}\r\n${head}\r\n\r\n${payload}`);
    log.warn("malformed request", { status, code: err.code });
  });

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(o.port ?? 0, bindHost, () => {
          server.off("error", reject);
          const a = server.address(); if (!a || typeof a === "string") { reject(new Error("no address")); return; }
          const names = [bindHost.includes(":") ? `[${bindHost}]` : bindHost, "localhost", "127.0.0.1", "[::1]"];
          allowedHosts = new Set(names.map((n) => `${n}:${a.port}`));
          const scheme = tls ? "https" : "http";
          allowedOrigins = new Set([...allowedHosts].map((h) => `${scheme}://${h}`));
          const hostPart = bindHost.includes(":") ? `[${bindHost}]` : bindHost;
          log.info("listening", { host: bindHost, port: a.port, tls });
          resolve({ host: bindHost, port: a.port, url: `${scheme}://${hostPart}:${a.port}` });
        });
      });
    },
    close() {
      return new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    },
  };
}
