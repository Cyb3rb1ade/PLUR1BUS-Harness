import { lstatSync, readFileSync, type Stats } from "node:fs";
import path from "node:path";
import { runDir } from "./paths.ts";

/**
 * Who may a client talk to? (audit M2; the Rust side is `crates/plur1bus-rpc/src/trust.rs`, the Python reference is
 * `clients/python/.../client.py`.)
 *
 * The POSIX trust model is "the `run/` directory is ours": a `0700` directory of the current user holds the sockets,
 * tokens and pid files. A client checks it before it reads a token or connects, and refuses (sending nothing) when
 * `run/` is a symlink, belongs to another uid or is writable by group or others, or when the socket is not ours.
 * Windows protects `run/` with a DACL instead; there the check is the pipe server's pid (see `client.ts`).
 *
 * Node cannot ask the kernel for the peer uid of a unix socket (`SO_PEERCRED`), so unlike the Rust and Python
 * clients this one cannot check it after connecting; the directory and socket checks before it are what is available.
 */
export type TrustVerdict = { ok: true } | { ok: false; reason: "run-dir-untrusted" | "socket-untrusted"; detail: string };

/** Platform and filesystem identity adapters for local endpoint trust checks. */
export interface TrustOptions {
  /** Defaults to the current platform; tests can select Windows behavior on any host. */
  platform?: NodeJS.Platform;
  /** The effective uid; default `process.geteuid()`. A test passes another uid to simulate a foreign owner. */
  euid?: number;
  lstat?: (p: string) => Pick<Stats, "isDirectory" | "isSymbolicLink" | "isSocket" | "uid" | "mode">;
}

const refuse = (reason: "run-dir-untrusted" | "socket-untrusted", detail: string): TrustVerdict => ({ ok: false, reason, detail });

function euidOf(o: TrustOptions): number | undefined {
  return o.euid ?? (typeof process.geteuid === "function" ? process.geteuid() : undefined);
}

/** `dir` must be a real directory of the current user that group and others cannot write to. A missing directory is
 *  `{ ok: true }`: that is "core absent", which the connect reports as it always did. */
/** Checks that a POSIX run directory is a real, current-user-owned directory not writable by others. */
export function checkRunDir(dir: string, o: TrustOptions = {}): TrustVerdict {
  if ((o.platform ?? process.platform) === "win32") return { ok: true };
  const euid = euidOf(o);
  let st: ReturnType<NonNullable<TrustOptions["lstat"]>>;
  try { st = (o.lstat ?? lstatSync)(dir); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: true };
    return refuse("run-dir-untrusted", `${dir} cannot be inspected: ${(e as Error).message}`);
  }
  if (st.isSymbolicLink()) return refuse("run-dir-untrusted", `${dir} is a symlink`);
  if (!st.isDirectory()) return refuse("run-dir-untrusted", `${dir} is not a directory`);
  if (euid !== undefined && st.uid !== euid) return refuse("run-dir-untrusted", `${dir} belongs to uid ${st.uid}, not to this user (uid ${euid})`);
  if ((st.mode & 0o022) !== 0) return refuse("run-dir-untrusted", `${dir} is writable by group or others (mode ${(st.mode & 0o7777).toString(8)})`);
  return { ok: true };
}

/** `file` must be a socket of the current user. A missing file is `{ ok: true }` (core absent). */
/** Checks that a POSIX RPC endpoint is a socket owned by the current user. */
export function checkSocketFile(file: string, o: TrustOptions = {}): TrustVerdict {
  if ((o.platform ?? process.platform) === "win32") return { ok: true };
  const euid = euidOf(o);
  let st: ReturnType<NonNullable<TrustOptions["lstat"]>>;
  try { st = (o.lstat ?? lstatSync)(file); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: true };
    return refuse("socket-untrusted", `${file} cannot be inspected: ${(e as Error).message}`);
  }
  if (!st.isSocket()) return refuse("socket-untrusted", `${file} is not a socket`);
  if (euid !== undefined && st.uid !== euid) return refuse("socket-untrusted", `${file} belongs to uid ${st.uid}, not to this user (uid ${euid})`);
  return { ok: true };
}

/** Before a client connects to `address`: a filesystem address on POSIX must live in a trusted `run/` directory and
 *  be a socket of ours. Pipe names and other addresses are not files and pass. */
export function checkAddress(address: string, o: TrustOptions = {}): TrustVerdict {
  if ((o.platform ?? process.platform) === "win32" || !path.isAbsolute(address)) return { ok: true };
  const dir = checkRunDir(path.dirname(address), o);
  return dir.ok ? checkSocketFile(address, o) : dir;
}

/** The pid in a `run/*.pid` file (`<pid> <instanceId>`), or undefined when the file is missing or unreadable. */
export function readRecordedPid(file: string): number | undefined {
  try {
    const first = readFileSync(file, "utf8").split(/\s+/).find((s) => s !== "");
    const pid = first === undefined ? NaN : Number(first);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch { return undefined; }
}

/** Thrown by [`readRunToken`] when `run/` is not trusted; nothing was read. */
export class UntrustedRunDir extends Error {
  readonly reason = "run-dir-untrusted"; readonly detail: string;
  constructor(detail: string) { super(`run/ is not trusted: ${detail}`); this.name = "UntrustedRunDir"; this.detail = detail; }
}

/** Reads a token file of `home`'s `run/` after checking `run/` itself (audit M2): nothing is read from a symlinked,
 *  foreign-owned or group/other-writable `run/`. A missing directory or file is the usual `ENOENT`. */
export function readRunToken(home: string, file: string, o: TrustOptions = {}): string {
  const v = checkRunDir(runDir(home), o);
  if (!v.ok) throw new UntrustedRunDir(v.detail);
  return readFileSync(file, "utf8").trim();
}
