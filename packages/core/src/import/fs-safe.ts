import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ImportError } from "./types.ts";

export function existsNoFollow(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function readSourceFileSafe(path: string, maxBytes: number): Buffer {
  const refuse = (reason: string) => new ImportError("E_IMPORT_FAILED", reason, `${basename(path)}: ${reason}`);
  let fd: number | undefined;
  try {
    const before = lstatSync(path);
    if (before.isSymbolicLink()) throw refuse("unsafe-symlink");
    // Windows cannot open directories as files; refuse them before that open fails.
    if (constants.O_NOFOLLOW === undefined && !before.isFile()) throw refuse("not-regular-file");
    // Resolve parent aliases once so swapping an alias does not redirect the subsequent open.
    const openPath = join(realpathSync(dirname(path)), basename(path));
    fd = openSync(openPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (before.dev !== stat.dev || before.ino !== stat.ino) throw refuse("unsafe-symlink");
    if (!stat.isFile()) throw refuse("not-regular-file");
    if (stat.size > maxBytes) throw refuse("file-too-large");

    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
      const bytes = readSync(fd, chunk, 0, chunk.length, null);
      if (bytes === 0) break;
      total += bytes;
      if (total > maxBytes) throw refuse("file-too-large");
      chunks.push(chunk.subarray(0, bytes));
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error instanceof ImportError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw refuse(code === "ELOOP" || code === "EMLINK" ? "unsafe-symlink" : "source-unreadable");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
