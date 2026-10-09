import type { ExtIndex } from "./ext-index/types.ts";
import type { Egress } from "../egress/index.ts";

export type CatalogErrorCode = "signature_invalid" | "key_unknown" | "key_revoked" | "rollback_detected" | "stale_index" | "hash_mismatch" | "revoked_package" | "transport";
export interface CatalogFailure { code: CatalogErrorCode; message: string }
export type CatalogResult<T> = { ok: true; value: T } | { ok: false; error: CatalogFailure };
export class CatalogError extends Error {
  readonly code: CatalogErrorCode;
  constructor(code: CatalogErrorCode, message: string) { super(message); this.name = "CatalogError"; this.code = code; }
}
export interface CatalogKey { id: string; publicKey: string; expires: string }
export interface CatalogRoot { type: "root"; version: number; threshold: number; expires: string; keys: readonly CatalogKey[] }
/** Detached signatures over the decoded payload's exact bytes. Never JSON.stringify a parsed payload to verify it. */
export interface SignedCatalogData { payload: string; signatures: { keyId: string; signature: string }[] }
export interface PackageRevocation { id: string; versions: string[]; reason: string }
export interface CatalogRevocations { type: "revocations"; version: number; rootVersion: number; expires: string; keys: string[]; packages: PackageRevocation[] }
export interface CatalogIndex extends ExtIndex { rootVersion: number; revocation: { version: number; sha256: string } }
export interface CatalogSnapshot { index: SignedCatalogData; revocations: SignedCatalogData; rotations: SignedCatalogData[]; fetchedAt: number }
export interface CatalogCheckpoint {
  serial: number; indexHash: string;
  rootVersion: number; rootHash: string;
  revocationVersion: number; revocationHash: string;
  revokedKeys: string[]; revokedPublicKeys: string[]; revokedPackages: PackageRevocation[];
  rotationHashes: string[];
}
export interface CatalogStore {
  read(): Promise<{ checkpoint: CatalogCheckpoint | null; snapshot: CatalogSnapshot | null; legacySerial?: number }>;
  write(checkpoint: CatalogCheckpoint, snapshot: CatalogSnapshot): Promise<void>;
  /** Serialize read/check/write, including downloads, for every client sharing this store. */
  exclusive<T>(operation: () => Promise<T>): Promise<T>;
}
export interface CatalogConfig {
  url: string;
  /** Trust anchor provisioned by a harness release, never by the network. Empty shipped placeholder fails closed. */
  root?: Omit<CatalogRoot, "threshold"> & { threshold?: number };
  /** Complete chain from the provisioned root, defaults to sibling `rotations`. */
  rotationsUrl?: string;
  revocationsUrl?: string;
  /** Exact loopback HTTP origin, ONLY for an explicitly configured local test catalogue. */
  testOrigin?: string;
  offlineGraceMs?: number;
  maxBytes?: number;
  maxArtifactBytes?: number;
  timeoutMs?: number;
}
export interface InstalledCatalogPort {
  list(): Promise<{ id: string; version: string }[]>;
  report(items: { id: string; version: string; status: "revoked"; reason: string }[]): Promise<void>;
}
export interface CatalogOptions { config: CatalogConfig; egress: Egress; store: CatalogStore; now?: () => number; installed?: InstalledCatalogPort }
export interface CatalogView {
  index: CatalogIndex; rootVersion: number; source: "network" | "cache"; stale: boolean; fetchedAt: number;
  refreshError?: CatalogFailure;
}
export interface CatalogClient {
  refresh(signal?: AbortSignal): Promise<CatalogResult<CatalogView>>;
  get(signal?: AbortSignal): Promise<CatalogResult<CatalogView>>;
  /** Caller supplies an index serial and identity, NEVER URLs, hashes or mutable metadata. */
  download(selection: { serial: number; id: string; version: string }, signal?: AbortSignal): Promise<CatalogResult<Uint8Array>>;
}

/** Owner must provision real extension keys before publishing. No test or invented key is trusted in production. */
export const BUNDLED_CATALOG_ROOT: CatalogRoot = Object.freeze({ type: "root", version: 1, threshold: 1, expires: "1970-01-01T00:00:00Z", keys: Object.freeze([]) });
