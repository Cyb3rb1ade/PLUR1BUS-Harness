/** One-use uploaded sources are streamed into a private, verified snapshot before detect or planning. */
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, type FileHandle } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { createSecurePath } from "@plur1bus/module-api";
import { DEFAULT_SNAPSHOT_MAX_BYTES, DEFAULT_SNAPSHOT_MAX_FILES, extractTarStream, type SnapshotFileInfo,
  type SnapshotMetadata } from "./snapshot.ts";
import { verifySourceSnapshot } from "./snapshot-source.ts";
import { ImportError, type SecretsReport } from "./types.ts";
import { decodeSourceText } from "./fs-safe.ts";
import { isSourceConfiguration, isSourceCredential, sealSourceConfiguration, sourceConfigurationKeys } from "./source-seal.ts";

const MAX_COMPRESSED_BYTES = 1024 ** 3;
const MAX_DEPTH = 32;
const MAX_LIFETIME_MS = 600_000;
const ID = /^[A-Za-z0-9_-]{43}$(?![\s\S])/;
const SHA256 = /^[a-f0-9]{64}$(?![\s\S])/;
const MANIFEST_BYTES = 8 * 1024 * 1024;
const CONFIG_BYTES = 32 * 1024 * 1024;
const unavailable = () => new ImportError("E_SOURCE_UNSUPPORTED", "snapshot-unavailable",
  "Import source snapshot is unavailable");

interface UploadMetadata {
  version: 1;
  userId: string;
  expiresAt: number;
  sha256: string;
  size: number;
}

export interface ImportSnapshotLimits {
  maxBytes: number;
  maxFiles: number;
  maxDepth: number;
  timeoutMs: number;
}

export interface ClaimImportSnapshotOptions {
  home: string;
  snapshotId: string;
  userId: string;
  signal?: AbortSignal;
  /** Trusted callers can tighten these budgets; none can exceed the import contract. */
  limits?: Partial<ImportSnapshotLimits>;
}

export interface ImportSnapshotReceipt {
  snapshotId: string;
  sha256: string;
  files: number;
  bytes: number;
}

function limitsOf(options: ClaimImportSnapshotOptions): ImportSnapshotLimits {
  const limits = { maxBytes: DEFAULT_SNAPSHOT_MAX_BYTES, maxFiles: DEFAULT_SNAPSHOT_MAX_FILES,
    maxDepth: MAX_DEPTH, timeoutMs: MAX_LIFETIME_MS };
  for (const key of Object.keys(options.limits ?? {})) {
    if (!(key in limits)) throw unavailable();
    const name = key as keyof ImportSnapshotLimits;
    const value = options.limits![name];
    if (!Number.isSafeInteger(value) || value! < 1 || value! > limits[name]) throw unavailable();
    limits[name] = value!;
  }
  return limits;
}

async function checkedDirectory(path: string, create = false): Promise<void> {
  if (create) await mkdir(path, { mode: 0o700 }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || typeof process.geteuid === "function" && stat.uid !== process.geteuid()) throw unavailable();
  if (create && !createSecurePath()(path, { mode: 0o700 }).applied) throw unavailable();
}

async function checkedFile(path: string, maximum: number): Promise<FileHandle> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum
    || typeof process.geteuid === "function" && before.uid !== process.geteuid()) throw unavailable();
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const after = await file.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size > maximum) {
      throw unavailable();
    }
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function readMetadata(path: string, userId: string): Promise<UploadMetadata> {
  const file = await checkedFile(path, 4096);
  try {
    const raw: unknown = JSON.parse(await file.readFile("utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw unavailable();
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).length !== 5 || value.version !== 1 || value.userId !== userId
      || !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) <= Date.now()
      || (value.expiresAt as number) > Date.now() + MAX_LIFETIME_MS
      || typeof value.sha256 !== "string" || !SHA256.test(value.sha256)
      || !Number.isSafeInteger(value.size) || (value.size as number) < 1
      || (value.size as number) > MAX_COMPRESSED_BYTES) throw unavailable();
    return value as unknown as UploadMetadata;
  } finally {
    await file.close();
  }
}

async function* compressedChunks(file: FileHandle, metadata: UploadMetadata, signal: AbortSignal) {
  const digest = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  let total = 0;
  for (;;) {
    signal.throwIfAborted();
    const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
    if (!bytesRead) break;
    total += bytesRead;
    if (total > metadata.size || total > MAX_COMPRESSED_BYTES) throw unavailable();
    digest.update(buffer.subarray(0, bytesRead));
    // Streams may retain this chunk while the next read fills the reusable buffer.
    yield Buffer.from(buffer.subarray(0, bytesRead));
  }
  if (total !== metadata.size || digest.digest("hex") !== metadata.sha256) throw unavailable();
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw unavailable();
  return value;
}

function memberPath(value: unknown): string {
  const path = text(value);
  if (path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)
    || path.split("/").some(part => !part || part === "." || part === "..")) throw unavailable();
  return path;
}

function keyDeclarations(value: unknown): SecretsReport["configKeys"] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4096) throw unavailable();
  return value.map(item => {
    const entry = record(item), path = text(entry.path);
    if (entry.form !== "inline" && entry.form !== "env-ref" && entry.form !== "object") throw unavailable();
    return { path, form: entry.form };
  });
}

function omissionPaths(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > DEFAULT_SNAPSHOT_MAX_FILES) throw unavailable();
  return value.map(path => typeof path === "string" && path.endsWith("/")
    ? memberPath(path.slice(0, -1)) + "/" : memberPath(path));
}

/** Raw member hashes authenticate the uploaded inventory; only this projection reaches snapshot storage. */
class SnapshotSeal {
  private readonly raw = new Map<string, { size: number; sha256: string; sealed?: SnapshotFileInfo }>();
  private manifest: Buffer | undefined;
  private readonly omitted = new Set<string>();
  private readonly env: Record<string, string[]> = Object.create(null);
  private readonly keys: SecretsReport["configKeys"] = [];
  private sealedBytes = 0;
  private readonly root: string;
  private readonly limits: ImportSnapshotLimits;
  private readonly signal: AbortSignal;
  constructor(root: string, limits: ImportSnapshotLimits, signal: AbortSignal) {
    this.root = root; this.limits = limits; this.signal = signal;
  }

  async file(entry: { path: string; size: number }, chunks: AsyncIterable<Buffer>): Promise<void> {
    this.signal.throwIfAborted();
    const path = memberPath(entry.path);
    if (path === "snapshot.json" ? this.manifest !== undefined : this.raw.has(path)) throw unavailable();
    const omitted = isSourceCredential(path), config = !omitted && isSourceConfiguration(path);
    const env = omitted && /^\.env(?:\.|$)/i.test(path.split("/").at(-1)!);
    const buffered = path === "snapshot.json" || config || env && entry.size <= 1024 * 1024;
    if (path === "snapshot.json" && entry.size > MANIFEST_BYTES || config && entry.size > CONFIG_BYTES) throw unavailable();
    const contents: Buffer[] = [];
    const digest = createHash("sha256");
    let output: FileHandle | undefined;
    try {
      if (!buffered && !omitted) {
        if (this.sealedBytes + entry.size > this.limits.maxBytes) throw unavailable();
        output = await this.output(path);
      }
      for await (const chunk of chunks) {
        this.signal.throwIfAborted();
        digest.update(chunk);
        if (buffered) contents.push(chunk);
        else if (output) await output.writeFile(chunk);
      }
      await output?.sync();
    } finally { await output?.close(); }
    const sha256 = digest.digest("hex");
    if (path === "snapshot.json") { this.manifest = Buffer.concat(contents, entry.size); return; }
    if (omitted) {
      this.omitted.add(path);
      if (env && buffered) {
        const names = new Set<string>();
        for (const line of decodeSourceText(Buffer.concat(contents, entry.size)).split(/\r?\n/)) {
          const name = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
          if (name) names.add(name);
        }
        this.env[path] = [...names];
      }
      this.raw.set(path, { size: entry.size, sha256 });
      return;
    }
    let sealed: SnapshotFileInfo = { path, size: entry.size, sha256 };
    if (config) {
      const bytes = Buffer.concat(contents, entry.size);
      this.keys.push(...sourceConfigurationKeys(path, bytes));
      if (this.keys.length > 4096) throw unavailable();
      const clean = sealSourceConfiguration(path, bytes);
      sealed = { path, size: clean.length, sha256: createHash("sha256").update(clean).digest("hex") };
      if (this.sealedBytes + sealed.size > this.limits.maxBytes) throw unavailable();
      const file = await this.output(path);
      try { await file.writeFile(clean); await file.sync(); } finally { await file.close(); }
    }
    this.sealedBytes += sealed.size;
    if (this.sealedBytes > this.limits.maxBytes) throw unavailable();
    this.raw.set(path, { size: entry.size, sha256, sealed });
  }

  private async output(path: string): Promise<FileHandle> {
    let parent = this.root;
    for (const part of path.split("/").slice(0, -1)) {
      parent = join(parent, part);
      await checkedDirectory(parent, true);
    }
    const target = join(this.root, path);
    const file = await open(target, "wx", 0o600);
    try {
      if (!createSecurePath()(target, { mode: 0o600 }).applied) throw unavailable();
      return file;
    } catch (error) { await file.close(); throw error; }
  }

  async finish(): Promise<void> {
    this.signal.throwIfAborted();
    if (!this.manifest) throw unavailable();
    const original = record(JSON.parse(decodeSourceText(this.manifest)));
    if (original.version !== 1 || !Array.isArray(original.files) || original.files.length !== this.raw.size) throw unavailable();
    const listed = new Set<string>();
    const files: SnapshotFileInfo[] = [];
    for (const item of original.files) {
      const info = record(item), path = memberPath(info.path), raw = this.raw.get(path);
      if (listed.has(path) || !raw || info.size !== raw.size || info.sha256 !== raw.sha256) throw unavailable();
      listed.add(path);
      if (info.sourceMode !== undefined && (!Number.isInteger(info.sourceMode)
        || (info.sourceMode as number) < 0 || (info.sourceMode as number) > 0o777)) throw unavailable();
      if (raw.sealed) files.push({ ...raw.sealed,
        ...(info.sourceMode === undefined ? {} : { sourceMode: info.sourceMode as number }),
        ...(typeof info.mtimeMs === "number" && Number.isFinite(info.mtimeMs) && info.mtimeMs >= 0 ? { mtimeMs: info.mtimeMs } : {}),
      });
    }
    const omitted = new Set([...omissionPaths(original.omittedCredentials), ...this.omitted]);
    const envKeys: Record<string, string[]> = Object.create(null);
    const uploadedEnv = original.envKeys === undefined ? {} : record(original.envKeys);
    for (const path of omitted) {
      const names = uploadedEnv[path];
      if (names !== undefined && (!Array.isArray(names) || names.length > 4096
        || names.some(name => typeof name !== "string" || name.length > 512 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))) throw unavailable();
      if (this.env[path] || names) envKeys[path] = [...new Set([...(names as string[] | undefined) ?? [], ...this.env[path] ?? []])];
    }
    const declarations = [...keyDeclarations(original.omittedConfigKeys), ...this.keys];
    const unique = new Map(declarations.map(entry => [JSON.stringify(entry), entry]));
    if (unique.size > 4096) throw unavailable();
    const sqlite: SnapshotMetadata["sqlite"] = Object.create(null);
    if (original.sqlite !== undefined) {
      for (const [path, value] of Object.entries(record(original.sqlite))) {
        const status = record(value);
        if (listed.has(path) && !this.omitted.has(path) && ["copy", "copy-live-unverified", "source-busy"].includes(String(status.status))) {
          sqlite[path] = { status: status.status as SnapshotMetadata["sqlite"][string]["status"],
            ...(Number.isSafeInteger(status.attempts) && (status.attempts as number) >= 0 && (status.attempts as number) <= 4 ? { attempts: status.attempts as number } : {}) };
        }
      }
    }
    const metadata: SnapshotMetadata = { version: 1, source: text(original.source), sourceRoot: text(original.sourceRoot),
      origin: text(original.origin), flavour: text(original.flavour), timestamp: text(original.timestamp),
      files: files.sort((a, b) => a.path.localeCompare(b.path)), sqlite, envKeys,
      omittedCredentials: [...omitted].sort(), omittedConfigKeys: [...unique.values()] };
    if (original.sourceHome === null || typeof original.sourceHome === "string") metadata.sourceHome = original.sourceHome === null ? null : text(original.sourceHome);
    if (original.liveCopy === true) metadata.liveCopy = true;
    if (original.skippedLinks !== undefined) metadata.skippedLinks = omissionPaths(original.skippedLinks);
    if (original.lancedb !== undefined) {
      metadata.lancedb = Object.create(null) as NonNullable<SnapshotMetadata["lancedb"]>;
      for (const [key, item] of Object.entries(record(original.lancedb))) {
        const path = memberPath(key), value = record(item);
        if (value.status !== "copy" && value.status !== "source-busy") throw unavailable();
        metadata.lancedb[path] = { status: value.status,
          ...(Number.isSafeInteger(value.attempts) && (value.attempts as number) >= 0 && (value.attempts as number) <= 4 ? { attempts: value.attempts as number } : {}) };
      }
    }
    if (original.skippedFiles !== undefined) {
      if (!Array.isArray(original.skippedFiles) || original.skippedFiles.length > DEFAULT_SNAPSHOT_MAX_FILES) throw unavailable();
      metadata.skippedFiles = original.skippedFiles.map(item => {
        const value = record(item);
        if (value.reason !== "invalid-filename-encoding") throw unavailable();
        return { path: memberPath(value.path), reason: "invalid-filename-encoding" };
      });
    }
    if (Number.isSafeInteger(original.tarWarnings) && (original.tarWarnings as number) > 0
      && (original.tarWarnings as number) <= DEFAULT_SNAPSHOT_MAX_FILES) metadata.tarWarnings = original.tarWarnings as number;
    const bytes = Buffer.from(JSON.stringify(metadata, null, 2) + "\n");
    if (bytes.length > MANIFEST_BYTES || this.sealedBytes + bytes.length > this.limits.maxBytes) throw unavailable();
    const file = await this.output("snapshot.json");
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  }
}

async function extract(file: FileHandle, path: string, metadata: UploadMetadata,
  limits: ImportSnapshotLimits, signal: AbortSignal) {
  const source = Readable.from(compressedChunks(file, metadata, signal));
  const gunzip = createGunzip();
  const pumping = pipeline(source, gunzip, { signal });
  void pumping.catch(() => {});
  try {
    await checkedDirectory(path, true);
    const seal = new SnapshotSeal(path, limits, signal);
    const result = await extractTarStream(gunzip, path, { ...limits, onFile: (entry, chunks) => seal.file(entry, chunks) });
    await pumping;
    signal.throwIfAborted();
    await seal.finish();
    return result;
  } finally {
    source.destroy();
    gunzip.destroy();
    await pumping.catch(() => {});
  }
}

async function writeReceipt(path: string, value: object): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    if (!createSecurePath()(path, { mode: 0o600 }).applied) throw unavailable();
    await file.writeFile(JSON.stringify(value) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
}

/** A killed worker cannot run finally; collect only closed claim names after expiry plus its full lifetime. */
export async function pruneImportSnapshotClaims(home: string): Promise<void> {
  if (!isAbsolute(home)) throw unavailable();
  const dir = join(home, "run", "import-snapshots");
  for (const path of [home, join(home, "run"), dir]) await checkedDirectory(path);
  for (const name of await readdir(dir)) {
    const match = /^\.([A-Za-z0-9_-]{43})\.claim-[a-f0-9]{32}\.json$(?![\s\S])/.exec(name);
    if (!match) continue;
    const path = join(dir, name);
    let file: FileHandle | undefined;
    try {
      file = await checkedFile(path, 4096);
      const value: unknown = JSON.parse(await file.readFile("utf8"));
      if (!value || typeof value !== "object") continue;
      const metadata = value as Record<string, unknown>;
      if (metadata.version !== 1 || !Number.isSafeInteger(metadata.expiresAt)
        || (metadata.expiresAt as number) < 0
        || (metadata.expiresAt as number) + MAX_LIFETIME_MS > Date.now()) continue;
      // Rename is the same exclusive boundary used by API pruning and live worker acquisition.
      const expired = join(dir, `.${match[1]}.expired-${randomBytes(16).toString("hex")}.json`);
      await rename(path, expired);
      await rm(join(dir, match[1]!), { force: true });
      await rm(expired, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unavailable();
    } finally {
      await file?.close();
    }
  }
}

/** Does not return a host path. The sealed source is always import/<id>/snapshot under the trusted home. */
export async function claimImportSnapshot(options: ClaimImportSnapshotOptions): Promise<ImportSnapshotReceipt> {
  let claim: string | undefined;
  let body: string | undefined;
  let directory: string | undefined;
  let file: FileHandle | undefined;
  let complete = false;
  try {
    if (!isAbsolute(options.home) || !ID.test(options.snapshotId) || !options.userId
      || options.userId.length > 512) throw unavailable();
    const limits = limitsOf(options);
    const signal = AbortSignal.any([AbortSignal.timeout(limits.timeoutMs), ...options.signal ? [options.signal] : []]);
    signal.throwIfAborted();
    for (const path of [options.home, join(options.home, "run"), join(options.home, "run", "import-snapshots")]) {
      await checkedDirectory(path);
    }
    await pruneImportSnapshotClaims(options.home);
    const uploads = join(options.home, "run", "import-snapshots");
    const metadataPath = join(uploads, options.snapshotId + ".json");
    const metadata = await readMetadata(metadataPath, options.userId);
    signal.throwIfAborted();
    const claimed = join(uploads, `.${options.snapshotId}.claim-${randomBytes(16).toString("hex")}.json`);
    await rename(metadataPath, claimed);
    claim = claimed;
    body = join(uploads, options.snapshotId);
    const checked = await readMetadata(claim, options.userId);
    if (JSON.stringify(checked) !== JSON.stringify(metadata)) throw unavailable();
    file = await checkedFile(body, MAX_COMPRESSED_BYTES);
    if ((await file.stat()).size !== checked.size) throw unavailable();
    await checkedDirectory(join(options.home, "import"), true);
    const target = join(options.home, "import", options.snapshotId);
    await mkdir(target, { mode: 0o700 });
    directory = target;
    await checkedDirectory(target, true);
    const root = join(target, "snapshot");
    const counts = await extract(file, root, checked, limits, signal);
    if (!verifySourceSnapshot(root, options.home)) throw unavailable();
    const manifest = await checkedFile(join(root, "snapshot.json"), 8 * 1024 * 1024);
    let manifestSha256: string;
    try {
      manifestSha256 = createHash("sha256").update(await manifest.readFile()).digest("hex");
    } finally {
      await manifest.close();
    }
    signal.throwIfAborted();
    const receipt = { snapshotId: options.snapshotId, sha256: checked.sha256,
      files: counts.filesCount, bytes: counts.bytesCount };
    await writeReceipt(join(target, "receipt.json"), { schema: "import.source-snapshot/1", ...receipt,
      userId: options.userId, manifestSha256 });
    complete = true;
    return receipt;
  } catch {
    throw unavailable();
  } finally {
    await file?.close().catch(() => {});
    if (claim) {
      await rm(body!, { force: true }).catch(() => {});
      await rm(claim, { force: true }).catch(() => {});
    }
    if (directory && !complete) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
