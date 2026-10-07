// One log line -> one wire record. Accepts the D111 diagnostic shape (`ts`, `source`, `event`), the legacy
// `{ at, level, role, ...fields, msg }` shape that the module-api logger and the supervisor write today (spec R1), and
// the audit shape (`at` epoch ms, `actor`, `action`, `target`, `detail`). A line that is none of them is corrupt:
// the caller counts it. Redaction happens in `toRecord`, never later.
import { isLevel, isSourceKey, type Level } from "@plur1bus/log-schema";
import type { Redactor } from "./redact.ts";

export type LogStream = "diagnostic" | "out" | "audit";
export const LOG_STREAMS: readonly LogStream[] = ["diagnostic", "out", "audit"];

/** The wire record (rpc-schema `LogRecord`). */
export interface LogRecord {
  ts: string;
  level: Level;
  /** Source key of the FILE the line came from (D111 R7), `<kind>` or `<kind>:<id>`. */
  source: string;
  stream: LogStream;
  /** False when the line claims a different source than its file (spec R7). */
  attributed: boolean;
  event?: string;
  msg: string;
  trace_id?: string;
  span_id?: string;
  agent?: string;
  session?: string;
  turn?: number;
  task?: string;
  principal?: string;
  duration_ms?: number;
  err?: Record<string, unknown>;
  /** stdout or stderr, only on wrapped child output. */
  iostream?: "stdout" | "stderr";
  attrs?: Record<string, unknown>;
  /** msg or attrs was cut to its limit. */
  truncated?: true;
}

export const MSG_BYTES = 2048;
export const ATTRS_BYTES = 8192;

export interface Parsed { tsMs: number; level: Level; obj: Record<string, unknown>; audit: boolean }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const MAX_MS = 8.64e15;

/** A timestamp in epoch ms from `ts` (RFC 3339) or the legacy `at` (ISO string or epoch ms); null when there is none. */
export function timestampOf(o: Record<string, unknown>): number | null {
  const v = o["ts"] !== undefined ? o["ts"] : o["at"];
  if (typeof v === "number") return Number.isFinite(v) && Math.abs(v) <= MAX_MS ? Math.trunc(v) : null;
  if (typeof v === "string" && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(v)) { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
}

/** Cheap timestamp of a raw line for the bisection (no level or shape checks). */
export function tsOfLine(line: string): number | null {
  try { const o = JSON.parse(line) as unknown; return isObj(o) ? timestampOf(o) : null; } catch { return null; }
}

export function parseLine(line: string, stream: LogStream): Parsed | null {
  let o: unknown;
  try { o = JSON.parse(line); } catch { return null; }
  if (!isObj(o)) return null;
  const tsMs = timestampOf(o);
  if (tsMs === null) return null;
  if (stream === "audit") {
    if (typeof o["action"] !== "string" || typeof o["target"] !== "string") return null;
    return { tsMs, level: "info", obj: o, audit: true };
  }
  if (!isLevel(o["level"]) || typeof o["msg"] !== "string") return null;
  return { tsMs, level: o["level"], obj: o, audit: false };
}

/** The source key a file's role stands for. */
export function sourceKeyOfRole(role: string, stream: LogStream): string {
  if (stream === "audit") return "harness:audit";
  let key: string;
  if (role === "core" || role === "supervisor") key = `harness:${role}`;
  else if (role.startsWith("module-")) key = `harness:module/${role.slice(7)}`;
  else key = `harness:${role}`;
  return isSourceKey(key) ? key : "harness";
}

/** True when `filter` (a source key) selects `fileKey`: exact, a `/`-boundary prefix of the id, or the bare kind. */
export function sourceMatches(filter: string, fileKey: string): boolean {
  if (filter === fileKey) return true;
  if (!filter.includes(":")) return fileKey === filter || fileKey.startsWith(`${filter}:`);
  return fileKey.startsWith(`${filter}/`);
}

const KNOWN = new Set(["ts", "at", "level", "role", "source", "event", "msg", "trace_id", "span_id", "agent", "session", "turn", "task", "principal", "duration_ms", "err", "stream", "attrs"]);
const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) ? v : undefined);
const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

function cutBytes(s: string, max: number): string {
  if (bytes(s) <= max) return s;
  let out = "";
  let n = 0;
  for (const ch of s) { const b = bytes(ch); if (n + b > max) break; out += ch; n += b; }
  return out;
}

export function toRecord(p: Parsed, file: { key: string; stream: LogStream }, redactor: Redactor): LogRecord {
  const o = p.obj;
  const claimed = isObj(o["source"]) && typeof o["source"]["kind"] === "string"
    ? `${o["source"]["kind"]}${typeof o["source"]["id"] === "string" && o["source"]["id"] !== "" ? `:${o["source"]["id"]}` : ""}` : null;
  const attributed = claimed === null || sourceMatches(claimed, file.key) || claimed === file.key;
  let truncated = false;
  const rec: LogRecord = { ts: new Date(p.tsMs).toISOString(), level: p.level, source: file.key, stream: file.stream, attributed, msg: "" };

  if (p.audit) {
    rec.event = str(o["action"], 128) ?? "audit";
    rec.msg = redactor.text(String(o["target"]));
    const actor = isObj(o["actor"]) ? o["actor"] : null;
    const who = str(actor?.["user"], 128);
    if (who) rec.principal = redactor.text(who);
    const attrs: Record<string, unknown> = {};
    if (o["detail"] !== undefined) attrs["detail"] = o["detail"];
    if (isObj(o["actor"]) && typeof o["actor"]["host"] === "string") attrs["host"] = o["actor"]["host"];
    for (const k of ["v", "surface", "store_ref"]) if (o[k] !== undefined) attrs[k] = o[k];
    if (Object.keys(attrs).length > 0) rec.attrs = redactor.value(attrs) as Record<string, unknown>;
  } else {
    const ev = str(o["event"], 128);
    if (ev) rec.event = redactor.text(ev);
    rec.msg = redactor.text(String(o["msg"]));
    const tid = str(o["trace_id"], 64); if (tid) rec.trace_id = redactor.text(tid);
    const sid = str(o["span_id"], 64); if (sid) rec.span_id = redactor.text(sid);
    for (const k of ["agent", "session", "task", "principal"] as const) { const v = str(o[k], 128); if (v) rec[k] = redactor.text(v); }
    const turn = int(o["turn"]); if (turn !== undefined) rec.turn = turn;
    const dur = int(o["duration_ms"]); if (dur !== undefined) rec.duration_ms = dur;
    if (isObj(o["err"])) rec.err = redactor.value(o["err"]) as Record<string, unknown>;
    if (o["stream"] === "stdout" || o["stream"] === "stderr") rec.iostream = o["stream"];
    // Legacy lines carry free fields next to `msg` (instanceId, address, err, ...): they become attrs, redacted like the rest.
    const attrs: Record<string, unknown> = isObj(o["attrs"]) ? { ...o["attrs"] } : {};
    delete attrs["__proto__"];
    for (const [k, v] of Object.entries(o)) if (!KNOWN.has(k) && k !== "__proto__" && v !== undefined) attrs[k] = v;
    if (Object.keys(attrs).length > 0) rec.attrs = redactor.value(attrs) as Record<string, unknown>;
  }

  if (bytes(rec.msg) > MSG_BYTES) { rec.msg = cutBytes(rec.msg, MSG_BYTES); truncated = true; }
  if (rec.attrs) {
    const n = bytes(JSON.stringify(rec.attrs));
    if (n > ATTRS_BYTES) { rec.attrs = { truncated: true, bytes: n }; truncated = true; }
  }
  if (truncated) rec.truncated = true;
  return rec;
}
