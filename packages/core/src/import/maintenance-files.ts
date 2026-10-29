/** Filesystem edge for cold maintenance copies. Source files are streamed and never overwritten through hard links. */
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { ImportError } from "./types.ts";

export interface MutationRoot {
  id: string;
  path: string;
  kind: "directory" | "file";
  /** Exact relative subtrees owned by another subsystem; never copied, fingerprinted, deleted or restored. */
  preserve?: readonly string[];
}

export interface ColdEntry {
  path: string;
  kind: "file" | "directory";
  size?: number;
  sha256?: string;
}

export interface ColdRoot extends MutationRoot {
  existed: boolean;
  entries: ColdEntry[];
}

export const coldUnavailable = () => new ImportError("E_IMPORT_FAILED", "cold-snapshot-unavailable",
  "Import maintenance snapshot is unavailable");
const HASH = /^[a-f0-9]{64}$(?![\s\S])/;

export function relativePath(value: string): boolean {
  return !!value && !value.includes("\\") && !value.includes("\0") && !value.includes(":")
    && value.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

export function normalizedRoots(roots: readonly MutationRoot[]): MutationRoot[] {
  if (!Array.isArray(roots) || !roots.length || roots.length > 64) throw coldUnavailable();
  const names = new Set<string>();
  return roots.map(root => {
    if (!/^[a-z][a-z0-9_-]{0,63}$(?![\s\S])/.test(root.id) || names.has(root.id) || !isAbsolute(root.path)
      || root.path === parse(root.path).root || !["file", "directory"].includes(root.kind)) throw coldUnavailable();
    names.add(root.id);
    const declared = [...root.preserve ?? []];
    // Core's OS lock is a held SQLite transaction. Its sidecars belong to that lock and must never be copied or
    // restored while the worker holds it; otherwise a later acquisition appears to modify the recovery baseline.
    const lockSidecars = declared.filter(path => /(?:^|\/)core\.lock$/.test(path))
      .flatMap(path => ["-journal", "-wal", "-shm"].map(suffix => path + suffix));
    const preserve = [...new Set([...declared, ...lockSidecars])].sort();
    if (preserve.length > 256 || preserve.some(path => !relativePath(path))
      || root.kind === "file" && preserve.length) throw coldUnavailable();
    return { id: root.id, path: resolve(root.path), kind: root.kind, preserve };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export async function noLinkedSegments(path: string, allowMissing = false): Promise<void> {
  if (!isAbsolute(path)) throw coldUnavailable();
  let current = parse(path).root;
  for (const part of resolve(path).slice(current.length).split(sep)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        // macOS exposes its OS-owned /private roots through these fixed aliases. Every user-controlled segment
        // below them is still checked, including links inside the selected home or any mutation root.
        const alias = process.platform === "darwin" && info.uid === 0
          ? new Map([["/var", "/private/var"], ["/tmp", "/private/tmp"], ["/etc", "/private/etc"]]).get(current)
          : undefined;
        if (!alias || await realpath(current) !== alias) throw coldUnavailable();
      }
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function openRegular(path: string): Promise<FileHandle> {
  await noLinkedSegments(path);
  const before = await lstat(path);
  if (!before.isFile()) throw coldUnavailable();
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) throw coldUnavailable();
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function writeAll(file: FileHandle, bytes: Buffer): Promise<void> {
  for (let offset = 0; offset < bytes.length;) {
    const result = await file.write(bytes, offset, bytes.length - offset);
    if (!result.bytesWritten) throw coldUnavailable();
    offset += result.bytesWritten;
  }
}

export async function streamRegular(path: string, options: {
  signal?: AbortSignal | undefined;
  destination?: string | undefined;
  expected?: { sha256: string; size: number } | undefined;
  maximum?: number | undefined;
} = {}): Promise<{ sha256: string; size: number }> {
  const input = await openRegular(path);
  let output: FileHandle | undefined;
  let temporary: string | undefined;
  try {
    const before = await input.stat();
    if (before.size > (options.maximum ?? Number.MAX_SAFE_INTEGER)) throw coldUnavailable();
    if (options.destination) {
      await noLinkedSegments(dirname(options.destination), true);
      await mkdir(dirname(options.destination), { recursive: true, mode: 0o700 });
      temporary = join(dirname(options.destination), `.import-copy-${randomBytes(16).toString("hex")}`);
      output = await open(temporary, "wx", 0o600);
    }
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let size = 0;
    for (;;) {
      options.signal?.throwIfAborted();
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > before.size || size > (options.maximum ?? Number.MAX_SAFE_INTEGER)) throw coldUnavailable();
      const bytes = buffer.subarray(0, bytesRead);
      digest.update(bytes);
      if (output) await writeAll(output, bytes);
    }
    const result = { sha256: digest.digest("hex"), size };
    const after = await input.stat();
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || options.expected && (result.size !== options.expected.size || result.sha256 !== options.expected.sha256)) {
      throw coldUnavailable();
    }
    if (output) {
      await output.sync();
      await output.close();
      output = undefined;
      await rename(temporary!, options.destination!);
      temporary = undefined;
      await syncDirectory(dirname(options.destination!));
    }
    return result;
  } finally {
    await input.close();
    await output?.close();
    if (temporary) await rm(temporary, { force: true });
  }
}

export async function syncDirectory(path: string): Promise<void> {
  // Windows does not expose directory handles with fsync through Node; each file is still flushed before rename.
  if (process.platform === "win32") return;
  const directory = await open(path, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function privateBytes(path: string, bytes: Buffer): Promise<void> {
  await noLinkedSegments(dirname(path));
  const file = await open(path, "wx", 0o600);
  try {
    await writeAll(file, bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(dirname(path));
}

export async function readColdBytes(path: string, maximum: number): Promise<Buffer> {
  const file = await openRegular(path);
  try {
    if ((await file.stat()).size > maximum) throw coldUnavailable();
    const bytes = await file.readFile();
    if (bytes.length > maximum) throw coldUnavailable();
    return bytes;
  } finally {
    await file.close();
  }
}

export async function scanMutationRoot(root: MutationRoot, options: {
  signal?: AbortSignal | undefined;
  file?: ((full: string, relative: string) => Promise<{ sha256: string; size: number }>) | undefined;
} = {}): Promise<ColdRoot> {
  await noLinkedSegments(root.path, true);
  let stat;
  try {
    stat = await lstat(root.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...root, existed: false, entries: [] };
    throw error;
  }
  if (root.kind === "directory" ? !stat.isDirectory() : !stat.isFile()) throw coldUnavailable();
  const entries: ColdEntry[] = [];
  const preserved = (path: string) => root.preserve?.some(keep => path === keep || path.startsWith(keep + "/"));
  const walk = async (full: string, path: string, depth: number): Promise<void> => {
    options.signal?.throwIfAborted();
    if (preserved(path)) return;
    if (depth > 64 || entries.length >= 100_000) throw coldUnavailable();
    const current = await lstat(full);
    if (current.isSymbolicLink()) throw coldUnavailable();
    if (current.isDirectory()) {
      if (path) entries.push({ path, kind: "directory" });
      for (const name of (await readdir(full)).sort()) await walk(join(full, name), path ? `${path}/${name}` : name, depth + 1);
    } else if (current.isFile()) {
      const digest = options.file ? await options.file(full, path) : await streamRegular(full, options);
      entries.push({ path, kind: "file", ...digest });
    } else {
      throw coldUnavailable();
    }
  };
  await walk(root.path, "", 0);
  return { ...root, existed: true, entries };
}

export function checkedEntry(entry: ColdEntry, root: MutationRoot): boolean {
  return (entry.path === "" && root.kind === "file" || relativePath(entry.path))
    && (entry.kind === "directory" && entry.size === undefined && entry.sha256 === undefined
      || entry.kind === "file" && Number.isSafeInteger(entry.size) && entry.size! >= 0
        && typeof entry.sha256 === "string" && HASH.test(entry.sha256));
}
