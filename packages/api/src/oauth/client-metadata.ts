import { errors } from "../errors.ts";
import type { OAuthClientMetadata } from "./types.ts";

const MAX_METADATA_SIZE = 64 * 1024;
const FETCH_TIMEOUT_MS = 5000;

function isPrivateIp(hostname: string): boolean {
  // IPv4 private & special ranges
  // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, 169.254.0.0/16, 0.0.0.0
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (ipv4) {
    const b0 = Number(ipv4[1]);
    const b1 = Number(ipv4[2]);
    if (b0 === 10) return true;
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
    if (b0 === 192 && b1 === 168) return true;
    if (b0 === 127) return true;
    if (b0 === 169 && b1 === 254) return true;
    if (b0 === 0) return true;
  }
  // IPv6 loopback / private / link-local
  const clean = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (clean === "::1" || clean === "::" || clean.startsWith("fc") || clean.startsWith("fd") || clean.startsWith("fe80")) {
    return true;
  }
  if (clean === "localhost") return true;
  return false;
}

export function matchRedirectUri(requestedUri: string, allowedUris: readonly string[]): boolean {
  if (allowedUris.includes(requestedUri)) {
    return true;
  }
  try {
    const reqUrl = new URL(requestedUri);
    // RFC 8252 §7.3 loopback port variance
    if (
      reqUrl.protocol === "http:" &&
      (reqUrl.hostname === "127.0.0.1" || reqUrl.hostname === "[::1]" || reqUrl.hostname === "localhost")
    ) {
      for (const allowed of allowedUris) {
        try {
          const allowedUrl = new URL(allowed);
          if (
            allowedUrl.protocol === "http:" &&
            (allowedUrl.hostname === "127.0.0.1" || allowedUrl.hostname === "[::1]" || allowedUrl.hostname === "localhost") &&
            allowedUrl.pathname === reqUrl.pathname
          ) {
            return true;
          }
        } catch {
          // Ignore malformed allowed URI
        }
      }
    }
  } catch {
    return false;
  }
  return false;
}

export class ClientMetadataResolver {
  readonly #staticClients: Map<string, OAuthClientMetadata>;
  readonly #cache = new Map<string, { metadata: OAuthClientMetadata; cachedAt: number }>();
  readonly #fetchImpl?: ((url: string) => Promise<unknown>) | undefined;
  readonly #allowLoopbackMetadata: boolean;

  constructor(options: {
    clients?: Record<string, OAuthClientMetadata> | undefined;
    fetchMetadata?: ((url: string) => Promise<unknown>) | undefined;
    allowLoopbackMetadata?: boolean | undefined;
  } = {}) {
    this.#staticClients = new Map(Object.entries(options.clients ?? {}));
    this.#fetchImpl = options.fetchMetadata;
    this.#allowLoopbackMetadata = options.allowLoopbackMetadata ?? false;
  }

  async resolveClient(clientId: string): Promise<OAuthClientMetadata | undefined> {
    if (typeof clientId !== "string" || clientId.length === 0 || clientId.length > 2048) {
      return undefined;
    }

    // 1. Static configured client
    const staticMatch = this.#staticClients.get(clientId);
    if (staticMatch) {
      return staticMatch;
    }
    for (const client of this.#staticClients.values()) {
      if (client.client_id === clientId) {
        return client;
      }
    }

    // 2. Draft client-id-metadata-document: client_id is an HTTPS (or allowed loopback) URL
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(clientId);
    } catch {
      return undefined;
    }

    const isHttps = parsedUrl.protocol === "https:";
    const isHttpLoopback =
      parsedUrl.protocol === "http:" &&
      (parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "localhost" || parsedUrl.hostname === "[::1]");

    if (!isHttps && !(isHttpLoopback && this.#allowLoopbackMetadata)) {
      return undefined;
    }

    if (isHttps && !this.#allowLoopbackMetadata && isPrivateIp(parsedUrl.hostname)) {
      throw errors.badRequest("client_id", "SSRF blocked: metadata URL resolves to private or loopback IP");
    }

    // Check cache (TTL 5 minutes)
    const cached = this.#cache.get(clientId);
    if (cached && Date.now() - cached.cachedAt < 5 * 60_000) {
      return cached.metadata;
    }

    try {
      let data: unknown;
      if (this.#fetchImpl) {
        data = await this.#fetchImpl(clientId);
      } else {
        const res = await fetch(clientId, {
          method: "GET",
          headers: { Accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) {
          return undefined;
        }
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.includes("application/json")) {
          return undefined;
        }
        const text = await res.text();
        if (text.length > MAX_METADATA_SIZE) {
          throw errors.badRequest("client_id", "client metadata document exceeds maximum size");
        }
        data = JSON.parse(text);
      }

      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return undefined;
      }

      const doc = data as Record<string, unknown>;
      if (doc.client_id !== clientId) {
        return undefined;
      }
      if (!Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0) {
        return undefined;
      }
      for (const uri of doc.redirect_uris) {
        if (typeof uri !== "string" || uri.length === 0) {
          return undefined;
        }
      }

      const clientMeta: OAuthClientMetadata = {
        client_id: clientId,
        client_name: typeof doc.client_name === "string" ? doc.client_name : undefined,
        client_uri: typeof doc.client_uri === "string" ? doc.client_uri : undefined,
        logo_uri: typeof doc.logo_uri === "string" ? doc.logo_uri : undefined,
        redirect_uris: Object.freeze([...doc.redirect_uris]),
        grant_types: Array.isArray(doc.grant_types) ? Object.freeze([...doc.grant_types]) : undefined,
        response_types: Array.isArray(doc.response_types) ? Object.freeze([...doc.response_types]) : undefined,
        scope: typeof doc.scope === "string" ? doc.scope : undefined,
        token_endpoint_auth_method: "none",
      };

      this.#cache.set(clientId, { metadata: clientMeta, cachedAt: Date.now() });
      return clientMeta;
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        throw errors.badRequest("client_id", "timeout fetching client metadata document");
      }
      return undefined;
    }
  }
}
