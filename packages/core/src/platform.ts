import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, statSync } from "node:fs";
import path from "node:path";
import type { IpcAddress, PlatformCapabilities, SecurePathResult } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";

/** Runs a tool synchronously and returns its stdout; throws when it cannot run or exits non-zero. */
export type ExecFile = (file: string, args: readonly string[]) => string;

export interface PlatformOptions {
  /** Defaults to `process.platform`; a test reaches the win32 branch on any OS. */
  platform?: NodeJS.Platform;
  /** Defaults to `execFileSync` (no window, output captured). */
  execFile?: ExecFile;
  /** Where a failed ACL grant is reported. */
  logger?: { warn(msg: string, fields?: Record<string, unknown>): void };
}

const defaultExec: ExecFile = (file, args) =>
  execFileSync(file, args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

/** The SID column of `whoami /user /fo csv /nh` (`"host\user","S-1-5-21-…"`), or null. */
export function parseWhoamiSid(out: string): string | null {
  const m = /"(S-1-\d+(?:-\d+)+)"\s*$/m.exec(out);
  return m ? m[1]! : null;
}

/** The user's SID through the default tool, asked once per process. */
let processSid: string | undefined;

/**
 * The host's platform capabilities (engine `PlatformCapabilities`). `securePath` restricts a path to the current user:
 * `chmod` on POSIX; on Windows (ruling S11) `icacls <p> /inheritance:r /grant:r *<user SID>:(F) *S-1-5-18:(F)`, with
 * the SID from `whoami /user`, memoised. A failed grant is `{ applied: false, reason: "acl-tool-unavailable" }` plus a
 * warning (`reason: "icacls-failed"`): the engine contract's closed unions name the mechanism `"acl"` and have no
 * separate failure reason.
 */
export function createPlatformCapabilities(o: PlatformOptions = {}): PlatformCapabilities {
  const platform = o.platform ?? process.platform;
  const exec = o.execFile ?? defaultExec;
  let sid: string | undefined;
  const userSid = (): string => {
    if (exec === defaultExec && processSid !== undefined) return processSid;
    if (sid !== undefined) return sid;
    const found = parseWhoamiSid(exec("whoami", ["/user", "/fo", "csv", "/nh"]));
    if (found === null) throw new Error("whoami /user named no SID");
    sid = found;
    if (exec === defaultExec) processSid = found;
    return found;
  };

  function securePath(p: string, options: { mode?: number } = {}): SecurePathResult {
    if (typeof p !== "string" || !path.isAbsolute(p)) return { applied: false, reason: "not-a-filesystem-path" };
    try { statSync(p); } catch { return { applied: false, reason: "missing" }; }
    if (platform === "win32") {
      try {
        exec("icacls", [p, "/inheritance:r", "/grant:r", `*${userSid()}:(F)`, "*S-1-5-18:(F)"]);
        return { applied: true, mechanism: "acl" };
      } catch (err) {
        o.logger?.warn("securePath: icacls grant failed", { path: p, reason: "icacls-failed", err: String((err as Error)?.message ?? err) });
        return { applied: false, reason: "acl-tool-unavailable" };
      }
    }
    chmodSync(p, options.mode ?? 0o600);
    return { applied: true, mechanism: "chmod" };
  }

  return { securePath, ipcAddress, isUnsafeLink, canonicalIdentityPath };
}

function ipcAddress(stateRoot: string): IpcAddress {
  if (process.platform === "win32") return { kind: "named-pipe", address: `\\\\.\\pipe\\plur1bus-embed-${Buffer.from(stateRoot).toString("hex").slice(0, 32)}` };
  return { kind: "unix-socket", address: path.join(stateRoot, "embedding.sock") };
}

function isUnsafeLink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function canonicalIdentityPath(p: string): string {
  return process.platform === "win32" ? path.win32.normalize(p).toLowerCase().replace(/^[a-z]:/, (d) => d.toLowerCase()) : path.posix.normalize(p);
}

export const platformCapabilities: PlatformCapabilities = createPlatformCapabilities();
