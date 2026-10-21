import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InboxStore, createInboxService } from "../../src/inbox/index.ts";
import { createAuditNotices, createAuditNoticeLogReader } from "../../src/audit/notices.ts";
import { tempDir } from "../helpers/temp-dir.ts";

test("refused and drained events survive a transient journal; replay remains hour-limited and content-free", () => {
  const now = 10_000, file = join(tempDir("audit-notice-log-"), "audit.log");
  const store = new InboxStore({ path: ":memory:", clock: () => now });
  const notices = createAuditNotices({ port: createInboxService({ store, admins: () => [] }), owners: () => ["owner"], clock: () => now });
  writeFileSync(file, [
    { at: now, chain: "refused", chainReason: "anchor-invalid", detail: { secret: "private" } },
    { at: now, action: "audit.chain.pending_drained", detail: { count: 2, dropped: 3, secret: "private" } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  const read = createAuditNoticeLogReader({ file, consume: notices.record }); read.scan(); read.scan();
  createAuditNoticeLogReader({ file, consume: notices.record }).scan();
  const entries = store.list("owner", {}).entries;
  assert.deepEqual(entries.map(e => e.params.code).sort(), ["anchor-invalid", "pending", "pending-overflow"]);
  assert.doesNotMatch(JSON.stringify(entries), /private/);
  store.close();
});
test("tail reader retains partial UTF-8 rows, observes replacement and ignores stale history", () => {
  const file = join(tempDir("audit-notice-torn-"), "audit.log"); const rows: unknown[] = [];
  const reader = createAuditNoticeLogReader({ file, consume: row => rows.push(row) });
  reader.scan(); writeFileSync(file, '{"at":1,"actor":"ä"'); reader.scan(); assert.equal(rows.length, 0);
  appendFileSync(file, '}\n'); reader.scan(); assert.deepEqual(rows, [{ at: 1, actor: "ä" }]);
  renameSync(file, `${file}.old`); writeFileSync(file, '{"at":2}\n'); reader.scan(); assert.deepEqual(rows.at(-1), { at: 2 });
  const store = new InboxStore({ path: ":memory:", clock: () => 10_000_000 });
  const n = createAuditNotices({ port: createInboxService({ store, admins: () => [] }), owners: () => ["owner"], clock: () => 10_000_000 });
  n.record({ at: 1, chain: "refused", chainReason: "anchor-invalid" });
  assert.equal(store.list("owner", {}).entries.length, 0); store.close();
});

test("each read is bounded, a UTF-8 record can span ticks, and oversized input does not block later events", () => {
  const file = join(tempDir("audit-notice-budget-"), "audit.log"); const rows: unknown[] = []; let oversized = 0;
  const reader = createAuditNoticeLogReader({ file, consume: row => rows.push(row), onOversize: () => oversized++ });
  const text = "ä".repeat(600_000);
  writeFileSync(file, JSON.stringify({ text }) + "\n");
  reader.scan(); assert.equal(rows.length, 0, "one tick must not consume the >1MiB record");
  reader.scan(); assert.deepEqual(rows, [{ text }]);
  renameSync(file, `${file}.large-old`);
  writeFileSync(file, "x".repeat(9 * 1024 * 1024 + 1) + "\n" + '{"at":3}\n');
  for (let i = 0; i < 11; i++) reader.scan();
  assert.equal(oversized, 1);
  assert.deepEqual(rows.at(-1), { at: 3 });
});
