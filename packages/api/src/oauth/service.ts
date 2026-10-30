import { createHash, randomBytes } from "node:crypto";
import type { Clock } from "../clock.ts";
import { ApiError } from "../errors.ts";
import type { TokenAudience } from "../ports.ts";
import { authorize, type RbacPrincipal } from "../rbac-bridge.ts";
import type { TokenService } from "../tokens.ts";
import { ClientMetadataResolver } from "./client-metadata.ts";
import { verifyPkce } from "./pkce.ts";
import type {
  OAuthAuthorizationCode,
  OAuthClientMetadata,
  OAuthGrantRecord,
  OAuthRefreshTokenRecord,
  OAuthServiceOptions,
  OAuthStore,
  OAuthTokenResponse,
} from "./types.ts";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

export const AUTH_CODE_TTL_MS = 10 * 60_000; // 10 minutes
export const ACCESS_TOKEN_TTL_MS = 3_600_000; // 1 hour (MIN_TTL_MS)
export const REFRESH_TOKEN_TTL_MS = 30 * 86_400_000; // 30 days

export class OAuthApiError extends ApiError {
  readonly oauthError: string;
  readonly oauthDescription?: string | undefined;

  constructor(status: number, oauthError: string, oauthDescription?: string) {
    const code = status === 401 ? "E_UNAUTHORIZED" : status === 403 ? "E_DENIED" : "E_INVALID_PARAMS";
    super(status, code, oauthDescription ?? oauthError, {
      reason: oauthError,
    });
    this.oauthError = oauthError;
    this.oauthDescription = oauthDescription;
  }
}

export function resolveResourceAudience(resource?: string): { audience: TokenAudience; resource?: string } {
  if (!resource || resource.trim().length === 0) {
    return { audience: "mcp" };
  }
  const r = resource.trim();
  if (r === "/mcp" || r.endsWith("/mcp") || r.includes("/mcp/")) {
    return { audience: "mcp", resource: r };
  }
  if (r === "/a2a" || r.endsWith("/a2a") || r.includes("/a2a/")) {
    return { audience: "a2a", resource: r };
  }
  throw new OAuthApiError(400, "invalid_target", "unsupported target resource (expected /mcp or /a2a)");
}

export const PROTOCOL_SCOPES: Record<TokenAudience, readonly string[]> = {
  mcp: Object.freeze([
    "mcp.read",
    "mcp.write",
    "agent.use",
    "agent.manage",
    "memory.read",
    "memory.write",
  ]),
  a2a: Object.freeze([
    "a2a.task",
    "agent.use",
  ]),
};

export function canGrantScope(rbac: RbacPrincipal, agentId: string, scope: string): boolean {
  switch (scope) {
    case "mcp.read":
      return authorize(rbac, "agent.read", { kind: "agent", agentId }).effect === "allow";
    case "mcp.write":
      return rbac.role !== "viewer" && authorize(rbac, "agent.use", { kind: "agent", agentId }).effect === "allow";
    case "agent.use":
      return authorize(rbac, "agent.use", { kind: "agent", agentId }).effect === "allow";
    case "agent.manage":
      return authorize(rbac, "agent.manage", { kind: "agent", agentId }).effect === "allow";
    case "memory.read":
      return authorize(rbac, "memory.workspace.read", { kind: "memory", scope: "workspace", agentId }).effect === "allow"
        || authorize(rbac, "agent.read", { kind: "agent", agentId }).effect === "allow";
    case "memory.write":
      return authorize(rbac, "memory.workspace.write", { kind: "memory", scope: "workspace", agentId }).effect === "allow";
    case "a2a.task":
      return rbac.role !== "viewer" && authorize(rbac, "agent.use", { kind: "agent", agentId }).effect === "allow";
    default:
      return false;
  }
}

export function filterPermittedScopes(
  rbac: RbacPrincipal,
  agentId: string,
  audience: TokenAudience,
  candidateScopes: readonly string[],
): string[] {
  const allowed = PROTOCOL_SCOPES[audience] ?? [];
  return candidateScopes.filter((s) => allowed.includes(s) && canGrantScope(rbac, agentId, s));
}

export function validateAudienceScopes(audience: TokenAudience, requestedScopes: readonly string[]): readonly string[] {
  const allowed = PROTOCOL_SCOPES[audience];
  if (!allowed) {
    throw new OAuthApiError(400, "invalid_scope", `unknown audience '${audience}'`);
  }
  for (const s of requestedScopes) {
    if (!allowed.includes(s)) {
      throw new OAuthApiError(400, "invalid_scope", `scope '${s}' is not permitted for ${audience}`);
    }
  }
  return requestedScopes;
}

export class OAuthService {
  readonly #tokens: TokenService;
  readonly #store: OAuthStore;
  readonly #clock: Clock;
  readonly #resolver: ClientMetadataResolver;
  readonly #codes = new Map<string, OAuthAuthorizationCode>();
  readonly #baseUrl?: string | undefined;

  constructor(options: OAuthServiceOptions) {
    this.#tokens = options.tokens;
    this.#store = options.store;
    this.#clock = options.clock;
    this.#baseUrl = options.baseUrl;
    this.#resolver = new ClientMetadataResolver({
      clients: options.clients,
      fetchMetadata: options.fetchMetadata,
      allowLoopbackMetadata: options.allowLoopbackMetadata ?? false,
    });
  }

  get store(): OAuthStore {
    return this.#store;
  }

  async resolveClient(clientId: string): Promise<OAuthClientMetadata | undefined> {
    return this.#resolver.resolveClient(clientId);
  }

  createAuthorizationCode(params: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: "S256";
    userId: string;
    agentId: string;
    projectId?: string | undefined;
    audience: TokenAudience;
    scopes: readonly string[];
    resource?: string | undefined;
  }): string {
    const code = "plb_code_" + randomBytes(24).toString("base64url");
    const now = this.#clock.now();
    const record: OAuthAuthorizationCode = {
      code,
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
      userId: params.userId,
      agentId: params.agentId,
      projectId: params.projectId,
      audience: params.audience,
      scopes: params.scopes,
      resource: params.resource,
      createdAt: now,
      expiresAt: now + AUTH_CODE_TTL_MS,
    };
    this.#codes.set(code, record);
    return code;
  }

  redeemAuthorizationCode(
    code: string,
    clientId: string,
    redirectUri: string,
    codeVerifier: string,
  ): OAuthAuthorizationCode {
    const record = this.#codes.get(code);
    if (!record) {
      throw new OAuthApiError(400, "invalid_grant", "authorization code is invalid or already consumed");
    }

    // Immediately remove code to guarantee single-use
    this.#codes.delete(code);

    if (this.#clock.now() > record.expiresAt) {
      throw new OAuthApiError(400, "invalid_grant", "authorization code has expired");
    }

    if (record.clientId !== clientId) {
      throw new OAuthApiError(400, "invalid_grant", "client_id does not match the code request");
    }

    if (record.redirectUri !== redirectUri) {
      throw new OAuthApiError(400, "invalid_grant", "redirect_uri does not match the code request");
    }

    if (!verifyPkce(codeVerifier, record.codeChallenge, record.codeChallengeMethod)) {
      throw new OAuthApiError(400, "invalid_grant", "PKCE code verification failed");
    }

    return record;
  }

  async exchangeAuthorizationCode(params: {
    code: string;
    clientId: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<OAuthTokenResponse> {
    const codeRec = this.redeemAuthorizationCode(
      params.code,
      params.clientId,
      params.redirectUri,
      params.codeVerifier,
    );

    const tokenRes = await this.#tokens.create(codeRec.userId, {
      name: `oauth:${codeRec.clientId}`,
      scopes: codeRec.scopes,
      ttlMs: ACCESS_TOKEN_TTL_MS,
      binding: {
        audience: codeRec.audience,
        agentId: codeRec.agentId,
        ...(codeRec.projectId !== undefined ? { projectId: codeRec.projectId } : {}),
      },
    });

    const refreshToken = "plb_rt_" + randomBytes(32).toString("base64url");
    const tokenHash = sha256(refreshToken).toString("hex");
    const grantId = randomBytes(16).toString("hex");
    const familyId = randomBytes(16).toString("hex");
    const now = this.#clock.now();

    const grant: OAuthGrantRecord = {
      id: grantId,
      familyId,
      userId: codeRec.userId,
      clientId: codeRec.clientId,
      agentId: codeRec.agentId,
      projectId: codeRec.projectId,
      audience: codeRec.audience,
      scopes: codeRec.scopes,
      resource: codeRec.resource,
      activeTokenId: tokenRes.record.id,
      createdAt: now,
      lastUsedAt: now,
    };
    await this.#store.saveGrant(grant);

    const rtRec: OAuthRefreshTokenRecord = {
      tokenHash,
      grantId,
      familyId,
      userId: codeRec.userId,
      clientId: codeRec.clientId,
      agentId: codeRec.agentId,
      projectId: codeRec.projectId,
      audience: codeRec.audience,
      scopes: codeRec.scopes,
      resource: codeRec.resource,
      createdAt: now,
      expiresAt: now + REFRESH_TOKEN_TTL_MS,
      used: false,
    };
    await this.#store.saveRefreshToken(rtRec);

    return {
      access_token: tokenRes.token,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: codeRec.scopes.join(" "),
      _meta: {
        tokenId: tokenRes.record.id,
        audience: codeRec.audience,
        agentId: codeRec.agentId,
        clientId: codeRec.clientId,
      },
    };
  }

  async refresh(params: {
    refreshToken: string;
    clientId: string;
    scope?: string | undefined;
  }): Promise<OAuthTokenResponse> {
    const tokenHash = sha256(params.refreshToken).toString("hex");
    const rt = await this.#store.getRefreshToken(tokenHash);

    if (!rt || this.#clock.now() > rt.expiresAt) {
      throw new OAuthApiError(400, "invalid_grant", "refresh token is invalid or expired");
    }

    if (rt.clientId !== params.clientId) {
      throw new OAuthApiError(400, "invalid_grant", "client_id does not match the refresh token");
    }

    const grant = await this.#store.getGrant(rt.grantId);

    // Replay detection: if this token was already used, revoke the whole family!
    if (rt.used) {
      await this.#store.revokeFamily(rt.familyId);
      if (grant?.activeTokenId) {
        try {
          await this.#tokens.revoke(grant.userId, grant.activeTokenId);
        } catch {
          // Ignore failure to revoke old active token
        }
      }
      throw new OAuthApiError(
        400,
        "invalid_grant",
        "refresh token reuse detected; entire token family has been revoked",
      );
    }

    if (!grant || grant.revokedAt !== undefined) {
      throw new OAuthApiError(400, "invalid_grant", "grant has been revoked");
    }

    // Mark current refresh token as used
    await this.#store.markRefreshTokenUsed(tokenHash);

    // Determine scopes (can narrow, cannot widen)
    let scopes = grant.scopes;
    if (params.scope) {
      const requested = params.scope.split(/\s+/).filter(Boolean);
      for (const s of requested) {
        if (!grant.scopes.includes(s)) {
          throw new OAuthApiError(
            400,
            "invalid_scope",
            `requested scope '${s}' exceeds granted scopes`,
          );
        }
      }
      scopes = Object.freeze(requested);
    }

    // Mint new access token
    const tokenRes = await this.#tokens.create(grant.userId, {
      name: `oauth:${grant.clientId}`,
      scopes,
      ttlMs: ACCESS_TOKEN_TTL_MS,
      binding: {
        audience: grant.audience,
        agentId: grant.agentId,
        ...(grant.projectId !== undefined ? { projectId: grant.projectId } : {}),
      },
    });

    // Revoke previous access token
    if (grant.activeTokenId) {
      try {
        await this.#tokens.revoke(grant.userId, grant.activeTokenId);
      } catch {
        // Ignore failure
      }
    }

    // Mint new refresh token
    const newRefreshToken = "plb_rt_" + randomBytes(32).toString("base64url");
    const newTokenHash = sha256(newRefreshToken).toString("hex");
    const now = this.#clock.now();

    const newRtRec: OAuthRefreshTokenRecord = {
      tokenHash: newTokenHash,
      grantId: grant.id,
      familyId: grant.familyId,
      userId: grant.userId,
      clientId: grant.clientId,
      agentId: grant.agentId,
      projectId: grant.projectId,
      audience: grant.audience,
      scopes,
      resource: grant.resource,
      createdAt: now,
      expiresAt: now + REFRESH_TOKEN_TTL_MS,
      used: false,
    };
    await this.#store.saveRefreshToken(newRtRec);

    // Update grant
    await this.#store.updateGrant(grant.id, {
      activeTokenId: tokenRes.record.id,
      lastUsedAt: now,
      scopes,
    });

    return {
      access_token: tokenRes.token,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: newRefreshToken,
      scope: scopes.join(" "),
      _meta: {
        tokenId: tokenRes.record.id,
        familyId: grant.familyId,
        clientId: grant.clientId,
      },
    };
  }

  async listGrantsForUser(userId: string): Promise<readonly OAuthGrantRecord[]> {
    const list = await this.#store.listGrantsByUser(userId);
    return list.filter((g) => g.revokedAt === undefined);
  }

  async revokeGrant(userId: string, grantId: string): Promise<OAuthGrantRecord | undefined> {
    const grant = await this.#store.getGrant(grantId);
    if (!grant) return undefined;
    if (userId && grant.userId !== userId) return undefined;

    await this.#store.revokeFamily(grant.familyId);
    if (grant.activeTokenId) {
      try {
        await this.#tokens.revoke(grant.userId, grant.activeTokenId);
      } catch {
        // Ignore failure
      }
    }
    const revokedAt = this.#clock.now();
    await this.#store.updateGrant(grantId, { revokedAt });
    return { ...grant, revokedAt };
  }

  async revokeActiveToken(userId: string, tokenId: string): Promise<boolean> {
    const grants = await this.#store.listGrantsByUser(userId);
    let found = false;
    for (const g of grants) {
      if (g.activeTokenId === tokenId) {
        await this.#store.revokeFamily(g.familyId);
        await this.#store.updateGrant(g.id, { revokedAt: this.#clock.now() });
        found = true;
      }
    }
    return found;
  }

  async revoke(
    token: string,
    tokenTypeHint?: string,
  ): Promise<{ revoked: boolean; clientId?: string; tokenId?: string }> {
    if (typeof token !== "string" || token.length === 0) {
      return { revoked: false };
    }

    // 1. Try refresh token
    if (tokenTypeHint === "refresh_token" || token.startsWith("plb_rt_")) {
      const hash = sha256(token).toString("hex");
      const rt = await this.#store.getRefreshToken(hash);
      if (rt) {
        await this.#store.revokeFamily(rt.familyId);
        const grant = await this.#store.getGrant(rt.grantId);
        if (grant?.activeTokenId) {
          try {
            await this.#tokens.revoke(grant.userId, grant.activeTokenId);
          } catch {
            // Ignore
          }
        }
        return {
          revoked: true,
          clientId: rt.clientId,
          ...(grant?.activeTokenId ? { tokenId: grant.activeTokenId } : {}),
        };
      }
    }

    // 2. Try access token
    if (token.startsWith("plb_") && !token.startsWith("plb_rt_")) {
      const auth = await this.#tokens.authenticate(token);
      if (auth.ok || auth.reason === "revoked" || auth.reason === "expired") {
        const tokenId = auth.ok ? auth.record.id : auth.id!;
        for (const g of await this.#store.listGrantsByUser("")) {
          if (g.activeTokenId === tokenId) {
            await this.#tokens.revoke(g.userId, tokenId);
            await this.#store.updateGrant(g.id, { revokedAt: this.#clock.now() });
            await this.#store.revokeFamily(g.familyId);
            return { revoked: true, clientId: g.clientId, tokenId };
          }
        }
      }
    }

    // 3. Fallback: also check refresh token hash if not previously matched
    const hash = sha256(token).toString("hex");
    const rt = await this.#store.getRefreshToken(hash);
    if (rt) {
      await this.#store.revokeFamily(rt.familyId);
      const grant = await this.#store.getGrant(rt.grantId);
      if (grant?.activeTokenId) {
        try {
          await this.#tokens.revoke(grant.userId, grant.activeTokenId);
        } catch {
          // Ignore
        }
      }
      return {
        revoked: true,
        clientId: rt.clientId,
        ...(grant?.activeTokenId ? { tokenId: grant.activeTokenId } : {}),
      };
    }

    return { revoked: false };
  }
}
