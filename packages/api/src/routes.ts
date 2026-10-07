import type { AuditEmitter } from "./audit.ts";
import { nameHandle } from "./audit.ts";
import type { Clock } from "./clock.ts";
import type { CoreRpc } from "./core-rpc.ts";
import { ApiError, errors, fromCoreError } from "./errors.ts";
import type { PasswordLogin } from "./login.ts";
import type { PublicToken, TokenService } from "./tokens.ts";
import type { RateClass } from "./rate-limit.ts";
import { authorize, type RbacPrincipal } from "./rbac-bridge.ts";
import type { Principal, Session, SessionStore } from "./session.ts";

export const API_VERSION = "1.0.0";
export const API_PREFIX = "/api/v1";
export const COOKIE_NAME = "plur1bus_session";
/** Over TLS the cookie takes the `__Host-` prefix: the browser then refuses it unless it is `Secure`, host-only, `Path=/`. */
export const COOKIE_NAME_TLS = "__Host-plur1bus_session";
export const CSRF_HEADER = "x-csrf-token";

export type JsonSchema = Record<string, unknown>;
export type Method = "GET" | "POST" | "DELETE";

/** What a route needs from `authorize(principal, action, resource)` (ADR-007 *Enforcement*): every route declares one of
 *  these, and a route that does not is refused with 403 whoever calls it.
 *  - `public`: no authentication at all (login only).
 *  - `authenticated`: any live principal; for the caller's own session handling (logout, CSRF token, whoami), which
 *    must work for a Viewer too. Deliberately narrow: the deny-by-default test names every route that uses it.
 *  - `{ action }`: a member of core's RBAC policy table, on the system resource or on the caller's own user. */
export type Authz = "public" | "authenticated" | { action: string; resource?: "system" | "self" };

export interface RouteSpec {
  id: string; method: Method; path: string; summary: string; tag: string;
  /** `none` is public (login only, ruling R5); `session` needs the session cookie; `any` takes the cookie or a personal
   *  API token (`Authorization: Bearer plb_…`). Token management is `session` only, so a token cannot mint tokens. */
  auth: "none" | "session" | "any";
  authz: Authz;
  /** A one-time CSRF token in `X-CSRF-Token` (ruling R6). */
  csrf: boolean;
  rate: RateClass;
  stability: "experimental" | "stable"; since: string;
  requestBody?: JsonSchema;
  successStatus: number; success: { description: string; schema: JsonSchema };
  /** Further documented statuses besides the shared ones (401, 403, 413, 429 …). */
  extra?: Record<number, { description: string; schema: JsonSchema }>;
}

const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });
const obj = (properties: Record<string, JsonSchema>, required: string[] = Object.keys(properties)): JsonSchema => ({ type: "object", additionalProperties: false, required, properties });
const schemaId = (id: string): JsonSchema => ({ const: id });
const iso: JsonSchema = { type: "string", format: "date-time" };
const ROLE_NAMES = ["owner", "admin", "operator", "member", "viewer"];

/** Reusable schemas of the OpenAPI document (`components.schemas`). */
export const COMPONENT_SCHEMAS: Record<string, JsonSchema> = {
  Error: obj({
    schema: schemaId("error/1"),
    error: { type: "string", description: "A member of the closed RPC `ErrorCode` enum (ADR-016 §2).", enum: ["E_UNAUTHORIZED", "E_RPC_VERSION", "E_NOT_AVAILABLE", "E_CORE_UNAVAILABLE", "E_INVALID_PARAMS", "E_AGENT_UNKNOWN", "E_CONFIG_INVALID", "E_MODULE_UNKNOWN", "E_INTERNAL", "E_LOCKED", "E_NOT_FOUND", "E_DENIED", "E_APPROVAL_REQUIRED", "E_CONFLICT", "E_STORAGE"] },
    message: { type: "string" },
    reason: { type: "string", description: "A short machine-readable cause, e.g. `no-session`, `csrf`, `rate-limited`, `locked`, `role-denied`, `body-too-large`." },
  }, ["schema", "error", "message"]),
  Principal: obj({ kind: { enum: ["owner", "user"] }, id: { type: "string" }, role: { enum: ROLE_NAMES } }),
  Token: obj({ id: { type: "string" }, prefix: { type: "string" }, name: { type: "string" }, scopes: { type: "array", items: { type: "string" } }, createdAt: iso, expiresAt: iso, lastUsedAt: iso, revokedAt: iso }, ["id", "prefix", "name", "scopes", "createdAt", "expiresAt"]),
  Activity: obj({ state: { type: "string" }, since: { type: "integer" }, phase: { enum: ["light", "rem", "deep"] } }, ["state", "since"]),
};

const SESSION_TIMES = { createdAt: iso, expiresAt: iso, idleExpiresAt: iso };

export const ROUTES: readonly RouteSpec[] = [
  {
    id: "session.create", method: "POST", path: `${API_PREFIX}/session`, tag: "session", summary: "Log in with the owner token or with a local account; sets the session cookie",
    auth: "none", authz: "public", csrf: false, rate: "auth", stability: "experimental", since: "1.0.0",
    requestBody: {
      oneOf: [
        obj({ token: { type: "string", minLength: 32, maxLength: 512, description: "The owner token (`run/api-owner.token`), the bootstrap way in. The core's RPC token is not accepted." } }),
        obj({ username: { type: "string", minLength: 1, maxLength: 128 }, password: { type: "string", minLength: 1, maxLength: 1024 } }),
      ],
    },
    successStatus: 200,
    success: { description: "Logged in; `Set-Cookie` carries the session (HttpOnly, SameSite=Strict, Secure over TLS). Any session cookie the request carried is ended.", schema: obj({ schema: schemaId("session.create/1"), principal: ref("Principal"), ...SESSION_TIMES }) },
  },
  {
    id: "session.delete", method: "DELETE", path: `${API_PREFIX}/session`, tag: "session", summary: "Log out; ends the session server-side",
    auth: "session", authz: "authenticated", csrf: true, rate: "write", stability: "experimental", since: "1.0.0",
    successStatus: 200, success: { description: "Logged out; the cookie is cleared.", schema: obj({ schema: schemaId("session.delete/1"), ok: { const: true } }) },
  },
  {
    id: "sessions.revoke-all", method: "DELETE", path: `${API_PREFIX}/sessions`, tag: "session", summary: "Log out everywhere: ends every session of the caller",
    auth: "session", authz: "authenticated", csrf: true, rate: "write", stability: "experimental", since: "1.0.0",
    successStatus: 200, success: { description: "Every session of the caller, this one included, is ended; the cookie is cleared.", schema: obj({ schema: schemaId("sessions.revoke-all/1"), revoked: { type: "integer" } }) },
  },
  {
    id: "csrf.issue", method: "GET", path: `${API_PREFIX}/csrf`, tag: "session", summary: "A one-time CSRF token for the next write, bound to this session",
    auth: "session", authz: "authenticated", csrf: false, rate: "read", stability: "experimental", since: "1.0.0",
    successStatus: 200, success: { description: "Send it back in `X-CSRF-Token`; it works once.", schema: obj({ schema: schemaId("csrf/1"), token: { type: "string" }, expiresAt: iso }) },
  },
  {
    id: "health", method: "GET", path: `${API_PREFIX}/health`, tag: "status", summary: "API and core health",
    auth: "any", authz: { action: "doctor.read" }, csrf: false, rate: "read", stability: "experimental", since: "1.0.0",
    successStatus: 200,
    success: {
      description: "`ok`, or `degraded` while the engine is not ready or reports a degradation.",
      schema: obj({
        schema: schemaId("health/1"), status: { enum: ["ok", "degraded", "down"] }, api: obj({ version: { type: "string" } }),
        core: obj({ reachable: { type: "boolean" }, rpc: { type: "string" }, contract: { type: "string" }, uptimeMs: { type: "integer" }, engineReady: { type: "boolean" }, degraded: { type: "boolean" } }, ["reachable"]),
      }, ["schema", "status", "api", "core"]),
    },
    extra: { 503: { description: "The core is not reachable (`status: down`).", schema: ref("Health") } },
  },
  {
    id: "whoami", method: "GET", path: `${API_PREFIX}/whoami`, tag: "status", summary: "The calling principal and the session or token it came in with",
    auth: "any", authz: "authenticated", csrf: false, rate: "read", stability: "experimental", since: "1.0.0",
    successStatus: 200, success: { description: "The principal behind the session cookie, with the role as it is now.", schema: obj({ schema: schemaId("whoami/1"), principal: ref("Principal"), via: { enum: ["session", "token"] }, session: obj(SESSION_TIMES), token: obj({ id: { type: "string" }, prefix: { type: "string" }, scopes: { type: "array", items: { type: "string" } }, expiresAt: iso }) }, ["schema", "principal", "via"]) },
  },
  {
    id: "agents.list", method: "GET", path: `${API_PREFIX}/agents`, tag: "agents", summary: "The agents the caller may see (core RPC `agent.list`, filtered by `agent.read`)",
    auth: "any", authz: { action: "agent.list" }, csrf: false, rate: "read", stability: "experimental", since: "1.0.0",
    successStatus: 200,
    success: { description: "The core's `agent.list` result, with a schema id, reduced to the agents the caller holds `agent.read` on.", schema: obj({ schema: schemaId("agents.list/1"), agents: { type: "array", items: obj({ agentId: { type: "string" }, open: { type: "boolean" }, activity: ref("Activity") }) } }) },
  },
  {
    id: "tokens.list", method: "GET", path: `${API_PREFIX}/tokens`, tag: "tokens", summary: "The caller's personal API tokens (never the secret, never the hash)",
    auth: "session", authz: { action: "my.read", resource: "self" }, csrf: false, rate: "read", stability: "experimental", since: "1.0.0",
    successStatus: 200, success: { description: "Newest first; revoked and expired tokens stay listed.", schema: obj({ schema: schemaId("tokens.list/1"), tokens: { type: "array", items: ref("Token") } }) },
  },
  {
    id: "tokens.create", method: "POST", path: `${API_PREFIX}/tokens`, tag: "tokens", summary: "Make a personal API token; the secret is shown once, in this answer",
    auth: "session", authz: { action: "my.write", resource: "self" }, csrf: true, rate: "write", stability: "experimental", since: "1.0.0",
    requestBody: obj({
      name: { type: "string", minLength: 1, maxLength: 64 },
      scopes: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" }, description: "RBAC action names or `prefix.*` (e.g. `agent.*`). A token can only narrow what the caller's role allows, never widen it." },
      ttlDays: { type: "integer", minimum: 1, maximum: 365, description: "Default 90." },
    }, ["name", "scopes"]),
    successStatus: 201,
    success: { description: "`token` is the full string (`plb_<id>_<secret>`), shown here and nowhere else; only its hash is kept.", schema: obj({ schema: schemaId("tokens.create/1"), token: { type: "string" }, record: ref("Token") }) },
    extra: { 409: { description: "The caller already holds the maximum number of live tokens (`reason`: `token-limit`).", schema: ref("Error") } },
  },
  {
    id: "tokens.revoke", method: "POST", path: `${API_PREFIX}/tokens/revoke`, tag: "tokens", summary: "Revoke one of the caller's tokens; it stops working at once",
    auth: "session", authz: { action: "my.write", resource: "self" }, csrf: true, rate: "write", stability: "experimental", since: "1.0.0",
    requestBody: obj({ id: { type: "string", pattern: "^[0-9a-f]{12}$" } }),
    successStatus: 200, success: { description: "Revoked.", schema: obj({ schema: schemaId("tokens.revoke/1"), revoked: { const: true } }) },
    extra: { 404: { description: "No such live token of the caller's (`reason`: `token`).", schema: ref("Error") } },
  },
];
// `Health` is the 200 schema of `health`, referenced by its 503.
COMPONENT_SCHEMAS.Health = ROUTES.find((r) => r.id === "health")!.success.schema;

export interface HandlerInput {
  principal: Principal | undefined; session: Session | undefined; sessionId: string | undefined; body: unknown;
  /** The RBAC principal built from the user directory for this request (never from the session's stored role). */
  rbac: RbacPrincipal | undefined;
  /** The session cookie the request carried, if any, on routes that do not authenticate with it (login): it is ended. */
  presentedSessionId: string | undefined;
  ip: string;
  /** How the caller authenticated: the session cookie or a personal API token. */
  via: "session" | "token" | undefined;
  /** Set when `via` is `token`: what whoami may show of it (never the hash, never the secret). */
  token: { id: string; prefix: string; scopes: readonly string[]; expiresAt: number } | undefined;
}
export interface HandlerOutput { status?: number; body: Record<string, unknown>; headers?: Record<string, string> }
export type Handler = (i: HandlerInput) => Promise<HandlerOutput> | HandlerOutput;

export interface HandlerDeps {
  core: CoreRpc; sessions: SessionStore; verifyOwner: (candidate: unknown) => boolean; clock: Clock; tls: boolean;
  principal: Principal; healthTimeoutMs: number; log: { info(msg: string, f?: Record<string, unknown>): void; warn(msg: string, f?: Record<string, unknown>): void };
  /** Password login; without it only the owner token logs in. */
  login?: PasswordLogin | undefined;
  tokens?: TokenService | undefined;
  audit: AuditEmitter;
}

const iso8601 = (ms: number) => new Date(ms).toISOString();

export function sessionCookie(tls: boolean, value: string, maxAgeSec: number): string {
  return `${tls ? COOKIE_NAME_TLS : COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${tls ? "; Secure" : ""}`;
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(errors.timeout("core-timeout")), ms); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

type LoginBody = { kind: "token"; token: string } | { kind: "password"; username: string; password: string };

/** Exactly `{token}` or exactly `{username, password}`; anything else is not a login. */
function loginBody(b: unknown): LoginBody | undefined {
  if (!b || typeof b !== "object" || Array.isArray(b)) return undefined;
  const o = b as Record<string, unknown>; const keys = Object.keys(o);
  if (keys.length === 1 && typeof o.token === "string") return { kind: "token", token: o.token };
  if (keys.length === 2 && typeof o.username === "string" && typeof o.password === "string") return { kind: "password", username: o.username, password: o.password };
  return undefined;
}

/** A token as the API shows it: times as ISO strings, nothing secret. */
function tokenJson(t: PublicToken): Record<string, unknown> {
  return { id: t.id, prefix: t.prefix, name: t.name, scopes: t.scopes, createdAt: iso8601(t.createdAt), expiresAt: iso8601(t.expiresAt), ...(t.lastUsedAt !== undefined ? { lastUsedAt: iso8601(t.lastUsedAt) } : {}), ...(t.revokedAt !== undefined ? { revokedAt: iso8601(t.revokedAt) } : {}) };
}

export function buildHandlers(d: HandlerDeps): Record<string, Handler> {
  const clearCookie = { "Set-Cookie": sessionCookie(d.tls, "", 0) };
  return {
    "session.create": async (i) => {
      const b = loginBody(i.body);
      if (!b) throw errors.badRequest("body", "body must be {\"token\": string} or {\"username\": string, \"password\": string}");
      let principal: Principal; let authVersion = 0;
      if (b.kind === "token") {
        if (!d.verifyOwner(b.token)) {
          d.log.warn("login refused");
          d.audit.emit("auth.login.failure", "anonymous", "owner-token", { via: "owner-token", reason: "invalid-token", ip: i.ip });
          throw new ApiError(401, "E_UNAUTHORIZED", "authentication failed", { reason: "invalid-token" });
        }
        principal = d.principal;
      } else {
        const r = d.login ? await d.login.check(b.username, b.password) : ({ ok: false, locked: false } as const);
        if (!r.ok) {
          d.log.warn("login refused");
          d.audit.emit("auth.login.failure", "anonymous", nameHandle(b.username), { via: "password", reason: r.locked ? "locked" : "invalid-credentials", ip: i.ip });
          if (r.locked) throw errors.locked(r.retryAfterSec ?? 1);
          throw new ApiError(401, "E_UNAUTHORIZED", "authentication failed", { reason: "invalid-credentials" });
        }
        principal = { kind: "user", id: r.user.id, role: r.user.role }; authVersion = r.user.version;
      }
      // Session fixation: a cookie the request already carried never becomes the logged-in session, and it dies here.
      d.sessions.destroy(i.presentedSessionId);
      const { id, session } = d.sessions.create(principal, { authVersion });
      d.log.info("login", { principal: session.principal.id });
      d.audit.emit("auth.login.success", principal.id, `user:${principal.id}`, { via: b.kind === "token" ? "owner-token" : "password", ip: i.ip });
      return { body: { schema: "session.create/1", principal: session.principal, createdAt: iso8601(session.createdAt), expiresAt: iso8601(session.absoluteExpiresAt), idleExpiresAt: iso8601(session.idleExpiresAt) }, headers: { "Set-Cookie": sessionCookie(d.tls, id, Math.floor((session.absoluteExpiresAt - session.createdAt) / 1000)) } };
    },
    "session.delete": (i) => {
      d.sessions.destroy(i.sessionId);
      d.log.info("logout", { principal: i.principal?.id });
      d.audit.emit("auth.logout", i.principal?.id ?? "anonymous", `user:${i.principal?.id ?? "-"}`, { ip: i.ip });
      return { body: { schema: "session.delete/1", ok: true }, headers: clearCookie };
    },
    "sessions.revoke-all": (i) => {
      if (!i.principal) throw errors.unauthenticated();
      const revoked = d.sessions.destroyAllFor(i.principal.id);
      d.log.info("logout everywhere", { principal: i.principal.id, revoked });
      d.audit.emit("auth.logout-all", i.principal.id, `user:${i.principal.id}`, { revoked, ip: i.ip });
      return { body: { schema: "sessions.revoke-all/1", revoked }, headers: clearCookie };
    },
    "csrf.issue": (i) => {
      const t = i.sessionId ? d.sessions.issueCsrf(i.sessionId) : undefined;
      if (!t) throw errors.unauthenticated("session-expired");
      return { body: { schema: "csrf/1", token: t.token, expiresAt: iso8601(t.expiresAt) } };
    },
    "health": async () => {
      try {
        const s = await withDeadline(d.core.call<{ rpc: string; contract: string; uptimeMs: number; engine: { ready: boolean; degraded: unknown } }>("core.status"), d.healthTimeoutMs);
        const degraded = s.engine.degraded !== null && s.engine.degraded !== undefined;
        return { body: { schema: "health/1", status: !s.engine.ready || degraded ? "degraded" : "ok", api: { version: API_VERSION }, core: { reachable: true, rpc: s.rpc, contract: s.contract, uptimeMs: s.uptimeMs, engineReady: s.engine.ready, degraded } } };
      } catch {
        return { status: 503, body: { schema: "health/1", status: "down", api: { version: API_VERSION }, core: { reachable: false } } };
      }
    },
    "whoami": (i) => {
      if (!i.principal) throw errors.unauthenticated();
      if (i.via === "token" && i.token) return { body: { schema: "whoami/1", principal: i.principal, via: "token", token: { id: i.token.id, prefix: i.token.prefix, scopes: i.token.scopes, expiresAt: iso8601(i.token.expiresAt) } } };
      if (!i.session) throw errors.unauthenticated();
      return { body: { schema: "whoami/1", principal: i.principal, via: "session", session: { createdAt: iso8601(i.session.createdAt), expiresAt: iso8601(i.session.absoluteExpiresAt), idleExpiresAt: iso8601(i.session.idleExpiresAt) } } };
    },
    "tokens.list": async (i) => {
      if (!i.principal || !d.tokens) throw errors.unauthenticated();
      const tokens = (await d.tokens.list(i.principal.id)).map(tokenJson);
      return { body: { schema: "tokens.list/1", tokens } };
    },
    "tokens.create": async (i) => {
      if (!i.principal || !d.tokens) throw errors.unauthenticated();
      const b = i.body as Record<string, unknown> | null;
      const keys = b && typeof b === "object" && !Array.isArray(b) ? Object.keys(b) : [];
      if (!b || !keys.includes("name") || !keys.includes("scopes") || keys.some((k) => !["name", "scopes", "ttlDays"].includes(k))) throw errors.badRequest("body", "body must be {\"name\": string, \"scopes\": string[], \"ttlDays\"?: integer}");
      let ttlMs: number | undefined;
      if (b.ttlDays !== undefined) {
        if (typeof b.ttlDays !== "number" || !Number.isInteger(b.ttlDays) || b.ttlDays < 1 || b.ttlDays > 365) throw errors.badRequest("ttl", "ttlDays must be an integer between 1 and 365");
        ttlMs = b.ttlDays * 86_400_000;
      }
      const made = await d.tokens.create(i.principal.id, { name: b.name, scopes: b.scopes, ...(ttlMs !== undefined ? { ttlMs } : {}) });
      d.audit.emit("auth.token.created", i.principal.id, `token:${made.record.id}`, { name: made.record.name, scopes: made.record.scopes, expiresAt: made.record.expiresAt, ip: i.ip });
      return { status: 201, body: { schema: "tokens.create/1", token: made.token, record: tokenJson(made.record) } };
    },
    "tokens.revoke": async (i) => {
      if (!i.principal || !d.tokens) throw errors.unauthenticated();
      const b = i.body as { id?: unknown } | null;
      if (!b || typeof b !== "object" || Array.isArray(b) || typeof b.id !== "string" || Object.keys(b).length !== 1 || !/^[0-9a-f]{12}$/.test(b.id)) throw errors.badRequest("body", "body must be {\"id\": string}");
      if (!(await d.tokens.revoke(i.principal.id, b.id))) throw new ApiError(404, "E_NOT_FOUND", "no such token", { reason: "token" });
      d.audit.emit("auth.token.revoked", i.principal.id, `token:${b.id}`, { ip: i.ip });
      return { body: { schema: "tokens.revoke/1", revoked: true } };
    },
    "agents.list": async (i) => {
      try {
        const r = await d.core.call<Record<string, unknown>>("agent.list");
        // Object rights decide which agents a caller sees (acceptance 3). Elements pass through untouched or not at all
        // (never re-serialised, ruling R13); a result that is not a list is shown to nobody.
        const all = Array.isArray(r.agents) ? (r.agents as unknown[]) : [];
        const agents = all.filter((a) => {
          const agentId = a && typeof a === "object" && typeof (a as { agentId?: unknown }).agentId === "string" ? (a as { agentId: string }).agentId : "";
          return authorize(i.rbac, "agent.read", { kind: "agent", agentId }).effect === "allow";
        });
        return { body: { schema: "agents.list/1", ...r, agents } };
      } catch (e) { throw fromCoreError(e); }
    },
  };
}
