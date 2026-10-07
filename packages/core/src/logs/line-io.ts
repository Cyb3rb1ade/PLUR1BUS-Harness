// Bounded line IO over one log file: backward line iteration, the end of the last complete line, and a byte-offset
// bisection by timestamp. Nothing here reads a whole file: every call touches O(block) bytes per step.
import type { FileHandle } from "node:fs/promises";

/** A line longer than this is not buffered: it is reported as `oversize` and skipped (D111 caps a record far below it). */
export const MAX_LINE_BYTES = 256 * 1024;
export const DEFAULT_BLOCK_BYTES = 64 * 1024;

export interface RawLine {
  /** The decoded line without its newline (and without a trailing `\r`), or null when it was oversize. */
  text: string | null;
  oversize: boolean;
  /** Byte offset of the first byte of the line. */
  start: number;
  /** Byte offset one past the last byte of the line, before its newline. */
  end: number;
}

const NL = 0x0a;
const CR = 0x0d;

async function readAt(fh: FileHandle, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const { bytesRead } = await fh.read(buf, got, len - got, pos + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return got === len ? buf : buf.subarray(0, got);
}

/** The offset just after the last `\n` in `[0, size)`; 0 when there is none. Bytes after it are a writer's half line. */
export async function completeEnd(fh: FileHandle, size: number, blockBytes = DEFAULT_BLOCK_BYTES): Promise<number> {
  let pos = size;
  while (pos > 0) {
    const bs = Math.max(0, pos - blockBytes);
    const buf = await readAt(fh, bs, pos - bs);
    const i = buf.lastIndexOf(NL);
    if (i >= 0) return bs + i + 1;
    pos = bs;
  }
  return 0;
}

/**
 * Lines of `[0, end)` from the last to the first. `end` must be a line boundary (an offset just after a `\n`, or 0):
 * use `completeEnd` for the end of a file that a writer may be appending to, so a half line is never seen. Empty lines
 * are skipped. A line over `MAX_LINE_BYTES` is yielded as `oversize` without being held in memory.
 */
export async function* readLinesBackward(fh: FileHandle, end: number, blockBytes = DEFAULT_BLOCK_BYTES): AsyncGenerator<RawLine> {
  let pos = end;
  let lineEnd = end;
  let parts: Buffer[] = [];
  let len = 0;
  let over = false;
  let first = true;
  const take = (b: Buffer): void => {
    len += b.length;
    if (over) return;
    if (len > MAX_LINE_BYTES) { over = true; parts = []; return; }
    parts.push(b);
  };
  const flush = function* (start: number): Generator<RawLine> {
    if (over) yield { text: null, oversize: true, start, end: lineEnd };
    else if (len > 0) {
      let b = Buffer.concat(parts.reverse());
      if (b.length > 0 && b[b.length - 1] === CR) b = b.subarray(0, b.length - 1);
      if (b.length > 0) yield { text: b.toString("utf8"), oversize: false, start, end: lineEnd };
    }
    parts = []; len = 0; over = false;
  };
  while (pos > 0) {
    const bs = Math.max(0, pos - blockBytes);
    const buf = await readAt(fh, bs, pos - bs);
    let hi = buf.length;
    if (first) {
      first = false;
      if (hi > 0 && buf[hi - 1] === NL) { hi -= 1; lineEnd = bs + hi; }
    }
    for (;;) {
      const idx = hi > 0 ? buf.lastIndexOf(NL, hi - 1) : -1;
      if (idx < 0) { if (hi > 0) take(buf.subarray(0, hi)); break; }
      if (hi > idx + 1) take(buf.subarray(idx + 1, hi));
      yield* flush(bs + idx + 1);
      lineEnd = bs + idx;
      hi = idx;
    }
    pos = bs;
  }
  yield* flush(0);
}

/** Start offset of the first line that starts at or after `from`, bounded by `limit` (returns `limit` if none). */
async function lineStartAtOrAfter(fh: FileHandle, from: number, limit: number, blockBytes: number): Promise<number> {
  if (from <= 0) return 0;
  let pos = from - 1;
  while (pos < limit) {
    const n = Math.min(blockBytes, limit - pos);
    const buf = await readAt(fh, pos, n);
    if (buf.length === 0) return limit;
    const i = buf.indexOf(NL);
    if (i >= 0) return Math.min(limit, pos + i + 1);
    pos += buf.length;
  }
  return limit;
}

/** The line starting exactly at `start` (a line boundary), and where the next one starts; null at `limit`. */
async function lineAt(fh: FileHandle, start: number, limit: number, blockBytes: number): Promise<{ text: string | null; next: number } | null> {
  if (start >= limit) return null;
  const chunks: Buffer[] = [];
  let total = 0;
  let pos = start;
  while (pos < limit) {
    const n = Math.min(blockBytes, limit - pos);
    const buf = await readAt(fh, pos, n);
    if (buf.length === 0) break;
    const i = buf.indexOf(NL);
    const cut = i >= 0 ? i : buf.length;
    total += cut;
    if (total <= MAX_LINE_BYTES) chunks.push(buf.subarray(0, cut));
    if (i >= 0) {
      const next = pos + i + 1;
      if (total > MAX_LINE_BYTES) return { text: null, next };
      let b = Buffer.concat(chunks);
      if (b.length > 0 && b[b.length - 1] === CR) b = b.subarray(0, b.length - 1);
      return { text: b.toString("utf8"), next };
    }
    pos += buf.length;
  }
  return { text: null, next: limit };
}

/**
 * The start offset of the first line (in `[0, end)`, `end` a line boundary) whose timestamp is `>= target`, or `end`
 * when there is none. Assumes the file is time-ordered, which an append-only log is up to clock steps; a run of up to
 * `maxCorruptProbe` unparsable lines at a probe point is stepped over, and a longer run counts as "not before".
 */
export async function bisectByTime(
  fh: FileHandle, end: number, target: number, tsOf: (line: string) => number | null,
  o: { blockBytes?: number; maxCorruptProbe?: number } = {},
): Promise<number> {
  const block = o.blockBytes ?? DEFAULT_BLOCK_BYTES;
  const maxProbe = o.maxCorruptProbe ?? 64;
  // `lo` and `hi` are always line starts (or `end`); `top` bounds where the next probe may start a line: no line starts in
  // [top, hi), so a probe that finds none past `mid` narrows `top` only, never `hi` to a mid-line offset.
  let lo = 0;
  let hi = end;
  let top = end;
  while (lo < hi) {
    const mid = lo + Math.floor((top - lo) / 2);
    const s = mid <= lo ? lo : await lineStartAtOrAfter(fh, mid, top, block);
    if (s >= top) { top = mid; continue; }
    let at = s;
    let ts: number | null = null;
    let next = s;
    for (let probe = 0; probe < maxProbe && at < hi; probe++) {
      const l = await lineAt(fh, at, hi, block);
      if (!l) break;
      next = l.next;
      const t = l.text === null ? null : tsOf(l.text);
      if (t !== null) { ts = t; break; }
      at = l.next;
    }
    if (ts !== null && ts < target) lo = next;
    else { hi = s; top = Math.min(top, s); }
  }
  return lo;
}
