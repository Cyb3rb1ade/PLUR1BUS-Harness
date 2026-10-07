// Mock data and /rpc handlers for the Activity and Sessions tests (test/activity-*.test.ts, test/sessions-*.test.ts). Shapes follow docs/rpc.md.
import type { MockHarnessServer } from "./mock-server.ts";
import type { LogRecord } from "../src/pages/logs/activity/model.ts";

/** Fixed "now": Wednesday 7 Oct 2026, 12:00 local time (the browser clock is set to it with page.clock). */
export const NOW = new Date(2026, 9, 7, 12, 0, 0).getTime();
export const at = (day: number, h: number, m = 0): number => new Date(2026, 9, day, h, m, 0).getTime();
const iso = (ms: number): string => new Date(ms).toISOString();

export const diag = (ms: number, event: string, job: string, agent = "main", trace = ""): LogRecord => ({
  ts: iso(ms), level: "info", component: "scheduler", stream: "diagnostic",
  record: { ts: iso(ms), level: "info", source: { kind: "harness", id: "core", version: null }, event, msg: "x", ...(trace ? { trace_id: trace } : {}), ...(agent ? { agent } : {}), attrs: { job } },
});
export const audit = (ms: number, action: string, detail: Record<string, unknown>, user = "usr_owner", trace = ""): LogRecord => ({
  ts: iso(ms), level: null, component: "audit", stream: "audit",
  record: { at: ms, actor: { user, host: "h" }, action, target: "", detail, ...(trace ? { trace_id: trace } : {}) },
});

export type ActivityFx = {
  audit: LogRecord[];
  diagnostic: LogRecord[];
  /** Records per page (the real server honours `limit`; the mock pages by this to exercise "Show more"). */
  pageSize: number;
  verify: { ok: boolean; records: number; files: number; lastSeq: number; lastHash: string | null; anchor: { status: string; seq: number | null }; findings: { code: string; file: string; line: number | null; seq: number | null }[]; findingsTotal: number };
};

export function defaultActivity(): ActivityFx {
  return {
    audit: [
      audit(at(7, 9, 30), "auth.login", { profile: "default" }, "usr_owner", "t-login"),
      audit(at(6, 16, 0), "user.break_glass", { target: "usr_anna", reason: "support case" }, "usr_admin", "t-bg"),
      audit(at(6, 10, 0), "config.set", { key: "core.logLevel" }),
    ],
    diagnostic: [
      diag(at(7, 8, 0), "scheduler.run.completed", "dreams.light", "main", "t-dream"),
      diag(at(7, 7, 0), "scheduler.run.completed", "models.scan", "", "t-scan"),
      diag(at(6, 3, 0), "scheduler.run.failed", "backup.daily", "", "t-backup"),
      diag(at(5, 10, 0), "scheduler.run.skipped", "cron.report", "bernd", "t-run"),
      diag(at(5, 9, 0), "scheduler.run.started", "cron.report", "bernd"),
      diag(at(2, 11, 0), "scheduler.run.completed", "cron.report", "main", "t-old"),
    ],
    pageSize: 100,
    verify: { ok: true, records: 1204, files: 3, lastSeq: 1204, lastHash: "ab", anchor: { status: "match", seq: 1204 }, findings: [], findingsTotal: 0 },
  };
}

/** Installs logs.query (cursor = start index in the stream, newest first) and audit.verify on the server. */
export function installActivity(server: MockHarnessServer, fx: ActivityFx = defaultActivity()): ActivityFx {
  const rpc = server.rpc;
  rpc.handle("logs.query", (p) => {
    const q = p as { stream?: string; cursor?: string; text?: string; limit?: number };
    const all = (q.stream === "audit" ? fx.audit : fx.diagnostic).filter((r) => !q.text || JSON.stringify(r.record).includes(q.text));
    const sorted = [...all].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    const start = q.cursor ? Number(q.cursor) : 0;
    const end = start + Math.min(fx.pageSize, q.limit ?? fx.pageSize);
    return { records: sorted.slice(start, end), nextCursor: end < sorted.length ? String(end) : null, corrupt: 0, scanned: { files: 1, bytes: 1 }, truncated: false };
  }, { write: false });
  rpc.handle("audit.verify", () => fx.verify, { write: false });
  return fx;
}

export type SessionRow = {
  id: string; kind: "direct"; agentId: string; scope: string; chatKey: string | null; title: string; pinned: boolean; memoryMode: "remember";
  createdAt: number; updatedAt: number; lastTurnAt: number | null; archivedAt: number | null; turnCount: number;
  /** Not part of the schema: a hostile or buggy server might send it; it must never reach the DOM. */
  preview?: string;
};

export function makeSessions(n: number): SessionRow[] {
  const agents = ["main", "bernd", "ops"];
  return Array.from({ length: n }, (_, i) => {
    const k = String(i + 1).padStart(3, "0");
    return {
      id: `ses_${k}`, kind: "direct", agentId: agents[i % 3]!, scope: "user", chatKey: null, title: `Chat ${k}`, pinned: i === 0, memoryMode: "remember",
      createdAt: at(1, 8) + i * 3_600_000, updatedAt: at(1, 9) + i * 3_600_000, lastTurnAt: i % 10 === 9 ? null : at(2, 9) + i * 3_600_000, archivedAt: i % 7 === 6 ? at(3, 9) : null, turnCount: i % 10 === 9 ? 0 : i + 2,
    } satisfies SessionRow;
  });
}

export function installSessions(server: MockHarnessServer, rows: SessionRow[], truncated = false): void {
  server.rpc.handle("session.list", () => ({ sessions: rows, truncated }), { write: false });
}
