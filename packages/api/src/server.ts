import { buildDesktopAttachHandlers } from "./desktop-attach-routes.ts";
import { extensionHandlers, NATIVE_FILE_ROUTES } from "./extension-routes.ts";
import { ExtensionUploads, ImportSnapshotUploads } from "./extension-uploads.ts";
import { ImportMaintenanceContext, coreTransportUnavailable, type ImportMaintenancePort, type MaintenanceAdmission } from "./import-maintenance.ts";
import { createMaintenanceEvents } from "./import-maintenance-events.ts";
import { DesktopStepUp, DESKTOP_STEPUP_HEADER } from "./desktop-stepup.ts";
import { buildWebAuthnHandlers, type PendingWebAuthn } from "./webauthn-routes.ts";
import {TLSSocket} from "node:tls";
import {certPin} from "../../remote-access/src/fingerprint.ts";
import {buildRemotePairingHandlers} from "./remote-pairing-routes.ts";
import type {RemotePairingController} from "./remote-pairing-controller.ts";
import {buildRemoteHandlers,type CertificateImporter} from "./remote-config-routes.ts";
import {remoteListenerPolicy,secondFactorRequired,type RemoteListenerPolicy} from "./remote-policy.ts";
import { WS_ROUTES } from "./ws-routes.ts";
import { createWsRoute } from "./ws.ts";
import type { AccountStore, CorePerson } from "./account-store.ts";
import { streamChat } from "./chat-stream.ts";
import { buildAccountHandlers } from "./account-routes.ts";
import { requestCore } from "./request-core.ts";
import { createEventsRoute } from "./events-route.ts";
import { rpcFailure } from "./rpc-route.ts";
import { webPrincipal, webConnection, forgetWebConnection } from "./principal.ts";
import { statSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { isIP, type Socket } from "node:net";
import { lingerLimits, lingerSocket, lingerUnread, type HarnessLogger, type LingerLimits } from "@plur1bus/module-api";
import { createAuditEmitter } from "./audit.ts";
import { systemClock, type Clock } from "./clock.ts";
import type { CoreRpc } from "./core-rpc.ts";
import { ApiError, errorBody, errors, fromCoreError } from "./errors.ts";
import { htmlCsp, injectNonce, newNonce, securityHeaders } from "./headers.ts";
import { PasswordLogin, type LockoutPolicy } from "./login.ts";
import { MemoryTokenStore, MemoryTotpStore } from "./memory-stores.ts";
import type { TokenStore, TotpStore, UserDirectory } from "./ports.ts";
import { LoginChallenges } from "./challenge.ts";
import { ConcurrencyLimit, DEFAULT_EXPENSIVE_CONCURRENCY, DEFAULT_RATE_CLASSES, EXPENSIVE_RPC_METHODS, RateLimiter, SHARED_ADDRESS_SCALE, type RateClasses } from "./rate-limit.ts";
import { authorize, type AuditSink, type Decision, type RbacPrincipal, type Resource } from "./rbac-bridge.ts";
import { redactFields } from "./redact.ts";
import { createStaticServer } from "./static.ts";
import { protocolUnauthenticatedError } from "./protocol-routes.ts";
import { buildHandlers, COOKIE_NAME, COOKIE_NAME_TLS, CSRF_HEADER, ROUTES, sessionCookie, type Handler, type RouteSpec } from "./routes.ts";
import { FileOAuthStore, MemoryOAuthStore } from "./oauth/store.ts";
import { OAuthService } from "./oauth/service.ts";
import { join } from "node:path";
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
/** File transfer has a separate bounded body deadline; ordinary JSON and header deadlines stay short. */
export const UPLOAD_BODY_TIMEOUT_MS = 600_000;

export type ApiLogger = Pick<HarnessLogger, "debug" | "info" | "warn" | "error">;
const noopLogger: ApiLogger = { debug() {}, info() {}, warn() {}, error() {} };

export interface ApiServerOptions {
  core: CoreRpc;
  /** Trusted native run authority, scoped to the initiating person and current maintenance job. */
  importMaintenance?: ImportMaintenancePort;
  /** The owner credential `POST /api/v1/session` checks (ruling R2). At least 32 characters. */
  ownerToken: string;
  /** Local accounts (password login). Without it only the owner token logs in. */
  users?: UserDirectory;
  accounts?: AccountStore;
  webauthnOrigin?: string;
  sharedLoginChallenges?: LoginChallenges; sharedWebauthnChallenges?: Map<string, PendingWebAuthn>;
  bootstrapConsumed?: () => void;
  resolveBootstrap?: () => Promise<CorePerson | null>;
  /** Where personal API tokens live. The in-memory default forgets them at a restart; the standalone entry supplies the durable adapter. */
  tokens?: TokenStore;
  /** Where second-factor secrets live; the in-memory default forgets them at a restart (the standalone entry supplies the private durable adapter). */
  totp?: TotpStore; totpIssuer?: string;
  /** The unbuffered, fail-closed sink for the API's own security-relevant writes (the bootstrap commit attempt, remote access
   *  changes); default: `audit`. Break-glass is not one of them: its single registry, audit and notice live in the core, and
   *  the REST routes forward to it. */
  breakGlassAudit?: AuditSink;
  /** The hash-chained audit log of the core, or any sink with the same `append`. Without one nothing is audited. */
  audit?: AuditSink;
  /** The built web app (`packages/web/dist`): served read-only at `/` and below, never under `/api`, with a CSP nonce per
   *  page. Without it the API serves JSON only. */
  webRoot?: string;
  /** Loopback only (ruling R7); anything else is refused. Default `127.0.0.1`. */
  host?: string; port?: number;
  remote?: RemoteListenerPolicy; sharedSessions?:SessionStore; requireSecondFactor?:"remote"|"always"|"never";
  home?:string; remoteCertificates?:CertificateImporter; remotePairing?:RemotePairingController;
  /** A PEM key and certificate: the listener is then HTTPS, the cookie `Secure`, HSTS is sent. */
  tls?: { key: string | Buffer; cert: string | Buffer };
  logger?: ApiLogger; clock?: Clock;
  limits?: Partial<ApiLimits>; rateClasses?: RateClasses; /** Most model-backed operations (chat turn, job or dream run, realtime voice) running at once, installation-wide. Default 8. */ expensiveConcurrency?: number; sessionLimits?: SessionLimits; lockout?: Partial<LockoutPolicy>;
  mcpConfig?: import("./mcp/activation.ts").McpServerConfigLike | (() => Promise<import("./mcp/activation.ts").McpServerConfigLike | undefined> | import("./mcp/activation.ts").McpServerConfigLike | undefined) | undefined;
  a2aConfig?: import("./a2a/activation.ts").A2aServerConfigLike | (() => Promise<import("./a2a/activation.ts").A2aServerConfigLike | undefined> | import("./a2a/activation.ts").A2aServerConfigLike | undefined) | undefined;
  taskStore?: ((agentId: string) => import("./a2a/task-store.ts").TaskStore) | undefined;
  oauthStore?: import("./oauth/types.ts").OAuthStore | undefined;
  oauthService?: import("./oauth/service.ts").OAuthService | undefined;
  oauthClients?: Record<string, import("./oauth/types.ts").OAuthClientMetadata> | undefined;
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

const LINGER_MS = 5_000;

const REASONS: Record<number, string> = { 200: "OK", 400: "Bad Request", 408: "Request Timeout", 431: "Request Header Fields Too Large" };

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
  const transport=remoteListenerPolicy(o.host??"127.0.0.1",!!o.tls,o.remote);
  const bindHost = transport.host;
  const originalOwnerVerifier = ownerTokenVerifier(o.ownerToken);
  const verifyOwner = (candidate: unknown) => !o.accounts?.hasOwnerAccount() && originalOwnerVerifier(candidate);
  if ((o.tls && !(o.tls.key && o.tls.cert))) throw new Error("tls needs both key and cert");
  const tls = transport.secure;
  const clock = o.clock ?? systemClock;
  const limits: ApiLimits = { ...DEFAULT_LIMITS, ...o.limits };
  /** How long a refused upload may keep its connection open while the server discards the rest of it (`lingerUnread`). */
  const lingerMs = Math.min(LINGER_MS, limits.requestTimeoutMs);
  const base = o.logger ?? noopLogger;
  // Whatever a call site passes, credential-named fields never reach the sink.
  const log: ApiLogger = {
    debug: (m, f) => base.debug(m, f && (redactFields(f) as Record<string, unknown>)),
    info: (m, f) => base.info(m, f && (redactFields(f) as Record<string, unknown>)),
    warn: (m, f) => base.warn(m, f && (redactFields(f) as Record<string, unknown>)),
    error: (m, f) => base.error(m, f && (redactFields(f) as Record<string, unknown>)),
  };
  const sessions = o.sharedSessions ?? new SessionStore(clock, o.sessionLimits ?? DEFAULT_SESSION_LIMITS);
  const forgetConnection = sessions.onEnd(forgetWebConnection);
  const limiter = new RateLimiter(clock, o.rateClasses ?? DEFAULT_RATE_CLASSES);
  const expensiveSlots = new ConcurrencyLimit(o.expensiveConcurrency ?? DEFAULT_EXPENSIVE_CONCURRENCY);
  // Behind `tailscale serve` every tailnet client arrives from 127.0.0.1 (forwarding headers stay ignored on purpose), so the
  // address tells clients apart no better than a constant: its bucket is only an upper bound, and the login name and the
  // principal carry the real limits.
  const sharedAddress = o.remote?.publish === "tailnet";
  const ipScale = sharedAddress ? SHARED_ADDRESS_SCALE : 1;
  const audit = createAuditEmitter({ sink: o.audit, clock, log });
  // A session forced out by a cap is not a logout: it is recorded against the person who lost it, with who caused it.
  const forgetEvictions = sessions.onEvict(e => audit.emit("auth.session.evicted", e.session.principal.id, `user:${e.session.principal.id}`, { reason: e.reason, by: e.by.id }));
  const login = o.users ? new PasswordLogin({ users: o.users, clock, ...(o.lockout ? { policy: o.lockout } : {}) }) : undefined;
  const tokens = new TokenService({ store: o.tokens ?? new MemoryTokenStore(), clock });
  const totp = new TotpService({ store: o.totp ?? new MemoryTotpStore(), clock, issuer: o.totpIssuer ?? "PLUR1BUS Harness" });
  const challenges = o.sharedLoginChallenges ?? new LoginChallenges(clock);
  const events = createEventsRoute({ core: o.core, sessions, initTimeoutMs: limits.handlerTimeoutMs, now: () => clock.now() });
  const perRequest = requestCore(o.core);
  const desktopStepUp = new DesktopStepUp({ core: o.core, sessions, clock,
    ...(o.users ? { users: o.users } : {}), credentialVersion: id => o.accounts?.localCredentialVersion(id),
  });
  const maintenancePort = o.importMaintenance ?? (o.core.callAs ? {
    status: (identity: import("./import-maintenance.ts").ImportMaintenanceIdentity) => o.core.callAs!<import("../../rpc-schema/generated/types.ts").AdminImportStatusResult>("admin.import.status", { runId: identity.runId }, identity.principal, "supervisor", identity.connectionKey),
    abort: (identity: import("./import-maintenance.ts").ImportMaintenanceIdentity) => o.core.callAs!<import("../../rpc-schema/generated/types.ts").AdminImportAbortResult>("admin.import.abort", { runId: identity.runId }, identity.principal, "supervisor", identity.connectionKey),
    ...(o.core.subscribeImportAs ? { subscribe: (identity: import("./import-maintenance.ts").ImportMaintenanceIdentity, progress: (value: import("../../rpc-schema/generated/types.ts").ImportProgress) => void, closed: () => void) => o.core.subscribeImportAs!(identity.principal, identity.runId, value => progress(value as import("../../rpc-schema/generated/types.ts").ImportProgress), closed, identity.connectionKey) } : {}),
  } : undefined);
  const maintenance = maintenancePort ? new ImportMaintenanceContext({ sessions, now: () => clock.now(), port: maintenancePort,
    credentialVersion: id => o.accounts ? o.accounts.localCredentialVersion(id) : id === "local-owner" ? 0 : undefined,
    importSessionProof: (session, principal) => desktopStepUp.importSessionProof(session, principal),
  }) : undefined;
  const maintenanceEvents = maintenance && maintenancePort ? createMaintenanceEvents(maintenance, maintenancePort) : undefined;
  const uploads = o.home ? new ExtensionUploads({ home: o.home, now: () => clock.now() }) : undefined;
  const snapshots = o.home ? new ImportSnapshotUploads({ home: o.home, now: () => clock.now() }) : undefined;
  const oauthStore = o.oauthStore ?? o.accounts?.oauth ?? (o.home ? new FileOAuthStore(join(o.home, "state", "api", "oauth-grants.json")) : new MemoryOAuthStore());
  const oauthService = o.oauthService ?? (tokens ? new OAuthService({
    tokens,
    store: oauthStore,
    clock,
    remote: !!o.remote,
    requireSecondFactor: o.requireSecondFactor,
    clients: o.oauthClients,
  }) : undefined);
  const handlerDeps = { core: perRequest.core, desktopStepUp, sessions, verifyOwner, clock, tls, principal: OWNER, healthTimeoutMs: limits.healthTimeoutMs, log, login, tokens, users: o.users, totp, challenges, limiter, sharedAddress, audit, resolveBootstrap: o.resolveBootstrap, requireSecondFactor:(role:string)=>secondFactorRequired(role,!!o.remote,o.requireSecondFactor), hasPasskeys: (id: string) => !!o.accounts?.passkeysFor(id).length, mcpConfig: o.mcpConfig, a2aConfig: o.a2aConfig, taskStore: o.taskStore, oauthService, isRemote: !!o.remote };
  const handlers = { ...buildHandlers(handlerDeps), ...extensionHandlers(o.core), ...buildDesktopAttachHandlers({...handlerDeps,core:o.core}, origin=>allowedOrigins.has(origin)), ...buildAccountHandlers(handlerDeps, o.accounts, o.core, o.bootstrapConsumed, !o.remote, () => { const sink=o.breakGlassAudit??o.audit; if(!sink)throw new Error("bootstrap audit unavailable"); sink.append({at:clock.now(),actor:{user:"local-owner",host:"api"},action:"account.bootstrap.commit-attempt",target:"account",detail:{}}); }),...buildWebAuthnHandlers(handlerDeps, o.accounts, (requestOrigin?: string) => o.remote?.publicOrigin ?? o.webauthnOrigin ?? requestOrigin ?? [...allowedOrigins][0]!, o.sharedWebauthnChallenges),...buildRemoteHandlers({core:o.core,home:o.home,audit:o.breakGlassAudit??o.audit,now:()=>clock.now(),certificates:o.remoteCertificates}),...buildRemotePairingHandlers(o.remotePairing) };
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

  let allowedHosts = new Set<string>(); let allowedOrigins = new Set<string>();
  const ws=createWsRoute({sessions,cookieName,clock,limiter,ipScale,audit,resolve,allowedHost:host=>allowedHosts.has(host),allowedOrigin:origin=>allowedOrigins.has(origin)});
  add(WS_ROUTES[0]!,async i=>{const ticket=ws.issue(i.sessionId!);if(!ticket)throw errors.unauthenticated();return {body:ticket};});
  add(WS_ROUTES[1]!,async()=>({status:426,body:{error:"E_NOT_AVAILABLE",reason:"upgrade-required"}}));

  /** The Referer's origin must be one the API issued; an unparseable, scheme-relative or opaque (`null`) value is not. */
  const refererAllowed = (value: string): boolean => {
    try { const u = new URL(value); return (u.protocol === "http:" || u.protocol === "https:") && allowedOrigins.has(u.origin.toLowerCase()); } catch { return false; }
  };

  /** `unread`: the request is answered before its upload is in. The answer goes out at once, but the response is only ended
   *  (so the connection only closed) after the rest of the upload was read, or a bound was hit: closing under a sender ends
   *  in an RST, and on macOS that RST wipes the answer from the client's receive queue (`lingerUnread`). */
  const send = (res: ServerResponse, status: number, body: object, extra: Record<string, string> = {}, unread?: Promise<void>): void => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    if (res.headersSent) { res.end(); return; }
    res.writeHead(status, { ...secHeaders, "Content-Type": "application/json; charset=utf-8", "Content-Length": payload.length, ...extra });
    if (unread) { res.write(payload); void unread.then(() => res.end()); } else res.end(payload);
  };

  /** The principal of a session as it is *now*: owner from the bootstrap, users from the directory (so a demotion, a
   *  disabled account or a deleted one takes effect at the next request, whatever the session was made with). */
  async function resolve(session: Session): Promise<Resolved | undefined> {
    if(session.device) {
      try {
        const identity=await o.core.serviceCall?.<import("./desktop-attach-routes.ts").DesktopIdentity>("admin.api.desktop.resolve",{deviceId:session.device.deviceId});
        if(!identity || identity.userId!==session.principal.id || identity.expiresAt<=clock.now())return undefined;
        const result=await o.core.serviceCall?.<{person:import("./account-store.ts").CorePerson|null}>("admin.api.person.resolve",{userId:identity.userId});
        const p=result?.person;if(!p||p.disabled)return undefined;
        const rbac = {...p,kind:"person" as const,tokenScopes:identity.scopes.filter(s=>session.device!.scopes.includes(s))};
        const proof = desktopStepUp.sessionProof(session, rbac);
        const required = secondFactorRequired(p.role,!!o.remote,o.requireSecondFactor) || await totp.isEnabled(identity.userId) || !!o.accounts?.passkeysFor(identity.userId).length;
        if (required && (!proof || proof.coreVersion !== p.version)) return undefined;
        return {principal:{kind:"user",id:identity.userId,role:p.role},rbac,version:p.version};
      } catch (error) { if (coreTransportUnavailable(error)) throw error; return undefined; }
    }
    return resolveSubject(session.principal.kind, session.principal.id);
  }

  async function resolveSubject(kind: Principal["kind"] | undefined, id: string): Promise<Resolved | undefined> {
    if (kind === "owner" || (kind === undefined && id === OWNER.id)) {
      if (o.resolveBootstrap) { const p = await o.resolveBootstrap(); if (!p || p.disabled) return undefined; return { principal: { ...OWNER, role: p.role }, rbac: { ...p, userId: OWNER.id }, version: p.version }; }
      return { principal: OWNER, rbac: { userId: OWNER.id, role: "owner", kind: "person" }, version: 0 };
    }
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
    if (az === "authenticated" || az === "delegated") return { effect: "allow", reason: "role" };
    // "user": some user, to be named by the handler, which asks the registry again with the real target.
    const resource: Resource = az.resource === "self" ? { kind: "user", userId: rbac.userId } : az.resource === "user" ? { kind: "user", userId: "*" } : { kind: "system" };
    // Break-glass grants live in the core's one registry and cover memory reads there; no API route is one, so this is plain authorize().
    return authorize(rbac, az.action, resource);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const t0 = process.hrtime.bigint();
    const ip = (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
    let routeId = "-"; let principalId: string | undefined; let status = 500; let releaseSlot: (() => void) | undefined;
    let preReadBody: unknown, didReadBody = false, offlineMaintenance: MaintenanceAdmission | undefined;
    let bodyTimer: NodeJS.Timeout | undefined, bodyTimedOut = false;
    const stopBodyTimer = (): void => { clearTimeout(bodyTimer); };
    const bodyDeadline = (ms: number): void => {
      stopBodyTimer(); if (req.complete) return;
      bodyTimer = setTimeout(() => {
        if (req.complete || res.writableEnded) return;
        bodyTimedOut = true; status = 408;
        res.once("finish", () => req.destroy());
        send(res, 408, errorBody(errors.timeout("request-timeout")), { Connection: "close" });
      }, ms); bodyTimer.unref();
    };
    req.once("end", stopBodyTimer); res.once("finish", stopBodyTimer);
    bodyDeadline(limits.requestTimeoutMs);
    let linger: LingerLimits = lingerLimits(limits.maxBodyBytes, lingerMs);
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
      let methods = byPath.get(path); let pathParams: Record<string,string> = {}; let badPath: ApiError | undefined;
      if(!methods) for(const [pattern,candidate] of byPath) {
        if(!pattern.includes("{"))continue;
        const names:string[]=[];
        const regex=new RegExp("^"+pattern.replace(/\{([a-zA-Z]+)\}/g,(_m,name)=>{names.push(name);return "([^/]+)";})+"$");
        const matched=regex.exec(path);if(!matched)continue;
        // A malformed percent escape is the client's mistake: 400, after the address bucket, never an unhandled URIError.
        try{pathParams=Object.fromEntries(names.map((name,index)=>[name,decodeURIComponent(matched[index+1]!)]));methods=candidate;}
        catch{badPath=errors.badRequest("path","the request path has an invalid percent-encoding");}
        break;
      }
      const route = methods?.get(req.method ?? "");
      const cls = route?.spec.rate ?? "read";
      if (route?.spec.id === "invitation.redeem") { const global = limiter.take("auth", "invitation:global"); if (!global.ok) rateLimited("invitation:global", "auth", global.retryAfterSec); }
      const ipVerdict = limiter.take(cls, `ip:${ip}`, ipScale);
      if (!ipVerdict.ok) rateLimited(`ip:${ip}`, cls, ipVerdict.retryAfterSec);
      if (badPath) throw badPath;
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
      const isProtocol = spec.transport === "protocol";
      if (isProtocol && spec.protocol?.bodyTimeoutMs !== undefined) bodyDeadline(spec.protocol.bodyTimeoutMs);
      else if (spec.requestContentType === "multipart/form-data") bodyDeadline(UPLOAD_BODY_TIMEOUT_MS);
      const bodyLimit = isProtocol && spec.protocol?.maxBodyBytes !== undefined ? spec.protocol.maxBodyBytes : spec.requestContentType === "multipart/form-data" ? 1073741824 + 16384 : spec.id === "web.rpc" ? o.limits?.maxBodyBytes ?? 1024 * 1024 : limits.maxBodyBytes;
      linger = lingerLimits(bodyLimit, lingerMs);

      const declared = req.headers["content-length"];
      if (declared !== undefined) {
        const n = Number(declared);
        if (!/^\d+$/.test(declared) || !Number.isSafeInteger(n)) throw errors.badRequest("content-length", "invalid Content-Length");
        if (n > bodyLimit) throw errors.tooLarge(bodyLimit);
      }

      const presented = readCookie(req.headers.cookie, cookieName);
      if ((spec.id === "web.rpc" || spec.id === "web.events") && req.headers.authorization !== undefined) {
        if (!presented) throw errors.unauthenticated();
        throw errors.forbidden("web-session-only");
      }
      let sessionId: string | undefined; let session: Session | undefined; let resolved: Resolved | undefined; let rotated: string | undefined;
      let via: "session" | "token" | undefined; let tokenInfo: import("./routes.ts").HandlerInput["token"]; let tokenRecord: import("./ports.ts").TokenRecord | undefined; let rateKey: string | undefined;
      const authHeader = req.headers.authorization;
      const bearer = (spec.auth === "any" || isProtocol && spec.auth !== "none") && typeof authHeader === "string" && /^bearer(\s|$)/i.test(authHeader) ? authHeader.slice(6).trim() : undefined;
      const protocolOrigin = o.remote?.publicOrigin || [...allowedOrigins][0] || `${tls ? "https" : "http"}://${req.headers.host ?? "127.0.0.1"}`;
      if (isProtocol && spec.auth !== "none" && (!bearer || bearer.length === 0)) {
        throw protocolUnauthenticatedError("bearer-required", protocolOrigin, spec.protocol?.resourceMetadataPath);
      }
      if (bearer !== undefined && NATIVE_FILE_ROUTES.has(spec.id) && !bearer.startsWith("plb_")) {
        // Narrow native file routes accept a live, explicitly enrolled device credential. PATs retain agent authority.
        if (!/^[A-Za-z0-9_-]{43}$/.test(bearer)) throw errors.unauthenticated("invalid-device-token");
        if (!o.core.serviceCall) throw new ApiError(503, "E_NOT_AVAILABLE", "native authentication unavailable");
        let identity: import("./desktop-attach-routes.ts").DesktopIdentity;
        try { identity = await o.core.serviceCall("admin.api.desktop.token", { token: bearer }); }
        catch { throw errors.unauthenticated("invalid-device-token"); }
        if (!identity || typeof identity.userId !== "string" || !identity.userId || !Array.isArray(identity.scopes) || identity.scopes.some(scope => typeof scope !== "string") || !Number.isSafeInteger(identity.expiresAt) || identity.expiresAt <= clock.now()) throw errors.unauthenticated("invalid-device-token");
        const result = await o.core.serviceCall<{ person: import("./account-store.ts").CorePerson | null }>("admin.api.person.resolve", { userId: identity.userId });
        let person = result.person;
        if (!person || person.disabled || person.userId !== identity.userId) throw errors.unauthenticated("device-person");
        let grantedScopes = identity.scopes;
        if (secondFactorRequired(person.role, !!o.remote, o.requireSecondFactor) || await totp.isEnabled(identity.userId) || o.accounts?.passkeysFor(identity.userId).length || req.headers[DESKTOP_STEPUP_HEADER] !== undefined) {
          const proof = await desktopStepUp.verify(bearer, req.headers[DESKTOP_STEPUP_HEADER], spec.id === "imports.snapshot.upload" ? "imports.manage" : "extensions.manage");
          identity = proof.identity; person = proof.person; grantedScopes = proof.grantedScopes;
        }
        resolved = { principal: { kind: "user", id: identity.userId, role: person.role }, rbac: { ...person, userId: identity.userId, kind: "person", tokenScopes: grantedScopes }, version: person.version };
        via = "token"; principalId = identity.userId; rateKey = `device:${identity.deviceId}`;
        tokenInfo = { id: identity.deviceId, prefix: "device", scopes: grantedScopes, expiresAt: identity.expiresAt };
        const verdict = limiter.takeAll(cls, [rateKey, `principal:${principalId}`]);
        if (!verdict.ok) rateLimited(rateKey, cls, verdict.retryAfterSec);
        const decision = decide(spec, resolved.rbac);
        if (decision.effect === "deny") throw errors.forbidden(decision.reason);
      } else if (bearer !== undefined) {
        // A personal API token. No cookie is consulted, so a bad token is a 401, never a fallback; no CSRF token is
        // needed because a browser never attaches this header by itself. A token acts as an agent principal: it can
        // never hold a human-only action, and its scopes only ever narrow the role it belongs to.
        const r = await tokens.authenticate(bearer);
        if (!r.ok) {
          audit.emit("auth.token.used-denied", "anonymous", r.id ? `token:${r.id}` : "token:-", { reason: r.reason, ip });
          throw isProtocol ? protocolUnauthenticatedError("invalid-token", protocolOrigin, spec.protocol?.resourceMetadataPath) : errors.unauthenticated("invalid-token");
        }
        resolved = await resolveSubject(r.record.userId === OWNER.id ? "owner" : "user", r.record.userId);
        if (!resolved) {
          try { await tokens.revoke(r.record.userId, r.record.id); } catch { /* invalid credentials remain refused */ }
          audit.emit("auth.token.used-denied", "anonymous", `token:${r.record.id}`, { reason: "account", ip });
          throw isProtocol ? protocolUnauthenticatedError("invalid-token", protocolOrigin, spec.protocol?.resourceMetadataPath) : errors.unauthenticated("invalid-token");
        }
        resolved = {
          ...resolved,
          rbac: {
            ...resolved.rbac,
            kind: "agent",
            tokenScopes: r.record.scopes,
            tokenId: r.record.id,
            ...(r.record.binding !== undefined ? { binding: r.record.binding } : {}),
          },
        };
        via = "token"; tokenRecord = r.record; tokenInfo = { id: r.record.id, prefix: `plb_${r.record.id}`, scopes: r.record.scopes, expiresAt: r.record.expiresAt, ...(r.record.binding !== undefined ? { binding: r.record.binding } : {}) };
        if(secondFactorRequired(resolved.principal.role,!!o.remote,o.requireSecondFactor))throw errors.forbidden("second-factor-required");
        principalId = resolved.principal.id; rateKey = `token:${r.record.id}`;
        const tv = limiter.take(cls, rateKey);
        if (!tv.ok) rateLimited(rateKey, cls, tv.retryAfterSec);
        if (!isProtocol && r.record.binding !== undefined) {
          if (req.method !== "GET") audit.emit("auth.denied", principalId, `route:${spec.id}`, { reason: "token-bound-protocol-only", method: req.method, via: "token", token: tokenInfo.id, ip, ...(typeof spec.authz === "object" ? { action: spec.authz.action } : {}) });
          throw errors.forbidden("token-bound-protocol-only", "agent-bound tokens may only be used on protocol routes");
        }
        const d = decide(spec, resolved.rbac);
        if (d.effect === "deny") {
          if (req.method !== "GET") audit.emit("auth.denied", principalId, `route:${spec.id}`, { reason: d.reason, method: req.method, via: "token", token: tokenInfo.id, ip, ...(typeof spec.authz === "object" ? { action: spec.authz.action } : {}) });
          throw errors.forbidden(d.reason);
        }
        if (isProtocol && spec.protocol?.audience !== undefined) {
          if (!r.record.binding) throw errors.forbidden("token-binding-required", "token requires an agent protocol binding");
          if (r.record.binding.audience !== spec.protocol.audience) {
            throw protocolUnauthenticatedError("invalid-audience", protocolOrigin, spec.protocol?.resourceMetadataPath);
          }
          const { tokenScopes: _omit, ...userRbac } = resolved.rbac;
          const useDec = authorize(userRbac, "agent.use", { kind: "agent", agentId: r.record.binding.agentId });
          if (useDec.effect === "deny") throw errors.forbidden(useDec.reason);
        }
      } else if (!isProtocol && (spec.auth === "session" || spec.auth === "any")) {
        via = "session";
        sessionId = presented;
        session = sessions.get(sessionId);
        if (!session) throw errors.unauthenticated();
        try { resolved = await resolve(session); }
        catch (error) {
          if (!coreTransportUnavailable(error)) { maintenance?.revoke(session); throw fromCoreError(error); }
          if (spec.id === "web.rpc" && (req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase() === "application/json") {
            preReadBody = parseJson(await readBody(req, bodyLimit)); didReadBody = true;
          }
          offlineMaintenance = await maintenance?.admit(sessionId, spec.id, preReadBody);
          if (!offlineMaintenance) throw error instanceof ApiError ? error : new ApiError(503, "E_CORE_UNAVAILABLE", "Core authorization unavailable", { reason: "core-unavailable" });
          resolved = { principal: { ...session.principal, role: offlineMaintenance.principal.role }, rbac: offlineMaintenance.principal, version: offlineMaintenance.authVersion };
        }
        if (!resolved) { maintenance?.revoke(session); sessions.destroy(sessionId); throw errors.unauthenticated("session-expired"); }
        if (!offlineMaintenance) maintenance?.observe(session, webPrincipal(resolved.rbac, resolved.principal.kind === "owner"), resolved.version);
        if(secondFactorRequired(resolved.principal.role,!!o.remote,o.requireSecondFactor)&&session.stepUpAt===undefined)throw errors.forbidden("second-factor-required");
        principalId = resolved.principal.id;
        const pv = limiter.take(cls, `principal:${principalId}`);
        if (!pv.ok) rateLimited(`principal:${principalId}`, cls, pv.retryAfterSec);
        // The CSRF token is spent before any rotation: rotation drops the old session's tokens.
        if (spec.csrf && !sessions.consumeCsrf(sessionId!, req.headers[CSRF_HEADER] as string | undefined)) {
          audit.emit("auth.csrf-refused", principalId, `user:${principalId}`, { route: routeId, ip });
          throw errors.forbidden("csrf", "a valid one-time CSRF token is required");
        }
        // Rights changed since the session was made (or someone asked for it): the cookie value changes, the old one dies.
        if (o.accounts && (session.mustRotate || resolved.version !== session.authVersion)) {
          sessions.destroy(sessionId); events.revoke(webPrincipal(resolved.rbac, session.principal.kind === "owner").userId);
          throw errors.unauthenticated("session-changed");
        }
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

      // Model-backed work (ADR-004): the class bucket above is per principal; this slot is the installation-wide cap. It is held
      // until the response, a chat stream included, is finished (`finally`).
      const takeSlot = (): void => { releaseSlot = expensiveSlots.tryAcquire(); if (!releaseSlot) rateLimited("expensive:concurrency", "expensive", 2); };
      if (spec.rate === "expensive") takeSlot();

      if (spec.id === "web.events") {
        if (target.includes("?")) throw errors.badRequest("query", "event credentials and filters cannot be in a URL");
        if (offlineMaintenance && maintenanceEvents) { status = 200; await maintenanceEvents.open(res, offlineMaintenance, secHeaders); return; }
        status = 200;
        await events.open(res, webPrincipal(resolved!.rbac, resolved!.principal.kind === "owner"), session!, sessionId!, webConnection(session!),
          typeof req.headers["last-event-id"] === "string" ? req.headers["last-event-id"] : undefined,
          { ...secHeaders, ...(rotated ? { "Set-Cookie": rotated } : {}) },
          async () => { const now = await resolve(session!); return now !== undefined && now.version === resolved!.version; });
        return;
      }
      if (spec.id === "extensions.upload" || spec.id === "imports.snapshot.upload") {
        const store = spec.id === "extensions.upload" ? uploads : snapshots;
        if (!store) throw new ApiError(503, "E_NOT_AVAILABLE", "upload storage unavailable");
        const type = req.headers["content-type"];
        if (typeof type !== "string" || !/^multipart\/form-data\s*;/i.test(type)) throw new ApiError(415, "E_INVALID_PARAMS", "multipart/form-data is required", { reason: "unsupported-media-type" });
        const owner = webPrincipal(resolved!.rbac, resolved!.principal.kind === "owner").userId;
        // A refused upload is answered by the catch below, which lingers on the unread rest (lingerUnread) within bounds.
        const result = await store.receive(req.iterator({ destroyOnReturn: false }), type, owner);
        const body = spec.id === "extensions.upload" ? result : { snapshotId: result.uploadId, expiresAt: result.expiresAt, sha256: result.sha256 };
        status = 200; send(res, 200, body, rotated ? { "Set-Cookie": rotated } : {});
        return;
      }
      let body: unknown = preReadBody;
      let rawBody: Buffer | undefined;
      if (isProtocol && !spec.requestBody) {
        if (req.method !== "GET" && req.method !== "HEAD" || declared !== undefined && declared !== "0" || req.headers["transfer-encoding"] !== undefined) {
          rawBody = await readBody(req, bodyLimit);
          didReadBody = true;
        }
      } else if (spec.requestBody) {
        const ct = (req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
        if (ct !== "application/json") throw errors.unsupportedMedia();
        const raw = didReadBody ? undefined : await readBody(req, bodyLimit);
        rawBody = raw;
        try { if (!didReadBody) body = parseJson(raw!); }
        catch (e) { if (spec.id !== "web.rpc") throw e; status = 200; send(res, 200, rpcFailure(null, { error: "E_INVALID_PARAMS", code: -32700, reason: "parse-error" })); return; }
      } else if (declared !== undefined && declared !== "0" || req.headers["transfer-encoding"] !== undefined) {
        await readBody(req, bodyLimit); // counted against the limit, then ignored
      }
      if (offlineMaintenance && spec.id === "web.rpc") {
        status = 200; send(res, 200, await maintenance!.dispatch(offlineMaintenance, body)); return;
      }
      if (spec.id === "web.rpc" && EXPENSIVE_RPC_METHODS.has((body as { method?: unknown } | null)?.method as string)) {
        const scope = rateKey ?? `principal:${principalId}`;
        const v = limiter.take("expensive", scope);
        if (!v.ok) rateLimited(scope, "expensive", v.retryAfterSec);
        takeSlot();
      }
      if (spec.id === "mcp.server") {
        let isMcpAsk = false;
        const mcpMethod = req.headers["mcp-method"];
        const mcpName = req.headers["mcp-name"];
        if (mcpMethod === "tools/call" && (mcpName === "agent_ask" || mcpName === "%61%67%65%6e%74%5f%61%73%6b")) {
          isMcpAsk = true;
        } else if (rawBody && rawBody.length > 0) {
          try {
            const p = JSON.parse(rawBody.toString("utf8"));
            if (p.method === "tools/call" && p.params?.name === "agent_ask") {
              isMcpAsk = true;
            }
          } catch {
            // invalid json handled by route handler
          }
        }
        if (isMcpAsk) {
          const scope = rateKey ?? (tokenRecord ? `token:${tokenRecord.id}` : principalId ? `principal:${principalId}` : `ip:${ip}`);
          const v = limiter.take("expensive", scope);
          if (!v.ok) {
            const agentId = tokenRecord?.binding?.agentId ?? "unknown";
            audit.emit("mcp.server.denied", principalId ?? tokenRecord?.id ?? "anonymous", `agent:${agentId}`, {
              tokenId: tokenRecord?.id ?? "-",
              tool: "agent_ask",
              agentId,
              reason: "rate-limited",
            });
            rateLimited(scope, "expensive", v.retryAfterSec);
          }
          const takeMcpSlot = (): void => {
            releaseSlot = expensiveSlots.tryAcquire();
            if (!releaseSlot) {
              const agentId = tokenRecord?.binding?.agentId ?? "unknown";
              audit.emit("mcp.server.denied", principalId ?? tokenRecord?.id ?? "anonymous", `agent:${agentId}`, {
                tokenId: tokenRecord?.id ?? "-",
                tool: "agent_ask",
                agentId,
                reason: "concurrency-limit",
              });
              rateLimited("expensive:concurrency", "expensive", 2);
            }
          };
          takeMcpSlot();
        }
      }
      if (spec.id === "a2a.endpoint") {
        let isTaskSend = false;
        if (rawBody && rawBody.length > 0) {
          try {
            const p = JSON.parse(rawBody.toString("utf8"));
            if (
              p.method === "SendMessage" ||
              p.method === "SendStreamingMessage" ||
              p.method === "message/send" ||
              p.method === "message/stream" ||
              p.method === "tasks/send"
            ) {
              isTaskSend = true;
            }
          } catch {
            // invalid json handled by route handler
          }
        }
        if (isTaskSend) {
          const scope = rateKey ?? (tokenRecord ? `token:${tokenRecord.id}` : principalId ? `principal:${principalId}` : `ip:${ip}`);
          const v = limiter.take("expensive", scope);
          if (!v.ok) {
            const agentId = tokenRecord?.binding?.agentId ?? pathParams?.agentId ?? "unknown";
            audit.emit("a2a.server.denied", principalId ?? tokenRecord?.id ?? "anonymous", `agent:${agentId}`, {
              tokenId: tokenRecord?.id ?? "-",
              method: "SendMessage",
              agentId,
              reason: "rate-limited",
            });
            rateLimited(scope, "expensive", v.retryAfterSec);
          }
          const takeA2aSlot = (): void => {
            releaseSlot = expensiveSlots.tryAcquire();
            if (!releaseSlot) {
              const agentId = tokenRecord?.binding?.agentId ?? pathParams?.agentId ?? "unknown";
              audit.emit("a2a.server.denied", principalId ?? tokenRecord?.id ?? "anonymous", `agent:${agentId}`, {
                tokenId: tokenRecord?.id ?? "-",
                method: "SendMessage",
                agentId,
                reason: "concurrency-limit",
              });
              rateLimited("expensive:concurrency", "expensive", 2);
            }
          };
          takeA2aSlot();
        }
      }

      let timer: NodeJS.Timeout | undefined;
      const ownCert=req.socket instanceof TLSSocket?req.socket.getCertificate():undefined;
      const candidate=ownCert&&"raw" in ownCert?ownCert.raw:undefined;
      const leaf=Buffer.isBuffer(candidate)?candidate:undefined;
      const remoteTransport={tls:!!leaf,origin:o.remote?.publicOrigin??"",...(leaf?{servedFingerprint:certPin(leaf)}:{}),...(o.remote?.publish==="tailnet"?{trustedGateway:true}:{})};
      const handlerInputBase = {
        remoteTransport, pathParams, query: new URL(target, "http://localhost").searchParams, headers: req.headers,
        session, sessionId, body, ip, origin: typeof req.headers.origin === "string" ? req.headers.origin : undefined,
        via, token: tokenInfo,
        ...(isProtocol ? { rawBody, req, res, secHeaders, tokenRecord } : {}),
      };
      const handlerTimeoutMs = isProtocol && spec.protocol?.handlerTimeoutMs !== undefined
        ? spec.protocol.handlerTimeoutMs
        : spec.id === "web.rpc"
          ? o.limits?.handlerTimeoutMs ?? 300_000
          : limits.handlerTimeoutMs;
      const out = await Promise.race([
        Promise.resolve(resolved ? perRequest.run(webPrincipal(resolved.rbac, resolved.principal.kind === "owner"), () => handler({ ...handlerInputBase, principal: resolved?.principal, rbac: resolved?.rbac, presentedSessionId: spec.auth === "none" ? presented : undefined }), session ? webConnection(session) : tokenInfo ? `token:${tokenInfo.id}` : undefined, !o.remote && /^(127\.|::1$|::ffff:127\.)/.test(req.socket.remoteAddress ?? "") ? "loopback" : "remote") : handler({ ...handlerInputBase, principal: undefined, rbac: undefined, presentedSessionId: presented })),
        new Promise<import("./routes.ts").HandlerOutput>((resolveTimeout, rej) => {
          timer = setTimeout(() => spec.id === "web.rpc"
            ? resolveTimeout({ body: rpcFailure((body as { id?: unknown })?.id ?? null, { error: "E_NOT_AVAILABLE", reason: "handler-timeout" }) })
            : rej(errors.timeout()), handlerTimeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
      if (session && sessionId && spec.id === "web.rpc") {
        const request = body as { method?: string }, response = out.body as { result?: { runId?: unknown }; error?: unknown };
        if (!response.error && ["admin.import.apply", "admin.import.rollback"].includes(request.method ?? "") && typeof response.result?.runId === "string") {
          maintenance?.remember({ session, sessionId, principal: webPrincipal(resolved!.rbac, resolved!.principal.kind === "owner"), connectionKey: webConnection(session), runId: response.result.runId });
        }
      }
      if (o.accounts && spec.id === "web.rpc" && !out.body?.error) {
        const request = body as { method?: string; params?: { userId?: string } };
        if (["user.disable", "user.enable", "user.role.set", "agent.rights.set"].includes(request.method ?? "") && request.params?.userId) await o.accounts.findById(request.params.userId);
      }
      if(out.chatStream) {
        status=200;
        await streamChat({res,core:o.core,principal:webPrincipal(resolved!.rbac,resolved!.principal.kind==="owner"),...out.chatStream,headers:secHeaders,current:async()=>{
          if(via==="token")return !!bearer && (await tokens.authenticate(bearer)).ok && !!await resolveSubject(resolved!.principal.kind,resolved!.principal.id);
          const fresh=await resolve(session!); return sessions.peek(sessionId)===session && fresh!==undefined && fresh.version===resolved!.version;
        }});return;
      }
      status = out.status ?? spec.successStatus;
      if (out.streamed) return;
      if (out.body === undefined) {
        if (!res.headersSent) {
          res.writeHead(status, { ...secHeaders, "Content-Length": "0", ...(rotated ? { "Set-Cookie": rotated } : {}), ...out.headers });
        }
        res.end();
        return;
      }
      send(res, status, out.body, { ...(rotated ? { "Set-Cookie": rotated } : {}), ...out.headers });
    } catch (e) {
      if (bodyTimedOut) return;
      let err: ApiError;
      if (e instanceof ApiError) err = e;
      else { err = errors.internal(); log.error("unhandled error", { route: routeId, error: e instanceof Error ? `${e.name}: ${e.message}` : "non-error thrown" }); }
      status = err.status;
      send(res, err.status, errorBody(err), err.headers, req.complete ? undefined : lingerUnread(req, linger));
    } finally {
      stopBodyTimer();
      if (!req.complete && res.writableEnded) {
        const closeIncomplete = (): void => { if (!req.complete) req.destroy(); };
        if (res.writableFinished) closeIncomplete(); else res.once("finish", closeIncomplete);
      }
      releaseSlot?.();
      log.info("request", { method: req.method, route: routeId, status, ip, principal: principalId, ms: Number((process.hrtime.bigint() - t0) / 1_000_000n) });
    }
  }

  const serverOptions = { maxHeaderSize: limits.maxHeaderBytes, requestTimeout: Math.max(limits.requestTimeoutMs, UPLOAD_BODY_TIMEOUT_MS), headersTimeout: Math.min(limits.headersTimeoutMs, limits.requestTimeoutMs), keepAliveTimeout: limits.keepAliveTimeoutMs,
    // Node checks request/header timeouts only on this interval (default 30 s), so it must be shorter than they are.
    connectionsCheckingInterval: Math.max(25, Math.min(1000, Math.floor(Math.min(limits.requestTimeoutMs, limits.headersTimeoutMs) / 4))) };
  const server: Server = o.tls ? createHttpsServer({ ...serverOptions, key: o.tls.key, cert: o.tls.cert }, (q, r) => { void handle(q, r); }) : createHttpServer(serverOptions, (q, r) => { void handle(q, r); });
  server.maxConnections = limits.maxConnections;
  if(transport.allowlist)server.on("connection",socket=>{if(!transport.allowlist!.allows(socket.remoteAddress??""))socket.destroy();});

  // Requests Node rejects before a handler runs (malformed, header overflow, request timeout) still get the headers and
  // the error/1 body; without a listener Node would write its own bare response.
  server.on("upgrade",(req,socket,head)=>{void (async()=>{if(o.remote||o.requireSecondFactor==="always"){const session=sessions.peek(readCookie(req.headers.cookie,cookieName));const current=session?await resolve(session):undefined;if(current&&secondFactorRequired(current.principal.role,!!o.remote,o.requireSecondFactor)&&session!.stepUpAt===undefined){socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");return;}}await ws.upgrade(req,socket,head);})().catch(()=>socket.destroy());});
  server.on("clientError", (err: NodeJS.ErrnoException & { rawPacket?: Buffer }, socket: Socket) => {
    // Node reports every further chunk of a connection it has given up on as another clientError. Once the answer is out,
    // the socket is only kept to read what the client is still sending, within the bounds of `lingerSocket`.
    if (socket.writableEnded) { lingerSocket(socket, lingerLimits(limits.maxHeaderBytes, lingerMs), err.rawPacket?.length ?? 0); return; }
    if (!socket.writable || socket.destroyed) { socket.destroy(); return; }
    const status = err.code === "ERR_HTTP_REQUEST_TIMEOUT" ? 408 : err.code === "HPE_HEADER_OVERFLOW" ? 431 : 400;
    const e = status === 408 ? errors.timeout("request-timeout") : new ApiError(status, "E_INVALID_PARAMS", "malformed request", { reason: status === 431 ? "headers-too-large" : "malformed-request" });
    const payload = JSON.stringify(errorBody(e));
    const head = Object.entries({ ...secHeaders, "Content-Type": "application/json; charset=utf-8", "Content-Length": String(Buffer.byteLength(payload)), Connection: "close" }).map(([k, v]) => `${k}: ${v}`).join("\r\n");
    socket.end(`HTTP/1.1 ${status === 408 ? 408 : status} ${REASONS[status] ?? "Error"}\r\n${head}\r\n\r\n${payload}`);
    lingerSocket(socket, lingerLimits(limits.maxHeaderBytes, lingerMs), err.rawPacket?.length ?? 0);
    log.warn("malformed request", { status, code: err.code });
  });

  return {
    server,
    rightsChanged: (userId) => { ws.revoke(userId); if(userId==="local-owner")ws.revoke("owner"); events.revoke(userId); if (userId === "owner") events.revoke("local-owner"); return o.accounts ? sessions.destroyAllFor(userId) + (userId === "local-owner" ? sessions.destroyAllFor("owner") : 0) : sessions.markRotate(userId); },
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
          if(transport.origin){allowedHosts=new Set([transport.hostHeader!]);allowedOrigins=new Set([transport.origin]);}
          const hostPart = bindHost.includes(":") ? `[${bindHost}]` : bindHost;
          log.info("listening", { host: bindHost, port: a.port, tls });
          resolveListen({ host: bindHost, port: a.port, url: `${scheme}://${hostPart}:${a.port}` });
        });
      });
    },
    close() {
      uploads?.close();
      snapshots?.close();
      maintenance?.close();
      maintenanceEvents?.close();
      desktopStepUp.close();
      forgetConnection(); forgetEvictions(); ws.close(); events.close();
      return new Promise((resolveClose) => { server.close(() => resolveClose()); server.closeAllConnections(); });
    },
  };
}
