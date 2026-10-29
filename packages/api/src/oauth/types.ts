import type { Clock } from "../clock.ts";
import type { TokenAudience } from "../ports.ts";
import type { TokenService } from "../tokens.ts";

export interface OAuthClientMetadata {
  readonly client_id: string;
  readonly client_name?: string | undefined;
  readonly client_uri?: string | undefined;
  readonly logo_uri?: string | undefined;
  readonly redirect_uris: readonly string[];
  readonly grant_types?: readonly string[] | undefined;
  readonly response_types?: readonly string[] | undefined;
  readonly scope?: string | undefined;
  readonly token_endpoint_auth_method?: "none" | undefined;
}

export interface OAuthAuthorizationServerMetadata {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly revocation_endpoint: string;
  readonly response_types_supported: readonly string[];
  readonly grant_types_supported: readonly string[];
  readonly code_challenge_methods_supported: readonly string[];
  readonly authorization_response_iss_parameter_supported: boolean;
  readonly client_id_metadata_document_supported: boolean;
  readonly token_endpoint_auth_methods_supported: readonly string[];
  readonly scopes_supported?: readonly string[] | undefined;
}

export interface OAuthProtectedResourceMetadata {
  readonly resource: string;
  readonly authorization_servers: readonly string[];
  readonly scopes_supported?: readonly string[] | undefined;
  readonly bearer_methods_supported?: readonly string[] | undefined;
  readonly resource_documentation?: string | undefined;
}

export interface OAuthAuthorizationCode {
  readonly code: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: "S256";
  readonly userId: string;
  readonly agentId: string;
  readonly projectId?: string | undefined;
  readonly audience: TokenAudience;
  readonly scopes: readonly string[];
  readonly resource?: string | undefined;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface OAuthRefreshTokenRecord {
  readonly tokenHash: string;
  readonly grantId: string;
  readonly familyId: string;
  readonly userId: string;
  readonly clientId: string;
  readonly agentId: string;
  readonly projectId?: string | undefined;
  readonly audience: TokenAudience;
  readonly scopes: readonly string[];
  readonly resource?: string | undefined;
  readonly createdAt: number;
  readonly expiresAt: number;
  used: boolean;
}

export interface OAuthGrantRecord {
  readonly id: string;
  readonly familyId: string;
  readonly userId: string;
  readonly clientId: string;
  readonly agentId: string;
  readonly projectId?: string | undefined;
  readonly audience: TokenAudience;
  readonly scopes: readonly string[];
  readonly resource?: string | undefined;
  activeTokenId?: string | undefined;
  readonly createdAt: number;
  lastUsedAt: number;
  revokedAt?: number | undefined;
}

export interface OAuthTokenResponse {
  readonly access_token: string;
  readonly token_type: "Bearer";
  readonly expires_in: number;
  readonly refresh_token?: string | undefined;
  readonly scope?: string | undefined;
  readonly _meta?: Record<string, unknown> | undefined;
}

export interface OAuthErrorResponse {
  readonly error: string;
  readonly error_description?: string | undefined;
}

export interface OAuthStore {
  saveGrant(grant: OAuthGrantRecord): Promise<void>;
  getGrant(grantId: string): Promise<OAuthGrantRecord | undefined>;
  getGrantByFamily(familyId: string): Promise<OAuthGrantRecord | undefined>;
  listGrantsByUser(userId?: string): Promise<readonly OAuthGrantRecord[]>;
  updateGrant(grantId: string, patch: Partial<OAuthGrantRecord>): Promise<void>;
  deleteGrant(grantId: string): Promise<void>;

  saveRefreshToken(token: OAuthRefreshTokenRecord): Promise<void>;
  getRefreshToken(tokenHash: string): Promise<OAuthRefreshTokenRecord | undefined>;
  markRefreshTokenUsed(tokenHash: string): Promise<void>;
  revokeFamily(familyId: string): Promise<void>;
}

export interface OAuthServiceOptions {
  tokens: TokenService;
  store: OAuthStore;
  clock: Clock;
  baseUrl?: string | undefined;
  remote?: boolean | undefined;
  requireSecondFactor?: boolean | "always" | "remote" | "never" | undefined;
  fetchMetadata?: ((url: string) => Promise<unknown>) | undefined;
  clients?: Record<string, OAuthClientMetadata> | undefined;
}
