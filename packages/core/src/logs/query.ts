// logs.query: a newest-first, filtered, cursor-paged read over the chains in `logs/`. The files are read backwards in
// blocks and merged k-way by timestamp, so a page costs O(page + skipped), never O(file). A half last line is ignored,
// unparsable or oversize lines are counted (`corruptLines`) and the read goes on.
import { createHash } from "node:crypto";
import { compareLevels, isLevel, isSourceKey, type Level } from "@plur1bus/log-schema";
import { RpcError } from "../rpc/errors.ts";
import { listChains, openRegular, type LogChain, type OpenLog } from "./files.ts";
import { DEFAULT_BLOCK_BYTES, bisectByTime, completeEnd, readLinesBackward } from "./line-io.ts";
import { LOG_STREAMS, parseLine, sourceMatches, toRecord, tsOfLine, type LogRecord, type LogStream, type Parsed } from "./normalize.ts";
import type { Redactor } from "./redact.ts";

export interface LogFilter {
  /** RFC 3339, inclusive. */
  since?: string;
  /** RFC 3339, inclusive. */
  until?: string;
  levelMin?: Level;
  /** Source keys (`<kind>` or `<kind>:<id>`, id matched exactly or as a `/`-boundary prefix). */
  components?: string[];
  /** Case-insensitive substring, matched against the REDACTED text only. */
  text?: string;
  /** Default `["diagnostic", "out"]`; `audit` only when named. */
  streams?: LogStream[];
}
export interface LogQueryParams extends LogFilter { limit?: number; cursor?: string }
export interface LogQueryResult {
  records: LogRecord[];
  /** Pass back as `cursor` for the next (older) page; null when the read reached the end. */
  cursor: string | null;
  /** Lines that were not parsable, or over the line limit, among those read for this page. */
  corruptLines: number;
  scannedBytes: number;
  /** The scan budget ended the call before the page was full; `cursor` continues from where it stopped. */
  truncated: boolean;
}

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;
export const DEFAULT_MAX_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_TEXT = 256;
const MAX_COMPONENTS = 16;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const bad = (detail: string, reason: string): RpcError => new RpcError("E_INVALID_PARAMS", `invalid log filter: ${detail}`, { reason, detail });

export interface CompiledFilter {
  sinceMs: number | null; untilMs: number | null; levelMin: Level | null; components: string[]; needle: string | null; streams: Set<LogStream>;
}

/** Validates and compiles the filter part shared by logs.query and logs.tail. */
export function compileFilter(f: LogFilter): CompiledFilter {
  const time = (name: string, v: string | undefined): number | null => {
    if (v === undefined) return null;
    const t = typeof v === "string" && RFC3339.test(v) ? Date.parse(v) : Number.NaN;
    if (!Number.isFinite(t)) throw bad(`${name} must be an RFC 3339 timestamp with a zone`, `${name}-invalid`);
    return t;
  };
  const sinceMs = time("since", f.since);
  const untilMs = time("until", f.until);
  if (sinceMs !== null && untilMs !== null && sinceMs > untilMs) throw bad("since is after until", "range-invalid");
  if (f.levelMin !== undefined && !isLevel(f.levelMin)) throw bad("levelMin is not a level", "level-invalid");
  const components = f.components ?? [];
  if (!Array.isArray(components) || components.length > MAX_COMPONENTS || components.some((c) => !isSourceKey(c))) throw bad(`components must be at most ${MAX_COMPONENTS} source keys`, "component-invalid");
  if (f.text !== undefined && (typeof f.text !== "string" || f.text.length === 0 || f.text.length > MAX_TEXT)) throw bad(`text must be 1 to ${MAX_TEXT} characters`, "text-invalid");
  const streams = f.streams ?? ["diagnostic", "out"];
  if (!Array.isArray(streams) || streams.length === 0 || streams.some((s) => !LOG_STREAMS.includes(s))) throw bad("streams must name diagnostic, out or audit", "stream-invalid");
  return { sinceMs, untilMs, levelMin: f.levelMin ?? null, components, needle: f.text === undefined ? null : f.text.toLowerCase(), streams: new Set(streams) };
}

export const chainSelected = (c: LogChain, f: CompiledFilter): boolean =>
  f.streams.has(c.stream) && (f.components.length === 0 || f.components.some((x) => sourceMatches(x, c.key)));

export const levelPasses = (level: Level, f: CompiledFilter): boolean => f.levelMin === null || compareLevels(level, f.levelMin) >= 0;

export function textPasses(rec: LogRecord, f: CompiledFilter): boolean {
  if (f.needle === null) return true;
  const hay = [rec.msg, rec.event, rec.source, rec.agent, rec.session, rec.principal, rec.err ? JSON.stringify(rec.err) : "", rec.attrs ? JSON.stringify(rec.attrs) : ""].join("\n").toLowerCase();
  return hay.includes(f.needle);
}

interface Cursor { t: number; c: string; h: string }
const hashOf = (line: string): string => createHash("sha256").update(line).digest("hex").slice(0, 16);
export const encodeCursor = (c: Cursor): string => Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
export function decodeCursor(s: string): Cursor {
  const fail = (): never => { throw new RpcError("E_INVALID_PARAMS", "invalid cursor", { reason: "cursor-invalid" }); };
  if (typeof s !== "string" || s.length === 0 || s.length > 512 || !/^[A-Za-z0-9_-]+$/.test(s)) return fail();
  let o: unknown;
  try { o = JSON.parse(Buffer.from(s, "base64url").toString("utf8")); } catch { return fail(); }
  if (typeof o !== "object" || o === null) return fail();
  const { t, c, h } = o as Record<string, unknown>;
  if (typeof t !== "number" || !Number.isSafeInteger(t) || typeof c !== "string" || c.length > 160 || typeof h !== "string" || !/^[0-9a-f]{16}$/.test(h)) return fail();
  return { t, c, h };
}

type Item = { corrupt: true } | { corrupt: false; parsed: Parsed; text: string };
interface ChainReader { chain: LogChain; next(): Promise<IteratorResult<Item>>; head: Item | null; done: boolean }

export interface QueryDeps {
  dir: string;
  redactor: Redactor;
  maxScanBytes?: number;
  blockBytes?: number;
}

export function createLogQuery(d: QueryDeps): { query(p: LogQueryParams, signal?: AbortSignal): Promise<LogQueryResult> } {
  const block = d.blockBytes ?? DEFAULT_BLOCK_BYTES;
  const maxScan = d.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES;

  async function query(p: LogQueryParams, signal?: AbortSignal): Promise<LogQueryResult> {
    const f = compileFilter(p);
    const limit = p.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw bad(`limit must be 1 to ${MAX_LIMIT}`, "limit-invalid");
    const cursor = p.cursor !== undefined ? decodeCursor(p.cursor) : null;
    const upperMs = Math.min(...[f.untilMs, cursor?.t].filter((x): x is number => typeof x === "number"), Number.POSITIVE_INFINITY);
    const bounded = Number.isFinite(upperMs);

    const chains = listChains(d.dir).filter((c) => chainSelected(c, f));
    const opened: OpenLog[] = [];
    const st = { scanned: 0, corrupt: 0 };
    try {
      // Every file of every selected chain is opened up front: the descriptors pin the inodes, so a rotation that
      // happens during the call cannot make a file be read twice or the chain's order change under us. A file seen
      // twice (rotated between two opens) is skipped by identity.
      const readers: ChainReader[] = [];
      for (const chain of chains) {
        const files: OpenLog[] = [];
        const seen = new Set<string>();
        for (const file of chain.files) {
          const o = await openRegular(file);
          if (!o) continue;
          if (o.identity.endsWith(":0") || !seen.has(o.identity)) { seen.add(o.identity); files.push(o); opened.push(o); } else await o.close();
        }
        if (files.length === 0) continue;
        const gen = (async function* (): AsyncGenerator<Item> {
          for (const o of files) {
            const whole = await completeEnd(o.fh, o.size, block);
            const end = bounded ? await bisectByTime(o.fh, whole, upperMs + 1, tsOfLine, { blockBytes: block }) : whole;
            for await (const line of readLinesBackward(o.fh, end, block)) {
              st.scanned += line.end - line.start + 1;
              if (line.text === null) { yield { corrupt: true }; continue; }
              const parsed = parseLine(line.text, chain.stream);
              yield parsed ? { corrupt: false, parsed, text: line.text } : { corrupt: true };
            }
          }
        })();
        readers.push({ chain, head: null, done: false, next: () => gen.next() });
      }

      const advance = async (r: ChainReader): Promise<void> => {
        for (;;) {
          signal?.throwIfAborted();
          const n = await r.next();
          if (n.done) { r.head = null; r.done = true; return; }
          if (n.value.corrupt) { st.corrupt++; continue; }
          if (f.sinceMs !== null && n.value.parsed.tsMs < f.sinceMs) { r.head = null; r.done = true; return; } // RULING: files are time-ordered; the older rest of this chain is out of range
          r.head = n.value; return;
        }
      };
      await Promise.all(readers.map(advance));

      const records: LogRecord[] = [];
      const passed = new Map<string, { found: boolean }>(); // cursor chain: lines at the cursor's ms newer than the cursor line are skipped
      let last: { t: number; c: string; text: string } | null = null;
      let truncated = false;
      for (;;) {
        let best: ChainReader | null = null;
        for (const r of readers) {
          if (!r.head) continue;
          if (!best) { best = r; continue; }
          const a = (r.head as Extract<Item, { corrupt: false }>).parsed.tsMs;
          const b = (best.head as Extract<Item, { corrupt: false }>).parsed.tsMs;
          if (a > b || (a === b && r.chain.id > best.chain.id)) best = r;
        }
        if (!best) break;
        if (st.scanned > maxScan) { truncated = true; break; }
        const item = best.head as Extract<Item, { corrupt: false }>;
        const chain = best.chain;
        await advance(best);

        const pos = { t: item.parsed.tsMs, c: chain.id, text: item.text };
        if (cursor) {
          if (item.parsed.tsMs > cursor.t) continue;
          if (item.parsed.tsMs === cursor.t) {
            if (chain.id > cursor.c) continue;
            if (chain.id === cursor.c) {
              const h = hashOf(item.text);
              const s = passed.get(chain.id) ?? { found: false };
              passed.set(chain.id, s);
              if (!s.found) { if (h === cursor.h) s.found = true; continue; }
              if (h === cursor.h) continue; // an identical line at the same ms: indistinguishable from the cursor line, not returned twice
            }
          }
        }
        last = pos;
        if (f.untilMs !== null && item.parsed.tsMs > f.untilMs) continue;
        if (!levelPasses(item.parsed.level, f)) continue;
        const rec = toRecord(item.parsed, { key: chain.key, stream: chain.stream }, d.redactor);
        if (!textPasses(rec, f)) continue;
        records.push(rec);
        if (records.length >= limit) break;
      }

      // `last` is the last line looked at, matching or not: a budget stop resumes from it.
      const next = last && (truncated || (records.length >= limit && readers.some((r) => r.head !== null)))
        ? encodeCursor({ t: last.t, c: last.c, h: hashOf(last.text) }) : null;
      return { records, cursor: next, corruptLines: st.corrupt, scannedBytes: st.scanned, truncated };
    } finally {
      await Promise.all(opened.map((o) => o.close().catch(() => {})));
    }
  }
  return { query };
}
