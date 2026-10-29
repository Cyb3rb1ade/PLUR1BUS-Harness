import { URL, URLSearchParams } from "node:url";
import { ApiError, errors } from "../errors.ts";
import type { TokenAudience } from "../ports.ts";
import type { Handler, HandlerDeps, HandlerInput, HandlerOutput, RouteSpec } from "../routes.ts";
import { readCookie } from "../session.ts";
import { validateScopes } from "../tokens.ts";
import { matchRedirectUri } from "./client-metadata.ts";
import { OAuthApiError, resolveResourceAudience, validateAudienceScopes, type OAuthService } from "./service.ts";
import type { OAuthAuthorizationServerMetadata, OAuthProtectedResourceMetadata } from "./types.ts";

export interface OAuthHandlerDeps extends HandlerDeps {
  oauthService?: OAuthService | undefined;
  isRemote?: boolean | undefined;
}

export const OAUTH_ROUTES: readonly RouteSpec[] = [
  {
    id: "oauth.metadata",
    method: "GET",
    path: "/.well-known/oauth-authorization-server",
    tag: "oauth",
    summary: "RFC 8414 OAuth 2.0 Authorization Server Metadata",
    auth: "none",
    authz: "public",
    csrf: false,
    rate: "read",
    stability: "stable",
    since: "1.0.0",
    successStatus: 200,
    success: {
      description: "OAuth 2.0 authorization server metadata document",
      schema: { type: "object", additionalProperties: true },
    },
  },
  {
    id: "oauth.protected_resource",
    method: "GET",
    path: "/.well-known/oauth-protected-resource",
    tag: "oauth",
    summary: "RFC 9728 OAuth 2.0 Protected Resource Metadata",
    auth: "none",
    authz: "public",
    csrf: false,
    rate: "read",
    stability: "stable",
    since: "1.0.0",
    successStatus: 200,
    success: {
      description: "OAuth 2.0 protected resource metadata document",
      schema: { type: "object", additionalProperties: true },
    },
  },
  {
    id: "oauth.authorize.get",
    method: "GET",
    path: "/oauth/authorize",
    tag: "oauth",
    summary: "OAuth 2.1 authorization endpoint (browser authorization code flow)",
    auth: "none",
    authz: "public",
    csrf: false,
    rate: "auth",
    stability: "experimental",
    since: "1.0.0",
    successStatus: 200,
    success: {
      description: "Redirect to client redirect_uri or consent screen presentation",
      schema: { type: "object", additionalProperties: true },
    },
  },
  {
    id: "oauth.authorize.post",
    method: "POST",
    path: "/oauth/authorize",
    tag: "oauth",
    summary: "OAuth 2.1 authorization consent submission",
    transport: "protocol",
    auth: "none",
    authz: "public",
    csrf: false,
    rate: "auth",
    stability: "experimental",
    since: "1.0.0",
    protocol: {
      maxBodyBytes: 64 * 1024,
      bodyTimeoutMs: 10_000,
      handlerTimeoutMs: 15_000,
    },
    successStatus: 200,
    success: {
      description: "Consent response with redirect_uri and authorization code",
      schema: { type: "object", additionalProperties: true },
    },
  },
  {
    id: "oauth.token",
    method: "POST",
    path: "/oauth/token",
    tag: "oauth",
    summary: "OAuth 2.1 token endpoint (authorization code exchange & refresh token rotation)",
    transport: "protocol",
    auth: "none",
    authz: "public",
    csrf: false,
    rate: "auth",
    stability: "stable",
    since: "1.0.0",
    protocol: {
      maxBodyBytes: 64 * 1024,
      bodyTimeoutMs: 10_000,
      handlerTimeoutMs: 15_000,
    },
    successStatus: 200,
    success: {
      description: "OAuth token response containing access_token and refresh_token",
      schema: { type: "object", additionalProperties: true },
    },
  },
  {
    id: "oauth.revoke",
    method: "POST",
    path: "/oauth/revoke",
    tag: "oauth",
    summary: "RFC 7009 OAuth token revocation endpoint",
    transport: "protocol",
    auth: "none",
    authz: "public",
    csrf: false,
    rate: "auth",
    stability: "stable",
    since: "1.0.0",
    protocol: {
      maxBodyBytes: 64 * 1024,
      bodyTimeoutMs: 10_000,
      handlerTimeoutMs: 15_000,
    },
    successStatus: 200,
    success: {
      description: "Token revocation acknowledgement",
      schema: { type: "object", additionalProperties: true },
    },
  },
  {
    id: "oauth.grants.list",
    method: "GET",
    path: "/api/v1/oauth/grants",
    tag: "oauth",
    summary: "List caller's active OAuth grants",
    auth: "session",
    authz: "authenticated",
    csrf: false,
    rate: "read",
    stability: "experimental",
    since: "1.0.0",
    successStatus: 200,
    success: {
      description: "List of active OAuth grants",
      schema: { type: "object", additionalProperties: true },
    },
  },
  {
    id: "oauth.grants.revoke",
    method: "POST",
    path: "/api/v1/oauth/grants/revoke",
    tag: "oauth",
    summary: "Revoke an OAuth grant and its refresh token family",
    auth: "session",
    authz: "authenticated",
    csrf: true,
    rate: "write",
    stability: "experimental",
    since: "1.0.0",
    requestBody: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
      additionalProperties: false,
    },
    successStatus: 200,
    success: {
      description: "Grant revocation acknowledgement",
      schema: { type: "object", additionalProperties: true },
    },
  },
];

function getIssuer(headers?: Record<string, string | string[] | undefined>, tls?: boolean): string {
  const host = typeof headers?.host === "string" ? headers.host : "localhost";
  const proto = tls ? "https" : "http";
  return `${proto}://${host}`;
}

function parseFormOrJsonBody(raw: Buffer | undefined, contentType?: string): Record<string, string> {
  if (!raw || raw.length === 0) return {};
  const ct = (contentType ?? "").split(";", 1)[0]!.trim().toLowerCase();
  const text = raw.toString("utf8");
  if (ct === "application/json") {
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        const res: Record<string, string> = {};
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === "string") res[k] = v;
          else if (typeof v === "boolean" || typeof v === "number") res[k] = String(v);
        }
        return res;
      }
    } catch {
      // Fall through
    }
  }
  const params = new URLSearchParams(text);
  const res: Record<string, string> = {};
  for (const [k, v] of params.entries()) {
    res[k] = v;
  }
  return res;
}

export function buildOAuthHandlers(d: OAuthHandlerDeps): Record<string, Handler> {
  const cookieName = d.tls ? "__Host-plur1bus_session" : "plur1bus_session";

  const getOAuthService = (): OAuthService => {
    if (!d.oauthService) {
      throw new ApiError(503, "E_NOT_AVAILABLE", "oauth service unavailable", { reason: "oauth-unavailable" });
    }
    return d.oauthService;
  };

  return {
    "oauth.metadata": (i: HandlerInput): HandlerOutput => {
      const issuer = getIssuer(i.headers, d.tls);
      const metadata: OAuthAuthorizationServerMetadata = {
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        revocation_endpoint: `${issuer}/oauth/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
        client_id_metadata_document_supported: true,
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["mcp.read", "mcp.write"],
      };
      return {
        status: 200,
        body: metadata as unknown as Record<string, unknown>,
        headers: {
          "Cache-Control": "no-cache, no-store",
          "Content-Type": "application/json; charset=utf-8",
        },
      };
    },

    "oauth.protected_resource": (i: HandlerInput): HandlerOutput => {
      const issuer = getIssuer(i.headers, d.tls);
      const reqResource = i.query?.get("resource") ?? "";

      if (reqResource.includes("/a2a")) {
        const metadata: OAuthProtectedResourceMetadata = {
          resource: `${issuer}/a2a`,
          authorization_servers: [issuer],
          scopes_supported: ["a2a.task", "agent.use"],
          bearer_methods_supported: ["header"],
          resource_documentation: `${issuer}/docs/a2a.md`,
        };
        return {
          status: 200,
          body: metadata as unknown as Record<string, unknown>,
          headers: {
            "Cache-Control": "no-cache, no-store",
            "Content-Type": "application/json; charset=utf-8",
          },
        };
      }

      if (reqResource.includes("/mcp")) {
        const metadata: OAuthProtectedResourceMetadata = {
          resource: `${issuer}/mcp`,
          authorization_servers: [issuer],
          scopes_supported: [
            "mcp.read",
            "mcp.write",
            "agent.use",
            "agent.manage",
            "memory.read",
            "memory.write",
          ],
          bearer_methods_supported: ["header"],
          resource_documentation: `${issuer}/docs/mcp-server.md`,
        };
        return {
          status: 200,
          body: metadata as unknown as Record<string, unknown>,
          headers: {
            "Cache-Control": "no-cache, no-store",
            "Content-Type": "application/json; charset=utf-8",
          },
        };
      }

      const metadata: OAuthProtectedResourceMetadata = {
        resource: issuer,
        authorization_servers: [issuer],
        scopes_supported: [
          "mcp.read",
          "mcp.write",
          "agent.use",
          "agent.manage",
          "memory.read",
          "memory.write",
          "a2a.task",
        ],
        bearer_methods_supported: ["header"],
      };
      return {
        status: 200,
        body: metadata as unknown as Record<string, unknown>,
        headers: {
          "Cache-Control": "no-cache, no-store",
          "Content-Type": "application/json; charset=utf-8",
        },
      };
    },

    "oauth.authorize.get": async (i: HandlerInput): Promise<HandlerOutput> => {
      const oauth = getOAuthService();
      const issuer = getIssuer(i.headers, d.tls);
      const params = i.query ?? new URLSearchParams();

      const clientId = params.get("client_id") ?? "";
      const redirectUri = params.get("redirect_uri") ?? "";
      const responseType = params.get("response_type");
      const codeChallenge = params.get("code_challenge") ?? "";
      const codeChallengeMethod = params.get("code_challenge_method");
      const scopeParam = params.get("scope");
      const state = params.get("state") ?? undefined;
      const resource = params.get("resource") ?? undefined;
      const approve = params.get("approve") === "true" || params.get("approve") === "1";

      // 1. Validate client
      if (!clientId) {
        throw new OAuthApiError(400, "invalid_request", "missing client_id");
      }
      const client = await oauth.resolveClient(clientId);
      if (!client) {
        throw new OAuthApiError(400, "invalid_client", "unknown or unresolvable client_id");
      }

      // 2. Validate redirect_uri (MUST NOT redirect if invalid)
      if (!redirectUri || !matchRedirectUri(redirectUri, client.redirect_uris)) {
        throw new OAuthApiError(400, "invalid_request", "invalid or unregistered redirect_uri");
      }

      // 3. Validate response_type
      if (responseType !== "code") {
        const errUrl = new URL(redirectUri);
        errUrl.searchParams.set("error", "unsupported_response_type");
        errUrl.searchParams.set("error_description", "response_type must be 'code'");
        if (state) errUrl.searchParams.set("state", state);
        errUrl.searchParams.set("iss", issuer);
        return { status: 302, headers: { Location: errUrl.toString() } };
      }

      // 4. Validate PKCE
      if (!codeChallenge) {
        const errUrl = new URL(redirectUri);
        errUrl.searchParams.set("error", "invalid_request");
        errUrl.searchParams.set("error_description", "code_challenge is required");
        if (state) errUrl.searchParams.set("state", state);
        errUrl.searchParams.set("iss", issuer);
        return { status: 302, headers: { Location: errUrl.toString() } };
      }
      if (codeChallengeMethod !== "S256") {
        const errUrl = new URL(redirectUri);
        errUrl.searchParams.set("error", "invalid_request");
        errUrl.searchParams.set("error_description", "code_challenge_method must be S256");
        if (state) errUrl.searchParams.set("state", state);
        errUrl.searchParams.set("iss", issuer);
        return { status: 302, headers: { Location: errUrl.toString() } };
      }

      // 5. Validate resource
      let audience: TokenAudience = "mcp";
      if (resource) {
        try {
          const resAud = resolveResourceAudience(resource);
          audience = resAud.audience;
        } catch (e) {
          const errUrl = new URL(redirectUri);
          errUrl.searchParams.set("error", "invalid_target");
          errUrl.searchParams.set("error_description", "invalid target resource");
          if (state) errUrl.searchParams.set("state", state);
          errUrl.searchParams.set("iss", issuer);
          return { status: 302, headers: { Location: errUrl.toString() } };
        }
      }

      // 6. Check user session
      const rawCookie = readCookie(typeof i.headers?.cookie === "string" ? i.headers.cookie : undefined, cookieName);
      const session = rawCookie ? d.sessions.peek(rawCookie) : undefined;
      if (!session) {
        const accept = typeof i.headers?.accept === "string" ? i.headers.accept : "";
        if (accept.includes("text/html")) {
          return {
            status: 302,
            headers: { Location: `/login?redirect=${encodeURIComponent(`/oauth/authorize?${params.toString()}`)}` },
          };
        }
        throw errors.unauthenticated("session-required");
      }

      // 7. Check 2FA if remote listener
      if (
        (d.isRemote || d.requireSecondFactor?.(session.principal.role)) &&
        session.stepUpAt === undefined
      ) {
        throw errors.forbidden("second-factor-required");
      }

      // 8. Validate scopes
      let scopes: readonly string[] = audience === "a2a" ? ["a2a.task"] : ["mcp.read"];
      if (scopeParam) {
        try {
          const split = scopeParam.split(/\s+/).filter(Boolean);
          scopes = validateAudienceScopes(audience, validateScopes(split));
        } catch {
          const errUrl = new URL(redirectUri);
          errUrl.searchParams.set("error", "invalid_scope");
          errUrl.searchParams.set("error_description", "invalid scope requested");
          if (state) errUrl.searchParams.set("state", state);
          errUrl.searchParams.set("iss", issuer);
          return { status: 302, headers: { Location: errUrl.toString() } };
        }
      }

      // 9. If approval confirmed, issue authorization code and redirect
      if (approve) {
        const agentId = params.get("agent_id") || "main";
        const code = oauth.createAuthorizationCode({
          clientId,
          redirectUri,
          codeChallenge,
          codeChallengeMethod: "S256",
          userId: session.principal.id,
          agentId,
          ...(params.get("project_id") ? { projectId: params.get("project_id")! } : {}),
          audience,
          scopes,
          ...(resource ? { resource } : {}),
        });

        d.audit.emit("oauth.authorize", session.principal.id, `agent:${agentId}`, {
          clientId,
          audience,
          scopes: scopes.join(" "),
        });

        const target = new URL(redirectUri);
        target.searchParams.set("code", code);
        if (state) target.searchParams.set("state", state);
        target.searchParams.set("iss", issuer);

        const accept = typeof i.headers?.accept === "string" ? i.headers.accept : "";
        if (accept.includes("application/json")) {
          return {
            status: 200,
            body: { redirect_uri: target.toString(), code, ...(state ? { state } : {}) },
          };
        }
        return { status: 302, headers: { Location: target.toString() } };
      }

      // 10. Consent screen presentation
      const accept = typeof i.headers?.accept === "string" ? i.headers.accept : "";
      if (accept.includes("application/json")) {
        return {
          status: 200,
          body: {
            consent_required: true,
            client_id: client.client_id,
            client_name: client.client_name ?? client.client_id,
            redirect_uri: redirectUri,
            scopes,
            audience,
            ...(state ? { state } : {}),
            ...(resource ? { resource } : {}),
          },
        };
      }

      // Browser redirect to consent page
      return {
        status: 302,
        headers: { Location: `/consent?${params.toString()}` },
      };
    },

    "oauth.authorize.post": async (i: HandlerInput): Promise<HandlerOutput> => {
      const oauth = getOAuthService();
      const issuer = getIssuer(i.headers, d.tls);

      let body: Record<string, unknown> = {};
      if (i.body && typeof i.body === "object") {
        body = i.body as Record<string, unknown>;
      } else if (i.rawBody) {
        body = parseFormOrJsonBody(i.rawBody, typeof i.headers?.["content-type"] === "string" ? i.headers["content-type"] : undefined);
      }

      const clientId = String(body.client_id ?? "");
      const redirectUri = String(body.redirect_uri ?? "");
      const codeChallenge = String(body.code_challenge ?? "");
      const codeChallengeMethod = String(body.code_challenge_method ?? "S256");
      const state = body.state ? String(body.state) : undefined;
      const resource = body.resource ? String(body.resource) : undefined;
      const approve = body.approve === true || body.approve === "true" || body.approve === 1 || body.approve === "1";
      const agentId = body.agent_id ? String(body.agent_id) : "main";
      const projectId = body.project_id ? String(body.project_id) : undefined;

      // 1. Validate client
      if (!clientId) throw new OAuthApiError(400, "invalid_request", "missing client_id");
      const client = await oauth.resolveClient(clientId);
      if (!client) throw new OAuthApiError(400, "invalid_client", "unknown client_id");

      // 2. Validate redirect_uri
      if (!redirectUri || !matchRedirectUri(redirectUri, client.redirect_uris)) {
        throw new OAuthApiError(400, "invalid_request", "invalid redirect_uri");
      }

      // 3. Check session
      const rawCookie = readCookie(typeof i.headers?.cookie === "string" ? i.headers.cookie : undefined, cookieName);
      const session = rawCookie ? d.sessions.peek(rawCookie) : undefined;
      if (!session) {
        throw errors.unauthenticated("session-required");
      }

      // 4. Check 2FA if remote listener
      if (
        (d.isRemote || d.requireSecondFactor?.(session.principal.role)) &&
        session.stepUpAt === undefined
      ) {
        throw errors.forbidden("second-factor-required");
      }

      // 5. Handle denial
      if (!approve) {
        d.audit.emit("oauth.denied", session.principal.id, `oauth:${clientId}`, {
          clientId,
          reason: "access_denied",
        });
        const target = new URL(redirectUri);
        target.searchParams.set("error", "access_denied");
        target.searchParams.set("error_description", "user denied access");
        if (state) target.searchParams.set("state", state);
        target.searchParams.set("iss", issuer);
        return {
          status: 200,
          body: { redirect_uri: target.toString() },
        };
      }

      // 6. Validate PKCE
      if (!codeChallenge || codeChallengeMethod !== "S256") {
        const errUrl = new URL(redirectUri);
        errUrl.searchParams.set("error", "invalid_request");
        errUrl.searchParams.set("error_description", "code_challenge and S256 required");
        if (state) errUrl.searchParams.set("state", state);
        errUrl.searchParams.set("iss", issuer);
        return { status: 200, body: { redirect_uri: errUrl.toString() } };
      }

      // 7. Validate resource & audience
      let audience: TokenAudience = "mcp";
      if (resource) {
        const resAud = resolveResourceAudience(resource);
        audience = resAud.audience;
      }

      // 8. Validate scopes
      let scopes: readonly string[] = audience === "a2a" ? ["a2a.task"] : ["mcp.read"];
      if (body.scope) {
        const split = Array.isArray(body.scope) ? body.scope : String(body.scope).split(/\s+/).filter(Boolean);
        scopes = validateAudienceScopes(audience, validateScopes(split));
      }

      // 9. Issue authorization code
      const code = oauth.createAuthorizationCode({
        clientId,
        redirectUri,
        codeChallenge,
        codeChallengeMethod: "S256",
        userId: session.principal.id,
        agentId,
        ...(projectId ? { projectId } : {}),
        audience,
        scopes,
        ...(resource ? { resource } : {}),
      });

      d.audit.emit("oauth.authorize", session.principal.id, `agent:${agentId}`, {
        clientId,
        audience,
        scopes: scopes.join(" "),
      });

      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      if (state) target.searchParams.set("state", state);
      target.searchParams.set("iss", issuer);

      return {
        status: 200,
        body: { redirect_uri: target.toString(), code, ...(state ? { state } : {}) },
      };
    },

    "oauth.token": async (i: HandlerInput): Promise<HandlerOutput> => {
      const oauth = getOAuthService();
      const params = parseFormOrJsonBody(i.rawBody, typeof i.headers?.["content-type"] === "string" ? i.headers["content-type"] : undefined);
      const grantType = params.grant_type;
      const clientId = params.client_id;

      try {
        if (grantType === "authorization_code") {
          const code = params.code;
          const redirectUri = params.redirect_uri;
          const codeVerifier = params.code_verifier;

          if (!code || !clientId || !redirectUri || !codeVerifier) {
            return {
              status: 400,
              body: {
                error: "invalid_request",
                error_description: "missing required parameter (code, client_id, redirect_uri, code_verifier)",
              },
              headers: { "Cache-Control": "no-store", "Pragma": "no-cache" },
            };
          }

          const tokenRes = await oauth.exchangeAuthorizationCode({
            code,
            clientId,
            redirectUri,
            codeVerifier,
          });

          const meta = tokenRes._meta as { tokenId?: string; audience?: string; agentId?: string } | undefined;
          const tokenId = meta?.tokenId ?? "-";
          d.audit.emit("oauth.token", `oauth:${clientId}`, `token:${tokenId}`, {
            clientId,
            audience: meta?.audience ?? "mcp",
            agentId: meta?.agentId ?? "main",
            tokenId,
          });

          const { _meta: _omit, ...respBody } = tokenRes;
          return {
            status: 200,
            body: respBody as unknown as Record<string, unknown>,
            headers: {
              "Cache-Control": "no-store",
              "Pragma": "no-cache",
              "Content-Type": "application/json; charset=utf-8",
            },
          };
        }

        if (grantType === "refresh_token") {
          const refreshToken = params.refresh_token;
          const scope = params.scope;

          if (!refreshToken || !clientId) {
            return {
              status: 400,
              body: {
                error: "invalid_request",
                error_description: "missing required parameter (refresh_token, client_id)",
              },
              headers: { "Cache-Control": "no-store", "Pragma": "no-cache" },
            };
          }

          const tokenRes = await oauth.refresh({
            refreshToken,
            clientId,
            ...(scope ? { scope } : {}),
          });

          const meta = tokenRes._meta as { tokenId?: string; familyId?: string } | undefined;
          const tokenId = meta?.tokenId ?? "-";
          d.audit.emit("oauth.refresh", `oauth:${clientId}`, `token:${tokenId}`, {
            clientId,
            tokenId,
            familyId: meta?.familyId ?? "-",
          });

          const { _meta: _omit, ...respBody } = tokenRes;
          return {
            status: 200,
            body: respBody as unknown as Record<string, unknown>,
            headers: {
              "Cache-Control": "no-store",
              "Pragma": "no-cache",
              "Content-Type": "application/json; charset=utf-8",
            },
          };
        }

        return {
          status: 400,
          body: {
            error: "unsupported_grant_type",
            error_description: `grant_type '${grantType}' is not supported`,
          },
          headers: { "Cache-Control": "no-store", "Pragma": "no-cache" },
        };
      } catch (e) {
        if (e instanceof OAuthApiError) {
          const cId = clientId || "unknown";
          d.audit.emit("oauth.denied", "anonymous", `oauth:${cId}`, {
            clientId: cId,
            reason: e.oauthError,
          });
          return {
            status: e.status,
            body: {
              error: e.oauthError,
              error_description: e.oauthDescription,
            },
            headers: { "Cache-Control": "no-store", "Pragma": "no-cache" },
          };
        }
        throw e;
      }
    },

    "oauth.revoke": async (i: HandlerInput): Promise<HandlerOutput> => {
      const oauth = getOAuthService();
      const params = parseFormOrJsonBody(i.rawBody, typeof i.headers?.["content-type"] === "string" ? i.headers["content-type"] : undefined);
      const token = params.token;
      const tokenTypeHint = params.token_type_hint;
      const clientId = params.client_id || "unknown";

      if (token) {
        const rev = await oauth.revoke(token, tokenTypeHint);
        if (rev.revoked) {
          const cId = rev.clientId ?? clientId;
          d.audit.emit("oauth.revoke", i.principal?.id ?? `oauth:${cId}`, `token:${rev.tokenId ?? "-"}`, {
            clientId: cId,
            ...(rev.tokenId ? { tokenId: rev.tokenId } : {}),
          });
        }
      }

      // RFC 7009: 200 OK whether token existed or not
      return {
        status: 200,
        body: { ok: true },
        headers: { "Cache-Control": "no-store" },
      };
    },

    "oauth.grants.list": async (i: HandlerInput): Promise<HandlerOutput> => {
      const oauth = getOAuthService();
      if (!i.principal) throw errors.unauthenticated();
      const grants = await oauth.listGrantsForUser(i.principal.id);
      return {
        status: 200,
        body: {
          schema: "oauth.grants.list/1",
          grants: grants.map((g) => ({
            id: g.id,
            clientId: g.clientId,
            agentId: g.agentId,
            audience: g.audience,
            scopes: g.scopes,
            createdAt: g.createdAt,
            lastUsedAt: g.lastUsedAt,
            ...(g.revokedAt !== undefined ? { revokedAt: g.revokedAt } : {}),
          })),
        },
      };
    },

    "oauth.grants.revoke": async (i: HandlerInput): Promise<HandlerOutput> => {
      const oauth = getOAuthService();
      if (!i.principal) throw errors.unauthenticated();
      const body = (i.body ?? {}) as { id?: unknown };
      if (!body.id || typeof body.id !== "string") {
        throw errors.badRequest("id", "grant id is required");
      }
      const grant = await oauth.revokeGrant(i.principal.id, body.id);
      if (!grant) {
        throw new ApiError(404, "E_NOT_FOUND", "grant not found", { reason: "grant" });
      }
      d.audit.emit("oauth.revoke", i.principal.id, `token:${grant.activeTokenId ?? "-"}`, {
        clientId: grant.clientId,
        ...(grant.activeTokenId ? { tokenId: grant.activeTokenId } : {}),
      });
      return {
        status: 200,
        body: { schema: "oauth.grants.revoke/1", revoked: true },
      };
    },
  };
}
