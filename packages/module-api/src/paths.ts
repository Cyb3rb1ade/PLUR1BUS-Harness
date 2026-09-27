import { createHash } from "node:crypto";
import path from "node:path";

/** The one address rule of every process in a home (H3B-R9; the Rust side is `crates/plur1bus/src/paths.rs`
 *  `address`): `<home>/run/<role>.sock` on POSIX, `\\.\pipe\plur1bus-<first 16 hex of sha256(lower-cased home)>-<role>`
 *  on Windows. `platform` decides the format, never the characters in the home (M5). */
export function pipeName(home: string, role: string): string {
  return `\\\\.\\pipe\\plur1bus-${createHash("sha256").update(home.toLowerCase()).digest("hex").slice(0, 16)}-${role}`;
}

/** The directory of a home's run files (tokens, pids, sockets), in this host's path syntax. */
export function runDir(home: string): string {
  return path.join(home, "run");
}

/** The RPC address of `role` (`core`, `supervisor`, `module-<name>`) in `home`. */
export function unitAddress(home: string, role: string, platform: NodeJS.Platform = process.platform): string {
  // Built with '/' explicitly, and a trailing '/' trimmed, exactly as paths.rs does.
  return platform === "win32" ? pipeName(home, role) : `${home.replace(/\/+$/, "")}/run/${role}.sock`;
}

/** The supervisor's RPC address. */
export function supervisorAddress(home: string, platform: NodeJS.Platform = process.platform): string {
  return unitAddress(home, "supervisor", platform);
}

/** `run/supervisor.token`: the supervisor's RPC token (and the nonce `core.adopt` proves). */
export function supervisorTokenPath(home: string): string {
  return path.join(runDir(home), "supervisor.token");
}

/** The core's RPC address. */
export function coreAddress(home: string, platform: NodeJS.Platform = process.platform): string {
  return unitAddress(home, "core", platform);
}

/** `run/core.token`: the core's RPC token, rewritten by every core start. */
export function coreTokenPath(home: string): string {
  return path.join(runDir(home), "core.token");
}

/** A module's RPC address: role `module-<name>`, the same rule as the core's (paths.rs `module_address`). */
export function moduleAddress(home: string, name: string, platform: NodeJS.Platform = process.platform): string {
  return unitAddress(home, `module-${name}`, platform);
}

/** A module's run files, beside its socket: `run/module-<name>.{token,pid,lock}` (paths.rs `Layout::endpoints`). */
export function moduleRunFiles(home: string, name: string): { token: string; pid: string; lock: string } {
  const j = (ext: string) => path.join(runDir(home), `module-${name}.${ext}`);
  return { token: j("token"), pid: j("pid"), lock: j("lock") };
}
