import { CHANNEL_HANDOFF_ROUTES, channelHandoffHandlers } from "./channel-handoff-routes.ts";
import { EXTENSION_COMPONENTS, EXTENSION_ROUTES, extensionHandlers } from "./extension-routes.ts";
import { IMPORT_ROUTES, importHandlers } from "./import-routes.ts";
import { MCP_ROUTES, buildMcpHandlers } from "./mcp/routes.ts";
import { A2A_ROUTES, buildA2aHandlers } from "./a2a/routes.ts";
import { OAUTH_ROUTES, buildOAuthHandlers } from "./oauth/routes.ts";
import { buildDesktopAttachHandlers } from "./desktop-attach-routes.ts";
import { DESKTOP_ATTACH_ROUTES } from "./desktop-attach-contract.ts";
import { DESKTOP_STEPUP_ROUTES } from "./desktop-stepup-contract.ts";
import { buildDesktopStepUpHandlers } from "./desktop-stepup-routes.ts";
import { WEBAUTHN_ROUTES, buildWebAuthnHandlers } from "./webauthn-routes.ts";
import {REMOTE_PAIRING_ROUTES,buildRemotePairingHandlers} from "./remote-pairing-routes.ts";
import {REMOTE_ROUTES,buildRemoteHandlers} from "./remote-config-routes.ts";
import { WS_ROUTES } from "./ws-routes.ts";
import { CHAT_ROUTES, buildChatHandlers } from "./chat-routes.ts";
import { ACCOUNT_ROUTES, buildAccountHandlers } from "./account-routes.ts";
import { TRANSPORT_ROUTES, buildTransportHandlers } from "./transport-routes.ts";
import { ERROR_CODES } from "@plur1bus/rpc-schema";
import type { AuditEmitter } from "./audit.ts";
import { nameHandle } from "./audit.ts";
import type { Clock } from "./clock.ts";
import type { CoreRpc } from "./core-rpc.ts";
import { ApiError, errors, fromCoreError } from "./errors.ts";
import type { PasswordLogin } from "./login.ts";
import type { LoginChallenges } from "./challenge.ts";
import { parseTokenBinding, type PublicToken, type TokenService } from "./tokens.ts";
import type { TotpService } from "./totp.ts";
import type { TokenBinding, UserDirectory } from "./ports.ts";
import type { RateLimiter } from "./rate-limit.ts";
import type { RateClass } from "./rate-limit.ts";
import { LOCAL_OWNER, authorize, type RbacPrincipal } from "./rbac-bridge.ts";
import type { Principal, Session, SessionStore } from "./session.ts";

export const API_VERSION = "1.0.0";
export const API_PREFIX = "/api/v1";
export const COOKIE_NAME = "plur1bus_session";
/** Over TLS the cookie takes the `__Host-` prefix: the browser then refuses it unless it is `Secure`, host-only, `Path=/`. */
export const COOKIE_NAME_TLS = "__Host-plur1bus_session";
export const CSRF_HEADER = "x-csrf-token";

export type JsonSchema = Record<string, unknown>;
export type Method = "GET" | "POST" | "PATCH" | "DELETE";

/** What a route needs from `authorize(principal, action, resource)` (ADR-007 *Enforcement*): every route declares one of
 *  these, and a route that does not is refused with 403 whoever calls it.
 *  - `public`: no authentication at all (login only).
 *  - `authenticated`: any live principal; for the caller's own session handling (logout, CSRF token, whoami), which
 *    must work for a Viewer too. Deliberately narrow: the deny-by-default test names every route that uses it.
 *  - `{ action }`: a member of core's RBAC policy table, on the system resource, on the caller's own user (`self`) or on
 *    *some* user (`user`: the role is checked here, the handler names the target and checks again). */
export type Authz = "public" | "authenticated" | "delegated" | { action: string; resource?: "system" | "self" | "user" };

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
  transport?: "protocol";
  protocol?: import("./protocol-routes.ts").ProtocolRouteOptions;
  requestBody?: JsonSchema;
  requestContentType?: "application/json" | "multipart/form-data";
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
  ...EXTENSION_COMPONENTS,
  Error: obj({
    schema: schemaId("error/1"),
    error: { type: "string", description: "A member of the closed RPC `ErrorCode` enum (ADR-016 §2).", enum: [...ERROR_CODES] },
    message: { type: "string" },
    reason: { type: "string", description: "A short machine-readable cause, e.g. `no-session`, `csrf`, `rate-limited`, `locked`, `role-denied`, `body-too-large`." },
  }, ["schema", "error", "message"]),
  Principal: obj({ kind: { enum: ["owner", "user"] }, id: { type: "string" }, role: { enum: ROLE_NAMES } }),
  SessionChallenge: obj({ schema: schemaId("session.challenge/1"), mfa: { enum: ["totp", "webauthn"] }, challenge: { type: "string", description: "One-time, valid for 5 minutes, dies after 5 wrong codes." }, expiresAt: iso }),
  BreakGlassGrant: obj({ id: { type: "string" }, targetUserId: { type: "string" }, reason: { type: "string" }, issuedAt: iso, expiresAt: iso }),
  Notice: obj({ kind: { const: "break-glass.granted" }, grantId: { type: "string" }, holderUserId: { type: "string" }, reason: { type: "string" }, expiresAt: iso }),
  TokenBinding: obj({
    audience: { enum: ["mcp", "a2a"] },
    agentId: { type: "string", minLength: 1, maxLength: 128 },
    projectId: { type: "string", minLength: 1, maxLength: 128 },
    system: { type: "string", minLength: 1, maxLength: 128 },
    groups: { type: "array", maxItems: 10, items: { enum: ["memory", "memory_store", "agent", "skills"] } },
    memory: obj({
      recall: obj({ workspace: { type: "boolean" }, user: { type: "boolean" }, agentPrivate: { type: "boolean" }, project: { type: "boolean" } }, []),
      filter: { type: "array", maxItems: 5, items: { enum: ["health", "financial", "credential", "identity", "personal"] } },
      disclose: { enum: ["agent-decides", "never"] },
      capture: { type: "boolean" },
    }, []),
  }, ["audience", "agentId"]),
  Token: obj({ id: { type: "string" }, prefix: { type: "string" }, name: { type: "string" }, scopes: { type: "array", items: { type: "string" } }, createdAt: iso, expiresAt: iso, lastUsedAt: iso, revokedAt: iso, binding: ref("TokenBinding") }, ["id", "prefix", "name", "scopes", "createdAt", "expiresAt"]),
  Activity: obj({ state: { type: "string" }, since: { type: "integer" }, phase: { enum: ["light", "rem", "deep"] }, job: { type: "string" } }, ["state", "since"]),
};

const SESSION_TIMES = { createdAt: iso, expiresAt: iso, idleExpiresAt: iso };

export const ROUTES: readonly RouteSpec[] = [
  ...IMPORT_ROUTES,
  ...EXTENSION_ROUTES,
  ...MCP_ROUTES,
  ...A2A_ROUTES,
  ...OAUTH_ROUTES,
  ...DESKTOP_ATTACH_ROUTES, ...DESKTOP_STEPUP_ROUTES, ...TRANSPORT_ROUTES, ...ACCOUNT_ROUTES, ...WEBAUTHN_ROUTES, ...CHAT_ROUTES, ...WS_ROUTES, ...REMOTE_ROUTES, ...REMOTE_PAIRING_ROUTES, ...CHANNEL_HANDOFF_ROUTES,
  {
    id: "session.create", method: "POST", path: `${API_PREFIX}/session`, tag: "session", summary: "Log in with a local account or an explicitly configured compatibility credential; sets the session cookie",
    auth: "none", authz: "public", csrf: false, rate: "auth", stability: "experimental", since: "1.0.0",
    requestBody: {
      oneOf: [
        obj({ token: { type: "string", minLength: 32, maxLength: 512, description: "Explicit createApiServer compatibility credential. Production startup does not generate an owner-token file; native attach uses device pairing. The core RPC token is not accepted." } }),
        obj({ username: { type: "string", minLength: 1, maxLength: 128 }, password: { type: "string", minLength: 1, maxLength: 1024 } }),
      ],
    },
    successStatus: 200,
    success: {
      description: "Logged in: `session.create/1`, and `Set-Cookie` carries the session (HttpOnly, SameSite=Strict, Secure over TLS); any session cookie the request carried is ended. When the account has a second factor the answer is `session.challenge/1` instead, with no cookie: send the challenge and a code to `POST /api/v1/session/totp`.",
      schema: { oneOf: [obj({ schema: schemaId("session.create/1"), principal: ref("Principal"), ...SESSION_TIMES }), ref("SessionChallenge")] },
    },
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
    successStatus: 200, success: { description: "The principal behind the session cookie, with the role as it is now.", schema: obj({ schema: schemaId("whoami/1"), principal: ref("Principal"), via: { enum: ["session", "token"] }, session: obj(SESSION_TIMES), token: obj({ id: { type: "string" }, prefix: { type: "string" }, scopes: { type: "array", items: { type: "string" } }, expiresAt: iso, binding: ref("TokenBinding") }, ["id", "prefix", "scopes", "expiresAt"]) }, ["schema", "principal", "via"]) },
  },
  {
    id: "agents.list", method: "GET", path: `${API_PREFIX}/agents`, tag: "agents", summary: "The agents the caller may see (core RPC `agent.list`, filtered by `agent.read`)",
    auth: "any", authz: { action: "agent.list" }, csrf: false, rate: "read", stability: "experimental", since: "1.0.0",
    successStatus: 200,
    success: { description: "The core's `agent.list` result, with a schema id, reduced to the agents the caller holds `agent.read` on.", schema: obj({ schema: schemaId("agents.list/1"), agents: { type: "array", items: obj({ agentId: { type: "string" }, open: { type: "boolean" }, activity: ref("Activity"), lifecycle: obj({ paused: { type: "boolean" }, archived: { type: "boolean" }, deleted: { type: "boolean" } }) }, ["agentId", "open", "activity"]) } }) },
    extra: {
      502: { description: "The core failed to answer (`reason`: `core-error`) or refused the API's own connection (`reason`: `core-handshake`). The core's own text is not forwarded.", schema: ref("Error") },
      503: { description: "The core is not reachable (`reason`: `core-unreachable`).", schema: ref("Error") },
    },
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
      binding: ref("TokenBinding"),
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
  {
    id: "session.totp", method: "POST", path: `${API_PREFIX}/session/totp`, tag: "session", summary: "Second step of a login: the challenge and a TOTP or backup code",
    auth: "none", authz: "public", csrf: false, rate: "totp", stability: "experimental", since: "1.0.0",
    requestBody: obj({ challenge: { type: "string", maxLength: 100 }, code: { type: "string", maxLength: 32, description: "Six digits from the authenticator app, or a one-time backup code." } }),
    successStatus: 200,
    success: { description: "Logged in; the session cookie is set and any cookie the request carried is ended.", schema: obj({ schema: schemaId("session.create/1"), principal: ref("Principal"), ...SESSION_TIMES }) },
  },
  {
    id: "totp.status", method: "GET", path: `${API_PREFIX}/me/totp`, tag: "totp", summary: "Whether the caller's second factor is on, and how many backup codes are left",
    auth: "session", authz: { action: "my.read", resource: "self" }, csrf: false, rate: "read", stability: "experimental", since: "1.0.0",
    successStatus: 200, success: { description: "Never the secret, never a code.", schema: obj({ schema: schemaId("totp.status/1"), enabled: { type: "boolean" }, backupCodesRemaining: { type: "integer" } }) },
  },
  {
    id: "totp.setup", method: "POST", path: `${API_PREFIX}/me/totp/setup`, tag: "totp", summary: "Start enrolling an authenticator app: a new secret and its otpauth URI",
    auth: "session", authz: { action: "my.write", resource: "self" }, csrf: true, rate: "write", stability: "experimental", since: "1.0.0",
    successStatus: 200,
    success: { description: "The secret is pending until `confirm` sees a right code from it. Shown here and nowhere else.", schema: obj({ schema: schemaId("totp.setup/1"), secret: { type: "string" }, otpauthUri: { type: "string" } }) },
    extra: { 409: { description: "A second factor is already on (`reason`: `totp-enabled`), or the caller is the owner-token login, which has no account (`reason`: `no-account`).", schema: ref("Error") } },
  },
  {
    id: "totp.confirm", method: "POST", path: `${API_PREFIX}/me/totp/confirm`, tag: "totp", summary: "Turn the second factor on with a code from the new secret; returns the backup codes once",
    auth: "session", authz: { action: "my.write", resource: "self" }, csrf: true, rate: "totp", stability: "experimental", since: "1.0.0",
    requestBody: obj({ code: { type: "string", maxLength: 32 } }),
    successStatus: 200, success: { description: "Ten one-time backup codes, shown here and nowhere else (only their hashes are kept).", schema: obj({ schema: schemaId("totp.confirm/1"), enabled: { const: true }, backupCodes: { type: "array", items: { type: "string" } } }) },
    extra: { 409: { description: "The caller is the owner-token login, which has no account (`reason`: `no-account`).", schema: ref("Error") } },
  },
  {
    id: "totp.disable", method: "POST", path: `${API_PREFIX}/me/totp/disable`, tag: "totp", summary: "Turn the second factor off; needs a valid TOTP or backup code",
    auth: "session", authz: { action: "my.write", resource: "self" }, csrf: true, rate: "totp", stability: "experimental", since: "1.0.0",
    requestBody: obj({ code: { type: "string", maxLength: 32 } }),
    successStatus: 200, success: { description: "Off; the secret and the backup codes are deleted.", schema: obj({ schema: schemaId("totp.disable/1"), enabled: { const: false } }) },
    extra: { 409: { description: "The caller is the owner-token login, which has no account (`reason`: `no-account`).", schema: ref("Error") } },
  },
  {
    id: "breakglass.request", method: "POST", path: `${API_PREFIX}/breakglass`, tag: "breakglass", summary: "Ask for time-boxed read access to another user's cards; a reason is mandatory",
    auth: "session", authz: { action: "breakglass.request", resource: "user" }, csrf: true, rate: "write", stability: "experimental", since: "1.0.0",
    requestBody: obj({
      targetUserId: { type: "string" },
      reason: { type: "string", minLength: 10, maxLength: 500, description: "Free text, audited, and shown to the affected user." },
      ttlMinutes: { type: "integer", minimum: 1, maximum: 60, description: "Default 15." },
    }, ["targetUserId", "reason"]),
    successStatus: 201,
    success: { description: "Forwarded to the core's `breakglass.request`, the one registry: the grant exists only after its audit entry was written and the affected user has a durable notice (inbox, plus the live notice). It ends by itself.", schema: obj({ schema: schemaId("breakglass.grant/1"), grant: ref("BreakGlassGrant") }) },
    extra: { 404: { description: "No such user (`reason`: `target`).", schema: ref("Error") }, 503: { description: "The core could not audit the grant (`reason`: `audit-unavailable`) or could not store the notice (`reason`: `notice-unavailable`), so there is none.", schema: ref("Error") } },
  },
  {
    id: "breakglass.list", method: "GET", path: `${API_PREFIX}/breakglass`, tag: "breakglass", summary: "The caller's own live break-glass grants (the core's registry, whichever way they were made)",
    auth: "session", authz: { action: "breakglass.request", resource: "user" }, csrf: false, rate: "read", stability: "experimental", since: "1.0.0",
    successStatus: 200, success: { description: "Lapsed grants are gone (and audited once).", schema: obj({ schema: schemaId("breakglass.list/1"), grants: { type: "array", items: ref("BreakGlassGrant") } }) },
  },
  {
    id: "breakglass.revoke", method: "POST", path: `${API_PREFIX}/breakglass/revoke`, tag: "breakglass", summary: "End a grant early: its holder or an Owner",
    auth: "session", authz: { action: "breakglass.request", resource: "user" }, csrf: true, rate: "write", stability: "experimental", since: "1.0.0",
    requestBody: obj({ grantId: { type: "string" } }),
    successStatus: 200, success: { description: "Ended and audited.", schema: obj({ schema: schemaId("breakglass.revoke/1"), revoked: { const: true } }) },
    extra: { 404: { description: "No such live grant (`reason`: `grant`).", schema: ref("Error") } },
  },
  {
    id: "notices.list", method: "GET", path: `${API_PREFIX}/me/notices`, tag: "status", summary: "Things the caller should know: break-glass grants over their own cards",
    auth: "session", authz: { action: "my.read", resource: "self" }, csrf: false, rate: "read", stability: "experimental", since: "1.0.0",
    successStatus: 200, success: { description: "The core's durable break-glass notices for the caller, newest first, whichever way the grant was made. The core records no issue time, so a notice carries none. Push delivery to channels is the core's (`breakglass.notice`); this is the pull side.", schema: obj({ schema: schemaId("notices.list/1"), notices: { type: "array", items: ref("Notice") } }) },
  },
];
// `Health` is the 200 schema of `health`, referenced by its 503.
COMPONENT_SCHEMAS.Health = ROUTES.find((r) => r.id === "health")!.success.schema;

export interface HandlerInput {
  remoteTransport?:import("./remote-pairing-controller.ts").PairingTransport;
  pathParams?: Record<string,string>; query?: URLSearchParams; headers?: import("node:http").IncomingHttpHeaders;
  principal: Principal | undefined; session: Session | undefined; sessionId: string | undefined; body: unknown;
  /** The RBAC principal built from the user directory for this request (never from the session's stored role). */
  rbac: RbacPrincipal | undefined;
  /** The session cookie the request carried, if any, on routes that do not authenticate with it (login): it is ended. */
  presentedSessionId: string | undefined;
  ip: string;
  /** Origin checked against the listener allowlist before handler dispatch. */
  origin?: string | undefined;
  /** How the caller authenticated: the session cookie or a personal API token. */
  via: "session" | "token" | undefined;
  /** Set when `via` is `token`: what whoami may show of it (never the hash, never the secret). */
  token: { id: string; prefix: string; scopes: readonly string[]; expiresAt: number; binding?: TokenBinding } | undefined;
  /** Populated on `transport: "protocol"` routes. */
  rawBody?: Buffer | undefined;
  req?: import("node:http").IncomingMessage | undefined;
  res?: import("node:http").ServerResponse | undefined;
  secHeaders?: Record<string, string> | undefined;
  tokenRecord?: import("./ports.ts").TokenRecord | undefined;
}
export interface HandlerOutput { chatStream?: {sessionId:string;turnId:string;afterSeq:number}; streamed?: boolean; status?: number; body?: Record<string, unknown>; headers?: Record<string, string> }
export type Handler = (i: HandlerInput) => Promise<HandlerOutput> | HandlerOutput;

export interface HandlerDeps {
  desktopStepUp?: import("./desktop-stepup.ts").DesktopStepUp;
  core: CoreRpc; sessions: SessionStore; verifyOwner: (candidate: unknown) => boolean; clock: Clock; tls: boolean;
  principal: Principal; healthTimeoutMs: number; log: { info(msg: string, f?: Record<string, unknown>): void; warn(msg: string, f?: Record<string, unknown>): void };
  /** Password login; without it only the owner token logs in. */
  login?: PasswordLogin | undefined;
  requireSecondFactor?: (role:string)=>boolean;
  resolveBootstrap?: (() => Promise<import("./account-store.ts").CorePerson | null>) | undefined;
  tokens?: TokenService | undefined;
  users?: UserDirectory | undefined;
  hasPasskeys?: ((id: string) => boolean) | undefined;
  totp?: TotpService | undefined;
  challenges?: LoginChallenges | undefined;
  limiter?: RateLimiter | undefined;
  /** All clients reach the API from one address (tailnet mode): login attempts are then also bucketed per account name. */
  sharedAddress?: boolean | undefined;
  audit: AuditEmitter;
  mcpConfig?: import("./mcp/activation.ts").McpServerConfigLike | (() => Promise<import("./mcp/activation.ts").McpServerConfigLike | undefined> | import("./mcp/activation.ts").McpServerConfigLike | undefined) | undefined;
  a2aConfig?: import("./a2a/activation.ts").A2aServerConfigLike | (() => Promise<import("./a2a/activation.ts").A2aServerConfigLike | undefined> | import("./a2a/activation.ts").A2aServerConfigLike | undefined) | undefined;
  oauthService?: import("./oauth/service.ts").OAuthService | undefined;
  isRemote?: boolean | undefined;
}

const iso8601 = (ms: number) => new Date(ms).toISOString();

/** The fields of `core.status` the health answer repeats, checked for type and size first: what the core sends is not
 *  forwarded as it is. `undefined` when the shape is not the documented one. */
function coreStatus(v: unknown): { rpc: string; contract: string; uptimeMs: number; engineReady: boolean; degraded: boolean } | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const s = v as { rpc?: unknown; contract?: unknown; uptimeMs?: unknown; engine?: unknown };
  const e = s.engine as { ready?: unknown; degraded?: unknown } | null | undefined;
  if (typeof s.rpc !== "string" || s.rpc.length < 1 || s.rpc.length > 32 || typeof s.contract !== "string" || s.contract.length < 1 || s.contract.length > 32) return undefined;
  if (typeof s.uptimeMs !== "number" || !Number.isSafeInteger(s.uptimeMs) || s.uptimeMs < 0) return undefined;
  if (!e || typeof e !== "object" || Array.isArray(e) || typeof e.ready !== "boolean") return undefined;
  if (e.degraded !== null && e.degraded !== undefined && (typeof e.degraded !== "object" || Array.isArray(e.degraded))) return undefined;
  return { rpc: s.rpc, contract: s.contract, uptimeMs: s.uptimeMs, engineReady: e.ready, degraded: e.degraded !== null && e.degraded !== undefined };
}

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

/** Exactly `{code: string}`. */
function codeBody(b: unknown): string {
  if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).length !== 1 || typeof (b as { code?: unknown }).code !== "string" || (b as { code: string }).code.length > 32) throw errors.badRequest("body", "body must be {\"code\": string}");
  return (b as { code: string }).code;
}
const noAccount = () => new ApiError(409, "E_CONFLICT", "the owner-token login has no account to protect", { reason: "no-account" });

/** What the core's break-glass RPC refuses with, as the REST reasons the route has always answered with. The core's own text
 *  (and a chain's lock error under it) is not forwarded. */
const BG_INVALID_REASON: Record<string, string> = { "invalid-target": "target", "self-target": "self-target", "reason-required": "reason", "ttl-invalid": "ttl" };
function breakGlassError(e: unknown, op: "request" | "list" | "revoke" | "notices"): ApiError {
  const x = e as { error?: unknown; reason?: unknown } | null;
  const reason = typeof x?.reason === "string" ? x.reason : "";
  const refused = (status: number, error: "E_DENIED" | "E_INVALID_PARAMS" | "E_NOT_FOUND" | "E_NOT_AVAILABLE", why: string) => new ApiError(status, error, `break-glass refused (${why})`, { reason: why });
  switch (x?.error) {
    case "E_DENIED": return refused(403, "E_DENIED", "role-denied");
    case "E_INVALID_PARAMS": return refused(400, "E_INVALID_PARAMS", BG_INVALID_REASON[reason] ?? "request");
    case "E_NOT_FOUND": return refused(404, "E_NOT_FOUND", op === "revoke" ? "grant" : "target");
    // The core would not act unrecorded or unannounced: no grant exists.
    case "E_STORAGE": if (reason === "audit-failed") return refused(503, "E_NOT_AVAILABLE", "audit-unavailable"); break;
    case "E_NOT_AVAILABLE": if (reason === "notification-failed") return refused(503, "E_NOT_AVAILABLE", "notice-unavailable"); break;
  }
  return fromCoreError(e);
}
const coreMalformed = () => new ApiError(502, "E_CORE_UNAVAILABLE", "the core failed to answer", { reason: "core-error" });
/** The installation owner is `owner` in the API and `local-owner` in the core. */
const toCoreUser = (id: string): string => (id === "owner" ? LOCAL_OWNER.userId : id);
const fromCoreUser = (id: string): string => (id === LOCAL_OWNER.userId ? "owner" : id);
const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
/** A grant as the core sends it (times in ms), checked for type before it is shown: what the core sends is not forwarded as it is. */
function grantJson(g: unknown): { id: string; targetUserId: string; reason: string; issuedAt: string; expiresAt: string } {
  const x = g as { id?: unknown; targetUserId?: unknown; reason?: unknown; issuedAt?: unknown; expiresAt?: unknown } | null;
  if (!x || typeof x !== "object" || typeof x.id !== "string" || typeof x.targetUserId !== "string" || typeof x.reason !== "string" || !Number.isSafeInteger(x.issuedAt) || !Number.isSafeInteger(x.expiresAt)) throw coreMalformed();
  return { id: x.id, targetUserId: fromCoreUser(x.targetUserId), reason: x.reason, issuedAt: iso8601(x.issuedAt as number), expiresAt: iso8601(x.expiresAt as number) };
}

/** A token as the API shows it: times as ISO strings, nothing secret. */
function tokenJson(t: PublicToken): Record<string, unknown> {
  return {
    id: t.id, prefix: t.prefix, name: t.name, scopes: t.scopes, createdAt: iso8601(t.createdAt), expiresAt: iso8601(t.expiresAt),
    ...(t.lastUsedAt !== undefined ? { lastUsedAt: iso8601(t.lastUsedAt) } : {}), ...(t.revokedAt !== undefined ? { revokedAt: iso8601(t.revokedAt) } : {}),
    ...(t.binding !== undefined ? { binding: t.binding } : {}),
  };
}

export function buildHandlers(d: HandlerDeps): Record<string, Handler> {
  const clearCookie = { "Set-Cookie": sessionCookie(d.tls, "", 0) };
  return {
    ...importHandlers(),
    ...extensionHandlers(d.core),
    ...buildMcpHandlers(d),
    ...buildA2aHandlers(d),
    ...buildOAuthHandlers(d),
    ...buildDesktopAttachHandlers(d, () => false),
    ...buildDesktopStepUpHandlers(d),
    ...buildAccountHandlers(d, undefined, d.core),
    ...buildWebAuthnHandlers(d, undefined, () => "http://localhost"),
    ...buildTransportHandlers(d.core),
    ...buildChatHandlers(d.core,d.audit),
    ...channelHandoffHandlers(d.core),
    ...buildRemoteHandlers({core:d.core,now:()=>d.clock.now()}),
    ...buildRemotePairingHandlers(undefined),
    "ws.ticket": () => ({body:{}}), "ws.reserved": () => ({body:{}}),
    "session.create": async (i) => {
      const b = loginBody(i.body);
      if (!b) throw errors.badRequest("body", "body must be {\"token\": string} or {\"username\": string, \"password\": string}");
      let principal: Principal; let authVersion = 0;
      if (d.sharedAddress && d.limiter) {
        // The address bucket is only an upper bound here; five wrong passwords for one name stop that name, not every client.
        const key = `login:${b.kind === "token" ? "owner-token" : nameHandle(b.username)}`;
        const v = d.limiter.take("auth", key);
        if (!v.ok) { d.audit.emit("auth.rate-limited", "anonymous", key, { class: "auth", route: "session.create", ip: i.ip }); throw errors.rateLimited(v.retryAfterSec); }
      }
      if (b.kind === "token") {
        if (!d.verifyOwner(b.token)) {
          d.log.warn("login refused");
          d.audit.emit("auth.login.failure", "anonymous", "owner-token", { via: "owner-token", reason: "invalid-token", ip: i.ip });
          throw new ApiError(401, "E_UNAUTHORIZED", "authentication failed", { reason: "invalid-token" });
        }
        const current = d.resolveBootstrap ? await d.resolveBootstrap() : undefined;
        if (d.resolveBootstrap && (!current || current.disabled)) throw errors.unauthenticated("invalid-token");
        principal = current ? { ...d.principal, role: current.role } : d.principal; authVersion = current?.version ?? 0;
      } else {
        const r = d.login ? await d.login.check(b.username, b.password) : ({ ok: false, locked: false } as const);
        if (!r.ok) {
          d.log.warn("login refused");
          d.audit.emit("auth.login.failure", "anonymous", nameHandle(b.username), { via: "password", reason: r.locked ? "locked" : "invalid-credentials", ip: i.ip });
          if (r.locked) throw errors.locked(r.retryAfterSec ?? 1);
          throw new ApiError(401, "E_UNAUTHORIZED", "authentication failed", { reason: "invalid-credentials" });
        }
        // A second factor turns the right password into a challenge, not a session.
        if (d.challenges && (await d.totp?.isEnabled(r.user.id) || d.hasPasskeys?.(r.user.id))) {
          const c = d.challenges.create(r.user.id, r.user.version);
          return { body: { schema: "session.challenge/1", mfa: await d.totp?.isEnabled(r.user.id) ? "totp" : "webauthn", challenge: c.id, expiresAt: iso8601(c.expiresAt) } };
        }
        principal = { kind: "user", id: r.user.id, role: r.user.role }; authVersion = r.user.version;
      }
      if(d.requireSecondFactor?.(principal.role)){d.audit.emit("auth.login.failure",principal.id,`user:${principal.id}`,{reason:"second-factor-required",ip:i.ip});throw errors.forbidden("second-factor-required","a second factor must be enrolled locally before remote login");}
      // Session fixation: a cookie the request already carried never becomes the logged-in session, and it dies here.
      d.sessions.destroy(i.presentedSessionId);
      const { id, session } = d.sessions.create(principal, { authVersion });
      d.log.info("login", { principal: session.principal.id });
      d.audit.emit("auth.login.success", principal.id, `user:${principal.id}`, { via: b.kind === "token" ? "owner-token" : "password", ip: i.ip });
      return { body: { schema: "session.create/1", principal: session.principal, createdAt: iso8601(session.createdAt), expiresAt: iso8601(session.absoluteExpiresAt), idleExpiresAt: iso8601(session.idleExpiresAt) }, headers: { "Set-Cookie": sessionCookie(d.tls, id, Math.floor((session.absoluteExpiresAt - session.createdAt) / 1000)) } };
    },
    "session.totp": async (i) => {
      const b = i.body as { challenge?: unknown; code?: unknown } | null;
      if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).length !== 2 || typeof b.challenge !== "string" || typeof b.code !== "string" || b.code.length > 32) throw errors.badRequest("body", "body must be {\"challenge\": string, \"code\": string}");
      const refused = (reason = "invalid-code") => new ApiError(401, "E_UNAUTHORIZED", "authentication failed", { reason });
      const ch = d.challenges?.get(b.challenge);
      if (!ch || !d.totp || !d.users || !d.limiter) throw refused();
      // Brute force is bounded per user, not per challenge: a fresh challenge costs only a password the attacker already has.
      const spend = d.limiter.take("totp", `user:${ch.userId}`);
      if (!spend.ok) { d.audit.emit("auth.rate-limited", ch.userId, `user:${ch.userId}`, { class: "totp", route: "session.totp", ip: i.ip }); throw errors.rateLimited(spend.retryAfterSec); }
      const user = await d.users.findById(ch.userId);
      if (!user || user.disabled === true || user.version !== ch.version) { d.challenges!.consume(b.challenge); throw refused(); }
      const v = await d.totp.verify(user.id, b.code);
      if (!v.ok) {
        d.challenges!.fail(b.challenge);
        d.audit.emit("auth.totp.failure", user.id, `user:${user.id}`, { stage: "login", ip: i.ip });
        throw refused();
      }
      // Spent exactly once: two valid codes sent at once (both inside the window, so the replay guard passes each) would
      // otherwise turn one challenge into two sessions. The loser gets the ordinary refusal.
      if (!d.challenges!.consume(b.challenge)) throw refused();
      d.sessions.destroy(i.presentedSessionId);
      const principal: Principal = { kind: "user", id: user.id, role: user.role };
      const { id, session } = d.sessions.create(principal, { authVersion: user.version, stepUpAt: d.clock.now() });
      d.log.info("login", { principal: user.id });
      d.audit.emit("auth.login.success", user.id, `user:${user.id}`, { via: v.method === "backup" ? "password+backup" : "password+totp", ip: i.ip });
      if (v.method === "backup") d.audit.emit("auth.totp.backup-used", user.id, `user:${user.id}`, { remaining: (await d.totp.status(user.id)).backupCodesRemaining, ip: i.ip });
      return { body: { schema: "session.create/1", principal: session.principal, createdAt: iso8601(session.createdAt), expiresAt: iso8601(session.absoluteExpiresAt), idleExpiresAt: iso8601(session.idleExpiresAt) }, headers: { "Set-Cookie": sessionCookie(d.tls, id, Math.floor((session.absoluteExpiresAt - session.createdAt) / 1000)) } };
    },
    "totp.status": async (i) => {
      if (!i.principal || !d.totp) throw errors.unauthenticated();
      if (i.principal.kind !== "user") return { body: { schema: "totp.status/1", enabled: false, backupCodesRemaining: 0 } };
      return { body: { schema: "totp.status/1", ...(await d.totp.status(i.principal.id)) } };
    },
    "totp.setup": async (i) => {
      if (!i.principal || !d.totp || !d.users) throw errors.unauthenticated();
      if (i.principal.kind !== "user") throw noAccount();
      const u = await d.users.findById(i.principal.id);
      if (!u) throw errors.unauthenticated("session-expired");
      const b = await d.totp.begin(u.id, u.username);
      return { body: { schema: "totp.setup/1", secret: b.secret, otpauthUri: b.otpauthUri } };
    },
    "totp.confirm": async (i) => {
      if (!i.principal || !d.totp) throw errors.unauthenticated();
      const code = codeBody(i.body);
      if (i.principal.kind !== "user") throw noAccount();
      const r = await d.totp.confirm(i.principal.id, code);
      if (!r.ok) { d.audit.emit("auth.totp.failure", i.principal.id, `user:${i.principal.id}`, { stage: "confirm", ip: i.ip }); throw errors.forbidden("invalid-code", "that code is not valid"); }
      d.audit.emit("auth.totp.enabled", i.principal.id, `user:${i.principal.id}`, { ip: i.ip });
      return { body: { schema: "totp.confirm/1", enabled: true, backupCodes: r.backupCodes } };
    },
    "totp.disable": async (i) => {
      if (!i.principal || !d.totp) throw errors.unauthenticated();
      const code = codeBody(i.body);
      if (i.principal.kind !== "user") throw noAccount();
      if (!(await d.totp.disable(i.principal.id, code))) { d.audit.emit("auth.totp.failure", i.principal.id, `user:${i.principal.id}`, { stage: "disable", ip: i.ip }); throw errors.forbidden("invalid-code", "that code is not valid"); }
      d.audit.emit("auth.totp.disabled", i.principal.id, `user:${i.principal.id}`, { ip: i.ip });
      return { body: { schema: "totp.disable/1", enabled: false } };
    },
    // Break-glass has ONE registry, the core's (audit, durable notice and the memory read that honours a grant all live there). The
    // routes only check the shape of the request, then forward it as the caller; nothing is granted, audited or announced here.
    "breakglass.request": async (i) => {
      if (!i.rbac) throw errors.unauthenticated();
      const b = i.body as Record<string, unknown> | null;
      if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).some((k) => !["targetUserId", "reason", "ttlMinutes"].includes(k))) throw errors.badRequest("body", "body must be {\"targetUserId\": string, \"reason\": string, \"ttlMinutes\"?: integer}");
      if (typeof b.targetUserId !== "string" || b.targetUserId === "") throw errors.badRequest("target", "a target user is required");
      if (!isText(b.targetUserId, 128)) throw errors.badRequest("target", "that is not a user id");
      // Shape only; how many characters a reason needs, and how long a window may be, is the core's configuration (breakglass.*).
      if (typeof b.reason !== "string" || b.reason.trim() === "" || !isText(b.reason, 10_000)) throw errors.badRequest("reason", "a reason of 10 to 500 characters is required");
      let windowMinutes: number | undefined;
      if (b.ttlMinutes !== undefined) {
        if (typeof b.ttlMinutes !== "number" || !Number.isInteger(b.ttlMinutes) || b.ttlMinutes < 1 || b.ttlMinutes > 60) throw errors.badRequest("ttl", "ttlMinutes must be an integer between 1 and 60");
        windowMinutes = b.ttlMinutes;
      }
      try {
        const g = await d.core.call<unknown>("breakglass.request", { targetUserId: toCoreUser(b.targetUserId), reason: b.reason, ...(windowMinutes !== undefined ? { windowMinutes } : {}) });
        return { status: 201, body: { schema: "breakglass.grant/1", grant: grantJson(g) } };
      } catch (e) { throw breakGlassError(e, "request"); }
    },
    "breakglass.list": async (i) => {
      if (!i.rbac) throw errors.unauthenticated();
      try {
        const r = await d.core.call<{ grants?: unknown }>("breakglass.list", {});
        if (!r || typeof r !== "object" || !Array.isArray(r.grants)) throw coreMalformed();
        return { body: { schema: "breakglass.list/1", grants: r.grants.map(grantJson) } };
      } catch (e) { throw breakGlassError(e, "list"); }
    },
    "breakglass.revoke": async (i) => {
      if (!i.rbac) throw errors.unauthenticated();
      const b = i.body as { grantId?: unknown } | null;
      if (!b || typeof b !== "object" || Array.isArray(b) || typeof b.grantId !== "string" || b.grantId === "" || !isText(b.grantId, 128) || Object.keys(b).length !== 1) throw errors.badRequest("body", "body must be {\"grantId\": string}");
      try { await d.core.call("breakglass.revoke", { grantId: b.grantId }); } catch (e) { throw breakGlassError(e, "revoke"); }
      return { body: { schema: "breakglass.revoke/1", revoked: true } };
    },
    "notices.list": async (i) => {
      if (!i.rbac) throw errors.unauthenticated();
      try {
        const r = await d.core.call<{ notices?: unknown }>("breakglass.notices", {});
        if (!r || typeof r !== "object" || !Array.isArray(r.notices)) throw coreMalformed();
        return { body: { schema: "notices.list/1", notices: r.notices.map((n: unknown) => {
          const x = n as { grantId?: unknown; holderUserId?: unknown; reason?: unknown; expiresAt?: unknown } | null;
          if (!x || typeof x !== "object" || typeof x.grantId !== "string" || typeof x.holderUserId !== "string" || typeof x.reason !== "string" || !Number.isSafeInteger(x.expiresAt)) throw coreMalformed();
          return { kind: "break-glass.granted", grantId: x.grantId, holderUserId: fromCoreUser(x.holderUserId), reason: x.reason, expiresAt: iso8601(x.expiresAt as number) };
        }) } };
      } catch (e) { throw breakGlassError(e, "notices"); }
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
        const s = coreStatus(await withDeadline(d.core.call<unknown>("core.status"), d.healthTimeoutMs));
        if (!s) throw new Error("core.status has an unexpected shape");
        return { body: { schema: "health/1", status: !s.engineReady || s.degraded ? "degraded" : "ok", api: { version: API_VERSION }, core: { reachable: true, rpc: s.rpc, contract: s.contract, uptimeMs: s.uptimeMs, engineReady: s.engineReady, degraded: s.degraded } } };
      } catch {
        return { status: 503, body: { schema: "health/1", status: "down", api: { version: API_VERSION }, core: { reachable: false } } };
      }
    },
    "whoami": (i) => {
      if (!i.principal) throw errors.unauthenticated();
      if (i.via === "token" && i.token) {
        return {
          body: {
            schema: "whoami/1", principal: i.principal, via: "token",
            token: {
              id: i.token.id, prefix: i.token.prefix, scopes: i.token.scopes, expiresAt: iso8601(i.token.expiresAt),
              ...(i.token.binding !== undefined ? { binding: i.token.binding } : {}),
            },
          },
        };
      }
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
      if (!b || !keys.includes("name") || !keys.includes("scopes") || keys.some((k) => !["name", "scopes", "ttlDays", "binding"].includes(k))) {
        throw errors.badRequest("body", "body must be {\"name\": string, \"scopes\": string[], \"ttlDays\"?: integer, \"binding\"?: object}");
      }
      let ttlMs: number | undefined;
      if (b.ttlDays !== undefined) {
        if (typeof b.ttlDays !== "number" || !Number.isInteger(b.ttlDays) || b.ttlDays < 1 || b.ttlDays > 365) throw errors.badRequest("ttl", "ttlDays must be an integer between 1 and 365");
        ttlMs = b.ttlDays * 86_400_000;
      }
      let binding: TokenBinding | undefined;
      if (b.binding !== undefined) {
        binding = parseTokenBinding(b.binding);
        let listedAgents: unknown;
        try {
          const r = await d.core.call<unknown>("agent.list");
          if (!r || typeof r !== "object" || Array.isArray(r)) throw coreMalformed();
          listedAgents = (r as { agents?: unknown }).agents;
        } catch (e) { throw fromCoreError(e); }
        const foundAgent = (Array.isArray(listedAgents) ? listedAgents : []).find((a) => {
          if (!a || typeof a !== "object" || Array.isArray(a)) return false;
          const rec = a as { agentId?: unknown; lifecycle?: { deleted?: unknown } };
          return rec.agentId === binding!.agentId && rec.lifecycle?.deleted !== true;
        });
        if (!foundAgent) throw new ApiError(404, "E_NOT_FOUND", "no such agent", { reason: "agent" });
        const useDec = authorize(i.rbac, "agent.use", { kind: "agent", agentId: binding.agentId });
        if (useDec.effect !== "allow") throw errors.forbidden(useDec.reason);
        if (binding.projectId !== undefined) {
          try {
            const proj = await d.core.call<unknown>("project.get", { projectId: binding.projectId });
            if (!proj || typeof proj !== "object" || Array.isArray(proj)) throw new ApiError(404, "E_NOT_FOUND", "no such project", { reason: "project" });
          } catch (e) { throw fromCoreError(e); }
        }
      }
      const made = await d.tokens.create(i.principal.id, { name: b.name, scopes: b.scopes, ...(ttlMs !== undefined ? { ttlMs } : {}), ...(binding !== undefined ? { binding } : {}) });
      d.audit.emit("auth.token.created", i.principal.id, `token:${made.record.id}`, {
        name: made.record.name, scopes: made.record.scopes, expiresAt: made.record.expiresAt,
        ...(made.record.binding !== undefined ? { binding: made.record.binding } : {}), ip: i.ip,
      });
      return { status: 201, body: { schema: "tokens.create/1", token: made.token, record: tokenJson(made.record) } };
    },
    "tokens.revoke": async (i) => {
      if (!i.principal || !d.tokens) throw errors.unauthenticated();
      const b = i.body as { id?: unknown } | null;
      if (!b || typeof b !== "object" || Array.isArray(b) || typeof b.id !== "string" || Object.keys(b).length !== 1 || !/^[0-9a-f]{12}$/.test(b.id)) throw errors.badRequest("body", "body must be {\"id\": string}");
      if (!(await d.tokens.revoke(i.principal.id, b.id))) throw new ApiError(404, "E_NOT_FOUND", "no such token", { reason: "token" });
      d.audit.emit("auth.token.revoked", i.principal.id, `token:${b.id}`, { ip: i.ip });
      if (d.oauthService) {
        await d.oauthService.revokeActiveToken(i.principal.id, b.id);
      }
      return { body: { schema: "tokens.revoke/1", revoked: true } };
    },
    "agents.list": async (i) => {
      try {
        const r = await d.core.call<unknown>("agent.list");
        if (!r || typeof r !== "object" || Array.isArray(r)) throw new ApiError(502, "E_CORE_UNAVAILABLE", "the core failed to answer", { reason: "core-error" });
        const { schema: _own, agents: listed, ...rest } = r as Record<string, unknown>;
        // Object rights decide which agents a caller sees (acceptance 3). Elements pass through untouched or not at all
        // (never re-serialised, ruling R13); an entry without an agent id is shown to nobody, and so is a result that is not a list.
        const agents = (Array.isArray(listed) ? listed : []).filter((a) => {
          const agentId = a && typeof a === "object" && !Array.isArray(a) ? (a as { agentId?: unknown }).agentId : undefined;
          return typeof agentId === "string" && agentId !== "" && authorize(i.rbac, "agent.read", { kind: "agent", agentId }).effect === "allow";
        });
        return { body: { schema: "agents.list/1", ...rest, agents } };
      } catch (e) { throw fromCoreError(e); }
    },
  };
}
