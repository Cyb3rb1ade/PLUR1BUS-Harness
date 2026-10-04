// Snapshot producer for cross-platform and container imports (§B.3, gap G6, owner decisions C7, C10).
// Provides native tree copying with bounded reads and manifest-based LanceDB consistency,
// and WSL tar stream extraction with strict path traversal, symlink escape and device protections.
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, normalize, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Flavour, flavourOf, locateSource, type Origin } from "./paths.ts";
import {
  copyFileBounded,
  envKeyNames,
  isSecretFileName,
  SQLITE_COPY_ATTEMPTS,
  SQLITE_COPY_LIMIT,
} from "./readonly.ts";
import { ImportError, type SourceType } from "./types.ts";
import { defaultWslRunner, type WslRunner } from "./wsl.ts";

export const DEFAULT_SNAPSHOT_MAX_BYTES = 512 * 1024 * 1024; // 512 MiB
export const DEFAULT_SNAPSHOT_MAX_FILES = 10_000;

export interface SnapshotFileInfo {
  path: string;
  size: number;
  sha256: string;
  mtimeMs?: number;
}

export interface SnapshotSqliteInfo {
  status: "copy" | "immutable" | "source-busy";
  attempts?: number;
  reason?: string;
}

export interface SnapshotMetadata {
  version: 1;
  source: string;
  sourceRoot: string;
  sourceHome?: string | null;
  origin: string;
  flavour: string;
  timestamp: string;
  files: SnapshotFileInfo[];
  sqlite: Record<string, SnapshotSqliteInfo>;
  envKeys: Record<string, string[]>;
}

export interface CreateSnapshotOptions {
  sourceType: SourceType;
  sourceRoot: string;
  home: string;
  origin?: Origin | undefined;
  flavour?: Flavour | undefined;
  distro?: string | undefined;
  subpaths?: string[] | undefined;
  allowLiveCopy?: boolean | undefined;
  maxBytes?: number | undefined;
  maxFiles?: number | undefined;
  stagingDir?: string | undefined;
  wslRunner?: WslRunner | undefined;
  timeoutMs?: number | undefined;
  platform?: NodeJS.Platform | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  homedir?: string | undefined;
  afterCopy?: ((attempt: number, copy: string) => void) | undefined;
  copyFile?: ((src: string, dst: string, limit: number) => void) | undefined;
}

export interface SnapshotResult {
  stagingDir: string;
  metadata: SnapshotMetadata;
}

export interface ExtractTarOptions {
  maxBytes?: number;
  maxFiles?: number;
  targetPlatform?: NodeJS.Platform;
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleepMs = (ms: number) => { Atomics.wait(sleeper, 0, 0, ms); };
const BACKOFF_MS = [50, 200, 800];

type Stamp = { size: number; mtimeMs: number } | null;
const stamp = (p: string): Stamp => {
  try {
    const st = statSync(p);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
};
const sameStamp = (a: Stamp, b: Stamp) => (a === null ? b === null : b !== null && a.size === b.size && a.mtimeMs === b.mtimeMs);

/** Computes the SHA-256 hex digest of a file. */
export function sha256File(path: string): string {
  const content = readFileSync(path);
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Tar stream extractor with strict security validations (§B.3):
 * - Rejects absolute paths and path traversal (`..`).
 * - Rejects symlinks whose resolved targets escape `stagingDir`.
 * - Rejects character devices, block devices, and FIFOs.
 * - Enforces total bytes and file count caps.
 * - On stream interruption / truncation or validation failure, removes `stagingDir` cleanly.
 */
export async function extractTarStream(
  input: Buffer | AsyncIterable<Buffer>,
  stagingDir: string,
  opts: ExtractTarOptions = {}
): Promise<{ filesCount: number; bytesCount: number }> {
  const maxBytes = opts.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES;
  const maxFiles = opts.maxFiles ?? DEFAULT_SNAPSHOT_MAX_FILES;
  const targetPlatform = opts.targetPlatform ?? process.platform;
  const absStaging = resolve(stagingDir);

  mkdirSync(absStaging, { recursive: true });

  let totalFiles = 0;
  let totalBytes = 0;

  try {
    const chunks: Buffer[] = [];
    if (Buffer.isBuffer(input)) {
      chunks.push(input);
    } else {
      for await (const chunk of input) {
        chunks.push(chunk);
        totalBytes += chunk.length;
        if (totalBytes > maxBytes + 16 * 1024 * 1024) {
          throw new ImportError("E_LIMIT_EXCEEDED", "too-large", `Tar stream exceeded max bytes limit (${maxBytes})`, 3);
        }
      }
    }
    const tarBuf = Buffer.isBuffer(input) ? input : Buffer.concat(chunks);
    let offset = 0;
    let nextPath: string | null = null;
    let nextLink: string | null = null;
    let zeroBlockCount = 0;

    totalBytes = 0; // Reset to track actual file payload bytes

    while (offset < tarBuf.length) {
      if (offset + 512 > tarBuf.length) {
        throw new ImportError("E_TAR_CORRUPT", "stream-truncated", "Incomplete tar block at end of stream", 3);
      }
      const header = tarBuf.subarray(offset, offset + 512);
      offset += 512;

      // Check for zero block (EOF)
      let isZero = true;
      for (let i = 0; i < 512; i++) {
        if (header[i] !== 0) {
          isZero = false;
          break;
        }
      }
      if (isZero) {
        zeroBlockCount++;
        if (zeroBlockCount >= 2) break; // Standard 2-block EOF marker
        continue;
      }
      zeroBlockCount = 0;

      // Parse header fields
      const rawName = readNullTerminatedAscii(header, 0, 100);
      const sizeStr = readNullTerminatedAscii(header, 124, 12).trim();
      const size = sizeStr ? parseInt(sizeStr, 8) : 0;
      if (isNaN(size) || size < 0) {
        throw new ImportError("E_TAR_CORRUPT", "invalid-size", `Invalid file size in tar header: ${sizeStr}`, 3);
      }

      const typeflagChar = String.fromCharCode(header[156]!);
      const rawLinkname = readNullTerminatedAscii(header, 157, 100);
      const prefix = readNullTerminatedAscii(header, 345, 155);

      const payloadBlocks = Math.ceil(size / 512);
      const payloadBytes = payloadBlocks * 512;
      if (offset + size > tarBuf.length) {
        throw new ImportError("E_TAR_CORRUPT", "stream-truncated", "Tar stream ended unexpectedly during entry payload", 3);
      }
      const payload = tarBuf.subarray(offset, offset + size);
      offset += payloadBytes;

      // Handle GNU / PAX extended attributes
      if (typeflagChar === "L") {
        nextPath = readNullTerminatedAscii(payload, 0, payload.length);
        continue;
      }
      if (typeflagChar === "K") {
        nextLink = readNullTerminatedAscii(payload, 0, payload.length);
        continue;
      }
      if (typeflagChar === "x" || typeflagChar === "g") {
        // PAX extended header
        const paxText = payload.toString("utf8");
        const paxRecords = parsePaxRecords(paxText);
        if (paxRecords.path) nextPath = paxRecords.path;
        if (paxRecords.linkpath) nextLink = paxRecords.linkpath;
        continue;
      }

      // Determine full entry name
      let entryPath = nextPath ?? (prefix ? `${prefix}/${rawName}` : rawName);
      let linkTarget = nextLink ?? rawLinkname;
      nextPath = null;
      nextLink = null;

      // Normalize entry path
      entryPath = entryPath.replace(/\\/g, "/");
      while (entryPath.startsWith("./")) entryPath = entryPath.slice(2);
      if (entryPath === "" || entryPath === ".") continue;

      // Security Check 1: No absolute paths
      if (entryPath.startsWith("/") || /^[a-zA-Z]:/.test(entryPath)) {
        throw new ImportError("E_TAR_SECURITY", "absolute-path", `Absolute path in tar entry is forbidden: ${entryPath}`, 3);
      }

      // Security Check 2: No path traversal (..)
      const segments = entryPath.split("/").filter(Boolean);
      if (segments.some((s) => s === "..")) {
        throw new ImportError("E_TAR_SECURITY", "path-traversal", `Path traversal ('..') in tar entry is forbidden: ${entryPath}`, 3);
      }

      const destPath = resolve(absStaging, entryPath);
      // Security Check 3: Must be inside staging dir
      if (!destPath.startsWith(absStaging + sep) && destPath !== absStaging) {
        throw new ImportError("E_TAR_SECURITY", "path-escape", `Path escapes staging directory: ${entryPath}`, 3);
      }

      // Security Check 4: No devices or FIFOs
      // '3': Character device, '4': Block device, '6': FIFO
      if (typeflagChar === "3" || typeflagChar === "4" || typeflagChar === "6") {
        throw new ImportError("E_TAR_SECURITY", "forbidden-device", `Device or FIFO entries in tar are forbidden: ${entryPath} (type ${typeflagChar})`, 3);
      }

      // Security Check 5: Symlinks must resolve inside stagingDir
      if (typeflagChar === "2") {
        if (!linkTarget) {
          throw new ImportError("E_TAR_CORRUPT", "missing-symlink-target", `Symlink entry has no target: ${entryPath}`, 3);
        }
        linkTarget = linkTarget.replace(/\\/g, "/");
        if (linkTarget.startsWith("/") || /^[a-zA-Z]:/.test(linkTarget)) {
          throw new ImportError("E_TAR_SECURITY", "symlink-escape", `Symlink with absolute target is forbidden: ${entryPath} -> ${linkTarget}`, 3);
        }
        const resolvedTarget = resolve(dirname(destPath), linkTarget);
        if (!resolvedTarget.startsWith(absStaging + sep) && resolvedTarget !== absStaging) {
          throw new ImportError("E_TAR_SECURITY", "symlink-escape", `Symlink escapes staging directory: ${entryPath} -> ${linkTarget}`, 3);
        }
        mkdirSync(dirname(destPath), { recursive: true });
        try {
          symlinkSync(linkTarget, destPath);
        } catch {
          // On environments without symlink privilege, write target path as marker
          writeFileSync(destPath, linkTarget, "utf8");
        }
        continue;
      }

      // Directory entry ('5' or ends with /)
      if (typeflagChar === "5" || entryPath.endsWith("/")) {
        mkdirSync(destPath, { recursive: true });
        continue;
      }

      // Regular file ('0' or '\0')
      totalFiles++;
      if (totalFiles > maxFiles) {
        throw new ImportError("E_LIMIT_EXCEEDED", "too-many-files", `Tar stream exceeded max file count (${maxFiles})`, 3);
      }
      totalBytes += size;
      if (totalBytes > maxBytes) {
        throw new ImportError("E_LIMIT_EXCEEDED", "too-large", `Tar stream exceeded max bytes limit (${maxBytes})`, 3);
      }

      mkdirSync(dirname(destPath), { recursive: true });
      writeFileSync(destPath, payload);
    }

    return { filesCount: totalFiles, bytesCount: totalBytes };
  } catch (err) {
    // On error, clean up staging dir immediately
    try {
      rmSync(absStaging, { recursive: true, force: true });
    } catch {}
    throw err;
  }
}

function readNullTerminatedAscii(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  const end = nul === -1 ? slice.length : nul;
  return slice.subarray(0, end).toString("utf8");
}

function parsePaxRecords(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < text.length) {
    const space = text.indexOf(" ", i);
    if (space === -1) break;
    const len = parseInt(text.slice(i, space), 10);
    if (isNaN(len) || len <= 0) break;
    const line = text.slice(space + 1, i + len - 1); // exclude trailing newline
    const eq = line.indexOf("=");
    if (eq > 0) {
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1);
      out[k] = v;
    }
    i += len;
  }
  return out;
}

/** Builds an in-memory tar buffer for tests. */
export function packTarBuffer(entries: { path: string; content?: Buffer | string; typeflag?: string; linkname?: string }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const typeflag = e.typeflag ?? (e.content !== undefined ? "0" : "5");
    const contentBuf = Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content ?? "");
    const size = typeflag === "0" ? contentBuf.length : 0;

    const header = Buffer.alloc(512);
    // name (0..100)
    const nameBytes = Buffer.from(e.path, "utf8");
    if (nameBytes.length <= 100) {
      nameBytes.copy(header, 0);
    } else {
      // PAX or prefix omitted for simple fixture generator
      nameBytes.subarray(0, 100).copy(header, 0);
    }
    // mode (100..108)
    Buffer.from("0000644\0").copy(header, 100);
    // uid, gid
    Buffer.from("0000000\0").copy(header, 108);
    Buffer.from("0000000\0").copy(header, 116);
    // size (124..136)
    Buffer.from(size.toString(8).padStart(11, "0") + "\0").copy(header, 124);
    // mtime (136..148)
    Buffer.from("00000000000\0").copy(header, 136);
    // typeflag (156)
    header[156] = typeflag.charCodeAt(0);
    // linkname (157..257)
    if (e.linkname) {
      Buffer.from(e.linkname, "utf8").copy(header, 157);
    }
    // magic & version
    Buffer.from("ustar\0").copy(header, 257);
    Buffer.from("00").copy(header, 263);

    // checksum
    header.fill(32, 148, 156);
    let chk = 0;
    for (let b = 0; b < 512; b++) chk += header[b]!;
    Buffer.from(chk.toString(8).padStart(6, "0") + "\0 ").copy(header, 148);

    blocks.push(header);
    if (size > 0) {
      blocks.push(contentBuf);
      const pad = 512 - (size % 512);
      if (pad < 512) blocks.push(Buffer.alloc(pad));
    }
  }
  // Two 512-byte zero blocks at end of archive
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/**
 * Copies a LanceDB table directory using manifest consistency (§B.5).
 * - Copies newest `_versions/*.manifest` first.
 * - Copies referenced data files.
 * - Re-checks that manifest remains newest.
 * - Retries up to 3 times on change; otherwise reports `source-busy` or throws.
 *
 * Out of scope:
 * 1. Remote or cloud-backed LanceDB storage (S3/GCS); only local disk tables are supported.
 * 2. Concurrent unindexed compaction that deletes fragments mid-copy without a table freeze.
 * 3. In-flight uncommitted transactions that have not yet written a `.manifest` file.
 */
export function copyLanceTableWithManifest(
  tableSrc: string,
  tableDst: string,
  opts: { allowLiveCopy?: boolean | undefined; maxBytes?: number | undefined }
): { success: boolean; attempts: number } {
  const versionsSrc = join(tableSrc, "_versions");
  if (!existsSync(versionsSrc)) {
    // Not a versioned Lance table; fallback to standard directory copy
    return { success: copyDirBounded(tableSrc, tableDst, opts.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES), attempts: 1 };
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) sleepMs(BACKOFF_MS[attempt - 2] ?? 800);
    const manifests = readdirSync(versionsSrc).filter((f) => f.endsWith(".manifest"));
    if (manifests.length === 0) break;

    manifests.sort((a, b) => {
      const na = parseInt(a.replace(".manifest", ""), 10) || 0;
      const nb = parseInt(b.replace(".manifest", ""), 10) || 0;
      return na - nb;
    });
    const newest = manifests[manifests.length - 1]!;
    const newestPath = join(versionsSrc, newest);
    const beforeStamp = stamp(newestPath);

    mkdirSync(join(tableDst, "_versions"), { recursive: true });
    copyFileBounded(newestPath, join(tableDst, "_versions", newest), opts.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES);

    // Copy remaining table files and subdirectories
    copyDirBounded(tableSrc, tableDst, opts.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES);

    // Re-check newest manifest
    const currentManifests = readdirSync(versionsSrc).filter((f) => f.endsWith(".manifest"));
    currentManifests.sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
    const currentNewest = currentManifests[currentManifests.length - 1]!;
    const afterStamp = stamp(newestPath);

    if (currentNewest === newest && sameStamp(beforeStamp, afterStamp)) {
      return { success: true, attempts: attempt };
    }
  }

  if (opts.allowLiveCopy) {
    throw new ImportError("E_SOURCE_BUSY", "source-busy", `LanceDB store ${tableSrc} kept changing while copied; stop the source and retry`, 3);
  }
  throw new ImportError("E_SOURCE_BUSY", "source-running", `LanceDB store ${tableSrc} is being written to; source must be stopped (C7)`, 3);
}

function copyDirBounded(src: string, dst: string, maxBytes: number): boolean {
  mkdirSync(dst, { recursive: true });
  const entries = readdirSync(src, { withFileTypes: true });
  for (const e of entries) {
    const srcPath = join(src, e.name);
    const dstPath = join(dst, e.name);
    if (e.isDirectory()) {
      copyDirBounded(srcPath, dstPath, maxBytes);
    } else if (e.isFile()) {
      copyFileBounded(srcPath, dstPath, maxBytes);
    }
  }
  return true;
}

/**
 * Creates a complete snapshot of a source installation (§B.3, G6).
 * Supports:
 * 1. Native directory trees: in-process bounded copier with manifest and SQLite retry guards.
 * 2. WSL sources: streamed tar generation via `wsl.exe` and safe extraction.
 * Emits `snapshot.json` with metadata, hashes, and SQLite statuses without leaking secrets.
 */
export async function createSnapshot(opts: CreateSnapshotOptions): Promise<SnapshotResult> {
  const platform = opts.platform ?? process.platform;
  const maxBytes = opts.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES;
  const maxFiles = opts.maxFiles ?? DEFAULT_SNAPSHOT_MAX_FILES;
  const runId = `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const stagingDir = opts.stagingDir ?? join(opts.home, "import", runId, "snapshot");

  mkdirSync(stagingDir, { recursive: true });

  const loc = locateSource({
    accessRoot: opts.sourceRoot,
    platform,
    env: opts.env ?? process.env,
    home: opts.homedir ?? null,
  });

  const isWsl = loc.origin.startsWith("wsl:") || opts.sourceRoot.startsWith("wsl:");
  const sqliteStatuses: Record<string, SnapshotSqliteInfo> = {};

  try {
    if (isWsl) {
      const distro = opts.distro ?? (loc.origin.startsWith("wsl:") ? loc.origin.slice(4) : "");
      if (!distro) {
        throw new ImportError("E_INVALID_PARAMS", "wsl-distro-missing", "WSL snapshot requires a distro name", 2);
      }
      const runner = opts.wslRunner ?? defaultWslRunner;
      const timeoutMs = opts.timeoutMs ?? 30_000;
      const subpaths = opts.subpaths && opts.subpaths.length ? opts.subpaths : ["."];
      const cmd = ["wsl.exe", "-d", distro, "--", "tar", "-C", loc.sourceRoot, "-cf", "-", ...subpaths];

      const res = await runner(cmd, { timeoutMs });
      if (res.exitCode !== 0) {
        throw new ImportError("E_IMPORT_FAILED", "wsl-tar-failed", `wsl.exe tar failed (exit ${res.exitCode}): ${res.stderr.toString("utf8")}`, 2);
      }
      await extractTarStream(res.stdout, stagingDir, { maxBytes, maxFiles, targetPlatform: platform });
    } else {
      // Native copier
      const absSrc = resolve(opts.sourceRoot);
      copyNativeTree(absSrc, stagingDir, {
        allowLiveCopy: opts.allowLiveCopy,
        maxBytes,
        sqliteStatuses,
        afterCopy: opts.afterCopy,
        copyFile: opts.copyFile,
      });
    }

    // Inspect files and generate snapshot.json
    const metadata = generateSnapshotMetadata({
      sourceRoot: loc.sourceRoot,
      source: opts.sourceRoot,
      origin: loc.origin,
      flavour: loc.flavour,
      sourceHome: loc.sourceHome,
      stagingDir,
      sqliteStatuses,
    });

    writeFileSync(join(stagingDir, "snapshot.json"), JSON.stringify(metadata, null, 2) + "\n", "utf8");
    return { stagingDir, metadata };
  } catch (err) {
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {}
    throw err;
  }
}

function copyNativeTree(
  srcDir: string,
  dstDir: string,
  opts: {
    allowLiveCopy?: boolean | undefined;
    maxBytes: number;
    sqliteStatuses: Record<string, SnapshotSqliteInfo>;
    afterCopy?: ((attempt: number, copy: string) => void) | undefined;
    copyFile?: ((src: string, dst: string, limit: number) => void) | undefined;
  }
): void {
  mkdirSync(dstDir, { recursive: true });
  const entries = readdirSync(srcDir, { withFileTypes: true });

  for (const e of entries) {
    const srcPath = join(srcDir, e.name);
    const dstPath = join(dstDir, e.name);

    if (e.isDirectory()) {
      if (e.name === "_versions" || existsSync(join(srcPath, "_versions"))) {
        // LanceDB table directory
        copyLanceTableWithManifest(srcPath, dstPath, { allowLiveCopy: opts.allowLiveCopy, maxBytes: opts.maxBytes });
      } else {
        copyNativeTree(srcPath, dstPath, opts);
      }
    } else if (e.isFile()) {
      const isSqlite = e.name.endsWith(".sqlite") || e.name.endsWith(".db");
      if (isSqlite) {
        copySqliteFile(srcPath, dstPath, opts);
      } else {
        const doCopy = opts.copyFile ?? copyFileBounded;
        doCopy(srcPath, dstPath, opts.maxBytes);
      }
    }
  }
}

function copySqliteFile(
  src: string,
  dst: string,
  opts: {
    allowLiveCopy?: boolean | undefined;
    maxBytes: number;
    sqliteStatuses: Record<string, SnapshotSqliteInfo>;
    afterCopy?: ((attempt: number, copy: string) => void) | undefined;
    copyFile?: ((src: string, dst: string, limit: number) => void) | undefined;
  }
): void {
  const walSrc = `${src}-wal`;
  const walDst = `${dst}-wal`;
  const hasWal = existsSync(walSrc);

  let success = false;
  let attempts = 0;
  const doCopy = opts.copyFile ?? copyFileBounded;

  for (let a = 1; a <= SQLITE_COPY_ATTEMPTS; a++) {
    attempts = a;
    if (a > 1) sleepMs(BACKOFF_MS[a - 2] ?? 800);

    const beforeSrc = stamp(src);
    const beforeWal = hasWal ? stamp(walSrc) : null;

    doCopy(src, dst, opts.maxBytes);
    if (hasWal) doCopy(walSrc, walDst, opts.maxBytes);

    opts.afterCopy?.(a, dst);

    const afterSrc = stamp(src);
    const afterWal = hasWal ? stamp(walSrc) : null;

    if (!sameStamp(beforeSrc, afterSrc) || !sameStamp(beforeWal, afterWal)) {
      continue;
    }

    // Verify quick_check
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dst);
      const check = db.prepare("PRAGMA quick_check").all() as Record<string, unknown>[];
      if (check.length === 1 && Object.values(check[0]!)[0] === "ok") {
        success = true;
        break;
      }
    } catch {
      // Retry
    } finally {
      try { db?.close(); } catch {}
    }
  }

  const rel = basename(src);
  if (success) {
    opts.sqliteStatuses[rel] = { status: "copy", attempts };
  } else if (opts.allowLiveCopy) {
    opts.sqliteStatuses[rel] = { status: "source-busy", attempts, reason: "changed during copy" };
  } else {
    throw new ImportError("E_SOURCE_BUSY", "source-running", `SQLite database ${src} changed while copying; stop the source or pass --allow-live-copy (C7)`, 3);
  }
}

function generateSnapshotMetadata(o: {
  source?: string;
  sourceRoot: string;
  origin: string;
  flavour: string;
  sourceHome?: string | null;
  stagingDir: string;
  sqliteStatuses: Record<string, SnapshotSqliteInfo>;
}): SnapshotMetadata {
  const files: SnapshotFileInfo[] = [];
  const envKeys: Record<string, string[]> = {};

  function scan(dir: string) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.name === "snapshot.json" && dir === o.stagingDir) continue;
      if (e.isDirectory()) {
        scan(full);
      } else if (e.isFile()) {
        const rel = relative(o.stagingDir, full).replace(/\\/g, "/");
        const st = statSync(full);
        const hash = sha256File(full);
        files.push({ path: rel, size: st.size, sha256: hash, mtimeMs: st.mtimeMs });

        if (e.name === ".env" || e.name.startsWith(".env.")) {
          envKeys[rel] = envKeyNames(full);
        }
      }
    }
  }

  scan(o.stagingDir);
  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    version: 1,
    source: o.source ?? o.sourceRoot,
    sourceRoot: o.sourceRoot,
    sourceHome: o.sourceHome ?? null,
    origin: o.origin,
    flavour: o.flavour,
    timestamp: new Date().toISOString(),
    files,
    sqlite: o.sqliteStatuses,
    envKeys,
  };
}
