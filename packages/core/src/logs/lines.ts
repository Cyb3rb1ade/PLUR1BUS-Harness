// Streaming line access over an open file: forward and backward iterators and a binary search by timestamp. Memory is
// bounded by the chunk size and the line cap, never by the file size (D4: a log file may be hundreds of MiB).
//
// Rules shared by both directions:
//  * A line is the bytes up to a "\n" (a trailing "\r" is dropped). Empty lines are skipped.
//  * An unterminated last line is the writer's half-written line: it is never yielded (RULING: not even when it
//    happens to be valid JSON, because the writer may still be appending to it).
//  * A line longer than `maxLine` is skipped without buffering it and reported once as `tooLong`.
import type { FileHandle } from "node:fs/promises";

export const CHUNK = 64 * 1024;
export const MAX_LINE = 256 * 1024;

export interface RawLine { text: string; tooLong: boolean }

export interface ScanStats { bytes: number }

const NL = 0x0a;
const decode = (b: Buffer): string => {
  const e = b.length > 0 && b[b.length - 1] === 0x0d ? b.length - 1 : b.length;
  return b.toString("utf8", 0, e);
};

async function readAt(fh: FileHandle, pos: number, len: number, stats?: ScanStats): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const { bytesRead } = await fh.read(buf, got, len - got, pos + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  if (stats) stats.bytes += got;
  return got === len ? buf : buf.subarray(0, got);
}

/** Complete lines of `[start, end)` in file order. `start` must be a line start (0 or just after a "\n"). */
export async function* forwardLines(fh: FileHandle, o: { start: number; end: number; maxLine?: number; stats?: ScanStats }): AsyncGenerator<RawLine> {
  const maxLine = o.maxLine ?? MAX_LINE;
  let pos = o.start;
  let carry: Buffer[] = []; let carryLen = 0; let skipping = false;
  while (pos < o.end) {
    const chunk = await readAt(fh, pos, Math.min(CHUNK, o.end - pos), o.stats);
    if (chunk.length === 0) return;
    pos += chunk.length;
    let from = 0;
    for (;;) {
      const nl = chunk.indexOf(NL, from);
      if (nl < 0) {
        if (!skipping) {
          carry.push(chunk.subarray(from)); carryLen += chunk.length - from;
          if (carryLen > maxLine) { skipping = true; carry = []; carryLen = 0; yield { text: "", tooLong: true }; }
        }
        break;
      }
      if (skipping) skipping = false;
      else {
        const line = carry.length ? Buffer.concat([...carry, chunk.subarray(from, nl)]) : chunk.subarray(from, nl);
        carry = []; carryLen = 0;
        if (line.length > maxLine) yield { text: "", tooLong: true };
        else if (line.length > 0 && !(line.length === 1 && line[0] === 0x0d)) yield { text: decode(line), tooLong: false };
      }
      from = nl + 1;
    }
  }
  // whatever is left in `carry` is an unterminated line: ignored
}

/** The offset just after the last "\n" before `end` (0 when there is none): the end of the last complete line. */
export async function lastLineBoundary(fh: FileHandle, end: number, stats?: ScanStats): Promise<number> {
  let pos = end;
  while (pos > 0) {
    const n = Math.min(CHUNK, pos);
    const chunk = await readAt(fh, pos - n, n, stats);
    const at = chunk.lastIndexOf(NL);
    if (at >= 0) return pos - n + at + 1;
    pos -= n;
  }
  return 0;
}

/** Complete lines before `end`, last to first. A partial last line (no "\n" before `end`) is ignored. */
export async function* backwardLines(fh: FileHandle, o: { end: number; maxLine?: number; stats?: ScanStats }): AsyncGenerator<RawLine> {
  const maxLine = o.maxLine ?? MAX_LINE;
  let pos = await lastLineBoundary(fh, o.end, o.stats);
  // Invariant: `rest` holds the bytes from `pos` up to (not including) a "\n" that terminates the line they belong to.
  let rest: Buffer = Buffer.alloc(0); let first = true; let skipping = false;
  while (pos > 0) {
    const n = Math.min(CHUNK, pos);
    const chunk = await readAt(fh, pos - n, n, o.stats);
    pos -= n;
    let buf: Buffer;
    if (skipping) {
      const nl = chunk.lastIndexOf(NL);
      if (nl < 0) continue; // still inside the over-long line
      skipping = false; buf = chunk.subarray(0, nl); // the "\n" at `nl` terminates the earlier line
    } else {
      buf = Buffer.concat([chunk, rest]);
      // The very first chunk ends with the "\n" of the last complete line (lastLineBoundary): that is its terminator.
      if (first) { buf = buf.subarray(0, buf.length - 1); first = false; }
    }
    // `buf` is line content up to an implied terminator; its first element may continue before `pos`.
    let to = buf.length;
    while (to > 0) {
      const nl = buf.lastIndexOf(NL, to - 1);
      if (nl < 0) break;
      const line = buf.subarray(nl + 1, to);
      if (line.length > maxLine) yield { text: "", tooLong: true };
      else if (line.length > 0 && !(line.length === 1 && line[0] === 0x0d)) yield { text: decode(line), tooLong: false };
      to = nl;
    }
    rest = Buffer.from(buf.subarray(0, to));
    if (rest.length > maxLine) { rest = Buffer.alloc(0); skipping = true; yield { text: "", tooLong: true }; }
  }
  if (!skipping && rest.length > 0 && pos === 0) {
    // the first line of the file
    if (rest.length > maxLine) yield { text: "", tooLong: true };
    else if (!(rest.length === 1 && rest[0] === 0x0d)) yield { text: decode(rest), tooLong: false };
  }
}

/** The line start at or after `off`: `off` itself at 0 or right after a "\n", else just after the next "\n"; `size` if none. */
export async function alignForward(fh: FileHandle, off: number, size: number, stats?: ScanStats): Promise<number> {
  if (off <= 0) return 0;
  if (off >= size) return size;
  let pos = off - 1;
  while (pos < size) {
    const chunk = await readAt(fh, pos, Math.min(4096, size - pos), stats); // small: a probe, not a scan
    if (chunk.length === 0) return size;
    const at = chunk.indexOf(NL);
    if (at >= 0) return pos + at + 1;
    pos += chunk.length;
  }
  return size;
}

/** The first line of `text` is read at `at`, a line start: its text, or null at the end of the file / for an over-long line. */
async function lineAt(fh: FileHandle, at: number, size: number, stats?: ScanStats): Promise<string | null> {
  const chunk = await readAt(fh, at, Math.min(4096, size - at), stats);
  const nl = chunk.indexOf(NL);
  if (nl < 0) return null; // unterminated within the probe: treat as unknown
  return decode(chunk.subarray(0, nl));
}

const SEEK_WINDOW = 64 * 1024;

/**
 * Binary search for the first line whose timestamp is `>= ts` (`strict: false`) or `> ts` (`strict: true`), by the
 * timestamp `tsOf` reads from a probe line. RULING: timestamps in one file are assumed non-decreasing (one writer, one
 * clock); the result is the start of a window of at most 64 KiB in front of the first such line, so a few lines out of
 * order inside the window are still seen. A probe that cannot be read makes the search give up and answer `size`/0
 * conservatively (0 for a lower bound: scan from the start).
 */
export async function seekByTs(fh: FileHandle, size: number, ts: string, tsOf: (line: string) => string | null, strict: boolean, stats?: ScanStats): Promise<number> {
  let lo = 0, hi = size;
  while (hi - lo > SEEK_WINDOW) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const s = await alignForward(fh, mid, size, stats);
    if (s >= hi) { hi = mid; continue; }
    const text = await lineAt(fh, s, size, stats);
    const t = text === null ? null : tsOf(text);
    if (t === null) return 0;
    if (strict ? t <= ts : t < ts) lo = s; else hi = mid;
  }
  return lo;
}
