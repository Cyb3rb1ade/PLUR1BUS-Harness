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

/** Strict source text decoding. BOM selects UTF-16; unmarked text must be valid UTF-8.
 * Never include decoder input in errors: configs may contain credentials. */
export function decodeSourceText(bytes: Buffer): string {
  let encoding = "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new ImportError("E_SOURCE_UNSUPPORTED", "invalid-text-encoding", "Source text has invalid encoding");
  }
}

export function readSourceTextSafe(path: string, maxBytes: number): string {
  return decodeSourceText(readSourceFileSafe(path, maxBytes));
}
