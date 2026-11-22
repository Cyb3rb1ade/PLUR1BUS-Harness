// Mode B exercises the TypeScript constructor with SQLite files written by both implementations.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DreamStore } from "../../packages/core/src/dreams/store.ts";

const [op, folder] = process.argv.slice(2);
assert.ok(folder);
const tsPath = join(folder, "from-ts.db");
const rustPath = join(folder, "from-rust.db");
const schema = (file: string) => {
  const db = new DatabaseSync(file);
  try {
    return {
      version: db.prepare("PRAGMA user_version").get(),
      integrity: db.prepare("PRAGMA integrity_check").get(),
      objects: db.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name LIKE 'dream_%' ORDER BY type, name").all(),
    };
  } finally { db.close(); }
};
if (op === "prepare") {
  const ts = new DreamStore(tsPath);
  try {
    assert.ok(ts.insertScheduleIfAbsent({ agentId: "agent-a", phase: "rem", cron: "15 1 * * *", timezone: "UTC", enabled: true, staggerOffsetS: 0, nextRunAt: 5000 }));
    ts.recordCapture("agent-a", 5.5, 65);
    ts.insertRun({ runId: "run-from-ts", agentId: "agent-a", phase: "rem", jobId: "fixture-job", partition: null,
      idempotencyKey: "fixture-slot", trigger: "manual", scheduledFor: 4000, startedAt: 4000, logPath: null });
    assert.ok(ts.claimKey("run-from-ts", "fixture-slot"));
  } finally { ts.close(); }
} else if (op === "verify") {
  const ts = new DreamStore(tsPath);
  const rust = new DreamStore(rustPath);
  try {
    assert.equal(ts.getRun("run-from-ts")?.outcome, "failed");
    assert.equal(ts.keyHolder("fixture-slot"), null);
    assert.equal(ts.getSchedule("agent-a", "rem")?.capturesAcc, 1);
    assert.equal(rust.getRun("run-from-rust")?.outcome, "completed");
    assert.equal(rust.getRun("run-from-rust")?.counts.llmSessions, 2);
    assert.equal(rust.keyHolder("fixture-key"), "run-from-rust");
  } finally { ts.close(); rust.close(); }
  assert.deepEqual(schema(rustPath), schema(tsPath));
  assert.equal(schema(tsPath).integrity?.integrity_check, "ok");
  console.log("DREAM_MODE_B_OK");
} else {
  throw new Error("unknown Mode B action");
}
