/** Root-confined local source reads; all open handles close even if a deadline wins the caller's race. */
import { constants, type Stats } from "node:fs";
import { open, opendir, realpath, readlink, stat, lstat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { FsBudget } from "./budget.ts";
import { RemoteFsError, type FsLimits, type FsStat, type ReadonlyFs } from "./types.ts";

/** The selected source root is the only filesystem authority held by the returned object. */
export interface LocalFsOptions {
  root: string;
  limits?: Partial<FsLimits>;
  signal?: AbortSignal;
}

function view(stats: Stats): FsStat {
  return Object.freeze({
    type: stats.isFile() ? "file" : stats.isDirectory() ? "directory" : stats.isSymbolicLink() ? "symlink" : "other",
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  });
}

/** Creates a frozen six-operation port, refusing escapes and nonregular reads with fixed reasons. */
export async function createLocalFs(options: LocalFsOptions): Promise<ReadonlyFs> {
  const budget = new FsBudget(options.limits, options.signal);
  const root = await budget.operation(() => realpath(options.root));
  if (!(await budget.operation(() => stat(root))).isDirectory()) throw new RemoteFsError("unsupported-type");
  const within = (path: string): string => {
    const rel = relative(root, path);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new RemoteFsError("path-denied");
    budget.depth(rel ? rel.split(sep).length : 0);
    return path;
  };
  const lexical = (path: string): string => {
    budget.check();
    if (typeof path !== "string" || path.includes("\0") || path.length > 8192) throw new RemoteFsError("path-denied");
    return within(resolve(root, path));
  };
  const target = async (path: string): Promise<string> => within(await realpath(lexical(path)));
  const noFollowTarget = async (path: string): Promise<string> => {
    const full = lexical(path);
    return full === root ? root : within(resolve(within(await realpath(dirname(full))), basename(full)));
  };
  return Object.freeze({
    stat: (path: string) => budget.operation(async () => view(await stat(await target(path)))),
    lstat: (path: string) => budget.operation(async () => view(await lstat(await noFollowTarget(path)))),
    realpath: (path: string) => budget.operation(() => target(path)),
    readlink: (path: string) => budget.operation(async () => {
      const full = await noFollowTarget(path);
      const link = await readlink(full);
      within(await realpath(resolve(dirname(full), link)));
      return link;
    }),
    readdir: (path: string) => budget.operation(async () => {
      const full = await target(path);
      const dir = await opendir(full);
      const entries: string[] = [];
      try {
        for await (const entry of dir) {
          budget.addEntry();
          entries.push(entry.name);
        }
        return Object.freeze(entries.sort());
      } finally {
        await dir.close().catch(() => {});
      }
    }),
    readFile: (path: string, maxBytes: number) => budget.operation(async () => {
      const cap = budget.fileLimit(maxBytes);
      const full = await target(path);
      const preliminary = await lstat(full);
      if (!preliminary.isFile()) throw new RemoteFsError("unsupported-type");
      if (preliminary.size > cap) throw new RemoteFsError("file-limit");
      const handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        budget.check();
        const opened = await handle.stat();
        const current = await stat(await target(path));
        if (!opened.isFile()) throw new RemoteFsError("unsupported-type");
        if (opened.dev !== current.dev || opened.ino !== current.ino) throw new RemoteFsError("path-denied");
        if (opened.size > cap) throw new RemoteFsError("file-limit");
        if (opened.size > budget.remainingBytes()) throw new RemoteFsError("total-limit");
        const chunks: Buffer[] = [];
        let bytes = 0;
        for (;;) {
          budget.check();
          const chunk = Buffer.allocUnsafe(Math.min(65_536, cap - bytes + 1, budget.remainingBytes() + 1));
          const read = await handle.read(chunk, 0, chunk.length, bytes);
          if (read.bytesRead === 0) break;
          budget.addBytes(read.bytesRead);
          bytes += read.bytesRead;
          if (bytes > cap) throw new RemoteFsError("file-limit");
          chunks.push(Buffer.from(chunk.subarray(0, read.bytesRead)));
        }
        const final = await stat(await target(path));
        if (opened.dev !== final.dev || opened.ino !== final.ino) throw new RemoteFsError("path-denied");
        return Buffer.concat(chunks, bytes);
      } finally {
        await handle.close();
      }
    }),
  });
}
