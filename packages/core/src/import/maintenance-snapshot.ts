/** A cold, complete baseline for supervised imports. Engine owners must be closed before these operations. */
import { createHash } from "node:crypto";
import { lstat, mkdir, rename, rm, rmdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { createSecurePath } from "@plur1bus/module-api";
import { maintenanceRunDirectory } from "./maintenance-journal.ts";
import {
  checkedEntry, coldUnavailable, noLinkedSegments, normalizedRoots, privateBytes, readColdBytes,
  scanMutationRoot, streamRegular, syncDirectory, type ColdEntry, type ColdRoot, type MutationRoot,
} from "./maintenance-files.ts";
export { fingerprintMutationRoots } from "./target-fingerprint.ts";

export type { MutationRoot } from "./maintenance-files.ts";

interface ColdManifest {
  schema: "import.cold-snapshot/1";
  runId: string;
  roots: ColdRoot[];
  config: { existed: boolean; sha256: string | null; size: number };
  bytes: number;
}

export interface ColdSnapshotOptions {
  home: string;
  runId: string;
  roots: readonly MutationRoot[];
  config: Buffer | null;
  signal?: AbortSignal;
  maxBytes?: number;
  /** A resumed run must retain the authenticated original baseline. */
  expectedSha256?: string;
}

export interface ColdRestoreOptions {
  home: string;
  runId: string;
  roots: readonly MutationRoot[];
  sha256: string;
  restoreConfig: (sha256: string | null) => Promise<void>;
}

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const sourceFile = (base: string, root: ColdRoot, entry: ColdEntry) => join(base, "roots", root.id, entry.path);

function rootBinding(root: MutationRoot) {
  return { id: root.id, path: root.path, kind: root.kind, preserve: root.preserve ?? [] };
}

function boundRoots(home: string, runId: string, roots: readonly MutationRoot[]): MutationRoot[] {
  const result = normalizedRoots(roots);
  const run = join(home, "imports", runId);
  for (const root of result) {
    // Never recursively back up the rollback copy, its ancestors, or overlapping mutation authorities.
    const toRun = relative(root.path, run);
    if (!toRun.startsWith(".." + sep) && toRun !== ".." && !toRun.startsWith(sep)) throw coldUnavailable();
    for (const child of result) {
      if (root === child) continue;
      const rel = relative(root.path, child.path).split(sep).join("/");
      if (rel === "" || !rel.startsWith("../") && rel !== ".." && !rel.startsWith("/")) {
        if (!root.preserve?.some(keep => rel === keep || rel.startsWith(keep + "/"))) throw coldUnavailable();
      }
    }
  }
  return result;
}

async function loadManifest(base: string, runId: string, roots: readonly MutationRoot[], sha256?: string) {
  const bytes = await readColdBytes(join(base, "manifest.json"), 32 * 1024 * 1024);
  if (sha256 !== undefined && digest(bytes) !== sha256) throw coldUnavailable();
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object") throw coldUnavailable();
  const manifest = value as ColdManifest;
  if (manifest.schema !== "import.cold-snapshot/1" || manifest.runId !== runId || !Array.isArray(manifest.roots)
    || manifest.roots.length !== roots.length || !manifest.config || typeof manifest.config.existed !== "boolean"
    || !Number.isSafeInteger(manifest.config.size) || manifest.config.size < 0
    || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 0) throw coldUnavailable();
  for (let index = 0; index < roots.length; index++) {
    const root = manifest.roots[index]!;
    if (JSON.stringify(rootBinding(root)) !== JSON.stringify(rootBinding(roots[index]!))
      || typeof root.existed !== "boolean" || !Array.isArray(root.entries) || root.entries.length > 100_000) {
      throw coldUnavailable();
    }
    const seen = new Set<string>();
    for (const entry of root.entries) {
      if (!checkedEntry(entry, root) || seen.has(entry.path)
        || root.preserve?.some(keep => entry.path === keep || entry.path.startsWith(keep + "/"))) throw coldUnavailable();
      seen.add(entry.path);
    }
    if (!root.existed && root.entries.length) throw coldUnavailable();
  }
  if (manifest.config.existed) {
    if (typeof manifest.config.sha256 !== "string") throw coldUnavailable();
    await streamRegular(join(base, "config.json"), { expected: {
      sha256: manifest.config.sha256, size: manifest.config.size,
    } });
  } else if (manifest.config.sha256 !== null || manifest.config.size !== 0) {
    throw coldUnavailable();
  }
  return { manifest, sha256: digest(bytes), bytes: manifest.bytes };
}

async function verifyCopies(base: string, manifest: ColdManifest): Promise<void> {
  for (const root of manifest.roots) {
    for (const entry of root.entries) {
      const path = sourceFile(base, root, entry);
      if (entry.kind === "file") {
        await streamRegular(path, { expected: { sha256: entry.sha256!, size: entry.size! } });
      } else {
        await noLinkedSegments(path);
        if (!(await lstat(path)).isDirectory()) throw coldUnavailable();
      }
    }
  }
}

/** Reopening on resume reuses the first cold baseline; it must never snapshot a partially imported target. */
export async function createColdSnapshot(options: ColdSnapshotOptions) {
  const run = maintenanceRunDirectory(options.home, options.runId);
  const roots = boundRoots(options.home, options.runId, options.roots);
  const base = join(run, "cold-snapshot");
  const pending = join(run, ".cold-snapshot.pending");
  let owned = false;
  try {
    const existing = await lstat(base).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    });
    if (existing) {
      const result = await loadManifest(base, options.runId, roots, options.expectedSha256);
      await verifyCopies(base, result.manifest);
      return { sha256: result.sha256, bytes: result.bytes };
    }
    if (options.expectedSha256) throw coldUnavailable();
    await noLinkedSegments(pending, true);
    await rm(pending, { recursive: true, force: true });
    await mkdir(pending, { mode: 0o700 });
    owned = true;
    if (!createSecurePath()(pending, { mode: 0o700 }).applied) throw coldUnavailable();
    await mkdir(join(pending, "roots"), { mode: 0o700 });
    const maximum = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(maximum) || maximum < 0) throw coldUnavailable();
    let bytes = options.config?.length ?? 0;
    if (bytes > maximum) throw coldUnavailable();
    if (options.config) await privateBytes(join(pending, "config.json"), options.config);
    const copied: ColdRoot[] = [];
    for (const root of roots) {
      if (root.kind === "directory") await mkdir(join(pending, "roots", root.id), { mode: 0o700 });
      copied.push(await scanMutationRoot(root, { signal: options.signal, file: async (full, path) => {
        const result = await streamRegular(full, { signal: options.signal, maximum: maximum - bytes,
          destination: join(pending, "roots", root.id, path) });
        bytes += result.size;
        return result;
      } }));
      for (const entry of copied.at(-1)!.entries) {
        if (entry.kind === "directory") await mkdir(join(pending, "roots", root.id, entry.path),
          { recursive: true, mode: 0o700 });
      }
    }
    const manifest: ColdManifest = { schema: "import.cold-snapshot/1", runId: options.runId, roots: copied,
      config: { existed: options.config !== null, sha256: options.config ? digest(options.config) : null,
        size: options.config?.length ?? 0 }, bytes };
    const raw = Buffer.from(JSON.stringify(manifest) + "\n");
    if (raw.length > 32 * 1024 * 1024) throw coldUnavailable();
    await privateBytes(join(pending, "manifest.json"), raw);
    options.signal?.throwIfAborted();
    await syncDirectory(pending);
    await rename(pending, base);
    owned = false;
    await syncDirectory(run);
    return { sha256: digest(raw), bytes };
  } catch {
    throw coldUnavailable();
  } finally {
    if (owned) await rm(pending, { recursive: true, force: true });
  }
}

async function restoreRoot(base: string, before: ColdRoot, current: ColdRoot): Promise<void> {
  const wanted = new Map(before.entries.map(entry => [entry.path, entry]));
  for (const entry of [...current.entries].sort((a, b) => b.path.length - a.path.length)) {
    const baseline = wanted.get(entry.path);
    if (baseline?.kind === entry.kind) continue;
    if (before.preserve?.some(keep => keep.startsWith(entry.path + "/"))) continue;
    const path = join(before.path, entry.path);
    if (entry.kind === "directory") await rmdir(path);
    else await rm(path, { force: true });
  }
  if (!before.existed) {
    if (current.existed && !before.preserve?.length) {
      if (before.kind === "directory") await rmdir(before.path);
      else await rm(before.path, { force: true });
    }
    return;
  }
  if (before.kind === "directory") await mkdir(before.path, { recursive: true, mode: 0o700 });
  for (const entry of before.entries) {
    const target = join(before.path, entry.path);
    if (entry.kind === "directory") await mkdir(target, { recursive: true, mode: 0o700 });
    else await streamRegular(sourceFile(base, before, entry), {
      destination: target, expected: { sha256: entry.sha256!, size: entry.size! },
    });
  }
}

/** All backup hashes and current target path types are verified before the first restorative mutation. */
export async function restoreColdSnapshot(options: ColdRestoreOptions): Promise<void> {
  try {
    const roots = boundRoots(options.home, options.runId, options.roots);
    const base = join(maintenanceRunDirectory(options.home, options.runId), "cold-snapshot");
    const { manifest } = await loadManifest(base, options.runId, roots, options.sha256);
    await verifyCopies(base, manifest);
    const current: ColdRoot[] = [];
    for (const root of roots) current.push(await scanMutationRoot(root));
    for (let index = 0; index < roots.length; index++) await restoreRoot(base, manifest.roots[index]!, current[index]!);
    await options.restoreConfig(manifest.config.sha256);
  } catch {
    throw coldUnavailable();
  }
}
