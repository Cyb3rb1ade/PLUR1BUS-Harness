// Safe file reader for Hermes source files (M7 Batch 3, M1).
// Opens with O_RDONLY | O_NOFOLLOW | O_NONBLOCK, checks fstat for regular file and size bound,
// and performs a bounded read without following symlinks or blocking on FIFOs.
import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";

export type SafeReadResult =
  | { ok: true; content: string; bytes: number }
  | { ok: false; error: "not-found" | "symlink-refused" | "not-a-regular-file" | "file-too-large" | "read-failed" };

export function readHermesSourceFileSafe(filePath: string, maxBytes: number): SafeReadResult {
  let fd: number;
  try {
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    fd = openSync(filePath, flags);
  } catch (err: any) {
    if (err.code === "ENOENT") return { ok: false, error: "not-found" };
    if (err.code === "ELOOP" || err.code === "EEXIST") return { ok: false, error: "symlink-refused" };
    return { ok: false, error: "read-failed" };
  }

  try {
    const st = fstatSync(fd);
    if (st.isSymbolicLink()) {
      return { ok: false, error: "symlink-refused" };
    }
    if (!st.isFile()) {
      return { ok: false, error: "not-a-regular-file" };
    }
    if (st.size > maxBytes) {
      return { ok: false, error: "file-too-large" };
    }

    const buf = Buffer.alloc(st.size);
    let bytesRead = 0;
    while (bytesRead < st.size) {
      const n = readSync(fd, buf, bytesRead, st.size - bytesRead, bytesRead);
      if (n === 0) break;
      bytesRead += n;
    }
    return { ok: true, content: buf.toString("utf8", 0, bytesRead), bytes: bytesRead };
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
