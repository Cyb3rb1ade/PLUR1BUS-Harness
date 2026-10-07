// Mock logs.query / logs.tail for the log viewer tests (test/logs-*.test.ts). Shapes follow docs/rpc.md (LogPage, LogRecord).
// `lines` is the log in append order (oldest first). logs.query pages it with a numeric-offset cursor; logs.tail anchors at the
// end and then long-polls (up to 1.5 s, the mock ignores larger waitMs) for lines pushed with `push()`.
import type { MockHarnessServer } from "./mock-server.ts";
import type { LogRecord } from "../src/pages/logs/viewer/model.ts";

export const T0 = Date.UTC(2026, 9, 7, 11, 0, 0);
const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"];
const CYCLE = ["info", "info", "warn", "error", "debug", "info"] as const;
const iso = (ms: number): string => new Date(ms).toISOString();

/** Record number k (1 = oldest). Every 10th line carries a trace id, every 7th a redacted attribute. */
export function makeRecord(k: number, over: Partial<LogRecord> = {}): LogRecord {
  const level = CYCLE[k % CYCLE.length]!;
  const ts = iso(T0 + k * 1000);
  const record: Record<string, unknown> = {
    ts, level, source: { kind: "harness", id: "core", version: "1.0.0" }, event: "core.tick", msg: `entry ${String(k).padStart(5, "0")}`,
    ...(k % 10 === 0 ? { trace_id: `trace${String(k).padStart(4, "0")}` } : {}),
    ...(k % 7 === 0 ? { attrs: { api_key: "[REDACTED:secret-key]", note: "visible" } } : {}),
  };
  return { ts, level, component: "core", stream: "diagnostic", record, ...over };
}

export const makeLines = (n: number): LogRecord[] => Array.from({ length: n }, (_, i) => makeRecord(i + 1));

export type LogsMock = {
  lines: LogRecord[];
  audit: LogRecord[];
  push(...recs: LogRecord[]): void;
  queries(): Record<string, unknown>[];
  tails(): Record<string, unknown>[];
};

const page = (records: LogRecord[], nextCursor: string | null): unknown => ({ records, nextCursor, corrupt: 0, scanned: { files: 1, bytes: 1024 }, truncated: false });

export function installLogsMocks(server: MockHarnessServer, init: { lines?: LogRecord[]; tail?: boolean; query?: boolean } = {}): LogsMock {
  const mock: LogsMock = {
    lines: init.lines ?? makeLines(30), audit: [],
    push(...recs) { mock.lines.push(...recs); for (const w of waiters.splice(0)) w(); },
    queries: () => server.rpc.calls.filter((c) => c.method === "logs.query").map((c) => c.params as Record<string, unknown>),
    tails: () => server.rpc.calls.filter((c) => c.method === "logs.tail").map((c) => c.params as Record<string, unknown>),
  };
  const waiters: (() => void)[] = [];
  const rank = (l: string | null): number => (l === null ? -1 : LEVELS.indexOf(l));
  const match = (r: LogRecord, p: Record<string, unknown>): boolean => {
    if (typeof p.minLevel === "string" && rank(r.level) < rank(p.minLevel)) return false;
    if (typeof p.component === "string" && r.component !== p.component) return false;
    if (typeof p.text === "string" && !JSON.stringify(r.record).toLowerCase().includes(p.text.toLowerCase())) return false;
    if (typeof p.from === "string" && r.ts < p.from) return false;
    if (typeof p.to === "string" && r.ts > p.to) return false;
    return true;
  };
  if (init.query !== false) {
    server.rpc.handle("logs.query", (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const src = p.stream === "audit" ? mock.audit : mock.lines;
      const all = src.filter((r) => match(r, p));
      const ordered = p.order === "asc" ? all : all.slice().reverse();
      const start = typeof p.cursor === "string" ? Number(p.cursor) : 0;
      const limit = typeof p.limit === "number" ? p.limit : 100;
      const slice = ordered.slice(start, start + limit);
      return page(slice, start + limit < ordered.length ? String(start + limit) : null);
    }, { write: false });
  }
  if (init.tail !== false) {
    server.rpc.handle("logs.tail", async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const limit = typeof p.limit === "number" ? p.limit : 100;
      if (typeof p.cursor !== "string") return page(mock.lines.filter((r) => match(r, p)).slice(-limit), `t${mock.lines.length}`);
      const from = Number(p.cursor.slice(1));
      if (mock.lines.length <= from) await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 1500); waiters.push(() => { clearTimeout(timer); resolve(); }); });
      const fresh = mock.lines.slice(from);
      return page(fresh.filter((r) => match(r, p)).slice(0, limit), `t${from + fresh.length}`);
    }, { write: false });
  }
  return mock;
}
