// `logs.query` and `logs.tail` (D4, D111 §2.1): read-only views over `<home>/logs/`.
// `logs.levels` (D111 remainder): live snapshot of per-source levels; Owner/Admin, same RBAC action.
import { isLevel, isSourceKey, type Level } from "@plur1bus/log-schema";
import { RpcError } from "../rpc/errors.ts";
import type { AuditSink } from "../rbac/audit.ts";
import type { CallContext, Handler } from "../rpc/server.ts";
import type { LevelSettings, LogWriter } from "./writer.ts";
import { CursorError, mintCursor, runQuery, type LogFilter, type Order, type QueryResult } from "./query.ts";
import { createRedactor, type Redactor } from "./redact.ts";

export interface LogsDeps {
  /** `<home>/logs`. */
  dir: string;
  redactor?: Redactor;
  /** Core stop: ends a waiting `logs.tail`. */
  signal?: AbortSignal;
  now?: () => number;
  /** Resolves after `ms`, or early when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Poll interval of a waiting `logs.tail`. */
  pollMs?: number;
  maxScanBytes?: number;
  onListed?: () => void | Promise<void>;
  /** Live diagnostic writer; absent when the core is using an injected logger. */
  writer?: Pick<LogWriter, "updateLevels" | "currentLevels">;
  audit?: AuditSink;
  actor?: (ctx: CallContext) => { user: string; host: string };
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) return resolve();
  const t = setTimeout(done, ms);
  function done(): void { clearTimeout(t); signal.removeEventListener("abort", done); resolve(); }
  signal.addEventListener("abort", done, { once: true });
});

const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
/** Normalises to millisecond precision so it compares as text with the normalised record timestamps. */
function bound(name: string, v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !TS.test(v) || Number.isNaN(Date.parse(v))) throw new RpcError("E_INVALID_PARAMS", `${name} must be an RFC 3339 UTC timestamp`, { reason: "bad-timestamp" });
  const iso = new Date(v).toISOString();
  // Date.parse rolls impossible dates over (02-30 becomes 03-02, 24:00 the next day): that would filter another range than asked for.
  if (iso.slice(0, 19) !== v.slice(0, 19)) throw new RpcError("E_INVALID_PARAMS", `${name} is not a valid calendar time`, { reason: "bad-timestamp" });
  return iso;
}

interface Params { stream?: "diagnostic" | "audit"; from?: string; to?: string; minLevel?: LogFilter["minLevel"]; component?: string; text?: string; limit?: number; cursor?: string; order?: Order; waitMs?: number }
interface LevelsParams { defaultLevel?: Level; levels?: Record<string, Level>; unset?: string[]; traceUntil?: string | null }

function publicLevels(s: LevelSettings): { defaultLevel: Level; levels: Record<string, Level>; traceUntil: string | null } {
  return { defaultLevel: s.defaultLevel ?? "info", levels: { ...(s.levels ?? {}) }, traceUntil: s.traceUntil !== undefined ? new Date(s.traceUntil).toISOString() : null };
}

function filterOf(p: Params): LogFilter {
  const stream = p.stream ?? "diagnostic";
  const from = bound("from", p.from), to = bound("to", p.to);
  if (from !== undefined && to !== undefined && from > to) throw new RpcError("E_INVALID_PARAMS", "from is after to", { reason: "empty-range" });
  // RULING: the audit stream has no level; a level filter on it is refused rather than silently ignored.
  if (stream === "audit" && p.minLevel !== undefined) throw new RpcError("E_INVALID_PARAMS", "the audit stream has no level", { reason: "level-not-applicable" });
  return { stream, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}), ...(p.minLevel ? { minLevel: p.minLevel } : {}), ...(p.component ? { component: p.component } : {}), ...(p.text ? { text: p.text } : {}) };
}

export function createLogsMethods(d: LogsDeps): Record<string, Handler> {
  const redactor = d.redactor ?? createRedactor();
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? defaultSleep;
  const pollMs = d.pollMs ?? 250;
  const run = async (filter: LogFilter, order: Order, limit: number, cursor: string | undefined): Promise<QueryResult> => {
    try {
      return await runQuery({
        dir: d.dir, filter, order, limit, redactor, ...(cursor !== undefined ? { cursor } : {}),
        ...(d.maxScanBytes !== undefined ? { maxScanBytes: d.maxScanBytes } : {}), ...(d.onListed ? { onListed: d.onListed } : {}),
      });
    } catch (e) {
      if (e instanceof CursorError) throw new RpcError("E_INVALID_PARAMS", e.reason === "bad-cursor" ? "malformed cursor" : "cursor belongs to a different query", { reason: e.reason });
      throw e;
    }
  };

  const publicOf = (r: QueryResult) => ({ records: r.records, nextCursor: r.nextCursor, corrupt: r.corrupt, scanned: r.scanned, truncated: r.truncated });

  const query: Handler = async (params: Params) => {
    const filter = filterOf(params);
    return publicOf(await run(filter, params.order ?? "desc", params.limit ?? 100, params.cursor));
  };

  const tail: Handler = async (params: Params, ctx: CallContext) => {
    const filter = filterOf(params);
    const limit = params.limit ?? 100;
    const deadline = now() + (params.waitMs ?? 0);
    const stop = new AbortController();
    const abort = (): void => stop.abort();
    ctx.signal.addEventListener("abort", abort, { once: true });
    d.signal?.addEventListener("abort", abort, { once: true });
    try {
      let cursor = params.cursor;
      for (;;) {
        let out: ReturnType<typeof publicOf>;
        if (cursor === undefined) {
          // First call: the newest `limit` matches, oldest first. The cursor anchors at the newest line looked at (a match
          // or not), so lines that arrive later are all "after" it even when nothing matched yet.
          const back = await run(filter, "desc", limit, undefined);
          out = { ...publicOf(back), records: [...back.records].reverse(), nextCursor: back.firstKey ? mintCursor(filter, "asc", back.firstKey) : null };
        } else {
          const r = await run(filter, "asc", limit, cursor);
          // A page cut by `limit` (or by the scan budget) carries the cursor to continue; otherwise move past what was looked at.
          out = { ...publicOf(r), nextCursor: r.nextCursor ?? (r.lastKey ? mintCursor(filter, "asc", r.lastKey) : cursor) };
        }
        if (out.records.length > 0 || now() >= deadline || stop.signal.aborted) return out;
        await sleep(Math.min(pollMs, Math.max(1, deadline - now())), stop.signal);
        if (stop.signal.aborted) return out;
        cursor = out.nextCursor ?? cursor;
      }
    } finally { ctx.signal.removeEventListener("abort", abort); d.signal?.removeEventListener("abort", abort); }
  };

  const levels: Handler = async (params: LevelsParams, ctx: CallContext) => {
    if (!d.writer) throw new RpcError("E_NOT_AVAILABLE", "live log levels are not available");
    const current = d.writer.currentLevels();
    const changing = params.defaultLevel !== undefined || params.levels !== undefined || params.unset !== undefined || params.traceUntil !== undefined;
    if (!changing) return publicLevels(current);

    const nextLevels: Record<string, Level> = { ...(current.levels ?? {}) };
    for (const [key, value] of Object.entries(params.levels ?? {})) {
      if (!isSourceKey(key) || !isLevel(value)) throw new RpcError("E_INVALID_PARAMS", "invalid source level", { reason: "invalid-level" });
      nextLevels[key] = value;
    }
    for (const key of params.unset ?? []) {
      if (!isSourceKey(key)) throw new RpcError("E_INVALID_PARAMS", "invalid source key", { reason: "invalid-level" });
      delete nextLevels[key];
    }
    let traceUntil = current.traceUntil;
    if (params.traceUntil === null) traceUntil = undefined;
    else if (params.traceUntil !== undefined) {
      const iso = bound("traceUntil", params.traceUntil);
      traceUntil = Date.parse(iso!);
    }
    const next: LevelSettings = { defaultLevel: params.defaultLevel ?? current.defaultLevel ?? "info", levels: nextLevels, ...(traceUntil !== undefined ? { traceUntil } : {}) };
    try { d.writer.updateLevels(next); }
    catch (e) { throw new RpcError("E_INVALID_PARAMS", e instanceof Error ? e.message : "invalid level snapshot", { reason: "invalid-level" }); }
    const after = d.writer.currentLevels();
    const beforeMap: Record<string, Level | undefined> = { default: current.defaultLevel ?? "info", ...current.levels };
    const afterMap: Record<string, Level | undefined> = { default: after.defaultLevel ?? "info", ...after.levels };
    const actor = d.actor?.(ctx) ?? { user: "unknown", host: "rpc" };
    for (const key of new Set([...Object.keys(beforeMap), ...Object.keys(afterMap)])) {
      if (beforeMap[key] === afterMap[key]) continue;
      try { d.audit?.append({ at: now(), actor, action: "logs.levels", target: key, detail: { ...(beforeMap[key] ? { from: beforeMap[key] } : {}), to: afterMap[key] ?? after.defaultLevel ?? "info" } }); } catch { /* the live change stands */ }
    }
    if ((current.traceUntil ?? null) !== (after.traceUntil ?? null)) {
      try { d.audit?.append({ at: now(), actor, action: "logs.levels", target: "traceUntil", detail: { from: current.traceUntil ?? null, to: after.traceUntil ?? null } }); } catch { /* the live change stands */ }
    }
    return publicLevels(after);
  };

  return { "logs.query": query, "logs.tail": tail, "logs.levels": levels };
}
