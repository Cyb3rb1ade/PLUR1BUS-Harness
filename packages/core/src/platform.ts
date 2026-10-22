import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import type { IpcAddress, PlatformCapabilities } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import { createSecurePath, type SecurePathOptions } from "@plur1bus/module-api";

// securePath and its Windows ACL helpers live in @plur1bus/module-api (H3B-R12): module processes secure their run
// files the same way.
export {
  othersInDacl, parseSddlDacl, parseWhoamiSid, resolveSddlTrustee, savedSddlLine, systemTool,
  type ExecFile, type SddlAce, type SecurePathOptions as PlatformOptions,
} from "@plur1bus/module-api";

/** Where a unix socket goes when the state root's own address does not fit `sun_path`. The two bases are test seams:
 *  every process of a user must compute the same address, so production never overrides them. */
export interface IpcFallbackOptions {
  /** The directory that holds the per-user fallback directory `plur1bus-<euid>`; default `/tmp` (fixed, not `TMPDIR`:
   *  macOS's is already ~50 bytes). */
  socketFallbackBase?: string;
  /** Linux only: the directory that holds the per-login-user runtime directories (`<base>/<euid>`); default `/run/user`. */
  runtimeDirBase?: string;
  /** The effective uid that owns the fallback directory; default `process.geteuid()`. */
  euid?: number;
}

/** The host's platform capabilities (engine `PlatformCapabilities`); `securePath` is module-api's `createSecurePath`. */
export function createPlatformCapabilities(o: SecurePathOptions & IpcFallbackOptions = {}): PlatformCapabilities {
  const platform = o.platform ?? process.platform;
  return {
    securePath: createSecurePath(o),
    ipcAddress: (stateRoot: string) => ipcAddress(stateRoot, platform, o),
    isUnsafeLink,
    canonicalIdentityPath: (p: string) => canonicalIdentityPath(p, platform),
  };
}

/** `sun_path` is a 108-byte buffer on Linux (and Android) and a 104-byte one on macOS, FreeBSD, OpenBSD and NetBSD; the
 *  last byte is the terminating NUL. Any other POSIX platform gets the smaller limit: a path that is too short for it is
 *  merely moved to the fallback directory earlier, never refused by the kernel. */
const maxSocketPathBytes = (platform: NodeJS.Platform): number => (platform === "linux" || platform === "android" ? 107 : 103);

/** The pipe name hashes the whole canonical state root (not a prefix of it: homes under one profile share their first
 *  bytes), so one state root has one pipe whatever its spelling and two state roots never share one.
 *
 *  On POSIX the socket is `<root>/embedding.sock` while that fits `sun_path`. A longer one cannot be bound, so it moves
 *  to `<dir>/embedding-<first 32 hex of sha256(root)>.sock` in the first trustworthy directory of a fixed candidate
 *  list: on Linux `/run/user/<euid>/plur1bus` (logind's per-user runtime directory, which no temp reaper empties), then
 *  `/tmp/plur1bus-<euid>`. `root` is the canonical identity of the state root both for the fits-or-not decision and for
 *  the hash, so two spellings of one root (NFC and NFD on macOS, a trailing separator) cannot end up with two sockets.
 *  The list and its order depend only on the platform and the uid, so every process of the user picks the same
 *  address. A candidate must be a real directory of ours with mode 0700 and no symlink ({@link ensurePrivateDir}; a
 *  runtime directory is checked, not created or tightened); an untrustworthy or too long one is passed over for the
 *  next, and only when all are refused this throws, naming each reason, rather than return an address that cannot work.
 *  Only the unix-socket branch has a limit: Windows pipe names are unaffected. */
function ipcAddress(stateRoot: string, platform: NodeJS.Platform, o: IpcFallbackOptions = {}): IpcAddress {
  const identity = canonicalIdentityPath(stateRoot, platform);
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  if (platform === "win32") return { kind: "named-pipe", address: `\\\\.\\pipe\\plur1bus-embed-${hash}` };
  const limit = maxSocketPathBytes(platform);
  // Unix socket paths are POSIX paths whatever host computes them (a win32 `path.join` would insert backslashes).
  const direct = path.posix.join(identity, "embedding.sock");
  if (Buffer.byteLength(direct) <= limit) return { kind: "unix-socket", address: direct };
  const euid = o.euid ?? (typeof process.geteuid === "function" ? process.geteuid() : undefined);
  if (euid === undefined) throw new Error(`socket path ${direct} exceeds the ${limit}-byte limit and this platform has no uid to name a private fallback directory`);
  const failures: string[] = [];
  for (const c of fallbackCandidates(platform, euid, o)) {
    const short = path.posix.join(c.dir, `embedding-${hash}.sock`);
    if (Buffer.byteLength(short) > limit) { failures.push(`socket path ${short} exceeds the ${limit}-byte limit`); continue; }
    try {
      if (c.parent !== undefined) requirePrivateDir(c.parent, euid);
      ensurePrivateDir(c.dir, euid);
      return { kind: "unix-socket", address: short };
    } catch (e) { failures.push((e as Error).message); }
  }
  throw new Error(`socket path ${direct} exceeds the ${limit}-byte limit and no fallback directory is usable: ${failures.join("; ")}`);
}

/** The fallback directories in the fixed order of preference. `parent`, when given, must already be a private
 *  directory of the user (it is checked, never created). */
function fallbackCandidates(platform: NodeJS.Platform, euid: number, o: IpcFallbackOptions): { parent?: string; dir: string }[] {
  const list: { parent?: string; dir: string }[] = [];
  if (platform === "linux") {
    const parent = path.posix.join(o.runtimeDirBase ?? "/run/user", String(euid));
    list.push({ parent, dir: path.posix.join(parent, "plur1bus") });
  }
  list.push({ dir: path.posix.join(o.socketFallbackBase ?? "/tmp", `plur1bus-${euid}`) });
  return list;
}

/** Opens `dir` with `O_NOFOLLOW | O_DIRECTORY` and returns the descriptor, or throws a reason that names `dir`. */
function openDirNoFollow(dir: string, what: string): number {
  try { return openSync(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(code === "ELOOP" ? `${what} ${dir} is a symlink` : code === "ENOTDIR" ? `${what} ${dir} is not a directory` : code === "ENOENT" ? `${what} ${dir} does not exist` : `${what} ${dir} cannot be opened: ${(e as Error).message}`);
  }
}

/** Checks, and never changes, that `dir` is a real directory of `euid` with no group/other access (logind's
 *  `/run/user/<euid>`: it is the system's to manage, not ours to chmod). */
function requirePrivateDir(dir: string, euid: number): void {
  const fd = openDirNoFollow(dir, "runtime directory");
  try {
    const st = fstatSync(fd);
    if (!st.isDirectory()) throw new Error(`runtime directory ${dir} is not a directory`);
    if (st.uid !== euid) throw new Error(`runtime directory ${dir} belongs to uid ${st.uid}, not to this user (uid ${euid})`);
    if ((st.mode & 0o077) !== 0) throw new Error(`runtime directory ${dir} is accessible to others (mode ${(st.mode & 0o777).toString(8)})`);
  } finally { closeSync(fd); }
}

/** Makes `dir` a real directory of `euid` with mode 0700, as the run directory's checks demand (`checkRunDir`: no
 *  symlink, our uid, no group/other access). It is opened with `O_NOFOLLOW | O_DIRECTORY` and examined and tightened
 *  through that descriptor, so a symlink swapped in between check and use cannot redirect the chmod. Anything else
 *  (a symlink, a file, another user's directory) is refused. */
function ensurePrivateDir(dir: string, euid: number): void {
  try { mkdirSync(dir, { mode: 0o700 }); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new Error(`cannot create the socket directory ${dir}: ${(e as Error).message}`);
  }
  const fd = openDirNoFollow(dir, "socket directory");
  try {
    const st = fstatSync(fd);
    if (!st.isDirectory()) throw new Error(`socket directory ${dir} is not a directory`);
    if (st.uid !== euid) throw new Error(`socket directory ${dir} belongs to uid ${st.uid}, not to this user (uid ${euid})`);
    if ((st.mode & 0o077) !== 0) fchmodSync(fd, 0o700);
  } finally { closeSync(fd); }
}

/** Fails closed: only "nothing there" is safe. A path that cannot be examined (permission, too long, a link loop) is not
 *  vouched for. */
function isUnsafeLink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

/** The comparison key of a path: normalised, without a trailing separator (the root keeps its own), Windows paths
 *  lower-cased with the extended-length (question-mark) and UNC prefixes removed, macOS paths in NFC (the default volume treats NFC and NFD as one name). */
function canonicalIdentityPath(p: string, platform: NodeJS.Platform): string {
  const flavour = platform === "win32" ? path.win32 : path.posix;
  let s = p;
  if (platform === "win32") s = s.replace(/^\\\\[?.]\\UNC\\/i, "\\\\").replace(/^\\\\[?.]\\(?=[A-Za-z]:)/, "");
  s = flavour.normalize(s);
  if (platform === "win32") s = s.toLowerCase();
  if (platform === "darwin") s = s.normalize("NFC");
  const root = flavour.parse(s).root;
  while (s.length > root.length && s.endsWith(flavour.sep)) s = s.slice(0, -1);
  return s;
}

export const platformCapabilities: PlatformCapabilities = createPlatformCapabilities();
