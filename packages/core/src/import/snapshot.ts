// Snapshot producer for cross-platform and container imports (§B.3, gap G6, owner decisions C7, C10).
// Provides native tree copying with bounded reads and manifest-based LanceDB consistency,
// and WSL tar stream extraction with strict path traversal, symlink escape and device protections.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { type Flavour, locateSource, type Origin } from "./paths.ts";
import {
  copyFileBounded,
  envKeyNames,
  isSecretFileName,
  SQLITE_COPY_ATTEMPTS,
} from "./readonly.ts";
import { ImportError, type SourceType } from "./types.ts";
import { defaultWslRunner, listWslDistros, spawnWslTarStream, type SpawnWslTarStreamOptions, validateAndNormalizeSubpaths, type WslRunner } from "./wsl.ts";

export const DEFAULT_SNAPSHOT_MAX_BYTES = 512 * 1024 * 1024; // 512 MiB
export const DEFAULT_SNAPSHOT_MAX_FILES = 10_000;

export interface SnapshotFileInfo {
  path: string;
  size: number;
  sha256: string;
  mtimeMs?: number;
}

export interface SnapshotSqliteInfo {
  status: "copy" | "copy-live-unverified" | "source-busy";
  attempts?: number;
  reason?: string;
}

export interface SnapshotLanceInfo {
  status: "copy" | "source-busy";
  attempts?: number;
  reason?: string;
}

export interface SnapshotMetadata {
  version: 1;
  source: string;
  sourceRoot: string;
  sourceHome?: string | null | undefined;
  origin: string;
  flavour: string;
  timestamp: string;
  files: SnapshotFileInfo[];
  sqlite: Record<string, SnapshotSqliteInfo>;
  lancedb?: Record<string, SnapshotLanceInfo> | undefined;
  skippedLinks?: string[] | undefined;
  skippedFiles?: Array<{ path: string; reason: string }>;
  omittedCredentials?: string[];
  envKeys: Record<string, string[]>;
  liveCopy?: boolean | undefined;
  tarWarnings?: number | undefined;
}

export interface CreateSnapshotOptions {
  sourceType: SourceType;
  sourceRoot?: string | undefined;
  source?: string | undefined;
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
  wslSpawn?: typeof spawn | undefined;
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
      try {
        writeSync(fd, slice);
      } catch (err) {
        if (err instanceof ImportError) throw err;
        const e = err as NodeJS.ErrnoException;
        throw new ImportError("E_IMPORT_FAILED", e.code ? `fs-${e.code.toLowerCase()}` : "fs-error", `Failed to write destination file: ${e.message}`, 3);
      }
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
        if (this.totalStreamBytes > this.maxBytes + 16 * 1024 * 1024) {
          throw new ImportError("E_LIMIT_EXCEEDED", "too-large", `Tar stream exceeded max bytes limit (${this.maxBytes})`, 3);
        }
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

  try {
    mkdirSync(absStaging, { recursive: true, mode: 0o700 });
  } catch (err) {
    if (err instanceof ImportError) throw err;
    const e = err as NodeJS.ErrnoException;
    throw new ImportError("E_IMPORT_FAILED", e.code ? `fs-${e.code.toLowerCase()}` : "fs-error", `Failed to create staging directory: ${e.message}`, 3);
  }

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
        if (size > 1024 * 1024) {
          throw new ImportError("E_TAR_SECURITY", "header-too-large", `Extended tar header payload exceeds 1 MiB (${size} bytes): ${rawName}`, 3);
        }
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

      if (entryPath.includes("\0")) {
        throw new ImportError("E_TAR_SECURITY", "invalid-path", "Tar entry path contains NUL byte", 3);
      }

      // Security Check 1: No absolute paths
      if (entryPath.startsWith("/") || /^[a-zA-Z]:/.test(entryPath) || entryPath.startsWith("\\\\")) {
        throw new ImportError("E_TAR_SECURITY", "absolute-path", `Absolute path in tar entry is forbidden: ${entryPath}`, 3);
      }

      // Security Check 2: No path traversal (..)
      const segments = entryPath.split("/").filter(Boolean);
      if (segments.some((s) => s === "..")) {
        throw new ImportError("E_TAR_SECURITY", "path-traversal", `Path traversal ('..') in tar entry is forbidden: ${entryPath}`, 3);
      }

      const targetPlatform = opts.targetPlatform ?? process.platform;
      if (targetPlatform === "win32") {
        for (const seg of segments) {
          if (seg.includes(":")) {
            throw new ImportError("E_TAR_SECURITY", "unportable-name", `Entry segment contains forbidden character ':': ${entryPath}`, 3);
          }
          if (seg.endsWith(".") || seg.endsWith(" ")) {
            throw new ImportError("E_TAR_SECURITY", "unportable-name", `Entry segment has trailing dot or space: ${entryPath}`, 3);
          }
          if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i.test(seg)) {
            throw new ImportError("E_TAR_SECURITY", "unportable-name", `Entry segment is a reserved Windows device name: ${entryPath}`, 3);
          }
        }
      }

      const destPath = resolve(absStaging, entryPath);
      // Security Check 3: Must be inside staging dir
      if (!destPath.startsWith(absStaging + sep) && destPath !== absStaging) {
        throw new ImportError("E_TAR_SECURITY", "path-escape", `Path escapes staging directory: ${entryPath}`, 3);
      }

      // Directory entry ('5' or ends with /)
      if (typeflagChar === "5" || entryPath.endsWith("/")) {
        totalFiles++;
        if (totalFiles > maxFiles) {
          throw new ImportError("E_LIMIT_EXCEEDED", "too-many-files", `Tar stream exceeded max file count (${maxFiles})`, 3);
        }
        try {
          mkdirSync(destPath, { recursive: true });
        } catch (err) {
          if (err instanceof ImportError) throw err;
          const e = err as NodeJS.ErrnoException;
          throw new ImportError("E_IMPORT_FAILED", e.code ? `fs-${e.code.toLowerCase()}` : "fs-error", `Failed to create directory: ${e.message}`, 3);
        }
        if (size > 0) {
          await reader.skip(size);
        }
        const pad = (512 - (size % 512)) % 512;
        if (pad > 0) await reader.skip(pad);
        continue;
      }

      // Regular file ('0' or '\0')
      totalFiles++;
      if (totalFiles > maxFiles) {
        throw new ImportError("E_LIMIT_EXCEEDED", "too-many-files", `Tar stream exceeded max file count (${maxFiles})`, 3);
      }

      let fd: number;
      try {
        mkdirSync(dirname(destPath), { recursive: true });
        fd = openSync(destPath, "w", 0o600);
      } catch (err) {
        if (err instanceof ImportError) throw err;
        const e = err as NodeJS.ErrnoException;
        throw new ImportError("E_IMPORT_FAILED", e.code ? `fs-${e.code.toLowerCase()}` : "fs-error", `Failed to open destination file: ${e.message}`, 3);
      }
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
  try { return new TextDecoder("utf-8", { fatal: true }).decode(slice.subarray(0, end)); }
  catch { throw new ImportError("E_TAR_SECURITY", "invalid-filename-encoding", "Tar header contains invalid UTF-8", 3); }
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
    const line = readNullTerminatedAscii(effectiveBuf, 0, effectiveBuf.length);
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
  opts: {
    allowLiveCopy?: boolean | undefined;
    maxBytes?: number | undefined;
    afterCopy?: ((attempt: number) => void) | undefined;
  }
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
    opts.afterCopy?.(attempt);

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
    try {
      rmSync(tableDst, { recursive: true, force: true });
    } catch {}
    return { success: false, attempts: 3 };
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

export const WSL_RUNNING_CHECK_SCRIPT = `root="$1"
cd "$root" || exit 1
real_root=$(pwd -P 2>/dev/null)
[ -z "$real_root" ] && exit 1
for f in "$root/gateway.pid" "$root/.gateway.pid" "$root/openclaw.pid" "$root/hermes.pid" "$root/state/gateway.pid" "$root/state/openclaw.pid"; do
  if [ -f "$f" ]; then
    pid=$(sed -n -E 's/.*"pid"[[:space:]]*:[[:space:]]*([0-9]+).*/\\1/p' "$f" 2>/dev/null | head -n 1)
    if [ -z "$pid" ]; then
      pid=$(sed -n -E 's/^[[:space:]]*([0-9]+).*/\\1/p' "$f" 2>/dev/null | head -n 1)
    fi
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "running:$f:$pid"
      exit 0
    fi
  fi
done
for l in "$root/gateway.lock" "$root/.gateway.lock"; do
  if [ -f "$l" ]; then
    echo "running:$l:lock"
    exit 0
  fi
done
echo "stopped"
`;

export const WSL_SYMLINK_SCAN_SCRIPT = `root="$1"
shift
if [ "$1" = "--" ]; then
  shift
fi
command -v find >/dev/null 2>&1 || { echo "wsl-tools-missing (find)" >&2; exit 4; }
find /dev/null -print0 >/dev/null 2>&1 || { echo "wsl-tools-missing (find -print0)" >&2; exit 4; }
cd "$root" || exit 1
real_root=$(pwd -P 2>/dev/null)
[ -z "$real_root" ] && exit 1
if [ $# -eq 0 ]; then
  set -- "."
fi
for p in "$@"; do
  [ -e "$p" ] || exit 3
  case "$p" in
    /*) exit 3 ;;
    ..|../*|*/..|*/../*) exit 3 ;;
  esac
  if [ -d "$p" ]; then
    real_p=$(cd "$p" 2>/dev/null && pwd -P)
  else
    real_dir=$(cd "$(dirname "$p")" 2>/dev/null && pwd -P)
    real_p="$real_dir/$(basename "$p")"
  fi
  [ -z "$real_p" ] && exit 3
  case "$real_p" in
    "$real_root"/*|"$real_root") ;;
    *) exit 3 ;;
  esac
done
find "$@" -type l -print0
`;

function runnerToSpawn(runner: WslRunner): typeof spawn {
  return ((cmd: string, args: string[]) => {
    const child = new EventEmitter() as any;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => {};
    process.nextTick(async () => {
      try {
        const res = await runner([cmd, ...args]);
        if (res.stdout && res.stdout.length > 0) stdout.write(res.stdout);
        stdout.end();
        if (res.stderr && res.stderr.length > 0) stderr.write(res.stderr);
        stderr.end();
        child.emit("close", res.exitCode, null);
      } catch (err) {
        child.emit("error", err);
      }
    });
    return child;
  }) as any;
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
  let stagingCreated = false;

  const rawSource = opts.sourceRoot ?? opts.source ?? "";
  const loc = locateSource({
    accessRoot: rawSource,
    platform,
    env: opts.env ?? process.env,
    home: opts.homedir ?? null,
    harnessHome: opts.home,
  });

  const isWsl = loc.origin.startsWith("wsl:") || rawSource.startsWith("wsl:");
  const sqliteStatuses: Record<string, SnapshotSqliteInfo> = {};
  const lanceStatuses: Record<string, SnapshotLanceInfo> = {};
  let skippedLinks: string[] = [];
  const skippedFiles: Array<{ path: string; reason: string }> = [];
  let tarWarnings = 0;

  // Refuse overlap before creating anything; cleanup must never own an existing directory.
  if (!isWsl) {
    const src = realpathSync(resolve(rawSource));
    const parent = resolve(dirname(stagingDir));
    let existing = parent;
    while (!existsSync(existing)) existing = dirname(existing);
    const dest = resolve(realpathSync(existing), relative(existing, resolve(stagingDir)));
    const inside = (a: string, b: string) => a === b || a.startsWith(b + sep);
    if (inside(dest, src) || inside(src, dest)) {
      throw new ImportError("E_INVALID_PARAMS", "snapshot-overlap", "Snapshot and source directories must not overlap");
    }
  }
  try {
    try {
      mkdirSync(dirname(stagingDir), { recursive: true, mode: 0o700 });
      mkdirSync(stagingDir, { mode: 0o700 });
      stagingCreated = true;
    } catch (err) {
      if (err instanceof ImportError) throw err;
      const e = err as NodeJS.ErrnoException;
      if (e.code === "EEXIST") throw new ImportError("E_INVALID_PARAMS", "snapshot-exists", "Snapshot destination already exists");
      throw new ImportError("E_IMPORT_FAILED", e.code ? `fs-${e.code.toLowerCase()}` : "fs-error", `Failed to create staging directory: ${e.message}`, 3);
    }

    if (isWsl) {
      const distro = opts.distro ?? (loc.origin.startsWith("wsl:") ? loc.origin.slice(4) : "");
      if (!distro || /[\/\\:\0\r\n]/.test(distro) || distro.startsWith("-")) {
        throw new ImportError("E_INVALID_PARAMS", "invalid-distro-name", `Invalid WSL distro name: ${distro}`, 2);
      }

      const timeoutMs = opts.timeoutMs ?? 30_000;
      const rawSubpaths = opts.subpaths && opts.subpaths.length ? opts.subpaths : ["."];
      const subpaths = validateAndNormalizeSubpaths(rawSubpaths);

      const runner = opts.wslRunner ?? defaultWslRunner;
      const installedDistros = await listWslDistros(runner);
      if (!installedDistros.some((d) => d.name === distro)) {
        throw new ImportError("E_INVALID_PARAMS", "unknown-distro", `WSL distro "${distro}" is not in installed distros list`, 2);
      }

      // Check running source inside WSL (N2, C7, F3, F4)
      const checkCmd = [
        "wsl.exe",
        "-d",
        distro,
        "--exec",
        "sh",
        "-c",
        WSL_RUNNING_CHECK_SCRIPT,
        "sh",
        loc.sourceRoot,
      ];
      const checkRes = await runner(checkCmd, { timeoutMs: 5000 });
      if (!checkRes || checkRes.exitCode !== 0) {
        throw new ImportError("E_IMPORT_FAILED", "wsl-probe-failed", "WSL running source check failed", 3);
      }
      const line = checkRes.stdout.toString("utf8").trim();
      if (line !== "stopped" && !line.startsWith("running:")) {
        throw new ImportError("E_IMPORT_FAILED", "wsl-probe-failed", `WSL running source check returned unexpected output: ${line}`, 3);
      }
      if (line.startsWith("running:")) {
        if (!opts.allowLiveCopy) {
          throw new ImportError("E_SOURCE_BUSY", "source-running", `WSL source is currently running (${line.slice(8)}); stop the source or pass --allow-live-copy (C7)`, 3);
        }
      }

      // Scan symlinks inside WSL (N1, F1, F2, F3)
      const symlinkCmd = [
        "wsl.exe",
        "-d",
        distro,
        "--exec",
        "sh",
        "-c",
        WSL_SYMLINK_SCAN_SCRIPT,
        "sh",
        loc.sourceRoot,
        "--",
        ...subpaths,
      ];
      const symlinkRes = await runner(symlinkCmd, { timeoutMs: 10_000 });
      if (!symlinkRes || symlinkRes.exitCode !== 0) {
        const stderrStr = symlinkRes?.stderr ? (Buffer.isBuffer(symlinkRes.stderr) ? symlinkRes.stderr.toString("utf8") : String(symlinkRes.stderr)) : "";
        const match = stderrStr.match(/wsl-tools-missing(?:\s*\(|:\s*)([^)\n]+)\)?/);
        if (match && match[1]) {
          throw new ImportError("E_IMPORT_FAILED", "wsl-tools-missing", `wsl-tools-missing (${match[1].trim()})`, 3);
        }
        throw new ImportError("E_IMPORT_FAILED", "wsl-probe-failed", "WSL symlink scan failed", 3);
      }
      const symlinkOut = symlinkRes.stdout;
      let startIdx = 0;
      for (let i = 0; i < symlinkOut.length; i++) {
        if (symlinkOut[i] === 0) {
          if (i > startIdx) {
            let link = symlinkOut.subarray(startIdx, i).toString("utf8");
            if (link.startsWith("./")) link = link.slice(2);
            if (link.length > 0) skippedLinks.push(link);
          }
          startIdx = i + 1;
        }
      }

      // Spawn WSL tar process (Single production code path, §B.3, M1)
      const spawnOpts: SpawnWslTarStreamOptions = {
        timeoutMs,
      };
      if (opts.wslSpawn) {
        spawnOpts.spawnFn = opts.wslSpawn;
      } else if (opts.wslRunner) {
        spawnOpts.spawnFn = runnerToSpawn(opts.wslRunner);
      }
      const tarProcess = spawnWslTarStream(distro, loc.sourceRoot, subpaths, spawnOpts);
      try {
        await extractTarStream(tarProcess.stream, stagingDir, { maxBytes, maxFiles, targetPlatform: platform });
        const closeRes = await tarProcess.waitClose(opts.allowLiveCopy);
        if (closeRes.tarWarnings > 0) {
          tarWarnings = closeRes.tarWarnings;
        }
      } catch (extractErr) {
        try {
          await tarProcess.waitClose(opts.allowLiveCopy);
        } catch (closeErr) {
          throw closeErr;
        }
        throw extractErr;
      } finally {
        tarProcess.dispose();
      }

      // Staged SQLite verification for WSL (F4)
      async function scanSqlite(dir: string): Promise<void> {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          const full = join(dir, e.name);
          if (e.isDirectory()) {
            await scanSqlite(full);
          } else if (e.isFile() && (e.name.endsWith(".db") || e.name.endsWith(".sqlite"))) {
            const rel = relative(stagingDir, full).replace(/\\/g, "/");
            let ok = false;
            let db: DatabaseSync | null = null;
            try {
              db = new DatabaseSync(full, { readOnly: true });
              const check = db.prepare("PRAGMA quick_check").all() as Record<string, unknown>[];
              if (check.length === 1 && Object.values(check[0]!)[0] === "ok") {
                await consolidateSqlite(db, full);
                db = null;
                ok = true;
              }
            } catch {
              ok = false;
            } finally {
              try { db?.close(); } catch {}
            }
            if (ok) {
              sqliteStatuses[rel] = { status: opts.allowLiveCopy ? "copy-live-unverified" : "copy", attempts: 1 };
            } else if (opts.allowLiveCopy) {
              try { rmSync(full, { force: true }); } catch {}
              try { rmSync(`${full}-wal`, { force: true }); } catch {}
              try { rmSync(`${full}-shm`, { force: true }); } catch {}
              sqliteStatuses[rel] = { status: "source-busy", attempts: 1, reason: "quick_check failed on live copy" };
            } else {
              throw new ImportError("E_SOURCE_BUSY", "source-running", `SQLite database ${rel} inconsistent; stop the source or pass --allow-live-copy (C7)`, 3);
            }
          }
        }
      }
      await scanSqlite(stagingDir);
    } else {
      // Native copier
      const absSrc = resolve(rawSource);
      const runCheck = isSourceRunning(absSrc);
      if (runCheck.running && !opts.allowLiveCopy) {
        throw new ImportError("E_SOURCE_BUSY", "source-running", `Source is currently running (${runCheck.reason}); stop the source or pass --allow-live-copy (C7)`, 3);
      }

      const nativeSkipped: string[] = [];
      const copiedSizes = new Map<string, number>();
      let copiedBytes = 0;
      const trackedCopy = (src: string, dst: string, limit: number): void => {
        const size = statSync(src).size;
        const total = copiedBytes - (copiedSizes.get(dst) ?? 0) + size;
        if (!copiedSizes.has(dst) && copiedSizes.size >= maxFiles) throw new ImportError("E_LIMIT_EXCEEDED", "too-many-files", "Snapshot exceeds file count limit", 3);
        if (total > maxBytes) throw new ImportError("E_LIMIT_EXCEEDED", "too-many-bytes", "Snapshot exceeds byte limit", 3);
        copiedSizes.set(dst, size);
        copiedBytes = total;
        (opts.copyFile ?? copyFileBounded)(src, dst, limit);
      };
      await copyNativeTree(absSrc, stagingDir, stagingDir, {
        allowLiveCopy: opts.allowLiveCopy,
        maxBytes,
        sqliteStatuses,
        lanceStatuses,
        skippedLinks: nativeSkipped,
        sourceRoot: absSrc,
        afterCopy: opts.afterCopy,
        copyFile: trackedCopy,
        skippedFiles,
      });
      skippedLinks = nativeSkipped;
    }

    // Inspect files and generate snapshot.json
    const metadata = generateSnapshotMetadata({
      sourceRoot: loc.sourceRoot,
      source: rawSource,
      origin: loc.origin,
      flavour: loc.flavour,
      sourceHome: loc.sourceHome,
      stagingDir,
      sqliteStatuses,
      lanceStatuses,
      skippedLinks,
      skippedFiles,
      liveCopy: opts.allowLiveCopy ? true : undefined,
      tarWarnings: tarWarnings > 0 ? tarWarnings : undefined,
    });

    if (metadata.files.length > maxFiles) throw new ImportError("E_LIMIT_EXCEEDED", "too-many-files", "Snapshot exceeds file count limit", 3);
    if (metadata.files.reduce((sum, file) => sum + file.size, 0) > maxBytes) throw new ImportError("E_LIMIT_EXCEEDED", "too-many-bytes", "Snapshot exceeds byte limit", 3);
    writeFileSync(join(stagingDir, "snapshot.json"), JSON.stringify(metadata, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    return { stagingDir, metadata };
  } catch (err) {
    if (stagingCreated) {
      try {
        rmSync(stagingDir, { recursive: true, force: true });
      } catch {}
    }
    throw err;
  }
}

async function copyNativeTree(
  srcDir: string,
  dstDir: string,
  stagingRoot: string,
  opts: {
    allowLiveCopy?: boolean | undefined;
    maxBytes: number;
    sqliteStatuses: Record<string, SnapshotSqliteInfo>;
    lanceStatuses?: Record<string, SnapshotLanceInfo> | undefined;
    skippedLinks: string[];
    sourceRoot: string;
    afterCopy?: ((attempt: number, copy: string) => void) | undefined;
    copyFile?: ((src: string, dst: string, limit: number) => void) | undefined;
    skippedFiles: Array<{ path: string; reason: string }>;
  },
  ancestors: ReadonlySet<string> = new Set(),
): Promise<void> {
  const realDir = realpathSync(srcDir);
  if (ancestors.has(realDir)) {
    opts.skippedLinks.push(relative(stagingRoot, dstDir).split(sep).join("/"));
    return;
  }
  const nextAncestors = new Set([...ancestors, realDir]);
  mkdirSync(dstDir, { recursive: true });
  const entries = readdirSync(srcDir, { withFileTypes: true, encoding: "buffer" });

  for (const e of entries) {
    let name: string;
    try { name = new TextDecoder("utf-8", { fatal: true }).decode(e.name); }
    catch {
      const prefix = relative(opts.sourceRoot, srcDir).split(sep).join("/");
      opts.skippedFiles.push({ path: `${prefix ? prefix + "/" : ""}hex:${e.name.toString("hex")}`, reason: "invalid-filename-encoding" });
      continue;
    }
    const srcPath = join(srcDir, name);
    const dstPath = join(dstDir, name);

    if (e.isSymbolicLink()) {
      try {
        const target = realpathSync(srcPath);
        const normSrc = resolve(opts.sourceRoot);
        if (target.startsWith(normSrc + sep) || target === normSrc) {
          const st = statSync(target);
          if (st.isDirectory()) {
            await copyNativeTree(target, dstPath, stagingRoot, opts, nextAncestors);
          } else if (st.isFile()) {
            const doCopy = opts.copyFile ?? copyFileBounded;
            doCopy(target, dstPath, opts.maxBytes);
          }
        } else {
          const rel = relative(opts.sourceRoot, srcPath).replace(/\\/g, "/");
          opts.skippedLinks.push(rel);
        }
      } catch (error) {
        if (error instanceof ImportError) throw error;
        const rel = relative(opts.sourceRoot, srcPath).replace(/\\/g, "/");
        opts.skippedLinks.push(rel);
      }
    } else if (e.isDirectory()) {
      if (name === "_versions" || existsSync(join(srcPath, "_versions"))) {
        // LanceDB table directory
        const res = copyLanceTableWithManifest(srcPath, dstPath, {
          allowLiveCopy: opts.allowLiveCopy,
          maxBytes: opts.maxBytes,
          afterCopy: opts.afterCopy ? (a) => opts.afterCopy!(a, dstPath) : undefined,
        });
        if (opts.lanceStatuses) {
          const rel = relative(stagingRoot, dstPath).replace(/\\/g, "/");
          opts.lanceStatuses[rel] = {
            status: res.success ? "copy" : "source-busy",
            attempts: res.attempts,
          };
        }
      } else {
        await copyNativeTree(srcPath, dstPath, stagingRoot, opts, nextAncestors);
      }
    } else if (e.isFile()) {
      if (name.endsWith("-wal") || name.endsWith("-shm")) {
        // WAL and SHM files are copied alongside their parent database in copySqliteFile
        continue;
      }
      const isSqlite = name.endsWith(".sqlite") || name.endsWith(".db");
      if (isSqlite) {
        const rel = relative(stagingRoot, dstPath).replace(/\\/g, "/");
        await copySqliteFile(srcPath, dstPath, rel, opts);
      } else {
        const doCopy = opts.copyFile ?? copyFileBounded;
        doCopy(srcPath, dstPath, opts.maxBytes);
      }
    }
  }
}

/** The input is always private staging data; never a live source connection. Closes it before rename (Windows). */
async function consolidateSqlite(db: DatabaseSync, dst: string): Promise<void> {
  const temporary = mkdtempSync(join(dirname(dst), ".sqlite-backup-"));
  const image = join(temporary, "image.db");
  try {
    await backup(db, image);
    const standalone = new DatabaseSync(image);
    try { standalone.exec("PRAGMA journal_mode=DELETE"); } finally { standalone.close(); }
    db.close();
    rmSync(dst, { force: true });
    rmSync(`${dst}-wal`, { force: true });
    rmSync(`${dst}-shm`, { force: true });
    renameSync(image, dst);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

async function copySqliteFile(
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
): Promise<void> {
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
        // Back up the verified private copy, never the live source: opening a source WAL
        // reader can write read marks to its SHM. Publish only a standalone SQLite image.
        await consolidateSqlite(db, dst);
        db = null;
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
    opts.sqliteStatuses[relPath] = { status: opts.allowLiveCopy ? "copy-live-unverified" : "copy", attempts };
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
  lanceStatuses?: Record<string, SnapshotLanceInfo> | undefined;
  skippedLinks?: string[] | undefined;
  skippedFiles?: Array<{ path: string; reason: string }>;
  liveCopy?: boolean | undefined;
  tarWarnings?: number | undefined;
}): SnapshotMetadata {
  const files: SnapshotFileInfo[] = [];
  const envKeys: Record<string, string[]> = {};
  const omittedCredentials: string[] = [];

  function scan(dir: string, credentials = false) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.name === "snapshot.json" && dir === o.stagingDir) continue;
      if (e.isDirectory()) {
        scan(full, credentials || e.name.toLowerCase() === "credentials");
      } else if (e.isFile()) {
        const rel = relative(o.stagingDir, full).replace(/\\/g, "/");
        if (credentials || isSecretFileName(e.name)) {
          if (e.name === ".env" || e.name.startsWith(".env.")) envKeys[rel] = envKeyNames(full);
          omittedCredentials.push(rel);
          rmSync(full, { force: true });
          continue;
        }
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

  const meta: SnapshotMetadata = {
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
  if (o.lanceStatuses && Object.keys(o.lanceStatuses).length > 0) {
    meta.lancedb = o.lanceStatuses;
  }
  if (o.skippedLinks && o.skippedLinks.length > 0) {
    meta.skippedLinks = o.skippedLinks;
  }
  if (o.skippedFiles?.length) meta.skippedFiles = o.skippedFiles;
  if (omittedCredentials.length) meta.omittedCredentials = omittedCredentials.sort();
  if (o.liveCopy) {
    meta.liveCopy = true;
  }
  if (o.tarWarnings && o.tarWarnings > 0) {
    meta.tarWarnings = o.tarWarnings;
  }
  return meta;
}
