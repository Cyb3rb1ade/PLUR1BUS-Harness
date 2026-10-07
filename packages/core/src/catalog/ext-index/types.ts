// D2: the signed extension catalogue index (extensions spec §7.2). Types, the typed error and the ports.

export type ExtIndexErrorCode =
  | "disabled" // catalogue switched off in configuration
  | "invalid-config" // url, key or limit in the configuration is unusable
  | "no-trusted-key" // no public key configured: nothing can be verified, so nothing is accepted
  | "unreachable" // egress failed (network, DNS, timeout, policy refusal)
  | "http-status" // the server answered with a non-200 status
  | "too-large" // body over the size cap
  | "signature-invalid" // the signature does not verify with any configured key
  | "malformed" // signed bytes that are not a valid v1 index
  | "unsupported-format" // `format` is not 1
  | "serial-rollback" // serial lower than the last accepted one
  | "serial-conflict" // same serial as the last accepted one, different content
  | "expired" // a freshly fetched index is already past `expires`
  | "catalog-stale" // the cached index is past `expires` and the caller needs a fresh one
  | "no-cache"; // offline and nothing cached

export class ExtIndexError extends Error {
  readonly code: ExtIndexErrorCode;
  constructor(code: ExtIndexErrorCode, message: string) {
    super(message);
    this.name = "ExtIndexError";
    this.code = code;
  }
}

/** The egress policy (B4) lives behind this port. The implementation must enforce `maxBytes` while reading and `timeoutMs`. */
export interface EgressPort {
  get(url: string, opts: { maxBytes: number; timeoutMs: number; signal?: AbortSignal | undefined }): Promise<{ status: number; body: Uint8Array }>;
}

export interface ExtIndexConfig {
  enabled: boolean;
  /** HTTPS URL of `index.json`; the signature is read from `signatureUrl` (default `<url>.minisig`). */
  url: string;
  signatureUrl?: string;
  /** keyId -> raw 32-byte Ed25519 public key, base64. No key is built in; an empty map refuses everything. */
  publicKeys: Record<string, string>;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface IndexVersion {
  version: string;
  url: string;
  sha256: string;
  size: number;
  [k: string]: unknown;
}
export interface IndexPackage {
  id: string;
  kind: string;
  name: string;
  versions: IndexVersion[];
  [k: string]: unknown;
}
export interface ExtIndex {
  format: 1;
  serial: number;
  generatedAt: string;
  expires: string;
  packages: IndexPackage[];
  revocations: unknown[];
  [k: string]: unknown;
}

export interface CachedIndex {
  indexBytes: Uint8Array;
  signature: string;
  fetchedAt: number; // epoch ms
}

export interface IndexCacheStore {
  read(): Promise<{ cached: CachedIndex | null; lastSerial: number }>;
  /** Writes the index first, then raises `last-serial` (a crash in between leaves a cache that is still acceptable). */
  write(cached: CachedIndex, serial: number): Promise<void>;
}

export interface IndexResult {
  index: ExtIndex;
  keyId: string;
  fetchedAt: number;
  /** Past `expires`: installed items keep running, installs/updates are refused, revocations still apply (§7.2.1). */
  stale: boolean;
  source: "network" | "cache";
  /** Set when a refresh failed and the cache was served instead. */
  refreshError?: ExtIndexError;
}
