// The query engine behind logs.query and logs.tail: streams the protected log files (rotation included), merges them in
// timestamp order, filters, redacts and pages with a cursor that does not depend on file names or offsets.
import { createHash } from "node:crypto";
import { isLevel, levelAtLeast, type Level } from "@plur1bus/log-schema";
import { alignForward, backwardLines, forwardLines, seekByTs, type RawLine, type ScanStats } from "./lines.ts";
import { closeLogFiles, openLogFiles, type OpenLogFile, type Stream } from "./files.ts";
import { createRedactor, type Redactor } from "./redact.ts";

export type Order = "asc" | "desc";

export interface LogFilter {
  stream: Stream;
  /** Inclusive RFC 3339 bounds. */
  from?: string; to?: string;
  minLevel?: Level;
  /** The file's role (`core`, `supervisor`, …), a record's `source.id` or `source.kind`; for the audit stream the action's first segment. */
  component?: string;
  /** Case-insensitive substring of the *redacted* record text. */
  text?: string;
}

export interface LogRecordOut {
  ts: string;
  level: Level | null;
  component: string;
  stream: Stream;
  /** The record as parsed from the line, after redaction. */
  record: Record<string, unknown>;
}

export interface QueryResult {
  records: LogRecordOut[];
  /** Opaque; resume after the last returned record. `null` when there is nothing more in this direction. */
  nextCursor: string | null;
  corrupt: number;
  scanned: { files: number; bytes: number };
  /** The scan budget ran out: `nextCursor` continues from the last line looked at, not the last one returned. */
  truncated: boolean;
  /** Internal: the first and last line looked at in scan order (matching or not); never part of an RPC result. */
  firstKey: Key | null; lastKey: Key | null;
}

export interface QueryOptions {
  dir: string;
  filter: LogFilter;
  order: Order;
  limit: number;
  cursor?: string;
  redactor?: Redactor;
  /** Bytes read from files per call (default 128 MiB). */
  maxScanBytes?: number;
  maxLine?: number;
  /** Test seam: runs after the files were listed and before they are opened (a rotation can be injected here). */
  onListed?: () => void | Promise<void>;
}

export interface Key { ts: string; h: string }
const cmp = (a: Key, b: Key): number => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.h < b.h ? -1 : a.h > b.h ? 1 : 0);
const hashOf = (line: string): string => createHash("sha1").update(line).digest("hex").slice(0, 16);

export class CursorError extends Error {
  reason: "bad-cursor" | "cursor-mismatch";
  constructor(reason: "bad-cursor" | "cursor-mismatch") { super(reason); this.reason = reason; }
}

export function fingerprint(f: LogFilter, order: Order): string {
  return createHash("sha1").update(JSON.stringify([f.stream, order, f.from ?? null, f.to ?? null, f.minLevel ?? null, f.component ?? null, f.text ?? null])).digest("hex").slice(0, 12);
}
export const mintCursor = (f: LogFilter, order: Order, k: Key): string => encodeCursor(k, fingerprint(f, order));
const encodeCursor = (k: Key, fp: string): string => Buffer.from(JSON.stringify({ v: 1, ts: k.ts, h: k.h, fp }), "utf8").toString("base64url");
export function decodeCursor(cursor: string, fp: string): Key {
  let o: any;
  try { o = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw new CursorError("bad-cursor"); }
  if (o === null || typeof o !== "object" || o.v !== 1 || typeof o.ts !== "string" || typeof o.h !== "string" || typeof o.fp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(o.ts)) throw new CursorError("bad-cursor");
  if (o.fp !== fp) throw new CursorError("cursor-mismatch");
  return { ts: o.ts, h: String(o.h) };
}

/** `ts` (D111) or the legacy `at` (ISO text or epoch milliseconds), normalised to `YYYY-MM-DDTHH:MM:SS.mmmZ`. */
function normalTs(r: Record<string, unknown>): string | null {
  const v = r.ts ?? r.at;
  const ms = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
const PREFIX = /^\s*\{\s*"(?:ts|at)"\s*:\s*("[^"]*"|\d+)/;
/** The timestamp of a line without parsing all of it (the writer puts `ts` first); null when it cannot be told. */
function quickTs(line: string): string | null {
  const m = PREFIX.exec(line);
  if (!m) { try { const o = JSON.parse(line); return o && typeof o === "object" ? normalTs(o) : null; } catch { return null; } }
  const raw = m[1]!;
  return normalTs({ ts: raw.startsWith('"') ? raw.slice(1, -1) : Number(raw) });
}

interface Cand { key: Key; ts: string; line: string; rec: Record<string, unknown>; level: Level | null; component: string; pre: boolean }

function parse(line: string, f: OpenLogFile, filter: LogFilter): Cand | null {
  let rec: unknown;
  try { rec = JSON.parse(line); } catch { return null; }
  if (rec === null || typeof rec !== "object" || Array.isArray(rec)) return null;
  const r = rec as Record<string, unknown>;
  const ts = normalTs(r);
  if (ts === null) return null;
  let level: Level | null = null;
  if (filter.stream === "diagnostic") { if (!isLevel(r.level)) return null; level = r.level; }
  let pre = true;
  if (filter.from !== undefined && ts < filter.from) pre = false;
  if (filter.to !== undefined && ts > filter.to) pre = false;
  if (pre && filter.minLevel && level && !levelAtLeast(level, filter.minLevel)) pre = false;
  if (pre && filter.component !== undefined) {
    const src = r.source as { id?: unknown; kind?: unknown } | undefined;
    const action = typeof r.action === "string" ? r.action.split(".")[0] : undefined;
    pre = filter.component === f.component || filter.component === src?.id || filter.component === src?.kind || filter.component === r.role || filter.component === action;
  }
  return { key: { ts, h: hashOf(line) }, ts, line, rec: r, level, component: f.component, pre };
}

interface Source { it: AsyncGenerator<Cand | "corrupt" | "long">; head: Cand | null }

async function* fileCands(f: OpenLogFile, o: { order: Order; filter: LogFilter; after: Key | null; stats: ScanStats; maxLine?: number }): AsyncGenerator<Cand | "corrupt" | "long"> {
  const base = { ...(o.maxLine ? { maxLine: o.maxLine } : {}), stats: o.stats };
  let lines: AsyncGenerator<RawLine>;
  if (o.order === "asc") {
    const from = [o.filter.from, o.after?.ts].filter((x): x is string => x !== undefined).sort().pop();
    const start = from ? await alignForward(f.fh, await seekByTs(f.fh, f.size, from, quickTs, false, o.stats), f.size, o.stats) : 0;
    lines = forwardLines(f.fh, { start, end: f.size, ...base });
  } else {
    const to = [o.filter.to, o.after?.ts].filter((x): x is string => x !== undefined).sort()[0];
    // the first line after `to`, and one search window beyond for lines slightly out of order
    const end = to ? await alignForward(f.fh, await seekByTs(f.fh, f.size, to, quickTs, true, o.stats), f.size, o.stats) : f.size;
    lines = backwardLines(f.fh, { end: to ? Math.min(f.size, end + 64 * 1024) : f.size, ...base });
  }
  for await (const raw of lines) {
    if (raw.tooLong) { yield "long"; continue; }
    const c = parse(raw.text, f, o.filter);
    if (!c) { yield "corrupt"; continue; }
    if (o.after && (o.order === "asc" ? cmp(c.key, o.after) <= 0 : cmp(c.key, o.after) >= 0)) continue;
    yield c;
  }
}

export async function runQuery(o: QueryOptions): Promise<QueryResult> {
  const fp = fingerprint(o.filter, o.order);
  const after = o.cursor !== undefined ? decodeCursor(o.cursor, fp) : null;
  const redactor = o.redactor ?? createRedactor();
  const files = await openLogFiles(o.dir, o.filter.stream, o.onListed ? { onListed: o.onListed } : {});
  const stats: ScanStats = { bytes: 0 };
  let corrupt = 0;
  const budget = o.maxScanBytes ?? 128 * 1024 * 1024;
  try {
    const sources: Source[] = files.map((f) => ({ it: fileCands(f, { order: o.order, filter: o.filter, after, stats, ...(o.maxLine ? { maxLine: o.maxLine } : {}) }), head: null }));
    const advance = async (s: Source): Promise<void> => {
      for (;;) {
        const n = await s.it.next();
        if (n.done) { s.head = null; return; }
        if (n.value === "corrupt" || n.value === "long") { corrupt++; continue; }
        s.head = n.value; return;
      }
    };
    await Promise.all(sources.map(advance));
    const records: LogRecordOut[] = [];
    let first: Key | null = null; let last: Key | null = null; let lastReturned: Key | null = null; let more = false; let truncated = false;
    const needle = o.filter.text?.toLowerCase();
    for (;;) {
      let pick: Source | null = null;
      for (const s of sources) {
        if (!s.head) continue;
        if (!pick || (o.order === "asc" ? cmp(s.head.key, pick.head!.key) < 0 : cmp(s.head.key, pick.head!.key) > 0)) pick = s;
      }
      if (!pick) break;
      if (stats.bytes > budget) { truncated = true; more = true; break; }
      const c = pick.head!;
      await advance(pick);
      let rec: Record<string, unknown> | null = null;
      if (c.pre) {
        rec = redactor.value(c.rec);
        // The text is matched against the redacted record, so a search cannot confirm a secret.
        if (needle !== undefined && JSON.stringify(rec).toLowerCase().indexOf(needle) < 0) rec = null;
      }
      if (rec) {
        // RULING: lines with an identical (ts, line hash) at a page boundary stay together (at most 100 extra), because
        // the cursor cannot tell them apart.
        const sameAsLast = lastReturned !== null && cmp(c.key, lastReturned) === 0 && records.length < o.limit + 100;
        if (records.length >= o.limit && !sameAsLast) { more = true; break; }
        records.push({ ts: c.ts, level: c.level, component: c.component, stream: o.filter.stream, record: rec });
        lastReturned = c.key;
      }
      first ??= c.key; last = c.key;
    }
    return {
      records, nextCursor: more && last ? encodeCursor(last, fp) : null, corrupt,
      scanned: { files: files.length, bytes: stats.bytes }, truncated, firstKey: first, lastKey: last,
    };
  } finally { await closeLogFiles(files); }
}
