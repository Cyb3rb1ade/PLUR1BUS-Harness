import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { errors, ApiError } from "../errors.ts";
import { parseAddress, classifyAddress } from "./ip.ts";
import type { OAuthClientMetadata } from "./types.ts";

const MAX_METADATA_SIZE = 64 * 1024;
const FETCH_TIMEOUT_MS = 5000;

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

async function fetchEgressMetadataDocument(
  url: URL,
  allowLoopback: boolean,
): Promise<unknown> {
  const hostname = url.hostname;
  if (hostname.toLowerCase() === "localhost") {
    if (!allowLoopback) {
      throw errors.badRequest("client_id", "SSRF blocked: metadata URL resolves to private or loopback IP");
    }
  }

  const directIp = parseAddress(hostname);
  let pinnedAddress: string;
  let pinnedFamily: 4 | 6;

  if (directIp) {
    const verdict = classifyAddress(directIp);
    if (!verdict.public && !allowLoopback) {
      throw errors.badRequest("client_id", "SSRF blocked: metadata URL resolves to private or loopback IP");
    }
    pinnedAddress = hostname.replace(/^\[|\]$/g, "");
    pinnedFamily = directIp.family;
  } else {
    let resolved: Array<{ address: string; family: number }>;
    try {
      resolved = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    } catch {
      return undefined;
    }
    if (resolved.length === 0) {
      return undefined;
    }
    for (const item of resolved) {
      const parsed = parseAddress(item.address);
      if (!parsed || (!classifyAddress(parsed).public && !allowLoopback)) {
        throw errors.badRequest("client_id", "SSRF blocked: metadata URL resolves to private or loopback IP");
      }
    }
    pinnedAddress = resolved[0]!.address;
    pinnedFamily = resolved[0]!.family === 6 ? 6 : 4;
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? https : http;
    const port = url.port ? Number(url.port) : (isHttps ? 443 : 80);

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port,
        path: url.pathname + url.search,
        method: "GET",
        headers: {
          Host: url.host,
          Accept: "application/json",
          "User-Agent": "Plur1bus-OAuth/1.0",
        },
        servername: isHttps ? url.hostname : undefined,
        lookup: (_hostname, _options, cb) => {
          cb(null, pinnedAddress, pinnedFamily);
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolvePromise(undefined);
          return;
        }
        const ct = res.headers["content-type"] ?? "";
        if (!ct.includes("application/json")) {
          res.resume();
          resolvePromise(undefined);
          return;
        }

        let totalBytes = 0;
        const chunks: Buffer[] = [];

        res.on("data", (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_METADATA_SIZE) {
            res.destroy();
            rejectPromise(errors.badRequest("client_id", "client metadata document exceeds maximum size"));
            return;
          }
          chunks.push(chunk);
        });

        res.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            resolvePromise(JSON.parse(text));
          } catch {
            resolvePromise(undefined);
          }
        });

        res.on("error", (err) => {
          rejectPromise(err);
        });
      },
    );

    req.on("error", (err) => {
      rejectPromise(err);
    });

    req.end();
  });
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
        data = await fetchEgressMetadataDocument(parsedUrl, this.#allowLoopbackMetadata);
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
      if (e instanceof ApiError) {
        throw e;
      }
      if (e instanceof Error && e.name === "AbortError") {
        throw errors.badRequest("client_id", "timeout fetching client metadata document");
      }
      return undefined;
    }
  }
}
