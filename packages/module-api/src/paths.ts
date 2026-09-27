import { createHash } from "node:crypto";
import path from "node:path";

/** The one address rule of every process in a home (H3B-R9; the Rust side is `crates/plur1bus/src/paths.rs`):
 *  `run/<role>.sock` on POSIX, `\\.\pipe\plur1bus-<first 16 hex of sha256(lower-cased home)>-<role>` on Windows. */
export function pipeName(home: string, role: string): string {
  return `\\\\.\\pipe\\plur1bus-${createHash("sha256").update(home.toLowerCase()).digest("hex").slice(0, 16)}-${role}`;
}

/** The directory of a home's run files (tokens, pids, sockets). A home written with backslashes is a Windows path. */
export function runDir(home: string): string {
  return (home.includes("\\") ? path.win32 : path.posix).join(home, "run");
}

/** The RPC address of `role` (`core`, `supervisor`, `module-<name>`) in `home`. */
export function unitAddress(home: string, role: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? pipeName(home, role) : (home.includes("\\") ? path.win32 : path.posix).join(runDir(home), `${role}.sock`);
}

/** The supervisor's RPC address. */
export function supervisorAddress(home: string, platform: NodeJS.Platform = process.platform): string {
  return unitAddress(home, "supervisor", platform);
}

/** `run/supervisor.token`: the supervisor's RPC token (and the nonce `core.adopt` proves). */
export function supervisorTokenPath(home: string): string {
  return (home.includes("\\") ? path.win32 : path.posix).join(runDir(home), "supervisor.token");
}
