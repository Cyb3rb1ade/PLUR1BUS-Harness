// Safe file reader for Hermes source files (M7 Batch 3, M1). Every Hermes source read goes through here.
// - Refuses a symlink as the final component: O_NOFOLLOW where the platform has it (POSIX); an lstat pre-check
//   everywhere (Windows has no O_NOFOLLOW), and the fstat'd fd must be the same file the lstat saw.
// - O_NONBLOCK so a FIFO cannot block the open; fstat on the fd must report a regular file.
// - Bounded read: never more than maxBytes + 1 bytes are buffered; a file that grew past the bound is refused.
// Swap for Copilot's `readSourceFileSafe` (PR #98, fs-safe.ts) once that is merged.
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";

export type SafeReadError = "not-found" | "symlink-refused" | "not-a-regular-file" | "file-too-large" | "read-failed";

export type SafeReadResult =
  | { ok: true; buffer: Buffer; content: string; bytes: number }
  | { ok: false; error: SafeReadError };

/** True when something (file, link, FIFO, dir, ...) exists at `path`, without following a final symlink. */
export function existsNoFollow(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function readHermesSourceFileSafe(filePath: string, maxBytes: number): SafeReadResult {
  let pre: ReturnType<typeof lstatSync>;
  try {
    pre = lstatSync(filePath);
  } catch (err: any) {
    return { ok: false, error: err?.code === "ENOENT" ? "not-found" : "read-failed" };
  }
  if (pre.isSymbolicLink()) return { ok: false, error: "symlink-refused" };
  if (!pre.isFile()) return { ok: false, error: "not-a-regular-file" };
  if (pre.size > maxBytes) return { ok: false, error: "file-too-large" };

  let fd: number;
  try {
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    fd = openSync(filePath, flags);
  } catch (err: any) {
    if (err?.code === "ENOENT") return { ok: false, error: "not-found" };
    if (err?.code === "ELOOP" || err?.code === "EMLINK") return { ok: false, error: "symlink-refused" };
    return { ok: false, error: "read-failed" };
  }

  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, error: "not-a-regular-file" };
    // The path was swapped between lstat and open (matters where O_NOFOLLOW is unavailable).
    if (pre.ino !== 0 && st.ino !== 0 && (pre.ino !== st.ino || pre.dev !== st.dev)) {
      return { ok: false, error: "symlink-refused" };
    }
    if (st.size > maxBytes) return { ok: false, error: "file-too-large" };

    // Read at most maxBytes + 1: the extra byte detects growth past the bound without buffering an unbounded file.
    const cap = maxBytes + 1;
    const chunk = Buffer.alloc(Math.min(cap, st.size + 1));
    const parts: Buffer[] = [];
    let total = 0;
    while (total < cap) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, cap - total), null);
      if (n === 0) break;
      parts.push(Buffer.from(chunk.subarray(0, n)));
      total += n;
    }
    if (total > maxBytes) return { ok: false, error: "file-too-large" };
    const out = Buffer.concat(parts, total);
    return { ok: true, buffer: out, content: out.toString("utf8"), bytes: total };
  } catch {
    return { ok: false, error: "read-failed" };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
  }
}
