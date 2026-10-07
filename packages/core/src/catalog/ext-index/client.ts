// The index client: fetch through the egress port, verify, check serial and expiry, cache, fall back offline.
import { createHash } from "node:crypto";
import { ExtIndexError, type EgressPort, type ExtIndexConfig, type IndexCacheStore, type IndexResult } from "./types.ts";
import { importKeys, parseIndex, verifySignature } from "./verify.ts";

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const TRANSPORT = new Set(["unreachable", "http-status", "too-large"]);

export interface ExtIndexClient {
  /** Fetch, verify and cache a fresh index. Never touches the cache on any failure. */
  refresh(signal?: AbortSignal): Promise<IndexResult>;
  /** The cached index, re-verified; `null` if there is none or it no longer verifies. */
  cached(): Promise<IndexResult | null>;
  /** `refresh`, and on any failure the cache (with `refreshError`); throws when there is no cache. */
  get(signal?: AbortSignal): Promise<IndexResult>;
}

export interface ExtIndexClientOptions {
  config: ExtIndexConfig;
  egress: EgressPort;
  store: IndexCacheStore;
  now?: () => number;
}

/** Installs and updates must be refused from a stale index (revocations still apply from it). */
export function assertFresh(result: IndexResult): void {
  if (result.stale) throw new ExtIndexError("catalog-stale", `catalogue index (serial ${result.index.serial}) is past its expiry`);
}

function requireHttps(url: string, what: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ExtIndexError("invalid-config", `${what} is not a URL`);
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "") throw new ExtIndexError("invalid-config", `${what} must be a plain https URL`);
}

export function createExtIndexClient(opts: ExtIndexClientOptions): ExtIndexClient {
  const { config, egress, store } = opts;
  const now = opts.now ?? Date.now;
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Validated lazily so a disabled or misconfigured catalogue is a typed error, not a constructor throw.
  const prepare = () => {
    if (!config.enabled) throw new ExtIndexError("disabled", "the extension catalogue is disabled");
    requireHttps(config.url, "catalogue url");
    const sigUrl = config.signatureUrl ?? `${config.url}.minisig`;
    requireHttps(sigUrl, "signature url");
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new ExtIndexError("invalid-config", "maxBytes must be a positive integer");
    return { keys: importKeys(config.publicKeys), sigUrl };
  };

  async function fetchOne(url: string, signal?: AbortSignal): Promise<Uint8Array> {
    let res: { status: number; body: Uint8Array };
    try {
      res = await egress.get(url, { maxBytes, timeoutMs, signal });
    } catch (e) {
      if (e instanceof ExtIndexError) throw e;
      throw new ExtIndexError("unreachable", `could not fetch ${new URL(url).host}: ${(e as { code?: string }).code ?? (e as Error).name ?? "failed"}`);
    }
    if (res.status !== 200) throw new ExtIndexError("http-status", `${new URL(url).host} answered ${res.status}`);
    if (res.body.byteLength > maxBytes) throw new ExtIndexError("too-large", `response over ${maxBytes} bytes`);
    return res.body;
  }

  const sameBytes = (a: Uint8Array, b: Uint8Array) => createHash("sha256").update(a).digest("hex") === createHash("sha256").update(b).digest("hex");

  async function refresh(signal?: AbortSignal): Promise<IndexResult> {
    const { keys, sigUrl } = prepare();
    const [indexBytes, sigBytes] = await Promise.all([fetchOne(config.url, signal), fetchOne(sigUrl, signal)]);
    const signature = Buffer.from(sigBytes).toString("utf8");
    const keyId = verifySignature(indexBytes, signature, keys); // before anything reads the content
    const { index, expiresAt } = parseIndex(indexBytes);
    const t = now();
    const { cached, lastSerial } = await store.read();
    if (index.serial < lastSerial) throw new ExtIndexError("serial-rollback", `index serial ${index.serial} is lower than the last accepted ${lastSerial}`);
    if (index.serial === lastSerial && cached && !sameBytes(cached.indexBytes, indexBytes)) {
      throw new ExtIndexError("serial-conflict", `index serial ${index.serial} was already accepted with different content`);
    }
    // RULING: a fresh index that is already expired is refused and not stored (a replayed old index must not become the cache).
    if (expiresAt <= t) throw new ExtIndexError("expired", `fetched index expired at ${index.expires}`);
    await store.write({ indexBytes, signature, fetchedAt: t }, index.serial);
    return { index, keyId, fetchedAt: t, stale: false, source: "network" };
  }

  async function cachedResult(): Promise<IndexResult | null> {
    const { keys } = prepare();
    const { cached, lastSerial } = await store.read();
    if (!cached) return null;
    try {
      const keyId = verifySignature(cached.indexBytes, cached.signature, keys); // the cache is untrusted storage: re-verify
      const { index, expiresAt } = parseIndex(cached.indexBytes);
      if (index.serial < lastSerial) return null; // a cache older than what was accepted is a rollback
      return { index, keyId, fetchedAt: cached.fetchedAt, stale: expiresAt <= now(), source: "cache" };
    } catch (e) {
      if (e instanceof ExtIndexError && e.code !== "invalid-config" && e.code !== "no-trusted-key") return null;
      throw e;
    }
  }

  return {
    refresh,
    cached: cachedResult,
    async get(signal) {
      try {
        return await refresh(signal);
      } catch (e) {
        if (!(e instanceof ExtIndexError) || e.code === "disabled" || e.code === "invalid-config" || e.code === "no-trusted-key") throw e;
        const c = await cachedResult();
        if (!c) throw TRANSPORT.has(e.code) ? new ExtIndexError("no-cache", `${e.message}; nothing cached`) : e;
        return { ...c, refreshError: e };
      }
    },
  };
}
