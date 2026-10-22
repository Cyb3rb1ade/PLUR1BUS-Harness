import type { MockHarnessServer } from "./mock-server.ts";

export const NOW = Date.UTC(2026, 9, 21, 10);
export function auditFixture() {
  return {
    health: { state: "ok", reason: null, lastSeq: 9, observedAt: NOW - 1000, lastVerifiedAt: null,
      pendingLines: 0, pendingDropped: 0, pending: [] as Record<string, unknown>[],
      lastAnchorAdvanced: { at: NOW - 2000, actor: { user: "usr_owner", host: "local" } }, lastReanchor: null },
    verify: { ok: true, records: 9, files: 1, lastSeq: 9, lastHash: "ab", anchor: { status: "match", seq: 9 }, findings: [] as Record<string, unknown>[], findingsTotal: 0,
      reanchors: [{ seq: 1, file: "audit-2026-10-21.jsonl", line: 1, at: NOW - 3000, suffix: "pre-reanchor-1792570000000" }],
      previousChains: [{ suffix: "pre-reanchor-1792570000000", announced: true, files: 2, records: 41, lastSeq: 41, lastHash: "cd", intact: false,
        firstBreak: { code: "hash-mismatch", file: "audit-2026-10-20.jsonl", line: 42, seq: 42 }, anchor: { status: "mismatch", seq: 42 } }] },
  };
}
export function installAudit(server: MockHarnessServer, fx = auditFixture()) {
  server.rpc.handle("core.status", () => ({ ready: true, audit: fx.health }), { write: false });
  server.rpc.handle("audit.verify", () => fx.verify, { write: false });
  return fx;
}
