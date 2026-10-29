/** Reusable read-only source access; the package has no Core dependency. */
export { createLocalFs, type LocalFsOptions } from "./local.ts";
export { DEFAULT_FS_LIMITS, RemoteFsError, type FsLimits, type FsStat, type ReadonlyFs } from "./types.ts";
export { createSftpFs, probeSftpHostKey, type ProbeOptions, type SftpOptions, type SftpSession } from "./sftp.ts";
export type { VerifiedWorker, VettedEndpoint, PrivateKeyLease } from "./worker.ts";
