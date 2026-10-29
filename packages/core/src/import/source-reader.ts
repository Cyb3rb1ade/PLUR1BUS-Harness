/** All live source I/O crosses the six-operation port; native database libraries see private local copies only. */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as native from "node:path";
import { createNativeSourceFs, RemoteFsError, type FsLimits, type FsStat, type ReadonlyFs } from "@plur1bus/remote-fs";
import { createSecurePath } from "@plur1bus/module-api";
import { decodeSourceText } from "./fs-safe.ts";
import { openSqliteReadOnly, type SqliteHandle } from "./readonly.ts";
import { ImportError } from "./types.ts";
import { locateSource, type SourceLocation } from "./paths.ts";

export interface SourceReaderOptions {
  fs: ReadonlyFs;
  /** Original configured authority, never replaced by a selected descendant before canonicalization. */
  root: string;
  remote?: boolean;
  signal?: AbortSignal;
}

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const changed = () => new ImportError("E_SOURCE_BUSY", "source-changed", "Source changed while it was read", 3);

export class SourceReader {
  static refuseFatal(error: unknown): void {
    if (error instanceof RemoteFsError && !["not-found", "path-denied", "unsupported-type"].includes(error.reason)
      || error instanceof ImportError && (["E_LIMIT_EXCEEDED", "E_SOURCE_BUSY"].includes(error.code)
        || ["timeout", "aborted"].includes(error.reason))) throw error;
  }
  readonly fs: ReadonlyFs;
  readonly paths: typeof native.posix;
  readonly root: string;
  readonly remote: boolean;
  private readonly files = new Map<string, { size: number; sha256: string }>();
  private readonly directories = new Map<string, string>();
  private readonly sourceModes = new Map<string, number>();
  private nativeLocal = false;

  constructor(options: SourceReaderOptions) {
    const source = options.fs;
    const guarded = async <T>(run: () => Promise<T>): Promise<T> => {
      const signal = options.signal;
      const stopped = () => new ImportError("E_IMPORT_FAILED", signal?.reason?.name === "TimeoutError" ? "timeout" : "aborted", "Source read was stopped", 3);
      if (signal?.aborted) throw stopped();
      if (!signal) return run();
      let detach = () => {};
      try {
        const value = await Promise.race([run(), new Promise<never>((_, reject) => {
          const abort = () => reject(stopped());
          signal.addEventListener("abort", abort, { once: true });
          detach = () => signal.removeEventListener("abort", abort);
          if (signal.aborted) abort();
        })]);
        if (signal.aborted) throw stopped();
        return value;
      } finally { detach(); }
    };
    this.fs = Object.freeze({ stat: (path: string) => guarded(() => source.stat(path)), lstat: (path: string) => guarded(() => source.lstat(path)),
      readdir: (path: string) => guarded(() => source.readdir(path)), readFile: (path: string, max: number) => guarded(() => source.readFile(path, max)),
      realpath: (path: string) => guarded(() => source.realpath(path)), readlink: (path: string) => guarded(() => source.readlink(path)) });
    this.root = options.root;
    this.remote = options.remote ?? false;
    this.paths = this.remote ? native.posix : native;
  }

  /** Native CLI reads span drives and UNC shares; only explicitly configured readers hold a confined root. */
  static async local(limits?: Partial<FsLimits>, signal?: AbortSignal): Promise<SourceReader> {
    const root = native.parse(process.cwd()).root;
    const fs = await createNativeSourceFs({ limits: { maxDepth: 128, maxEntries: 100_000,
      maxFileBytes: 1024 ** 3, timeoutMs: 300_000, ...limits }, ...(signal ? { signal } : {}) });
    const reader = new SourceReader({ fs, root });
    reader.nativeLocal = true;
    return reader;
  }

  /** Configured selections canonicalize both paths using the already-confined port before traversal. */
  async select(path: string): Promise<string> {
    const full = await this.fs.realpath(path);
    if (this.nativeLocal) return full;
    const root = await this.fs.realpath(this.root);
    const relative = this.paths.relative(root, full);
    if (relative === ".." || relative.startsWith(`..${this.paths.sep}`) || this.paths.isAbsolute(relative)) {
      throw new ImportError("E_DENIED", "source-path-denied", "Source path is outside the configured root");
    }
    return full;
  }

  contains(root: string, path: string): boolean {
    const delta = this.paths.relative(root, path);
    return delta !== ".." && !delta.startsWith(`..${this.paths.sep}`) && !this.paths.isAbsolute(delta);
  }

  async location(options: Parameters<typeof locateSource>[0]): Promise<SourceLocation> {
    const local = locateSource({ ...options, skipSnapshotCheck: true });
    if (this.remote) return { origin: "network", flavour: "posix", hostFlavour: "posix", accessRoot: options.accessRoot,
      sourceRoot: options.accessRoot, sourceHome: null, accessHome: null, mounts: [] };
    const manifest = this.paths.join(options.accessRoot, "snapshot.json");
    if (!await this.exists(manifest)) return local;
    // The detector has already validated the private snapshot anchor and every listed file.
    const meta = JSON.parse(await this.text(manifest, 8 * 1024 * 1024));
    const allowed = ["native", "network", "windows-from-wsl", "container"];
    if (meta?.version !== 1 || !["posix", "win32"].includes(meta.flavour)
      || typeof meta.origin !== "string" || !allowed.includes(meta.origin) && !meta.origin.startsWith("wsl:")) return local;
    return { ...local, snapshot: true, origin: meta.origin, flavour: meta.flavour,
      sourceRoot: typeof meta.sourceRoot === "string" ? meta.sourceRoot : options.accessRoot,
      sourceHome: typeof meta.sourceHome === "string" ? meta.sourceHome : options.home, accessHome: null };
  }

  async stat(path: string, follow = true): Promise<FsStat | null> {
    try {
      const stat = await (follow ? this.fs.stat(path) : this.fs.lstat(path));
      const mode = this.sourceModes.get(path);
      return mode === undefined ? stat : Object.freeze({ ...stat, mode });
    }
    catch (error) {
      if (error instanceof RemoteFsError && error.reason === "not-found") return null;
      throw error;
    }
  }

  /** Called only after authenticating the local snapshot anchor, path, length and digest. Never changes disk mode. */
  snapshotMode(path: string, mode: number): void { this.sourceModes.set(path, mode); }

  async isFile(path: string): Promise<boolean> { return (await this.stat(path))?.type === "file"; }
  async isDir(path: string): Promise<boolean> { return (await this.stat(path))?.type === "directory"; }
  async exists(path: string): Promise<boolean> { return (await this.stat(path, false)) !== null; }

  async names(path: string): Promise<string[]> {
    if (!await this.isDir(path)) return [];
    const entries = [...await this.fs.readdir(path)].sort();
    const current = JSON.stringify(entries);
    const previous = this.directories.get(path);
    if (previous !== undefined && previous !== current) throw changed();
    this.directories.set(path, current);
    return entries;
  }

  async subdirs(path: string): Promise<string[]> {
    const names: string[] = [];
    for (const name of await this.names(path)) {
      if ((await this.stat(this.paths.join(path, name), false))?.type === "directory") names.push(name);
    }
    return names;
  }

  async read(path: string, maxBytes: number): Promise<Buffer> {
    const info = await this.stat(path, false);
    if (info?.type === "symlink") throw new ImportError("E_SOURCE_UNSUPPORTED", "unsafe-symlink", "Source file is a symlink");
    if (!info) throw new ImportError("E_SOURCE_UNSUPPORTED", "source-unreadable", "Source file is unreadable");
    if (info.type !== "file") throw new ImportError("E_SOURCE_UNSUPPORTED", "not-regular-file", "Source entry is not a regular file");
    if (info.size > maxBytes) throw new ImportError("E_IMPORT_FAILED", "file-too-large", "Source file exceeds its parser limit", 3);
    const bytes = await this.fs.readFile(path, maxBytes);
    const current = { size: bytes.length, sha256: digest(bytes) };
    const previous = this.files.get(path);
    if (bytes.length !== info.size || previous && (previous.size !== current.size || previous.sha256 !== current.sha256)) throw changed();
    this.files.set(path, current);
    return bytes;
  }

  async text(path: string, maxBytes: number): Promise<string> { return decodeSourceText(await this.read(path, maxBytes)); }

  async bounded(path: string, maximum: number): Promise<string | null> {
    if (!await this.isFile(path) || (await this.stat(path))!.size > maximum) return null;
    return this.text(path, maximum);
  }

  async envKeys(path: string): Promise<string[]> {
    const keys: string[] = [];
    for (const line of (await this.text(path, 1024 * 1024)).split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      if (match && !keys.includes(match[1]!)) keys.push(match[1]!);
    }
    return keys;
  }

  /** Hashes and names only; values and file bodies are never retained in this descriptor. */
  fingerprint(): string {
    return digest(Buffer.from(JSON.stringify({ files: [...this.files].sort(), directories: [...this.directories].sort() })));
  }

  async verify(prefix?: string): Promise<void> {
    for (const [path, expected] of [...this.files]) {
      if (prefix && path !== prefix && !path.startsWith(prefix + this.paths.sep)) continue;
      const bytes = await this.fs.readFile(path, expected.size);
      if (bytes.length !== expected.size || digest(bytes) !== expected.sha256) throw changed();
    }
    for (const [path, expected] of [...this.directories]) {
      if (prefix && path !== prefix && !path.startsWith(prefix + this.paths.sep)) continue;
      if (JSON.stringify([...await this.fs.readdir(path)].sort()) !== expected) throw changed();
    }
  }

  private async temporary<T>(run: (directory: string) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(native.join(tmpdir(), "p1-source-reader-"));
    try {
      if (!createSecurePath()(directory, { mode: 0o700 }).applied) throw new ImportError("E_NOT_AVAILABLE", "private-staging-unavailable", "Private staging is unavailable");
      return await run(directory);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  private async privateFile(path: string, bytes: Buffer): Promise<void> {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    if (!createSecurePath()(path, { mode: 0o600 }).applied) throw new ImportError("E_NOT_AVAILABLE", "private-staging-unavailable", "Private staging is unavailable");
  }

  async sqlite<T>(path: string, run: (handle: SqliteHandle) => T): Promise<T> {
    return this.temporary(async directory => {
      const local = native.join(directory, "source.db");
      for (const suffix of ["", "-wal", "-shm"]) {
        if (await this.isFile(path + suffix)) await this.privateFile(local + suffix, await this.read(path + suffix, 256 * 1024 * 1024));
      }
      await this.verify(path);
      for (const suffix of ["-wal", "-shm"]) if (await this.isFile(path + suffix)) await this.verify(path + suffix);
      const handle = openSqliteReadOnly(local, { onBusy: "throw" });
      try { return run(handle); } finally { handle.close(); }
    });
  }

  async directory<T>(path: string, run: (local: string) => Promise<T>): Promise<T> {
    return this.temporary(async directory => {
      const copy = async (source: string, target: string): Promise<void> => {
        for (const name of await this.names(source)) {
          const full = this.paths.join(source, name);
          const info = await this.stat(full, false);
          if (info?.type === "directory") { await mkdir(native.join(target, name), { mode: 0o700 }); await copy(full, native.join(target, name)); }
          else if (info?.type === "file") await this.privateFile(native.join(target, name), await this.read(full, 1024 ** 3));
          else throw new ImportError("E_SOURCE_UNSUPPORTED", "unsafe-source-entry", "Database tree has an unsupported entry");
        }
      };
      await copy(path, directory);
      await this.verify(path);
      return run(directory);
    });
  }
}
