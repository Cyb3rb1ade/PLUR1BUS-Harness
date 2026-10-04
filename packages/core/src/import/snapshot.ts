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
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Flavour, locateSource, type Origin } from "./paths.ts";
import {
  copyFileBounded,
  envKeyNames,
  SQLITE_COPY_ATTEMPTS,
} from "./readonly.ts";
import { ImportError, type SourceType } from "./types.ts";
import { defaultWslRunner, spawnWslTarStream, type WslRunner } from "./wsl.ts";

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

async function* toAsyncChunks(input: Buffer | AsyncIterable<Buffer>): AsyncIterable<Buffer> {
  if (Buffer.isBuffer(input)) {
    yield input;
  } else {
    for await (const chunk of input) {
      yield chunk;
    }
  }
}

class TarStreamReader {
  private chunks: AsyncIterator<Buffer>;
  private buf: Buffer = Buffer.alloc(0);
  private done = false;
  public totalStreamBytes = 0;
  private maxBytes: number;

  constructor(source: AsyncIterable<Buffer>, maxBytes: number) {
    this.chunks = source[Symbol.asyncIterator]();
    this.maxBytes = maxBytes;
  }

  async read(needed: number): Promise<Buffer | null> {
    while (this.buf.length < needed && !this.done) {
      const next = await this.chunks.next();
      if (next.done) {
        this.done = true;
        break;
      }
      this.totalStreamBytes += next.value.length;
      if (this.totalStreamBytes > this.maxBytes + 16 * 1024 * 1024) {
        throw new ImportError("E_LIMIT_EXCEEDED", "too-large", `Tar stream exceeded max bytes limit (${this.maxBytes})`, 3);
      }
      this.buf = this.buf.length === 0 ? next.value : Buffer.concat([this.buf, next.value]);
    }
    if (this.buf.length < needed) {
      return null;
    }
    const out = this.buf.subarray(0, needed);
    this.buf = this.buf.subarray(needed);
    return out;
  }

  async drainToFile(fd: number, size: number, onBytes: (n: number) => void): Promise<void> {
    let remaining = size;
    while (remaining > 0) {
      if (this.buf.length === 0) {
        const next = await this.chunks.next();
        if (next.done) {
          throw new ImportError("E_TAR_CORRUPT", "stream-truncated", "Tar stream ended unexpectedly during entry payload", 3);
        }
        this.totalStreamBytes += next.value.length;
        if (this.totalStreamBytes > this.maxBytes + 16 * 1024 * 1024) {
          throw new ImportError("E_LIMIT_EXCEEDED", "too-large", `Tar stream exceeded max bytes limit (${this.maxBytes})`, 3);
        }
        this.buf = next.value;
      }
      const take = Math.min(this.buf.length, remaining);
      const slice = this.buf.subarray(0, take);
      this.buf = this.buf.subarray(take);
      writeSync(fd, slice);
      remaining -= take;
      onBytes(take);
    }
  }

  async skip(bytes: number): Promise<void> {
    let remaining = bytes;
    while (remaining > 0) {
      if (this.buf.length === 0) {
        const next = await this.chunks.next();
        if (next.done) {
          throw new ImportError("E_TAR_CORRUPT", "stream-truncated", "Tar stream ended unexpectedly during padding", 3);
        }
        this.totalStreamBytes += next.value.length;
        this.buf = next.value;
      }
      const take = Math.min(this.buf.length, remaining);
      this.buf = this.buf.subarray(take);
      remaining -= take;
    }
  }
}

/**
 * Tar stream extractor with strict security and integrity validations (§B.3, C1, I1, I2):
 * - Verifies 8-byte header checksum.
 * - Requires standard two 512-byte zero block EOF marker.
 * - Rejects all symlinks (typeflag '2') and hardlinks (typeflag '1') to prevent directory escapes.
 * - Rejects absolute paths, path traversal ('..'), UNC and Windows drive letters.
 * - Rejects character devices, block devices, and FIFOs.
 * - Refuses unsupported or unknown typeflags.
 * - Streams chunks incrementally to disk, enforcing byte and file limits live.
 * - On stream truncation, integrity failure, or limit breach, removes stagingDir cleanly.
 */
export async function extractTarStream(
  input: Buffer | AsyncIterable<Buffer>,
  stagingDir: string,
  opts: ExtractTarOptions = {}
): Promise<{ filesCount: number; bytesCount: number }> {
  const maxBytes = opts.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES;
  const maxFiles = opts.maxFiles ?? DEFAULT_SNAPSHOT_MAX_FILES;
  const absStaging = resolve(stagingDir);

  mkdirSync(absStaging, { recursive: true, mode: 0o700 });

  let totalFiles = 0;
  let totalBytes = 0;

  try {
    const reader = new TarStreamReader(toAsyncChunks(input), maxBytes);
    let nextPath: string | null = null;
    let nextLink: string | null = null;
    let zeroBlockCount = 0;

    while (true) {
      const header = await reader.read(512);
      if (header === null) {
        if (zeroBlockCount < 2) {
          throw new ImportError("E_TAR_CORRUPT", "stream-truncated", "Tar stream ended without standard EOF zero blocks", 3);
        }
        break;
      }

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
        if (zeroBlockCount >= 2) {
          break; // Standard 2-block EOF marker reached
        }
        continue;
      }
      zeroBlockCount = 0;

      // Verify header checksum (I1)
      let unsignedSum = 0;
      let signedSum = 0;
      for (let i = 0; i < 512; i++) {
        const b = (i >= 148 && i < 156) ? 32 : header[i]!;
        unsignedSum += b;
        signedSum += (b > 127 ? b - 256 : b);
      }
      const chkStr = readNullTerminatedAscii(header, 148, 8).trim();
      const expectedChk = parseInt(chkStr, 8);
      if (isNaN(expectedChk) || (unsignedSum !== expectedChk && signedSum !== expectedChk)) {
        throw new ImportError("E_TAR_CORRUPT", "invalid-checksum", `Tar header checksum mismatch: expected ${chkStr}, got ${unsignedSum}`, 3);
      }

      // Parse header fields
      const rawName = readNullTerminatedAscii(header, 0, 100);
      const sizeStr = readNullTerminatedAscii(header, 124, 12).trim();
      let size = 0;
      if (sizeStr) {
        if (!/^[0-7]+$/.test(sizeStr)) {
          throw new ImportError("E_TAR_CORRUPT", "invalid-size", `Invalid file size in tar header: ${sizeStr}`, 3);
        }
        size = parseInt(sizeStr, 8);
        if (isNaN(size) || size < 0) {
          throw new ImportError("E_TAR_CORRUPT", "invalid-size", `Invalid file size in tar header: ${sizeStr}`, 3);
        }
      }

      const typeflagChar = String.fromCharCode(header[156]!);
      const rawLinkname = readNullTerminatedAscii(header, 157, 100);
      const magic = readNullTerminatedAscii(header, 257, 6);
      const prefix = magic.startsWith("ustar") ? readNullTerminatedAscii(header, 345, 155) : "";

      // Typeflag security whitelist (C1, I1):
      // Symlinks ('2') and hardlinks ('1') are strictly forbidden
      if (typeflagChar === "1") {
        throw new ImportError("E_TAR_SECURITY", "hardlink-forbidden", `Hardlink entries in tar archives are forbidden: ${rawName}`, 3);
      }
      if (typeflagChar === "2") {
        throw new ImportError("E_TAR_SECURITY", "symlink-forbidden", `Symlink entries in tar archives are forbidden: ${rawName}`, 3);
      }
      if (typeflagChar === "3" || typeflagChar === "4" || typeflagChar === "6") {
        throw new ImportError("E_TAR_SECURITY", "forbidden-device", `Device or FIFO entries in tar are forbidden: ${rawName} (type ${typeflagChar})`, 3);
      }
      if (
        typeflagChar !== "0" &&
        typeflagChar !== "\0" &&
        typeflagChar !== "5" &&
        typeflagChar !== "x" &&
        typeflagChar !== "g" &&
        typeflagChar !== "L" &&
        typeflagChar !== "K"
      ) {
        throw new ImportError("E_TAR_SECURITY", "unsupported-typeflag", `Unsupported tar entry typeflag '${typeflagChar}': ${rawName}`, 3);
      }

      // Handle GNU long names / links and PAX headers
      if (typeflagChar === "L" || typeflagChar === "K" || typeflagChar === "x" || typeflagChar === "g") {
        const payloadBuf = await reader.read(size);
        if (payloadBuf === null) {
          throw new ImportError("E_TAR_CORRUPT", "stream-truncated", "Tar stream ended unexpectedly during extended header", 3);
        }
        const pad = (512 - (size % 512)) % 512;
        if (pad > 0) await reader.skip(pad);

        if (typeflagChar === "L") {
          nextPath = readNullTerminatedAscii(payloadBuf, 0, payloadBuf.length);
        } else if (typeflagChar === "K") {
          nextLink = readNullTerminatedAscii(payloadBuf, 0, payloadBuf.length);
        } else if (typeflagChar === "x" || typeflagChar === "g") {
          const paxRecords = parsePaxRecords(payloadBuf);
          if (paxRecords.path) nextPath = paxRecords.path;
          if (paxRecords.linkpath) nextLink = paxRecords.linkpath;
        }
        continue;
      }

      // Determine full entry name
      let entryPath = nextPath ?? (prefix ? `${prefix}/${rawName}` : rawName);
      nextPath = null;
      nextLink = null;

      // Normalize entry path
      entryPath = entryPath.replace(/\\/g, "/");
      while (entryPath.startsWith("./")) entryPath = entryPath.slice(2);
      if (entryPath === "" || entryPath === ".") continue;

      // Security Check 1: No absolute paths
      if (entryPath.startsWith("/") || /^[a-zA-Z]:/.test(entryPath) || entryPath.startsWith("\\\\")) {
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

      // Directory entry ('5' or ends with /)
      if (typeflagChar === "5" || entryPath.endsWith("/")) {
        mkdirSync(destPath, { recursive: true });
        const pad = (512 - (size % 512)) % 512;
        if (pad > 0) await reader.skip(pad);
        continue;
      }

      // Regular file ('0' or '\0')
      totalFiles++;
      if (totalFiles > maxFiles) {
        throw new ImportError("E_LIMIT_EXCEEDED", "too-many-files", `Tar stream exceeded max file count (${maxFiles})`, 3);
      }

      mkdirSync(dirname(destPath), { recursive: true });
      const fd = openSync(destPath, "w", 0o600);
      try {
        await reader.drainToFile(fd, size, (n) => {
          totalBytes += n;
          if (totalBytes > maxBytes) {
            throw new ImportError("E_LIMIT_EXCEEDED", "too-large", `Tar stream exceeded max bytes limit (${maxBytes})`, 3);
          }
        });
      } finally {
        try { closeSync(fd); } catch {}
      }

      const pad = (512 - (size % 512)) % 512;
      if (pad > 0) await reader.skip(pad);
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

function parsePaxRecords(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  while (offset < buf.length) {
    const spaceIdx = buf.indexOf(32, offset); // space character
    if (spaceIdx === -1) break;
    const lenStr = buf.subarray(offset, spaceIdx).toString("ascii");
    const len = parseInt(lenStr, 10);
    if (isNaN(len) || len <= 0 || offset + len > buf.length) break;
    const recordBuf = buf.subarray(spaceIdx + 1, offset + len);
    const newlineOffset = recordBuf.indexOf(10); // newline
    const effectiveBuf = newlineOffset >= 0 ? recordBuf.subarray(0, newlineOffset) : recordBuf;
    const line = effectiveBuf.toString("utf8");
    const eq = line.indexOf("=");
    if (eq > 0) {
      out[line.slice(0, eq).trim()] = line.slice(eq + 1);
    }
    offset += len;
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

const U64_MAX = (2n ** 64n) - 1n;

/** Parses a LanceDB manifest version: handles Lance V2 inverted u64 format (u64::MAX - version) and V1 integers (I4). */
export function parseLanceManifestVersion(filename: string): bigint {
  const base = filename.replace(/\.manifest$/, "");
  try {
    const val = BigInt(base);
    if (val > (1n << 62n)) {
      return U64_MAX - val;
    }
    return val;
  } catch {
    return -1n;
  }
}

/**
 * Copies a LanceDB table directory using manifest consistency (§B.5, I4).
 * - Determines the newest version correctly using Lance manifest naming (inverted u64 or sequential).
 * - Copies newest `_versions/*.manifest` first.
 * - Copies table directory contents.
 * - Re-checks that manifest remains newest and unmodified.
 * - Retries up to 3 times on change; otherwise reports `source-busy` or throws.
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
      const va = parseLanceManifestVersion(a);
      const vb = parseLanceManifestVersion(b);
      return va < vb ? -1 : va > vb ? 1 : 0;
    });
    const newest = manifests[manifests.length - 1]!;
    const newestPath = join(versionsSrc, newest);
    const beforeStamp = stamp(newestPath);

    mkdirSync(join(tableDst, "_versions"), { recursive: true });
    copyFileBounded(newestPath, join(tableDst, "_versions", newest), opts.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES);

    // Copy table files and subdirectories
    copyDirBounded(tableSrc, tableDst, opts.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES);

    // Re-check newest manifest
    const currentManifests = readdirSync(versionsSrc).filter((f) => f.endsWith(".manifest"));
    currentManifests.sort((a, b) => {
      const va = parseLanceManifestVersion(a);
      const vb = parseLanceManifestVersion(b);
      return va < vb ? -1 : va > vb ? 1 : 0;
    });
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

/** Checks whether a source root has an active running process or lock (B.5, C7). */
export function isSourceRunning(root: string): { running: boolean; pid?: number; reason?: string } {
  const pidFiles = [
    "gateway.pid",
    "gateway.lock",
    ".gateway.pid",
    "openclaw.pid",
    "hermes.pid",
    join("state", "gateway.pid"),
    join("state", "openclaw.pid"),
  ];
  for (const rel of pidFiles) {
    const p = join(root, rel);
    if (existsSync(p)) {
      try {
        const text = readFileSync(p, "utf8").trim();
        const m = /"pid"\s*:\s*(\d+)/.exec(text) ?? /^(\d+)/.exec(text);
        if (m) {
          const pid = parseInt(m[1]!, 10);
          if (pid > 0 && isProcessAlive(pid)) {
            return { running: true, pid, reason: `live process ${pid} from ${rel}` };
          }
        }
      } catch {}
    }
  }
  return { running: false };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
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

  // Create staging directory with restricted permissions (0700, M1)
  mkdirSync(stagingDir, { recursive: true, mode: 0o700 });

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
      if (!distro || /[\/\\:\0\r\n]/.test(distro) || distro.startsWith("-")) {
        throw new ImportError("E_INVALID_PARAMS", "invalid-distro-name", `Invalid WSL distro name: ${distro}`, 2);
      }
      const timeoutMs = opts.timeoutMs ?? 30_000;
      const subpaths = opts.subpaths && opts.subpaths.length ? opts.subpaths : ["."];
      for (const p of subpaths) {
        if (p.startsWith("-")) {
          throw new ImportError("E_TAR_SECURITY", "invalid-subpath", `Subpath cannot start with '-': ${p}`, 3);
        }
        if (p.includes("\0")) {
          throw new ImportError("E_TAR_SECURITY", "invalid-subpath", "Subpath cannot contain NUL byte", 3);
        }
      }

      const runner = opts.wslRunner;
      if (runner) {
        // Custom or test runner path
        const checkCmd = [
          "wsl.exe",
          "-d",
          distro,
          "--exec",
          "sh",
          "-c",
          `if [ -f "${loc.sourceRoot}/gateway.pid" ] && kill -0 $(cat "${loc.sourceRoot}/gateway.pid" 2>/dev/null) 2>/dev/null; then echo running; elif [ -f "${loc.sourceRoot}/openclaw.pid" ] && kill -0 $(cat "${loc.sourceRoot}/openclaw.pid" 2>/dev/null) 2>/dev/null; then echo running; fi`
        ];
        const checkRes = await runner(checkCmd, { timeoutMs: 5000 }).catch(() => null);
        const isRunning = checkRes && checkRes.exitCode === 0 && checkRes.stdout.toString("utf8").trim() === "running";
        if (isRunning && !opts.allowLiveCopy) {
          throw new ImportError("E_SOURCE_BUSY", "source-running", "WSL source is currently running; stop the source or pass --allow-live-copy (C7)", 3);
        }

        const cmd = ["wsl.exe", "-d", distro, "--exec", "tar", "-h", "-C", loc.sourceRoot, "-cf", "-", "--", ...subpaths];
        const res = await runner(cmd, { timeoutMs });
        if (res.exitCode !== 0) {
          throw new ImportError("E_IMPORT_FAILED", "wsl-tar-failed", `wsl.exe tar failed (exit ${res.exitCode}): ${res.stderr.toString("utf8")}`, 2);
        }
        await extractTarStream(res.stdout, stagingDir, { maxBytes, maxFiles, targetPlatform: platform });
      } else {
        // Production streaming runner path (I2, I5)
        const tarProcess = spawnWslTarStream(distro, loc.sourceRoot, subpaths, { timeoutMs });
        try {
          await extractTarStream(tarProcess.stream, stagingDir, { maxBytes, maxFiles, targetPlatform: platform });
        } catch (err) {
          tarProcess.abort();
          throw err;
        }
      }
    } else {
      // Native copier
      const absSrc = resolve(opts.sourceRoot);
      const runCheck = isSourceRunning(absSrc);
      if (runCheck.running && !opts.allowLiveCopy) {
        throw new ImportError("E_SOURCE_BUSY", "source-running", `Source is currently running (${runCheck.reason}); stop the source or pass --allow-live-copy (C7)`, 3);
      }

      copyNativeTree(absSrc, stagingDir, stagingDir, {
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
  stagingRoot: string,
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
        copyNativeTree(srcPath, dstPath, stagingRoot, opts);
      }
    } else if (e.isFile()) {
      if (e.name.endsWith("-wal") || e.name.endsWith("-shm")) {
        // WAL and SHM files are copied alongside their parent database in copySqliteFile
        continue;
      }
      const isSqlite = e.name.endsWith(".sqlite") || e.name.endsWith(".db");
      if (isSqlite) {
        const rel = relative(stagingRoot, dstPath).replace(/\\/g, "/");
        copySqliteFile(srcPath, dstPath, rel, opts);
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
  relPath: string,
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
  const shmSrc = `${src}-shm`;
  const shmDst = `${dst}-shm`;

  let success = false;
  let attempts = 0;
  const doCopy = opts.copyFile ?? copyFileBounded;

  for (let a = 1; a <= SQLITE_COPY_ATTEMPTS; a++) {
    attempts = a;
    if (a > 1) sleepMs(BACKOFF_MS[a - 2] ?? 800);

    const hasWal = existsSync(walSrc);
    const hasShm = existsSync(shmSrc);
    const beforeSrc = stamp(src);
    const beforeWal = hasWal ? stamp(walSrc) : null;
    const beforeShm = hasShm ? stamp(shmSrc) : null;

    doCopy(src, dst, opts.maxBytes);
    if (hasWal) doCopy(walSrc, walDst, opts.maxBytes);
    if (hasShm) doCopy(shmSrc, shmDst, opts.maxBytes);

    opts.afterCopy?.(a, dst);

    const afterSrc = stamp(src);
    const afterWal = hasWal ? stamp(walSrc) : null;
    const afterShm = hasShm ? stamp(shmSrc) : null;

    if (!sameStamp(beforeSrc, afterSrc) || !sameStamp(beforeWal, afterWal) || !sameStamp(beforeShm, afterShm)) {
      continue;
    }

    // Verify quick_check in readOnly mode so quick_check doesn't checkpoint into copy
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dst, { readOnly: true });
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

  if (success) {
    opts.sqliteStatuses[relPath] = { status: "copy", attempts };
  } else if (opts.allowLiveCopy) {
    try { rmSync(dst, { force: true }); } catch {}
    try { rmSync(walDst, { force: true }); } catch {}
    try { rmSync(shmDst, { force: true }); } catch {}
    opts.sqliteStatuses[relPath] = { status: "source-busy", attempts, reason: "changed during copy" };
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
