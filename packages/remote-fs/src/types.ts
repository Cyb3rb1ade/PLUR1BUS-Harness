/** Public read-only filesystem contract for source discovery and snapshots (M v2, E1). */
export interface FsStat {
  readonly type: "file" | "directory" | "symlink" | "other";
  readonly size: number;
  /** Portable permission bits, when the backend supplies them. */
  readonly mode?: number;
  readonly mtimeMs?: number;
}

/** No write, shell, raw-client or descriptor escape hatch is exposed by this port. */
export interface ReadonlyFs {
  stat(path: string): Promise<FsStat>;
  lstat(path: string): Promise<FsStat>;
  readdir(path: string): Promise<readonly string[]>;
  readFile(path: string, maxBytes: number): Promise<Buffer>;
  realpath(path: string): Promise<string>;
  readlink(path: string): Promise<string>;
}

/** Limits apply to the entire run, including repeated reads of the same file. */
export interface FsLimits {
  timeoutMs: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxDepth: number;
  maxEntries: number;
}

/** Fixed reasons omit source contents and backend error messages. */
export class RemoteFsError extends Error {
  readonly reason: "aborted" | "timeout" | "file-limit" | "total-limit" | "depth-limit" |
    "entry-limit" | "path-denied" | "unsupported-type" | "not-found" | "unavailable" | "invalid-limit" |
    "worker-untrusted" | "host-key-mismatch" | "authentication-failed" | "limit-exceeded" | "remote-protocol" |
    "permission-denied";
  constructor(reason: RemoteFsError["reason"]) {
    super(`remote-fs: ${reason}`);
    this.name = "RemoteFsError";
    this.reason = reason;
  }
}

/** Conservative defaults; callers may choose explicit finite budgets for a larger snapshot. */
export const DEFAULT_FS_LIMITS: Readonly<FsLimits> = Object.freeze({
  timeoutMs: 60_000,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxDepth: 32,
  maxEntries: 16_384,
});
