/** Local source reads with explicit confined or native authority; handles close even when a deadline wins. */
import { constants, type Dirent, type Stats } from "node:fs";
import { open, opendir, realpath, readlink, stat, lstat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { FsBudget } from "./budget.ts";
import { localSourceRelativePath } from "./local-paths.ts";
import { RemoteFsError, type FsLimits, type FsStat, type ReadonlyFs } from "./types.ts";

const WSL_SHARE = /^\\\\wsl(?:\$|\.localhost)\\/i;
const SHARE_LINK: FsStat = Object.freeze({ type: "symlink", size: 0, mode: 0, mtimeMs: 0 });

/**
 * Windows cannot lstat a Linux symlink on a WSL share (`\\wsl.localhost\…`, `\\wsl$\…`): the call fails with EISDIR, while
 * the share's own directory listing names the entry a link. Only for that failure the listing answers, with a link of
 * unknown size and mode; every other error, path and platform keeps the native answer (undefined here).
 */
export async function wslShareLinkStat(full: string, error: unknown, platform: NodeJS.Platform = process.platform,
  list: (directory: string) => Promise<AsyncIterable<Dirent>> = opendir, check: () => void = () => {}): Promise<FsStat | undefined> {
  if (platform !== "win32" || !WSL_SHARE.test(full) || (error as NodeJS.ErrnoException)?.code !== "EISDIR") return undefined;
  const name = win32.basename(full);
  for await (const entry of await list(win32.dirname(full))) {
    check();
    if (entry.name === name) return entry.isSymbolicLink() ? SHARE_LINK : undefined;
  }
  return undefined;
}

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
    mode: stats.mode & 0o777,
    mtimeMs: stats.mtimeMs,
  });
}

/** Creates a frozen six-operation port, refusing escapes and nonregular reads with fixed reasons. */
export async function createLocalFs(options: LocalFsOptions): Promise<ReadonlyFs> {
  const budget = new FsBudget(options.limits, options.signal);
  const selectedRoot = resolve(options.root);
  const root = await budget.operation(() => realpath(options.root));
  if (!(await budget.operation(() => stat(root))).isDirectory()) throw new RemoteFsError("unsupported-type");
  return localFs(budget, { root, selectedRoot });
}

/** Native CLI discovery can read all local volumes; configured sources must use createLocalFs for confinement. */
export async function createNativeSourceFs(options: Omit<LocalFsOptions, "root"> = {}): Promise<ReadonlyFs> {
  return localFs(new FsBudget(options.limits, options.signal));
}

function localFs(budget: FsBudget, authority?: { root: string; selectedRoot: string }): ReadonlyFs {
  const root = authority?.root;
  const within = (path: string): string => {
    const rel = localSourceRelativePath(path, root);
    budget.depth(rel ? rel.split(sep).length : 0);
    return path;
  };
  const lexical = (path: string): string => {
    budget.check();
    if (typeof path !== "string" || path.includes("\0") || path.length > 8192) throw new RemoteFsError("path-denied");
    const full = root === undefined ? resolve(path) : resolve(root, path);
    if (authority && isAbsolute(path) && authority.selectedRoot !== root) {
      const selected = relative(authority.selectedRoot, full);
      if (selected !== ".." && !selected.startsWith(`..${sep}`) && !isAbsolute(selected)) {
        // The explicitly selected alias is translated to the authority pinned at creation, never followed again.
        return within(resolve(authority.root, selected));
      }
    }
    return within(full);
  };
  const target = async (path: string): Promise<string> => {
    const full = lexical(path);
    try {
      return within(await realpath(full));
    } catch (error) {
      // A link this host cannot resolve (a Linux symlink seen through a WSL share points at a Linux path) is denied
      // like a link that escapes, never followed; any other failure keeps its own reason.
      if (!(error instanceof RemoteFsError) && (error as NodeJS.ErrnoException).code !== "ENOENT"
        && await lstat(full).then(info => info.isSymbolicLink(), () => false)) throw new RemoteFsError("path-denied");
      throw error;
    }
  };
  const noFollowTarget = async (path: string): Promise<string> => {
    const full = lexical(path);
    return full === root ? root : within(resolve(within(await realpath(dirname(full))), basename(full)));
  };
  return Object.freeze({
    stat: (path: string) => budget.operation(async () => view(await stat(await target(path)))),
    lstat: (path: string) => budget.operation(async () => {
      const full = await noFollowTarget(path);
      try {
        return view(await lstat(full));
      } catch (error) {
        const link = await wslShareLinkStat(full, error, process.platform, opendir, () => budget.check());
        if (link) return link;
        throw error;
      }
    }),
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
