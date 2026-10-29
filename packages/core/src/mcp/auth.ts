/** MCP OAuth stays bound to its protected resource and selected issuer; discovery never receives bearer credentials. */
import { randomBytes, createHash } from "node:crypto";
import { discoverOAuthProtectedResourceMetadata, discoverAuthorizationServerMetadata, extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AuthorizationServerMetadata, OAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Redactor } from "./redact.ts";
import { DevicePrompt } from "../auth/login.ts";
import type { McpAuthInteraction } from "./auth-interaction.ts";

/** One interactive attempt is bounded independently of transport deadlines (M-A8). */
export const MCP_AUTH_TIMEOUT_MS = 600_000;
const MAX_AUTHORIZATION_SERVERS = 8;
const MAX_DEVICE_LIFETIME_SECONDS = 3600;
const MAX_DEVICE_INTERVAL_SECONDS = 60;

/** A safe, nonretryable request for human sign-in; never retains a foreign error or authorization material. */
export class McpAuthRequiredError extends Error {
  readonly code = "auth-required";
  constructor() {
    super("MCP authorization is required; complete sign-in and retry");
    this.name = "McpAuthRequiredError";
  }
}

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
  /** Discovery may skip an incompatible listed issuer before starting any human interaction. */
  supportsAuthorizationServer?(metadata: AuthorizationServerMetadata): boolean;
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
  authorize?(url: URL, signal?: AbortSignal): Promise<{ code: string; state: string; issuer?: string }>;
  /** Shared ladder interaction. This port receives no verifier and performs no token exchange. */
  interaction?: McpAuthInteraction;
}
interface TokenSet { access: string; refresh?: string; expires: number; issuer: string; resource: string; scopes: string[]; metadata: AuthorizationServerMetadata; fetch: FetchLike; protect: (value: string) => void }
export class PkceAuthProvider implements McpAuthProvider {
  private readonly port: McpPkcePort;
  #token: TokenSet | undefined;
  constructor(port: McpPkcePort) {
    const redirect = new URL(port.redirectUri);
    if (redirect.username || redirect.password || redirect.hash) throw new Error("MCP OAuth redirect URI refused");
    this.port = port;
  }
  /** URL client IDs require advertised metadata-document support; pre-registered identifiers remain compatible. */
  supportsAuthorizationServer(metadata: AuthorizationServerMetadata): boolean {
    return !!metadata.token_endpoint
      && (!!metadata.authorization_endpoint && !!metadata.code_challenge_methods_supported?.includes("S256")
        || !!this.port.interaction && "device_authorization_endpoint" in metadata
          && typeof metadata.device_authorization_endpoint === "string")
      && (!clientMetadataUrl(this.port.clientId) || metadata.client_id_metadata_document_supported === true);
  }
  async accessToken(resource: string, signal?: AbortSignal): Promise<string | undefined> {
    const token = this.#token;
    if (!token || token.resource !== resource) return undefined;
    if (token.expires > Date.now() + 5000) return token.access;
    if (!token.refresh) return undefined;
    const params = new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refresh, client_id: this.port.clientId, resource });
    try { return await this.exchange(params, token.metadata, resource, token.fetch, token.protect, signal, token.refresh, token.scopes); }
    catch { this.#token = undefined; return undefined; }
  }
  async authorize(c: McpAuthChallenge, signal?: AbortSignal): Promise<string> {
    const metadata = c.authorizationServer;
    if (!metadata.code_challenge_methods_supported?.includes("S256") && !this.port.interaction) throw new Error("MCP OAuth requires PKCE S256");
    if (!metadata.authorization_endpoint || !metadata.token_endpoint) throw new Error("MCP OAuth endpoints missing");
    if (c.resourceMetadata.resource !== c.resource || !c.resourceMetadata.authorization_servers?.includes(metadata.issuer)) {
      throw new Error("MCP OAuth resource or issuer mismatch");
    }
    await validateClientMetadata(this.port, c, signal);
    const previous = this.#token;
    const scopes = unionScopes(previous?.resource === c.resource && previous.issuer === metadata.issuer ? previous.scopes : [], c.scope);
    const verifier = randomBytes(32).toString("base64url"); const state = randomBytes(32).toString("base64url");
    c.protect(verifier); c.protect(state);
    const url = new URL(metadata.authorization_endpoint);
    secureEndpoint(url);
    const params = new URLSearchParams({ response_type: "code", client_id: this.port.clientId, redirect_uri: this.port.redirectUri,
      state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: c.resource });
    if (scopes.length) params.set("scope", scopes.join(" "));
    params.forEach((value, key) => url.searchParams.set(key, value));
    let response: Awaited<ReturnType<McpAuthInteraction["authorize"]>>;
    try {
      response = this.port.interaction ? await this.port.interaction.authorize(url, metadata, signal)
        : this.port.authorize ? await this.port.authorize(url, signal) : (() => { throw new McpAuthRequiredError(); })();
    } catch { throw new McpAuthRequiredError(); }
    if ("kind" in response && response.kind === "device_code") return this.device(c, scopes, signal);
    if (!("code" in response) || !metadata.code_challenge_methods_supported?.includes("S256")) throw new Error("MCP OAuth requires PKCE S256");
    c.protect(response.code);
    if (response.state !== state || response.issuer !== undefined && response.issuer !== metadata.issuer
      || "authorization_response_iss_parameter_supported" in metadata
        && metadata.authorization_response_iss_parameter_supported === true && response.issuer === undefined) {
      throw new Error("MCP OAuth state or issuer mismatch");
    }
    if (signal?.aborted) throw new Error("MCP OAuth aborted");
    return await this.exchange(new URLSearchParams({ grant_type: "authorization_code", code: response.code, code_verifier: verifier,
      redirect_uri: this.port.redirectUri, client_id: this.port.clientId, resource: c.resource }), metadata, c.resource, c.fetch, c.protect, signal, undefined, scopes);
  }
  private async exchange(params: URLSearchParams, metadata: AuthorizationServerMetadata, resource: string, fetch: FetchLike,
    protect: (value: string) => void, signal?: AbortSignal, refresh?: string, requestedScopes: string[] = []): Promise<string> {
    const data = await tokenRequest(metadata.token_endpoint!, params, fetch, signal);
    return this.acceptToken(data, metadata, resource, fetch, protect, refresh, requestedScopes);
  }
  private acceptToken(data: Record<string, unknown>, metadata: AuthorizationServerMetadata, resource: string,
    fetch: FetchLike, protect: (value: string) => void, refresh: string | undefined, requestedScopes: string[]): string {
    if (typeof data.access_token !== "string" || !data.access_token || typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer") throw new Error("MCP OAuth invalid token response");
    protect(data.access_token);
    const nextRefresh = typeof data.refresh_token === "string" ? data.refresh_token : refresh;
    if (nextRefresh) protect(nextRefresh);
    if (data.expires_in !== undefined && (typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0)) throw new Error("MCP OAuth invalid token expiry");
    const scopes = data.scope === undefined ? requestedScopes : unionScopes([], data.scope);
    this.#token = { access: data.access_token, ...(nextRefresh ? { refresh: nextRefresh } : {}), scopes,
      expires: Date.now() + (typeof data.expires_in === "number" ? data.expires_in * 1000 : 60_000), issuer: metadata.issuer,
      resource, metadata, fetch, protect };
    return data.access_token;
  }
  private async device(c: McpAuthChallenge, scopes: string[], signal?: AbortSignal): Promise<string> {
    const interaction = this.port.interaction;
    const endpoint = "device_authorization_endpoint" in c.authorizationServer
      ? c.authorizationServer.device_authorization_endpoint : undefined;
    if (!interaction || typeof endpoint !== "string") throw new McpAuthRequiredError();
    const deadline = AbortSignal.any([AbortSignal.timeout(MCP_AUTH_TIMEOUT_MS), ...(signal ? [signal] : [])]);
    const params = { client_id: this.port.clientId, resource: c.resource };
    const device = await tokenRequest(endpoint, new URLSearchParams({ ...params,
      ...(scopes.length ? { scope: scopes.join(" ") } : {}),
    }), c.fetch, deadline);
    if (typeof device.device_code !== "string" || !device.device_code || typeof device.user_code !== "string"
      || !device.user_code || typeof device.verification_uri !== "string" || typeof device.expires_in !== "number"
      || !Number.isFinite(device.expires_in) || device.expires_in <= 0
      || device.expires_in > MAX_DEVICE_LIFETIME_SECONDS
      || device.interval !== undefined && (typeof device.interval !== "number" || !Number.isFinite(device.interval)
        || device.interval <= 0 || device.interval > MAX_DEVICE_INTERVAL_SECONDS)) throw new McpAuthRequiredError();
    secureEndpoint(new URL(device.verification_uri));
    if (device.verification_uri_complete !== undefined) {
      if (typeof device.verification_uri_complete !== "string") throw new McpAuthRequiredError();
      secureEndpoint(new URL(device.verification_uri_complete));
      c.protect(device.verification_uri_complete);
    }
    c.protect(device.device_code);
    c.protect(device.user_code);
    const now = interaction.now ?? Date.now;
    const expires = now() + device.expires_in * 1000;
    await interaction.onDevice(new DevicePrompt(device.user_code, device.verification_uri,
      typeof device.verification_uri_complete === "string" ? device.verification_uri_complete : undefined), deadline);
    let interval = (typeof device.interval === "number" ? device.interval : 5) * 1000;
    while (now() < expires && !deadline.aborted) {
      await interaction.sleep(Math.min(interval, expires - now()), deadline);
      if (now() >= expires || deadline.aborted) break;
      try {
        return await this.exchange(new URLSearchParams({ ...params,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.device_code,
        }), c.authorizationServer, c.resource, c.fetch, c.protect, deadline, undefined, scopes);
      } catch (error) {
        if (!(error instanceof OAuthTokenError)) throw error;
        if (error.code === "authorization_pending") continue;
        if (error.code === "slow_down") { interval = Math.min(interval + 5000, 60_000); continue; }
        throw new McpAuthRequiredError();
      }
    }
    throw new McpAuthRequiredError();
  }
}
class OAuthTokenError extends Error {
  readonly code: string;
  constructor(code: string) { super("MCP OAuth token exchange failed"); this.code = code; }
}
async function tokenRequest(endpoint: string, params: URLSearchParams, fetch: FetchLike,
  signal?: AbortSignal): Promise<Record<string, unknown>> {
  const url = new URL(endpoint);
  secureEndpoint(url);
  if (signal?.aborted) throw new McpAuthRequiredError();
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(), ...(signal ? { signal } : {}),
  });
  if (signal?.aborted) {
    await response.body?.cancel();
    throw new McpAuthRequiredError();
  }
  let data: unknown;
  try { data = await response.json(); } catch { throw new McpAuthRequiredError(); }
  if (signal?.aborted) throw new McpAuthRequiredError();
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new McpAuthRequiredError();
  const record = data as Record<string, unknown>;
  if (!response.ok || record.error !== undefined) throw new OAuthTokenError(
    record.error === "authorization_pending" || record.error === "slow_down" ? record.error : "rejected");
  return record;
}
function unionScopes(previous: readonly string[], requested: unknown): string[] {
  if (requested !== undefined && (typeof requested !== "string" || !/^[\x21\x23-\x5b\x5d-\x7e]+(?: [\x21\x23-\x5b\x5d-\x7e]+)*$/.test(requested))) {
    throw new Error("MCP OAuth invalid scope");
  }
  return [...new Set([...previous, ...(typeof requested === "string" ? requested.split(" ") : [])])].sort();
}
function clientMetadataUrl(clientId: string): URL | undefined {
  if (!/^https?:\/\//i.test(clientId)) return undefined;
  let url: URL;
  try { url = new URL(clientId); } catch { return undefined; }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("MCP OAuth client metadata URL refused");
  return url;
}
async function validateClientMetadata(port: McpPkcePort, c: McpAuthChallenge, signal?: AbortSignal): Promise<void> {
  const url = clientMetadataUrl(port.clientId);
  if (!url) return;
  if (c.authorizationServer.client_id_metadata_document_supported !== true) throw new Error("MCP OAuth client metadata is unsupported");
  const response = await c.fetch(url, { headers: { accept: "application/json" }, ...(signal ? { signal } : {}) });
  if (!response.ok) { await response.body?.cancel(); throw new Error("MCP OAuth client metadata unavailable"); }
  const data = await response.json() as Record<string, unknown>;
  if (!data || typeof data !== "object" || Array.isArray(data) || data.client_id !== port.clientId
    || !Array.isArray(data.redirect_uris) || !data.redirect_uris.includes(port.redirectUri)
    || data.token_endpoint_auth_method !== undefined && data.token_endpoint_auth_method !== "none") {
    throw new Error("MCP OAuth client metadata mismatch");
  }
}
function secureEndpoint(url: URL): void {
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.hash || url.protocol !== "https:" && !(loopback && url.protocol === "http:")) throw new Error("MCP OAuth endpoint refused");
}

/** Shared metadata discovery for explicit human login and challenged resource requests. Never sends resource credentials. */
export async function discoverMcpAuthChallenge(resource: string, base: FetchLike, provider: McpAuthProvider,
  protect: (value: string) => void, signal?: AbortSignal,
  hint: { resourceMetadataUrl?: URL; scope?: string } = {}): Promise<McpAuthChallenge> {
  const unauthenticated: FetchLike = (url, options = {}) => {
    const headers = new Headers(options.headers);
    headers.delete("authorization");
    headers.delete("proxy-authorization");
    headers.delete("cookie");
    const requestSignal = options.signal ?? signal;
    return base(url, { ...options, ...(requestSignal ? { signal: requestSignal } : {}), headers });
  };
  const resourceMetadata = await discoverOAuthProtectedResourceMetadata(resource,
    hint.resourceMetadataUrl ? { resourceMetadataUrl: hint.resourceMetadataUrl } : {}, unauthenticated);
  if (new URL(resourceMetadata.resource).toString() !== new URL(resource).toString()) {
    throw new Error("MCP OAuth resource mismatch");
  }
  const issuers = resourceMetadata.authorization_servers ?? [];
  if (!issuers.length || issuers.length > MAX_AUTHORIZATION_SERVERS) {
    throw new Error("MCP OAuth authorization server missing or excessive");
  }
  for (const issuer of [...new Set(issuers)]) {
    try {
      const url = new URL(issuer);
      secureEndpoint(url);
      if (url.search) continue;
      const candidate = await discoverAuthorizationServerMetadata(issuer, { fetchFn: unauthenticated });
      if (candidate?.issuer !== issuer || provider.supportsAuthorizationServer?.(candidate) === false) continue;
      return { resource, resourceMetadata, authorizationServer: candidate, fetch: unauthenticated, protect,
        ...(hint.scope ? { scope: hint.scope } : {}) };
    } catch {
      if (signal?.aborted) throw new Error("MCP OAuth aborted");
      // Another listed issuer may serve; no human interaction or credential has started yet.
    }
  }
  throw new Error("MCP OAuth authorization server unavailable");
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
      const challenge = extractWWWAuthenticateParams(response);
      const challenged = response.status === 401 || response.status === 403 && challenge.error === "insufficient_scope";
      if (!challenged) return response;
      await response.body?.cancel();
      if (!provider?.authorize) throw new McpAuthRequiredError();
      if (!authorizing) {
        const signal = init.signal ?? undefined;
        authorizing = discoverMcpAuthChallenge(resource, base, provider, value => redactor.add(value, true), signal,
          { ...(challenge.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {}),
            ...(challenge.scope ? { scope: challenge.scope } : {}) },
        ).then(current => provider.authorize!(current, signal));
      }
      let value: string;
      try { value = await authorizing; } finally { authorizing = undefined; }
      const retry = await send(value);
      if (retry.status === 401 || retry.status === 403 && extractWWWAuthenticateParams(retry).error === "insufficient_scope") {
        await retry.body?.cancel();
        throw new McpAuthRequiredError();
      }
      return retry;
    } catch (error) {
      if (error instanceof McpAuthRequiredError) throw error;
      throw new Error("MCP authorization or guarded HTTP request failed");
    }
  };
}
