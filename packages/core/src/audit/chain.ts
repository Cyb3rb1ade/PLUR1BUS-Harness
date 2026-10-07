// The tamper-evident audit chain (B5): the line format, the hash, and the file layout. No I/O here except `forEachLine`,
// the bounded streaming reader both the writer (tail) and the verifier share.
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AuditEvent } from "../rbac/audit.ts";

/** `prev` of the very first line of a chain. */
export const GENESIS = "0".repeat(64);
export const HASH_RE = /^[0-9a-f]{64}$/;
/** Longest line the reader will hold in memory; a longer one is reported (`bad-line`), never buffered. */
export const MAX_LINE_BYTES = 1024 * 1024;

export const ACTIVE_FILE = "audit.chain.jsonl";
export const ANCHOR_FILE = "audit.chain.anchor";
export const LOCK_DIR = "audit.chain.lock";
export const rotatedName = (index: number): string => `audit.chain.${String(index).padStart(6, "0")}.jsonl`;
const ROTATED_RE = /^audit\.chain\.(\d{6})\.jsonl$/;

/** RULING B5-1: the chain hashes the exact bytes of a line without its terminator (`\n` or `\r\n`), so a file that
 *  an editor, git or a Windows tool converted to CRLF still verifies. */
export function hashLine(raw: string | Uint8Array): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** The five audit v1 keys, then `seq` and `prev`, in that order. Built field by field: an event can never inject
 *  a top-level `seq` or `prev`. */
export function encodeLine(e: AuditEvent, seq: number, prev: string): string {
  return JSON.stringify({ at: e.at, actor: e.actor, action: e.action, target: e.target, detail: e.detail, seq, prev });
}

export interface ChainLine { at: unknown; actor: unknown; action: unknown; target: unknown; detail: unknown; seq: number; prev: string }

/** A parsed line, or null when it is not a chain line (not JSON, not an object, `seq` or `prev` missing or malformed). */
export function parseLine(raw: Uint8Array): ChainLine | null {
  let o: unknown;
  try { o = JSON.parse(Buffer.from(raw).toString("utf8")); } catch { return null; }
  if (typeof o !== "object" || o === null || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  const seq = r["seq"], prev = r["prev"];
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) return null;
  if (typeof prev !== "string" || !HASH_RE.test(prev)) return null;
  return r as unknown as ChainLine;
}

/** Rotated indexes present in `dir`, ascending. */
export function listRotated(dir: string): number[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: number[] = [];
  for (const n of names) { const m = ROTATED_RE.exec(n); if (m) out.push(Number(m[1])); }
  return out.sort((a, b) => a - b);
}

export interface RawLine {
  /** The line without its terminator; empty when `overflow`. */
  raw: Buffer;
  /** Longer than MAX_LINE_BYTES: not held in memory. */
  overflow: boolean;
  /** Ended with `\n` (false only for an unterminated last line). */
  terminated: boolean;
}

/** Streams `path` line by line in 64 KiB reads. Returns false when the file does not exist. Memory is bounded by
 *  MAX_LINE_BYTES plus one chunk whatever the file looks like. */
export function forEachLine(path: string, cb: (line: RawLine) => void): boolean {
  let fd: number;
  try { fd = openSync(path, "r"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
  try {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let parts: Buffer[] = []; let held = 0; let overflow = false;
    const flush = (terminated: boolean): void => {
      let raw = overflow ? Buffer.alloc(0) : Buffer.concat(parts, held);
      if (terminated && raw.length > 0 && raw[raw.length - 1] === 0x0d) raw = raw.subarray(0, raw.length - 1);
      cb({ raw, overflow, terminated });
      parts = []; held = 0; overflow = false;
    };
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(0x0a, start);
        const end = nl === -1 || nl >= n ? n : nl;
        const piece = end - start;
        if (!overflow && piece > 0) {
          if (held + piece > MAX_LINE_BYTES) { overflow = true; parts = []; held = 0; }
          else { parts.push(Buffer.from(chunk.subarray(start, end))); held += piece; }
        }
        if (nl === -1 || nl >= n) break;
        flush(true);
        start = nl + 1;
      }
    }
    if (held > 0 || overflow) flush(false);
    return true;
  } finally { closeSync(fd); }
}

export interface Tail {
  /** The last line (no terminator), null for an empty file. */
  raw: Buffer | null;
  /** The file ends with `\n` (an empty file counts as terminated). */
  terminated: boolean;
  overflow: boolean;
}

/** The last line of `path` by reading backwards, so an append never rereads the whole file. */
export function readTail(path: string): Tail | null {
  let fd: number;
  try { fd = openSync(path, "r"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return { raw: null, terminated: true, overflow: false };
    let window = 4096;
    for (;;) {
      const len = Math.min(size, window);
      const buf = Buffer.allocUnsafe(len);
      let got = 0;
      while (got < len) { const n = readSync(fd, buf, got, len - got, size - len + got); if (n === 0) break; got += n; }
      const data = buf.subarray(0, got);
      const terminated = data[data.length - 1] === 0x0a;
      let end = terminated ? data.length - 1 : data.length;
      if (terminated && end > 0 && data[end - 1] === 0x0d) end -= 1;
      const nl = end > 0 ? data.lastIndexOf(0x0a, end - 1) : -1;
      if (nl === -1 && len < size) {
        if (window >= MAX_LINE_BYTES) return { raw: Buffer.alloc(0), terminated, overflow: true };
        window *= 2; continue;
      }
      return { raw: Buffer.from(data.subarray(nl + 1, end)), terminated, overflow: false };
    }
  } finally { closeSync(fd); }
}

export interface Anchor { v: 1; seq: number; hash: string; file: string }

export function readAnchor(dir: string): Anchor | null {
  let text: string;
  try { text = readFileSync(join(dir, ANCHOR_FILE), "utf8"); } catch { return null; }
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    if (o["v"] === 1 && typeof o["seq"] === "number" && Number.isSafeInteger(o["seq"]) && typeof o["hash"] === "string" && /^[0-9a-f]{64}$/.test(o["hash"]) && typeof o["file"] === "string") return o as unknown as Anchor;
  } catch { /* unreadable anchor = no anchor */ }
  return null;
}

