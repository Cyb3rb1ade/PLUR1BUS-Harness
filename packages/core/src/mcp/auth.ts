import { randomBytes, createHash } from "node:crypto";
import { discoverOAuthProtectedResourceMetadata, discoverAuthorizationServerMetadata, extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AuthorizationServerMetadata, OAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Redactor } from "./redact.ts";

export interface McpAuthChallenge {
  resource: string;
  resourceMetadata: OAuthProtectedResourceMetadata;
  authorizationServer: AuthorizationServerMetadata;
  scope?: string;
  /** Uses the same egress-pinned HTTP client; never includes the MCP bearer token. */
  fetch: FetchLike;
  protect(value: string): void;
}
/** A host port, bound to one resource. No browser, provider or UI integration is installed here. */
export interface McpAuthProvider {
  accessToken(resource: string, signal?: AbortSignal): Promise<string | undefined>;
  authorize?(challenge: McpAuthChallenge, signal?: AbortSignal): Promise<string>;
}

type LeaseSecrets = {
  lease(p: { kind: "core" }, name: string, options: { purpose: string; profileId: string }): Promise<{ leaseId: string; value: string }>;
  revokeLease(p: { kind: "core" }, leaseId: string): boolean;
};
/** Default configured auth: resolve a named secret through the real core lease API, never process.env. */
export class SecretBearerAuthProvider implements McpAuthProvider {
  private readonly store: LeaseSecrets;
  private readonly name: string;
  private resource: string | undefined;
  constructor(store: LeaseSecrets, name: string) { this.store = store; this.name = name; }
  async accessToken(resource: string): Promise<string> {
    if (this.resource !== undefined && this.resource !== resource) throw new Error("MCP static bearer resource mismatch");
    this.resource = resource;
    const lease = await this.store.lease({ kind: "core" }, this.name, { purpose: "mcp-auth", profileId: "mcp" });
    try { return lease.value; } finally { this.store.revokeLease({ kind: "core" }, lease.leaseId); }
  }
}

export interface McpPkcePort {
  /** Pre-registered public client, or a client ID metadata document URL; no dynamic registration. */
  clientId: string;
  redirectUri: string;
  authorize(url: URL, signal?: AbortSignal): Promise<{ code: string; state: string; issuer?: string }>;
}
interface TokenSet { access: string; refresh?: string; expires: number; issuer: string; resource: string; metadata: AuthorizationServerMetadata; fetch: FetchLike; protect: (value: string) => void }
export class PkceAuthProvider implements McpAuthProvider {
  private readonly port: McpPkcePort;
  private token: TokenSet | undefined;
  constructor(port: McpPkcePort) {
    const redirect = new URL(port.redirectUri);
    if (redirect.username || redirect.password || redirect.hash) throw new Error("MCP OAuth redirect URI refused");
    this.port = port;
  }
  async accessToken(resource: string, signal?: AbortSignal): Promise<string | undefined> {
    const token = this.token;
    if (!token || token.resource !== resource) return undefined;
    if (token.expires > Date.now() + 5000) return token.access;
    if (!token.refresh) return undefined;
    const params = new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refresh, client_id: this.port.clientId, resource });
    try { return await this.exchange(params, token.metadata, resource, token.fetch, token.protect, signal, token.refresh); }
    catch { this.token = undefined; return undefined; }
  }
  async authorize(c: McpAuthChallenge, signal?: AbortSignal): Promise<string> {
    const metadata = c.authorizationServer;
    if (!metadata.code_challenge_methods_supported?.includes("S256")) throw new Error("MCP OAuth requires PKCE S256");
    if (!metadata.authorization_endpoint || !metadata.token_endpoint) throw new Error("MCP OAuth endpoints missing");
    const verifier = randomBytes(32).toString("base64url"); const state = randomBytes(32).toString("base64url");
    c.protect(verifier); c.protect(state);
    const url = new URL(metadata.authorization_endpoint);
    secureEndpoint(url);
    const params = new URLSearchParams({ response_type: "code", client_id: this.port.clientId, redirect_uri: this.port.redirectUri,
      state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: c.resource });
    if (c.scope) params.set("scope", c.scope);
    params.forEach((value, key) => url.searchParams.set(key, value));
    const response = await this.port.authorize(url, signal);
    c.protect(response.code);
    if (response.state !== state || (response.issuer !== undefined && response.issuer !== metadata.issuer)) throw new Error("MCP OAuth state or issuer mismatch");
    if (signal?.aborted) throw new Error("MCP OAuth aborted");
    return await this.exchange(new URLSearchParams({ grant_type: "authorization_code", code: response.code, code_verifier: verifier,
      redirect_uri: this.port.redirectUri, client_id: this.port.clientId, resource: c.resource }), metadata, c.resource, c.fetch, c.protect, signal);
  }
  private async exchange(params: URLSearchParams, metadata: AuthorizationServerMetadata, resource: string, fetch: FetchLike,
    protect: (value: string) => void, signal?: AbortSignal, refresh?: string): Promise<string> {
    const endpoint = new URL(metadata.token_endpoint!); secureEndpoint(endpoint);
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: params.toString(), ...(signal ? { signal } : {}) });
    if (!response.ok) { await response.body?.cancel(); throw new Error("MCP OAuth token exchange failed"); }
    const data = await response.json() as Record<string, unknown>;
    if (typeof data.access_token !== "string" || !data.access_token || typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer") throw new Error("MCP OAuth invalid token response");
    protect(data.access_token);
    const nextRefresh = typeof data.refresh_token === "string" ? data.refresh_token : refresh;
    if (nextRefresh) protect(nextRefresh);
    if (data.expires_in !== undefined && (typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0)) throw new Error("MCP OAuth invalid token expiry");
    this.token = { access: data.access_token, ...(nextRefresh ? { refresh: nextRefresh } : {}),
      expires: Date.now() + (typeof data.expires_in === "number" ? data.expires_in * 1000 : 60_000), issuer: metadata.issuer,
      resource, metadata, fetch, protect };
    return data.access_token;
  }
}
function secureEndpoint(url: URL): void {
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.hash || url.protocol !== "https:" && !(loopback && url.protocol === "http:")) throw new Error("MCP OAuth endpoint refused");
}

/** Bounded 401 retry. All discovery is unauthenticated and uses the egress client. */
export function createAuthorizedFetch(base: FetchLike, resource: string, provider: McpAuthProvider | undefined, redactor: Redactor): FetchLike {
  let authorizing: Promise<string> | undefined;
  return async (raw, init = {}) => {
    if (new URL(raw).toString() !== new URL(resource).toString()) throw new Error("MCP authorization endpoint mismatch");
    try {
      const token = await provider?.accessToken(resource, init.signal ?? undefined);
      const send = async (value?: string) => {
        const headers = new Headers(init.headers);
        if (value) { redactor.add(value, true); redactor.add(`Bearer ${value}`, true); headers.set("authorization", `Bearer ${value}`); }
        return await base(raw, { ...init, headers });
      };
      const response = await send(token);
      if (response.status !== 401 || !provider?.authorize) return response;
      const challenge = extractWWWAuthenticateParams(response);
      await response.body?.cancel();
      if (!authorizing) {
        const signal = init.signal ?? undefined;
        const unauthenticated: FetchLike = (url, options = {}) => {
          const requestSignal = options.signal ?? signal;
          return base(url, { ...options, ...(requestSignal ? { signal: requestSignal } : {}), headers: new Headers(options.headers) });
        };
        authorizing = (async () => {
          const resourceMetadata = await discoverOAuthProtectedResourceMetadata(resource, challenge.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {}, unauthenticated);
          if (new URL(resourceMetadata.resource).toString() !== new URL(resource).toString()) throw new Error("MCP OAuth resource mismatch");
          const issuer = resourceMetadata.authorization_servers?.[0];
          if (!issuer) throw new Error("MCP OAuth authorization server missing");
          secureEndpoint(new URL(issuer));
          const authorizationServer = await discoverAuthorizationServerMetadata(issuer, { fetchFn: unauthenticated });
          if (!authorizationServer || authorizationServer.issuer !== issuer) throw new Error("MCP OAuth issuer mismatch");
          return await provider.authorize!({ resource, resourceMetadata, authorizationServer, fetch: unauthenticated,
            protect: value => redactor.add(value, true), ...(challenge.scope ? { scope: challenge.scope } : {}) }, signal);
        })();
      }
      let value: string;
      try { value = await authorizing; } finally { authorizing = undefined; }
      return await send(value);
    } catch { throw new Error("MCP authorization or guarded HTTP request failed"); }
  };
}
