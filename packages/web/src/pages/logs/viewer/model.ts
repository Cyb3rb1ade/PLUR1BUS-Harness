// Log viewer model: wire types of logs.query / logs.tail (docs/rpc.md, D111), the filter state and its exact RPC parameters,
// redaction markers, row summaries and export serialisation. Pure functions, no DOM, so node tests cover them directly.

export const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type Level = (typeof LEVELS)[number];
export type Stream = "diagnostic" | "audit";

export type LogRecord = { ts: string; level: Level | null; component: string; stream: Stream; record: Record<string, unknown> };
export type LogPage = { records: LogRecord[]; nextCursor: string | null; corrupt: number; scanned: { files: number; bytes: number }; truncated: boolean };

export type QueryParams = { stream: Stream; minLevel?: Level; component?: string; text?: string; from?: string; to?: string; order: "asc" | "desc"; limit: number; cursor?: string };
export type TailParams = { stream: Stream; minLevel?: Level; component?: string; text?: string; limit: number; cursor?: string; waitMs?: number };

export type Range = "any" | "15m" | "1h" | "24h" | "custom";
export type Order = "asc" | "desc";
export type Filters = {
  stream: Stream; minLevel: "" | Level; component: string; text: string; trace: string; range: Range; from: string; to: string; order: Order;
};
export const DEFAULT_FILTERS: Filters = { stream: "diagnostic", minLevel: "", component: "", text: "", trace: "", range: "any", from: "", to: "", order: "desc" };

export const PAGE_LIMIT = 200;
const RANGE_MS: Record<"15m" | "1h" | "24h", number> = { "15m": 900_000, "1h": 3_600_000, "24h": 86_400_000 };

export type BuildError = "both" | "badDate" | "emptyRange";
export type Built = { ok: true; params: QueryParams } | { ok: false; error: BuildError };

/** Local "datetime-local" value (2026-10-07T10:30) to RFC 3339 UTC; null when empty or not a date. */
export function localToIso(v: string): string | null {
  if (v.trim() === "") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The parameters of logs.query for a filter state. The server has no trace_id parameter: a trace id is sent as `text`, so it
 *  excludes a second text search (the server holds one substring filter). `minLevel` is not valid on the audit stream. */
export function buildQuery(f: Filters, now: number, cursor?: string): Built {
  const trace = f.trace.trim(), text = f.text.trim();
  if (trace !== "" && text !== "") return { ok: false, error: "both" };
  const p: QueryParams = { stream: f.stream, order: f.order, limit: PAGE_LIMIT };
  if (f.minLevel !== "" && f.stream === "diagnostic") p.minLevel = f.minLevel;
  if (f.component.trim() !== "") p.component = f.component.trim();
  if (trace !== "" || text !== "") p.text = trace !== "" ? trace : text;
  if (f.range === "custom") {
    const from = localToIso(f.from), to = localToIso(f.to);
    if ((f.from.trim() !== "" && from === null) || (f.to.trim() !== "" && to === null)) return { ok: false, error: "badDate" };
    if (from !== null && to !== null && from > to) return { ok: false, error: "emptyRange" };
    if (from !== null) p.from = from;
    if (to !== null) p.to = to;
  } else if (f.range !== "any") p.from = new Date(now - RANGE_MS[f.range]).toISOString();
  if (cursor !== undefined) p.cursor = cursor;
  return { ok: true, params: p };
}

/** logs.tail takes the stream, level, component and text filters only; the time range does not apply to new lines. */
export function tailParams(q: QueryParams, extra: { cursor?: string; waitMs?: number; limit?: number }): TailParams {
  const p: TailParams = { stream: q.stream, limit: extra.limit ?? PAGE_LIMIT };
  if (q.minLevel !== undefined) p.minLevel = q.minLevel;
  if (q.component !== undefined) p.component = q.component;
  if (q.text !== undefined) p.text = q.text;
  if (extra.cursor !== undefined) p.cursor = extra.cursor;
  if (extra.waitMs !== undefined) p.waitMs = extra.waitMs;
  return p;
}

/** New lines can be followed when the view is newest-first and open-ended (no upper time bound). */
export const liveEligible = (f: Filters): boolean => f.order === "desc" && !(f.range === "custom" && f.to.trim() !== "");

export const isDefaultFilters = (f: Filters): boolean => (Object.keys(DEFAULT_FILTERS) as (keyof Filters)[]).every((k) => f[k] === DEFAULT_FILTERS[k]);

// ---- rows -----------------------------------------------------------------------------------------------------------------

export const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** One-line summary of a record: `msg` (or the event code) for diagnostic lines; action and target for audit lines. */
export function messageOf(r: LogRecord): string {
  const rec = r.record;
  if (r.stream === "audit") return [str(rec.action) || str(rec.event), str(rec.target)].filter((x) => x !== "").join(" ") || "-";
  return str(rec.msg) || str(rec.event) || "-";
}

const MARKER = "\\[REDACTED:[^\\]]*\\]";
export type Piece = { text: string; redacted: boolean; rule: string };

/** Splits a string at the server's redaction markers `[REDACTED:<rule>]`. */
export function splitRedacted(text: string): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  for (const m of text.matchAll(new RegExp(MARKER, "g"))) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at), redacted: false, rule: "" });
    out.push({ text: m[0], redacted: true, rule: m[0].slice(10, -1) });
    last = at + m[0].length;
  }
  if (last < text.length || out.length === 0) out.push({ text: text.slice(last), redacted: false, rule: "" });
  return out;
}

export function hasRedaction(r: LogRecord): boolean { return JSON.stringify(r.record).includes("[REDACTED:"); }

/** Distinct redaction rules named in a record. */
export function redactionRules(r: LogRecord): string[] {
  return [...new Set([...JSON.stringify(r.record).matchAll(new RegExp(MARKER, "g"))].map((m) => m[0].slice(10, -1)))];
}

export type FieldRow = { key: string; value: string; block: boolean };

/** The fields of a record as text, in record order. Objects become indented JSON blocks. */
export function fieldRows(r: LogRecord): FieldRow[] {
  return Object.entries(r.record).map(([key, v]) => (typeof v === "object" && v !== null
    ? { key, value: JSON.stringify(v, null, 2), block: true }
    : { key, value: String(v), block: false }));
}

// ---- tail buffer ----------------------------------------------------------------------------------------------------------

export const TAIL_BUFFER_MAX = 2000;
export const ROW_CAP = 50_000;

/** Appends to a bounded buffer, dropping the oldest entries; returns how many were dropped. */
export function bufferAppend<T>(buf: readonly T[], incoming: readonly T[], max = TAIL_BUFFER_MAX): { buf: T[]; dropped: number } {
  const all = [...buf, ...incoming];
  const dropped = Math.max(0, all.length - max);
  return { buf: dropped > 0 ? all.slice(dropped) : all, dropped };
}

/** Stable identity of a line, to avoid showing the anchor line of logs.tail twice. */
export const recordKey = (r: LogRecord): string => `${r.ts}|${r.stream}|${r.component}|${JSON.stringify(r.record)}`;

// ---- export ---------------------------------------------------------------------------------------------------------------

/** Records exactly as the server returned them (already redacted). One JSON object per line. */
export const toNdjson = (recs: readonly LogRecord[]): string => recs.map((r) => JSON.stringify(r)).join("\n") + (recs.length > 0 ? "\n" : "");
export const toJson = (recs: readonly LogRecord[]): string => JSON.stringify(recs, null, 2) + "\n";
export function exportName(now: number, ext: "ndjson" | "json"): string {
  return `plur1bus-logs-${new Date(now).toISOString().replaceAll(/[:.]/g, "-")}.${ext}`;
}
