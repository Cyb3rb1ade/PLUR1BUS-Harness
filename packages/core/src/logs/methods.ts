// `logs.query` and `logs.tail` (D4, D111 §2.1): read-only views over `<home>/logs/`. Both are guarded by RBAC action
// `logs.query` (Owner/Admin, packages/core/src/rbac/guard.ts); the handlers themselves know nothing about principals.
import { RpcError } from "../rpc/errors.ts";
import type { CallContext, Handler } from "../rpc/server.ts";
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
  return new Date(v).toISOString();
}

interface Params { stream?: "diagnostic" | "audit"; from?: string; to?: string; minLevel?: LogFilter["minLevel"]; component?: string; text?: string; limit?: number; cursor?: string; order?: Order; waitMs?: number }

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
  return { "logs.query": query, "logs.tail": tail };
}
