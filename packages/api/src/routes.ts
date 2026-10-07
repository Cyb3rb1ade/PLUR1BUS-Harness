import type { Clock } from "./clock.ts";
import type { CoreRpc } from "./core-rpc.ts";
import { ApiError, errors, fromCoreError } from "./errors.ts";
import type { RateClass } from "./rate-limit.ts";
import type { Principal, Session, SessionStore } from "./session.ts";

export const API_VERSION = "1.0.0";
export const API_PREFIX = "/api/v1";
export const COOKIE_NAME = "plur1bus_session";
/** Over TLS the cookie takes the `__Host-` prefix: the browser then refuses it unless it is `Secure`, host-only, `Path=/`. */
export const COOKIE_NAME_TLS = "__Host-plur1bus_session";
export const CSRF_HEADER = "x-csrf-token";

export type JsonSchema = Record<string, unknown>;
export type Method = "GET" | "POST" | "DELETE";

export interface RouteSpec {
  id: string; method: Method; path: string; summary: string; tag: string;
  /** `none` is public (login only, ruling R5); everything else needs a session. */
  auth: "none" | "session";
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

/** Reusable schemas of the OpenAPI document (`components.schemas`). */
export const COMPONENT_SCHEMAS: Record<string, JsonSchema> = {
  Error: obj({
    schema: schemaId("error/1"),
    error: { type: "string", description: "A member of the closed RPC `ErrorCode` enum (ADR-016 §2).", enum: ["E_UNAUTHORIZED", "E_RPC_VERSION", "E_NOT_AVAILABLE", "E_CORE_UNAVAILABLE", "E_INVALID_PARAMS", "E_AGENT_UNKNOWN", "E_CONFIG_INVALID", "E_MODULE_UNKNOWN", "E_INTERNAL", "E_LOCKED", "E_NOT_FOUND", "E_DENIED", "E_APPROVAL_REQUIRED", "E_CONFLICT", "E_STORAGE"] },
    message: { type: "string" },
    reason: { type: "string", description: "A short machine-readable cause, e.g. `no-session`, `csrf`, `rate-limited`, `body-too-large`." },
  }, ["schema", "error", "message"]),
  Principal: obj({ kind: { enum: ["owner"] }, id: { type: "string" }, role: { enum: ["owner"] } }),
  Activity: obj({ state: { type: "string" }, since: { type: "integer" }, phase: { enum: ["light", "rem", "deep"] } }, ["state", "since"]),
};

const iso: JsonSchema = { type: "string", format: "date-time" };
const SESSION_TIMES = { createdAt: iso, expiresAt: iso, idleExpiresAt: iso };

export const ROUTES: readonly RouteSpec[] = [
  {
    id: "session.create", method: "POST", path: `${API_PREFIX}/session`, tag: "session", summary: "Log in with the owner token; sets the session cookie",
    auth: "none", csrf: false, rate: "auth", stability: "experimental", since: "1.0.0",
    requestBody: obj({ token: { type: "string", minLength: 32, maxLength: 512, description: "The owner token (`run/api-owner.token`). The core's RPC token is not accepted." } }),
    successStatus: 200,
    success: { description: "Logged in; `Set-Cookie` carries the session (HttpOnly, SameSite=Strict, Secure over TLS).", schema: obj({ schema: schemaId("session.create/1"), principal: ref("Principal"), ...SESSION_TIMES }) },
  },
  {
    id: "session.delete", method: "DELETE", path: `${API_PREFIX}/session`, tag: "session", summary: "Log out; ends the session server-side",
    auth: "session", csrf: true, rate: "write", stability: "experimental", since: "1.0.0",
    successStatus: 200, success: { description: "Logged out; the cookie is cleared.", schema: obj({ schema: schemaId("session.delete/1"), ok: { const: true } }) },
  },
  {
    id: "csrf.issue", method: "GET", path: `${API_PREFIX}/csrf`, tag: "session", summary: "A one-time CSRF token for the next write, bound to this session",
    auth: "session", csrf: false, rate: "read", stability: "experimental", since: "1.0.0",
    successStatus: 200, success: { description: "Send it back in `X-CSRF-Token`; it works once.", schema: obj({ schema: schemaId("csrf/1"), token: { type: "string" }, expiresAt: iso }) },
  },
  {
    id: "health", method: "GET", path: `${API_PREFIX}/health`, tag: "status", summary: "API and core health",
    auth: "session", csrf: false, rate: "read", stability: "experimental", since: "1.0.0",
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
    id: "whoami", method: "GET", path: `${API_PREFIX}/whoami`, tag: "status", summary: "The calling principal and its session",
    auth: "session", csrf: false, rate: "read", stability: "experimental", since: "1.0.0",
    successStatus: 200, success: { description: "The principal behind the session cookie.", schema: obj({ schema: schemaId("whoami/1"), principal: ref("Principal"), session: obj(SESSION_TIMES) }) },
  },
  {
    id: "agents.list", method: "GET", path: `${API_PREFIX}/agents`, tag: "agents", summary: "The agents the core knows (core RPC `agent.list`)",
    auth: "session", csrf: false, rate: "read", stability: "experimental", since: "1.0.0",
    successStatus: 200,
    success: { description: "The core's `agent.list` result, with a schema id.", schema: obj({ schema: schemaId("agents.list/1"), agents: { type: "array", items: obj({ agentId: { type: "string" }, open: { type: "boolean" }, activity: ref("Activity") }) } }) },
  },
];
// `Health` is the 200 schema of `health`, referenced by its 503.
COMPONENT_SCHEMAS.Health = ROUTES.find((r) => r.id === "health")!.success.schema;

export interface HandlerInput { principal: Principal | undefined; session: Session | undefined; sessionId: string | undefined; body: unknown }
export interface HandlerOutput { status?: number; body: Record<string, unknown>; headers?: Record<string, string> }
export type Handler = (i: HandlerInput) => Promise<HandlerOutput> | HandlerOutput;

export interface HandlerDeps {
  core: CoreRpc; sessions: SessionStore; verifyOwner: (candidate: unknown) => boolean; clock: Clock; tls: boolean;
  principal: Principal; healthTimeoutMs: number; log: { info(msg: string, f?: Record<string, unknown>): void; warn(msg: string, f?: Record<string, unknown>): void };
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

export function buildHandlers(d: HandlerDeps): Record<string, Handler> {
  return {
    "session.create": (i) => {
      const b = i.body as { token?: unknown } | null;
      if (!b || typeof b !== "object" || Array.isArray(b) || typeof b.token !== "string" || Object.keys(b).length !== 1) throw errors.badRequest("body", "body must be {\"token\": string}");
      if (!d.verifyOwner(b.token)) { d.log.warn("login refused"); throw new ApiError(401, "E_UNAUTHORIZED", "authentication failed", { reason: "invalid-token" }); }
      const { id, session } = d.sessions.create(d.principal);
      d.log.info("login", { principal: session.principal.id });
      return { body: { schema: "session.create/1", principal: session.principal, createdAt: iso8601(session.createdAt), expiresAt: iso8601(session.absoluteExpiresAt), idleExpiresAt: iso8601(session.idleExpiresAt) }, headers: { "Set-Cookie": sessionCookie(d.tls, id, Math.floor((session.absoluteExpiresAt - session.createdAt) / 1000)) } };
    },
    "session.delete": (i) => {
      d.sessions.destroy(i.sessionId);
      d.log.info("logout", { principal: i.principal?.id });
      return { body: { schema: "session.delete/1", ok: true }, headers: { "Set-Cookie": sessionCookie(d.tls, "", 0) } };
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
      if (!i.session || !i.principal) throw errors.unauthenticated();
      return { body: { schema: "whoami/1", principal: i.principal, session: { createdAt: iso8601(i.session.createdAt), expiresAt: iso8601(i.session.absoluteExpiresAt), idleExpiresAt: iso8601(i.session.idleExpiresAt) } } };
    },
    "agents.list": async () => {
      try {
        const r = await d.core.call<Record<string, unknown>>("agent.list");
        return { body: { schema: "agents.list/1", ...r } }; // the raw RPC value, never re-serialised (AGENTS.md, ruling R13)
      } catch (e) { throw fromCoreError(e); }
    },
  };
}
