// The four file operations. Every path goes through the D109 canonicaliser and every open through `openVerified`
// (O_NOFOLLOW + identity re-check); nothing here calls `open(path)` on a caller-controlled string directly.
import { constants as fsc } from "node:fs";
import { link, lstat, opendir, rename, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { canonicalisePath, isPathRefusal, matchDeny, openVerified } from "../../policy/paths-index.ts";
import type { CanonicalPath, DenyEntry, PathRoot } from "../../policy/paths-index.ts";
import { FsFailure } from "./failure.ts";

export interface FsLimits {
  /** Largest read returned (bytes). Default 1 MiB. */
  maxReadBytes: number;
  /** Largest write accepted (bytes). Default 4 MiB. */
  maxWriteBytes: number;
  /** Most entries `file.list` returns. Default 1000. */
  maxListEntries: number;
}
export const DEFAULT_LIMITS: Readonly<FsLimits> = Object.freeze({ maxReadBytes: 1 << 20, maxWriteBytes: 4 << 20, maxListEntries: 1000 });
// RULING: a directory with more entries than this is refused rather than listed partially (a partial sorted list would
// depend on readdir order).
const LIST_SCAN_CAP = 10_000;

export interface FsConfig {
  roots: readonly PathRoot[];
  deny?: readonly DenyEntry[];
  /** RULING: relative paths resolve against this, default the first root. It must itself be inside a root. */
  cwd?: string;
  limits?: Partial<FsLimits>;
  /** Overrides `os.homedir()` for the policy's "home is never a root" rule (tests). */
  home?: string;
  /** Platform seam for the policy (tests). */
  platform?: NodeJS.Platform;
  /** Race-injection seam: honoured only with PLUR1BUS_ALLOW_TEST_INTERNALS=1, ignored otherwise. */
  testHooks?: { afterCheck?: (op: "read" | "write") => Promise<void> };
}
export interface OpContext { signal?: AbortSignal | undefined }

export interface FsOps {
  stat(args: { path: string }, ctx?: OpContext): Promise<StatResult>;
  list(args: { path: string; maxEntries?: number }, ctx?: OpContext): Promise<ListResult>;
  read(args: { path: string; encoding?: "auto" | "utf8" | "base64"; offset?: number; length?: number }, ctx?: OpContext): Promise<ReadResult>;
  write(args: { path: string; content: string; encoding?: "utf8" | "base64"; overwrite?: boolean }, ctx?: OpContext): Promise<WriteResult>;
}

export type EntryType = "file" | "directory" | "symlink" | "other";
export interface StatResult { rootId: string; path: string; type: EntryType; size: number; modifiedAt: string }
export interface ListEntry { name: string; type: EntryType; size?: number }
export interface ListResult { rootId: string; path: string; entries: ListEntry[]; truncated: boolean }
export interface ReadResult { rootId: string; path: string; encoding: "utf8" | "base64"; content: string; size: number; offset: number; bytesRead: number; truncated: boolean }
export interface WriteResult { rootId: string; path: string; bytesWritten: number; created: boolean }

const typeOf = (s: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): EntryType =>
  s.isFile() ? "file" : s.isDirectory() ? "directory" : s.isSymbolicLink() ? "symlink" : "other";

export function createFsOps(cfg: FsConfig): FsOps {
  const limits: FsLimits = { ...DEFAULT_LIMITS, ...cfg.limits };
  const roots = cfg.roots;
  if (roots.length === 0) throw new Error("createFsOps: at least one root is required");
  const windows = (cfg.platform ?? process.platform) === "win32";
  const sep = windows ? "\\" : "/";
  const cwd = cfg.cwd ?? roots[0]!.path;
  const afterCheck = process.env.PLUR1BUS_ALLOW_TEST_INTERNALS === "1" ? cfg.testHooks?.afterCheck : undefined;

  const canon = async (input: unknown, access: "read" | "write"): Promise<CanonicalPath> => {
    if (typeof input !== "string") throw new FsFailure("invalid-arguments", "path must be a string");
    const r = await canonicalisePath(input, {
      roots, cwd, access, requireRoot: true,
      ...(cfg.deny ? { deny: cfg.deny } : {}), ...(cfg.home !== undefined ? { home: cfg.home } : {}), ...(cfg.platform ? { platform: cfg.platform } : {}),
    });
    if (isPathRefusal(r)) {
      // A missing path is `not-found`, not a policy refusal, so the agent can list the parent. Policy reasons are kept.
      throw new FsFailure("path-refused", `${r.reason}: ${r.detail}`, r.reason);
    }
    return r;
  };
  const rootReal = new Map<string, string>();
  /** Root-relative `/` path, so a result never discloses the host's absolute layout. */
  const rel = async (c: CanonicalPath): Promise<{ rootId: string; path: string }> => {
    const id = c.rootId!;
    let base = rootReal.get(id);
    if (base === undefined) {
      // The root's own real path: canonicalise it (a root is always inside itself).
      const rp = roots.find((x) => x.id === id)!.path;
      const rc = await canonicalisePath(rp, { roots, access: "read", ...(cfg.home !== undefined ? { home: cfg.home } : {}), ...(cfg.platform ? { platform: cfg.platform } : {}) });
      if (isPathRefusal(rc)) throw new FsFailure("changed", "a root changed while the tool worked");
      base = rc.canonical;
      rootReal.set(id, base);
    }
    const tail = c.canonical === base ? "" : c.canonical.slice(base.endsWith(sep) ? base.length : base.length + 1);
    return { rootId: id, path: tail.split(sep).filter(Boolean).join("/") };
  };
  const checkAbort = (ctx?: OpContext): void => { if (ctx?.signal?.aborted) throw new FsFailure("aborted", "cancelled"); };
  const openOrFail = async (c: CanonicalPath, flags: number): Promise<FileHandle> => {
    const r = await openVerified(c, flags);
    if (isPathRefusal(r)) {
      if (r.reason === "not-found") throw new FsFailure("not-found", "no such file");
      if (r.reason === "identity-changed" || r.reason === "link-swap") throw new FsFailure("changed", `${r.reason}: ${r.detail}`, r.reason);
      throw new FsFailure("path-refused", `${r.reason}: ${r.detail}`, r.reason);
    }
    return r;
  };
  const ioFail = (e: unknown): FsFailure => {
    if (e instanceof FsFailure) return e;
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return new FsFailure("not-found", "no such file or directory");
    if (code === "ENOTDIR") return new FsFailure("not-a-directory", "a path component is not a directory");
    return new FsFailure("io-error", `file system error${code ? ` (${code})` : ""}`);
  };
  const guard = async <T>(run: () => Promise<T>): Promise<T> => { try { return await run(); } catch (e) { throw ioFail(e); } };

  const intArg = (v: unknown, name: string, min: number, max: number): number | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw new FsFailure("invalid-arguments", `${name} must be an integer between ${min} and ${max}`);
    return v;
  };

  // ---- stat -------------------------------------------------------------------------------------------------------
  const doStat: FsOps["stat"] = (args, ctx) => guard(async () => {
    checkAbort(ctx);
    const c = await canon(args?.path, "read");
    if (!c.exists) throw new FsFailure("not-found", "no such file or directory");
    // `canonical` is the real target, so `stat` (not `lstat`) describes it; the identity must still be the checked one.
    const st = await stat(c.canonical, { bigint: true });
    if (st.dev.toString() !== c.identity.dev || st.ino.toString() !== c.identity.ino) throw new FsFailure("changed", "the target was replaced");
    return { ...(await rel(c)), type: typeOf(st), size: Number(st.size), modifiedAt: new Date(Number(st.mtimeMs)).toISOString() };
  });

  // ---- list -------------------------------------------------------------------------------------------------------
  const doList: FsOps["list"] = (args, ctx) => guard(async () => {
    checkAbort(ctx);
    const max = intArg(args?.maxEntries, "maxEntries", 1, limits.maxListEntries) ?? limits.maxListEntries;
    const c = await canon(args?.path, "read");
    if (!c.exists) throw new FsFailure("not-found", "no such directory");
    const before = await stat(c.canonical, { bigint: true });
    if (!before.isDirectory()) throw new FsFailure("not-a-directory", "the target is not a directory");
    if (before.dev.toString() !== c.identity.dev || before.ino.toString() !== c.identity.ino) throw new FsFailure("changed", "the target was replaced");
    const names: string[] = [];
    const dir = await opendir(c.canonical);
    try {
      for await (const d of dir) {
        checkAbort(ctx);
        if (names.length >= LIST_SCAN_CAP) throw new FsFailure("too-large", `more than ${LIST_SCAN_CAP} entries`);
        names.push(d.name);
      }
    } finally { await dir.close().catch(() => {}); }
    const after = await stat(c.canonical, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino) throw new FsFailure("changed", "the directory was replaced while listing");
    names.sort();
    const entries: ListEntry[] = [];
    let truncated = false;
    for (const name of names) {
      // Deny-listed names (credential files) are not even named to the agent.
      if (cfg.deny && matchDeny(path.join(c.canonical, name), cfg.deny)) continue;
      if (entries.length >= max) { truncated = true; break; }
      try {
        const l = await lstat(path.join(c.canonical, name)); // never follows a link
        entries.push({ name, type: typeOf(l), ...(l.isFile() ? { size: l.size } : {}) });
      } catch { /* vanished between readdir and lstat */ }
    }
    return { ...(await rel(c)), entries, truncated };
  });

  // ---- read -------------------------------------------------------------------------------------------------------
  const strict = new TextDecoder("utf-8", { fatal: true });
  const decodeText = (buf: Buffer, moreFollows: boolean): string | null => {
    if (buf.includes(0)) return null;
    // A cut inside a multi-byte sequence at the end is not binary: drop the incomplete tail (at most 3 bytes).
    for (let drop = 0; drop <= (moreFollows ? 3 : 0) && drop < buf.length + 1; drop++) {
      try { return strict.decode(drop === 0 ? buf : buf.subarray(0, buf.length - drop)); } catch { /* try shorter */ }
    }
    return null;
  };

  const doRead: FsOps["read"] = (args, ctx) => guard(async () => {
    checkAbort(ctx);
    const encoding = args?.encoding ?? "auto";
    if (encoding !== "auto" && encoding !== "utf8" && encoding !== "base64") throw new FsFailure("invalid-arguments", "encoding must be auto, utf8 or base64");
    const offset = intArg(args?.offset, "offset", 0, Number.MAX_SAFE_INTEGER) ?? 0;
    const explicitLen = intArg(args?.length, "length", 1, limits.maxReadBytes);
    const c = await canon(args?.path, "read");
    if (!c.exists) throw new FsFailure("not-found", "no such file");
    await afterCheck?.("read");
    // O_NONBLOCK: opening a FIFO read-only must not hang waiting for a writer. It is ignored for regular files.
    const fh = await openOrFail(c, fsc.O_RDONLY | (fsc.O_NONBLOCK ?? 0));
    try {
      const st = await fh.stat({ bigint: true });
      // The decision is on the OPENED handle, so a swap after the check cannot make a device look like a file.
      if (!st.isFile()) throw new FsFailure("not-a-file", "not a regular file");
      const size = Number(st.size);
      const remaining = Math.max(0, size - offset);
      if (explicitLen === undefined && remaining > limits.maxReadBytes) {
        throw new FsFailure("too-large", `file has ${remaining} bytes beyond offset ${offset}; the limit is ${limits.maxReadBytes} (pass length to read a range)`);
      }
      const want = Math.min(explicitLen ?? limits.maxReadBytes, remaining);
      const buf = Buffer.allocUnsafe(want);
      let got = 0;
      while (got < want) {
        checkAbort(ctx);
        const { bytesRead } = await fh.read(buf, got, want - got, offset + got);
        if (bytesRead === 0) break; // the file shrank
        got += bytesRead;
      }
      const data = buf.subarray(0, got);
      const truncated = offset + got < size;
      const after = await fh.stat({ bigint: true });
      if (after.dev !== st.dev || after.ino !== st.ino) throw new FsFailure("changed", "the file was replaced while reading");
      const rp = await rel(c);
      if (encoding === "base64") return { ...rp, encoding: "base64" as const, content: data.toString("base64"), size, offset, bytesRead: got, truncated };
      // RULING: a ranged read that starts mid-codepoint is binary; binary is never returned as text.
      const text = decodeText(data, truncated);
      if (text === null) throw new FsFailure("binary-content", "content is not valid UTF-8 text");
      return { ...rp, encoding: "utf8" as const, content: text, size, offset, bytesRead: Buffer.byteLength(text, "utf8"), truncated };
    } finally { await fh.close().catch(() => {}); }
  });

  // ---- write ------------------------------------------------------------------------------------------------------
  const doWrite: FsOps["write"] = (args, ctx) => guard(async () => {
    checkAbort(ctx);
    const encoding = args?.encoding ?? "utf8";
    if (encoding !== "utf8" && encoding !== "base64") throw new FsFailure("invalid-arguments", "encoding must be utf8 or base64");
    if (typeof args?.content !== "string") throw new FsFailure("invalid-arguments", "content must be a string");
    if (args.overwrite !== undefined && typeof args.overwrite !== "boolean") throw new FsFailure("invalid-arguments", "overwrite must be a boolean");
    const overwrite = args.overwrite === true;
    if (encoding === "utf8" && !args.content.isWellFormed()) throw new FsFailure("invalid-arguments", "content contains a lone surrogate");
    if (encoding === "base64" && !/^[A-Za-z0-9+/]*={0,2}$/u.test(args.content)) throw new FsFailure("invalid-arguments", "content is not valid base64");
    // Size before any I/O (base64 length is a cheap upper bound; the exact check follows the decode).
    if (args.content.length > limits.maxWriteBytes * 2) throw new FsFailure("too-large", `content exceeds ${limits.maxWriteBytes} bytes`);
    const data = Buffer.from(args.content, encoding);
    if (data.length > limits.maxWriteBytes) throw new FsFailure("too-large", `content has ${data.length} bytes; the limit is ${limits.maxWriteBytes}`);

    const target = await canon(args.path, "write");
    if (target.exists) {
      const st = await stat(target.canonical, { bigint: true });
      if (!st.isFile()) throw new FsFailure("not-a-file", "the target is not a regular file");
      if (!overwrite) throw new FsFailure("exists", "a file already exists at that path");
    }
    const dir = path.dirname(target.canonical);
    const leaf = path.basename(target.canonical);
    // The temp file is a sibling (same file system, so rename is atomic) and goes through the same policy.
    const tmpPath = path.join(dir, `.${leaf.slice(0, 64)}.${randomBytes(6).toString("hex")}.p1tmp`);
    const tmp = await canon(tmpPath, "write");
    if (tmp.exists || tmp.canonical !== tmpPath) throw new FsFailure("changed", "temp path is not fresh");
    // RULING: created files are 0600; an overwrite keeps the existing permission bits (POSIX; Windows ignores the mode).
    let mode = 0o600;
    if (target.exists && !windows) mode = Number((await stat(target.canonical, { bigint: true })).mode & 0o777n);
    const fh = await openOrFail(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL);
    let tmpLive = true;
    try {
      try {
        if (!windows) await fh.chmod(mode);
        await fh.writeFile(data);
        await fh.sync();
      } finally { await fh.close().catch(() => {}); }
      checkAbort(ctx);
      await afterCheck?.("write");
      // Re-validate the destination right before the swap: the policy again, and the same file (or still absent).
      const again = await canon(args.path, "write");
      if (again.canonical !== target.canonical || again.rootId !== target.rootId) throw new FsFailure("changed", "the destination now resolves elsewhere");
      // dev/ino alone is not enough: a deleted file's inode number is recycled at once; the birth time (when reported) is not.
      const sameFile = (a: CanonicalPath, b: CanonicalPath): boolean =>
        a.identity.dev === b.identity.dev && a.identity.ino === b.identity.ino && (a.identity.birth === undefined || b.identity.birth === undefined || a.identity.birth === b.identity.birth);
      if (again.exists !== target.exists || (again.exists && !sameFile(again, target))) {
        throw new FsFailure("changed", "the destination was replaced since it was checked");
      }
      if (!sameFile({ ...again, identity: again.parentIdentity }, { ...target, identity: target.parentIdentity })) throw new FsFailure("changed", "the directory was replaced");
      if (overwrite) {
        // rename replaces a link at the destination instead of following it, so a swapped-in link cannot redirect it.
        await rename(tmp.canonical, target.canonical);
      } else {
        // No-clobber publish: link fails with EEXIST if anything (a file, a link) is there.
        try {
          await link(tmp.canonical, target.canonical);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "EEXIST") throw new FsFailure("exists", "a file already exists at that path");
          // File systems without hard links (FAT/exFAT, some network shares): fall back to check + rename.
          if (code !== "EPERM" && code !== "ENOSYS" && code !== "EOPNOTSUPP" && code !== "ENOTSUP") throw e;
          if (await lstat(target.canonical).then(() => true, () => false)) throw new FsFailure("exists", "a file already exists at that path");
          await rename(tmp.canonical, target.canonical);
          tmpLive = false;
          return { ...(await rel(target)), bytesWritten: data.length, created: true };
        }
        await unlink(tmp.canonical);
      }
      tmpLive = false;
      return { ...(await rel(target)), bytesWritten: data.length, created: !target.exists };
    } finally {
      if (tmpLive) await unlink(tmp.canonical).catch(() => {});
    }
  });

  return { stat: doStat, list: doList, read: doRead, write: doWrite };
}
