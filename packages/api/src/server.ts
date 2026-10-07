import { statSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { isIP, type Socket } from "node:net";
import type { HarnessLogger } from "@plur1bus/module-api";
import { createAuditEmitter } from "./audit.ts";
import { systemClock, type Clock } from "./clock.ts";
import type { CoreRpc } from "./core-rpc.ts";
import { ApiError, errorBody, errors } from "./errors.ts";
import { htmlCsp, injectNonce, newNonce, securityHeaders } from "./headers.ts";
import { PasswordLogin, type LockoutPolicy } from "./login.ts";
import { MemoryTokenStore, MemoryTotpStore } from "./memory-stores.ts";
import type { TokenStore, TotpStore, UserDirectory } from "./ports.ts";
import { LoginChallenges } from "./challenge.ts";
import { DEFAULT_RATE_CLASSES, RateLimiter, type RateClasses } from "./rate-limit.ts";
import { createBreakGlass, type AuditSink, type BreakGlassNotice, type Decision, type RbacPrincipal, type Resource } from "./rbac-bridge.ts";
import { NoticeInbox } from "./notices.ts";
import { redactFields } from "./redact.ts";
import { createStaticServer } from "./static.ts";
import { buildHandlers, COOKIE_NAME, COOKIE_NAME_TLS, CSRF_HEADER, ROUTES, sessionCookie, type Handler, type RouteSpec } from "./routes.ts";
import { TokenService } from "./tokens.ts";
import { TotpService } from "./totp.ts";
import { DEFAULT_SESSION_LIMITS, OWNER, ownerTokenVerifier, readCookie, SessionStore, type Principal, type Session, type SessionLimits } from "./session.ts";

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
  /** Local accounts (password login). Without it only the owner token logs in. */
  users?: UserDirectory;
  /** Where personal API tokens live. The in-memory default forgets them at a restart; the real store is a follow-up. */
  tokens?: TokenStore;
  /** Where second-factor secrets live; the in-memory default forgets them at a restart (the real store is core's secret store, a follow-up). */
  totp?: TotpStore; totpIssuer?: string;
  /** Break-glass writes its own audit here and must not act unrecorded, so this is the unbuffered, fail-closed sink
   *  (default: `audit`; with neither, there is no break-glass). */
  breakGlassAudit?: AuditSink;
  /** Tells the affected user about a grant over their cards, through whatever channel the host has (delivery is a
   *  follow-up). The API's own inbox (`GET /me/notices`) is filled either way. A throwing hook is audited, the grant stands. */
  notifyBreakGlass?: (notice: BreakGlassNotice) => void;
  /** The hash-chained audit log of the core, or any sink with the same `append`. Without one nothing is audited. */
  audit?: AuditSink;
  /** The built web app (`packages/web/dist`): served read-only at `/` and below, never under `/api`, with a CSP nonce per
   *  page. Without it the API serves JSON only. */
  webRoot?: string;
  /** Loopback only (ruling R7); anything else is refused. Default `127.0.0.1`. */
  host?: string; port?: number;
  /** A PEM key and certificate: the listener is then HTTPS, the cookie `Secure`, HSTS is sent. */
  tls?: { key: string | Buffer; cert: string | Buffer };
  logger?: ApiLogger; clock?: Clock;
  limits?: Partial<ApiLimits>; rateClasses?: RateClasses; sessionLimits?: SessionLimits; lockout?: Partial<LockoutPolicy>;
  /** Test seam: routes served besides the table, to prove what the dispatcher does with a route that declares nothing. */
  extraRoutes?: ReadonlyArray<{ spec: RouteSpec; handler: Handler }>;
}

export interface ApiServer {
  listen(): Promise<{ host: string; port: number; url: string }>;
  close(): Promise<void>;
  readonly server: Server;
  /** A user's role or rights changed: their sessions get a new cookie value at their next request. */
  rightsChanged(userId: string): number;
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

interface Resolved { principal: Principal; rbac: RbacPrincipal; version: number }

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
  const audit = createAuditEmitter({ sink: o.audit, clock, log });
  const login = o.users ? new PasswordLogin({ users: o.users, clock, ...(o.lockout ? { policy: o.lockout } : {}) }) : undefined;
  const tokens = new TokenService({ store: o.tokens ?? new MemoryTokenStore(), clock });
  const totp = new TotpService({ store: o.totp ?? new MemoryTotpStore(), clock, issuer: o.totpIssuer ?? "PLUR1BUS Harness" });
  const challenges = new LoginChallenges(clock);
  const notices = new NoticeInbox(clock);
  const noSink: AuditSink = { append() { throw new Error("no audit sink configured"); } };
  const breakGlass = createBreakGlass({ audit: o.breakGlassAudit ?? o.audit ?? noSink, clock: () => clock.now(), host: "api", notify: (n) => { notices.add(n); o.notifyBreakGlass?.(n); } });
  const handlers = buildHandlers({ core: o.core, sessions, verifyOwner, clock, tls, principal: OWNER, healthTimeoutMs: limits.healthTimeoutMs, log, login, tokens, users: o.users, totp, challenges, limiter, breakGlass, notices, audit });
  if (o.webRoot !== undefined && !statSync(o.webRoot, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`webRoot ${JSON.stringify(o.webRoot)} is not a directory`);
  const staticFiles = o.webRoot !== undefined ? createStaticServer(o.webRoot) : undefined;
  const cookieName = tls ? COOKIE_NAME_TLS : COOKIE_NAME;
  const secHeaders = securityHeaders(tls);
  const byPath = new Map<string, Map<string, { spec: RouteSpec; handler: Handler }>>();
  const add = (spec: RouteSpec, handler: Handler | undefined) => {
    if (!handler) throw new Error(`no handler for route ${spec.id}`);
    const m = byPath.get(spec.path) ?? new Map(); m.set(spec.method, { spec, handler }); byPath.set(spec.path, m);
  };
  for (const spec of ROUTES) add(spec, handlers[spec.id]);
  for (const x of o.extraRoutes ?? []) add(x.spec, x.handler);

  let sweeper: NodeJS.Timeout | undefined;
  let allowedHosts = new Set<string>(); let allowedOrigins = new Set<string>();

  /** The Referer's origin must be one the API issued; an unparseable, scheme-relative or opaque (`null`) value is not. */
  const refererAllowed = (value: string): boolean => {
    try { const u = new URL(value); return (u.protocol === "http:" || u.protocol === "https:") && allowedOrigins.has(u.origin.toLowerCase()); } catch { return false; }
  };

  const send = (res: ServerResponse, status: number, body: object, extra: Record<string, string> = {}): void => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    if (res.headersSent) { res.end(); return; }
    res.writeHead(status, { ...secHeaders, "Content-Type": "application/json; charset=utf-8", "Content-Length": payload.length, ...extra });
    res.end(payload);
  };

  /** The principal of a session as it is *now*: owner from the bootstrap, users from the directory (so a demotion, a
   *  disabled account or a deleted one takes effect at the next request, whatever the session was made with). */
  async function resolve(session: Session): Promise<Resolved | undefined> { return resolveSubject(session.principal.kind, session.principal.id); }

  async function resolveSubject(kind: Principal["kind"] | undefined, id: string): Promise<Resolved | undefined> {
    if (kind === "owner" || (kind === undefined && id === OWNER.id)) return { principal: OWNER, rbac: { userId: OWNER.id, role: "owner", kind: "person" }, version: 0 };
    const u = await o.users?.findById(id);
    if (!u || u.disabled === true) return undefined;
    return {
      principal: { kind: "user", id: u.id, role: u.role },
      rbac: { userId: u.id, role: u.role, kind: "person", ...(u.agentRights ? { agentRights: u.agentRights } : {}), ...(u.projectRights ? { projectRights: u.projectRights } : {}) },
      version: u.version,
    };
  }

  /** Every route's declared authorization, evaluated by core's `authorize`. A route without a declaration is refused. */
  function decide(spec: RouteSpec, rbac: RbacPrincipal): Decision {
    const az = spec.authz as RouteSpec["authz"] | undefined;
    if (az === undefined || az === "public") return { effect: "deny", reason: "unknown-action" };
    if (az === "authenticated") return { effect: "allow", reason: "role" };
    // "user": some user, to be named by the handler, which asks the registry again with the real target.
    const resource: Resource = az.resource === "self" ? { kind: "user", userId: rbac.userId } : az.resource === "user" ? { kind: "user", userId: "*" } : { kind: "system" };
    // The registry honours the caller's live break-glass grants and audits their use; without one it is plain authorize().
    return breakGlass.authorize(rbac, az.action, resource);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const t0 = process.hrtime.bigint();
    const ip = (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
    let routeId = "-"; let principalId: string | undefined; let status = 500;
    const rateLimited = (scope: string, cls: string, retryAfterSec: number): never => {
      audit.emit("auth.rate-limited", principalId ?? "anonymous", scope, { class: cls, route: routeId, ip });
      throw errors.rateLimited(retryAfterSec);
    };
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
      // A write that names a Referer must name the API's own origin (even when Origin is fine: a browser never sends that
      // pair). Reads may carry any Referer, it is a normal link from elsewhere. A missing one is a non-browser client.
      const referer = req.headers.referer;
      if (referer !== undefined && req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS" && !refererAllowed(referer)) throw errors.forbidden("referer");
      const site = req.headers["sec-fetch-site"];
      if (site !== undefined && site !== "same-origin" && site !== "none") throw errors.forbidden("cross-site");
      const methods = byPath.get(path); const route = methods?.get(req.method ?? "");
      const cls = route?.spec.rate ?? "read";
      const ipVerdict = limiter.take(cls, `ip:${ip}`);
      if (!ipVerdict.ok) rateLimited(`ip:${ip}`, cls, ipVerdict.retryAfterSec);
      if (!methods) {
        // Not an API route: the app shell and its assets, if a web root is configured. Public by design (the sign-in page
        // must load before anyone is signed in), read-only, files below the root only, and never anything under /api.
        if (staticFiles && path !== "/api" && !path.startsWith("/api/")) {
          routeId = "static";
          if (req.method !== "GET" && req.method !== "HEAD") throw errors.methodNotAllowed(["GET", "HEAD"]);
          const f = await staticFiles.read(path);
          if (!f) throw errors.notFound();
          const nonce = f.html ? newNonce() : undefined;
          const body = nonce ? Buffer.from(injectNonce(f.body.toString("utf8"), nonce), "utf8") : f.body;
          status = 200;
          res.writeHead(200, { ...secHeaders, ...(nonce ? { "Content-Security-Policy": htmlCsp(nonce) } : {}), "Content-Type": f.contentType, "Content-Length": body.length });
          res.end(req.method === "HEAD" ? undefined : body);
          return;
        }
        throw errors.notFound();
      }
      if (!route) throw errors.methodNotAllowed([...methods.keys()]);
      const { spec, handler } = route; routeId = spec.id;

      const declared = req.headers["content-length"];
      if (declared !== undefined) {
        const n = Number(declared);
        if (!/^\d+$/.test(declared) || !Number.isSafeInteger(n)) throw errors.badRequest("content-length", "invalid Content-Length");
        if (n > limits.maxBodyBytes) { drain(req, limits.maxBodyBytes * 4 + 65_536); throw errors.tooLarge(limits.maxBodyBytes); }
      }

      const presented = readCookie(req.headers.cookie, cookieName);
      let sessionId: string | undefined; let session: Session | undefined; let resolved: Resolved | undefined; let rotated: string | undefined;
      let via: "session" | "token" | undefined; let tokenInfo: { id: string; prefix: string; scopes: readonly string[]; expiresAt: number } | undefined; let rateKey: string | undefined;
      const authHeader = req.headers.authorization;
      const bearer = spec.auth === "any" && typeof authHeader === "string" && /^bearer(\s|$)/i.test(authHeader) ? authHeader.slice(6).trim() : undefined;
      if (bearer !== undefined) {
        // A personal API token. No cookie is consulted, so a bad token is a 401, never a fallback; no CSRF token is
        // needed because a browser never attaches this header by itself. A token acts as an agent principal: it can
        // never hold a human-only action, and its scopes only ever narrow the role it belongs to.
        const r = await tokens.authenticate(bearer);
        if (!r.ok) {
          audit.emit("auth.token.used-denied", "anonymous", r.id ? `token:${r.id}` : "token:-", { reason: r.reason, ip });
          throw errors.unauthenticated("invalid-token");
        }
        resolved = await resolveSubject(r.record.userId === OWNER.id ? "owner" : "user", r.record.userId);
        if (!resolved) { audit.emit("auth.token.used-denied", "anonymous", `token:${r.record.id}`, { reason: "account", ip }); throw errors.unauthenticated("invalid-token"); }
        resolved = { ...resolved, rbac: { ...resolved.rbac, kind: "agent", tokenScopes: r.record.scopes } };
        via = "token"; tokenInfo = { id: r.record.id, prefix: `plb_${r.record.id}`, scopes: r.record.scopes, expiresAt: r.record.expiresAt };
        principalId = resolved.principal.id; rateKey = `token:${r.record.id}`;
        const tv = limiter.take(cls, rateKey);
        if (!tv.ok) rateLimited(rateKey, cls, tv.retryAfterSec);
        const d = decide(spec, resolved.rbac);
        if (d.effect === "deny") {
          if (req.method !== "GET") audit.emit("auth.denied", principalId, `route:${spec.id}`, { reason: d.reason, method: req.method, via: "token", token: tokenInfo.id, ip, ...(typeof spec.authz === "object" ? { action: spec.authz.action } : {}) });
          throw errors.forbidden(d.reason);
        }
      } else if (spec.auth === "session" || spec.auth === "any") {
        via = "session";
        sessionId = presented;
        session = sessions.get(sessionId);
        if (!session) throw errors.unauthenticated();
        resolved = await resolve(session);
        if (!resolved) { sessions.destroy(sessionId); throw errors.unauthenticated("session-expired"); }
        principalId = resolved.principal.id;
        const pv = limiter.take(cls, `principal:${principalId}`);
        if (!pv.ok) rateLimited(`principal:${principalId}`, cls, pv.retryAfterSec);
        // The CSRF token is spent before any rotation: rotation drops the old session's tokens.
        if (spec.csrf && !sessions.consumeCsrf(sessionId!, req.headers[CSRF_HEADER] as string | undefined)) {
          audit.emit("auth.csrf-refused", principalId, `user:${principalId}`, { route: routeId, ip });
          throw errors.forbidden("csrf", "a valid one-time CSRF token is required");
        }
        // Rights changed since the session was made (or someone asked for it): the cookie value changes, the old one dies.
        if (session.mustRotate || resolved.version !== session.authVersion) {
          const r = sessions.rotate(sessionId, resolved.version);
          if (r) {
            sessionId = r.id; session = r.session;
            rotated = sessionCookie(tls, r.id, Math.max(1, Math.floor((r.session.absoluteExpiresAt - clock.now()) / 1000)));
            audit.emit("auth.session.rotated", principalId, `user:${principalId}`, { route: routeId });
          }
        }
        const d = decide(spec, resolved.rbac);
        if (d.effect === "deny") {
          if (req.method !== "GET") audit.emit("auth.denied", principalId, `route:${spec.id}`, { reason: d.reason, method: req.method, ip, ...(typeof spec.authz === "object" ? { action: spec.authz.action } : {}) });
          throw spec.authz === undefined ? errors.undeclared() : errors.forbidden(d.reason);
        }
      } else if ((spec.authz as RouteSpec["authz"] | undefined) !== "public") {
        // A route that is not authenticated by a session and not declared public has no way to be allowed.
        throw errors.undeclared();
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
        Promise.resolve(handler({ principal: resolved?.principal, session, sessionId, body, rbac: resolved?.rbac, presentedSessionId: spec.auth === "none" ? presented : undefined, ip, via, token: tokenInfo })),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(errors.timeout()), limits.handlerTimeoutMs); }),
      ]).finally(() => clearTimeout(timer));
      status = out.status ?? spec.successStatus;
      send(res, status, out.body, { ...(rotated ? { "Set-Cookie": rotated } : {}), ...out.headers });
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
    rightsChanged: (userId) => sessions.markRotate(userId),
    listen() {
      return new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(o.port ?? 0, bindHost, () => {
          server.off("error", reject);
          const a = server.address(); if (!a || typeof a === "string") { reject(new Error("no address")); return; }
          const names = [bindHost.includes(":") ? `[${bindHost}]` : bindHost, "localhost", "127.0.0.1", "[::1]"];
          allowedHosts = new Set(names.map((n) => `${n}:${a.port}`));
          const scheme = tls ? "https" : "http";
          allowedOrigins = new Set([...allowedHosts].map((h) => `${scheme}://${h}`));
          const hostPart = bindHost.includes(":") ? `[${bindHost}]` : bindHost;
          // Grants also end when nobody asks: lapsed ones are swept (and audited) twice a minute.
          sweeper = setInterval(() => { try { breakGlass.sweep(); } catch { /* the next sweep retries */ } }, 30_000); sweeper.unref();
          log.info("listening", { host: bindHost, port: a.port, tls });
          resolveListen({ host: bindHost, port: a.port, url: `${scheme}://${hostPart}:${a.port}` });
        });
      });
    },
    close() {
      if (sweeper) clearInterval(sweeper);
      return new Promise((resolveClose) => { server.close(() => resolveClose()); server.closeAllConnections(); });
    },
  };
}
