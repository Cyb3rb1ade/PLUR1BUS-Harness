/** AF2's filesystem policy for the single Layout-owned Apple socket; no repair, alternate path or TCP fallback. */
import { lstatSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { layout } from "../paths.ts";
import { requirePrivateDir } from "../platform.ts";
import type { UnixSocketGuard } from "../../../providers/src/local/unix.ts";

export interface AppleFmSocketOptions {
  platform?: NodeJS.Platform;
  euid?: number;
  /** Identity seam for the foreign-uid refusal test; production always uses lstat without following the socket. */
  readSocketInfo?: (path: string) => Pick<Stats, "uid" | "isSocket" | "isSymbolicLink">;
}

function requireUnlinkedParents(parent: string): void {
  for (let current = parent;; current = dirname(current)) {
    if (lstatSync(current).isSymbolicLink()) throw new Error("symlinked managed socket ancestor");
    if (dirname(current) === current) return;
  }
}

/** The captured Layout descriptor is the only allowed destination; every verify performs fresh checks. */
export function createAppleFmSocketGuard(home: string, options: AppleFmSocketOptions = {}): UnixSocketGuard {
  const expected = layout(home).appleFmSocket;
  const platform = options.platform ?? process.platform;
  const uid = options.euid ?? process.geteuid?.();
  const readSocketInfo = options.readSocketInfo ?? lstatSync;
  return { verify(socket) {
    if (platform === "win32") return { ok: false, reason: "platform" };
    if (Buffer.byteLength(expected) > 103) return { ok: false, reason: "socket-path-too-long" };
    if (socket.id !== "apple-fm" || socket.path !== expected || !isAbsolute(expected) || expected.includes("\0")) {
      return { ok: false, reason: "socket-untrusted" };
    }
    try {
      if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) throw new Error("missing effective uid");
      const parent = dirname(expected);
      requireUnlinkedParents(parent);
      requirePrivateDir(parent, uid);
      if ((lstatSync(parent).mode & 0o777) !== 0o700) throw new Error("managed socket parent is not 0700");
      const info = readSocketInfo(expected);
      if (info.isSymbolicLink() || !info.isSocket() || info.uid !== uid) throw new Error("untrusted socket identity");
      return { ok: true };
    } catch {
      return { ok: false, reason: "socket-untrusted" };
    }
  } };
}
