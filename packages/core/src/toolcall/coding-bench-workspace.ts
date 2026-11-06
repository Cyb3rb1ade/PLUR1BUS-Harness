/** B1 source copying and frozen images. Trusted fixture copies are separate from shared-provisioner live worktrees. */
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { CodingSourceFile } from "./coding-bench-corpus.ts";

/** Trusted original-fixture copy only. Live card worktrees come exclusively from #820's provisioner. */
export interface CodingFixtureWorkspace {
  root: string;
  tree: string;
  close(): Promise<void>;
}

/** Frozen candidate bytes retained outside the verifier root, restored for each independent hidden invocation. */
export type CodingImage = Map<string, { data: Buffer; mode: number }>;

/** Snapshot limits and a missing/nonregular entry are candidate failures; unexpected I/O errors propagate. */
export class CodingSnapshotInvalid extends Error {
  readonly ignoredEntries: number;
  constructor(message: string, ignoredEntries: number) {
    super(message);
    this.ignoredEntries = ignoredEntries;
  }
}

export interface CodingSnapshot {
  image: CodingImage;
  ignoredEntries: number;
}

/** Copy only bounded regular code files after the subject has stopped. Never inspect Git metadata on the host. */
export async function snapshotCodingSources(root: string, entry: string): Promise<CodingSnapshot> {
  const image: CodingImage = new Map();
  const ignored = new Set([".git", "target", "node_modules", "__pycache__", ".cache", ".build"]);
  let bytes = 0;
  let entries = 0;
  let ignoredEntries = 0;
  const initial = await lstat(root);
  if (!initial.isDirectory() || initial.isSymbolicLink()) {
    throw new Error("invalid coding snapshot root");
  }
  async function walk(relative: string, depth: number): Promise<void> {
    if (depth > 32) throw new CodingSnapshotInvalid("coding snapshot depth limit", ignoredEntries);
    for (const name of (await readdir(join(root, relative))).sort()) {
      if (++entries > 2048) throw new CodingSnapshotInvalid("coding snapshot entry limit", ignoredEntries);
      const rel = relative ? `${relative}/${name}` : name;
      const source = join(root, rel);
      const stat = await lstat(source);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        ignoredEntries++;
        continue;
      }
      if (ignored.has(name)) continue;
      if (!codingSourceName(rel)) {
        ignoredEntries++;
        continue;
      }
      if (stat.isDirectory()) await walk(rel, depth + 1);
      else {
        // The stopped subject's fixtures are untrusted. A final-component race must never follow a link or block on a FIFO.
        let file;
        try {
          file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ELOOP") throw error;
          ignoredEntries++;
          continue;
        }
        try {
          const current = await file.stat();
          if (!current.isFile()) {
            ignoredEntries++;
            continue;
          }
          if (current.size > 16_777_216 || bytes + current.size > 16_777_216) {
            throw new CodingSnapshotInvalid("coding snapshot file limit", ignoredEntries);
          }
          const data = await file.readFile();
          bytes += data.length;
          if (bytes > 16_777_216) throw new CodingSnapshotInvalid("coding snapshot byte limit", ignoredEntries);
          image.set(rel, { data, mode: current.mode & 0o100 ? 0o700 : 0o600 });
        } finally {
          await file.close();
        }
      }
    }
  }
  await walk("", 0);
  if (!image.has(entry)) throw new CodingSnapshotInvalid("coding snapshot entry missing or nonregular", ignoredEntries);
  return { image, ignoredEntries };
}

/** Restore an immutable code image into a fresh private directory; no hardlinks or source aliases. */
export async function writeCodingImage(
  root: string,
  image: ReadonlyMap<string, { data: Buffer; mode: number }>,
): Promise<void> {
  for (const [name, file] of image) {
    if (!codingSourceName(name)) throw new Error("invalid coding image path");
    const target = join(root, name);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.data, { mode: file.mode, flag: "wx" });
  }
}

/** Public source names cannot overwrite Git administration or escape their private seed repository. */
export function codingSourceName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 512 &&
    !isAbsolute(name) &&
    !/[\\\0\r\n:]/u.test(name) &&
    name.split("/").every((part) => !!part && part !== "." && part !== ".." && part !== ".git")
  );
}

/** Write only bounded public text with explicit private modes; callers own the fresh destination. */
export async function writeCodingSources(root: string, files: ReadonlyMap<string, CodingSourceFile>): Promise<void> {
  let bytes = 0;
  if (files.size > 512 || !files.size) throw new Error("invalid coding source count");
  for (const [name, file] of files) {
    bytes += Buffer.byteLength(file.text);
    if (!codingSourceName(name) || ![0o600, 0o700].includes(file.mode) || bytes > 16_777_216) {
      throw new Error("invalid coding source");
    }
  }
  for (const [name, file] of files) {
    const target = join(root, name);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.text, { mode: file.mode, flag: "wx" });
  }
}

/** Stage trusted original fixture files without invoking a model, Git or the live worktree provisioner. */
export async function stageCodingFixture(
  files: ReadonlyMap<string, CodingSourceFile>,
  signal: AbortSignal,
): Promise<CodingFixtureWorkspace> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "p1b-coding-case-")));
  const tree = join(root, "fixture");
  try {
    signal.throwIfAborted();
    await mkdir(tree, { mode: 0o700 });
    await writeCodingSources(tree, files);
    return {
      root,
      tree,
      async close() {
        await rm(root, { recursive: true, force: true, maxRetries: 3 });
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
    throw error;
  }
}
