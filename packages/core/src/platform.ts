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

/** Where a unix socket goes when the state root's own address does not fit `sun_path`. */
export interface IpcFallbackOptions {
  /** The directory that holds the per-user fallback directory; default `/tmp` (fixed, not `TMPDIR`: macOS's is already
   *  ~50 bytes, and every process of a user must compute the same address). */
  socketFallbackBase?: string;
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

/** `sun_path` holds 104 bytes on macOS and 108 on Linux and the BSDs, each including the terminating NUL. */
const maxSocketPathBytes = (platform: NodeJS.Platform): number => (platform === "darwin" ? 103 : 107);

/** The pipe name hashes the whole canonical state root (not a prefix of it: homes under one profile share their first
 *  bytes), so one state root has one pipe whatever its spelling and two state roots never share one.
 *
 *  On POSIX the socket is `<stateRoot>/embedding.sock` while that fits `sun_path`. A longer one cannot be bound, so it
 *  moves to `<base>/plur1bus-<euid>/embedding-<first 32 hex of sha256(canonical state root)>.sock` (base `/tmp`): a
 *  fixed, short place that depends only on the state root, so every process of the user computes the same address.
 *  That directory is created 0700 and must be ours and no symlink ({@link ensurePrivateDir}); when even that address
 *  does not fit, or the directory cannot be trusted, this throws instead of returning an address that cannot work.
 *  Only the unix-socket branch has a limit: Windows pipe names are unaffected. */
function ipcAddress(stateRoot: string, platform: NodeJS.Platform, o: IpcFallbackOptions = {}): IpcAddress {
  const identity = canonicalIdentityPath(stateRoot, platform);
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  if (platform === "win32") return { kind: "named-pipe", address: `\\\\.\\pipe\\plur1bus-embed-${hash}` };
  const limit = maxSocketPathBytes(platform);
  const direct = path.join(stateRoot, "embedding.sock");
  if (Buffer.byteLength(direct) <= limit) return { kind: "unix-socket", address: direct };
  const euid = o.euid ?? (typeof process.geteuid === "function" ? process.geteuid() : undefined);
  if (euid === undefined) throw new Error(`socket path ${direct} exceeds the ${limit}-byte limit and this platform has no uid to name a private fallback directory`);
  const dir = path.posix.join(o.socketFallbackBase ?? "/tmp", `plur1bus-${euid}`);
  const short = path.posix.join(dir, `embedding-${hash}.sock`);
  if (Buffer.byteLength(short) > limit) throw new Error(`socket path ${short} exceeds the ${limit}-byte limit (the state root ${stateRoot} is too long and so is the fallback base)`);
  ensurePrivateDir(dir, euid);
  return { kind: "unix-socket", address: short };
}

/** Makes `dir` a real directory of `euid` with mode 0700, as the run directory's checks demand (`checkRunDir`: no
 *  symlink, our uid, no group/other access). It is opened with `O_NOFOLLOW | O_DIRECTORY` and examined and tightened
 *  through that descriptor, so a symlink swapped in between check and use cannot redirect the chmod. Anything else
 *  (a symlink, a file, another user's directory) is refused. */
function ensurePrivateDir(dir: string, euid: number): void {
  try { mkdirSync(dir, { mode: 0o700 }); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new Error(`cannot create the socket directory ${dir}: ${(e as Error).message}`);
  }
  let fd: number;
  try { fd = openSync(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(code === "ELOOP" ? `socket directory ${dir} is a symlink` : code === "ENOTDIR" ? `socket directory ${dir} is not a directory` : `socket directory ${dir} cannot be opened: ${(e as Error).message}`);
  }
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
