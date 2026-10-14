// Findings of the logs/** audit (agent d01): each test failed before its fix.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createWriter } from "../../src/logs/writer.ts";
import { runQuery } from "../../src/logs/query.ts";
import { logsDir, put, rec, iso } from "./helpers.ts";

const source = { kind: "harness" as const, id: "core", version: null };
const lines = (dir: string): Array<Record<string, any>> => readFileSync(path.join(dir, "core.log"), "utf8").trim().split("\n").filter(Boolean).map((s) => JSON.parse(s));

describe("logs/** audit", () => {
  it("reader: one deeply nested foreign line is withheld and counted, not a failed query", async () => {
    const dir = logsDir();
    const deep = JSON.stringify({ ts: iso(1), level: "info", x: 0 }).replace("0}", `${"[".repeat(20000)}${"]".repeat(20000)}}`);
    put(dir, "core.log", rec(0, "info", "before") + deep + "\n" + rec(2, "info", "after"));
    const r = await runQuery({ dir, filter: { stream: "diagnostic" }, order: "asc", limit: 10 });
    assert.deepEqual(r.records.map((x) => x.record.msg), ["before", "after"]);
    assert.equal(r.corrupt, 1);
  });

  it("writer: caller fields cannot overwrite the legacy record's at, level, role or msg", () => {
    const dir = logsDir(); const w = createWriter({ dir, role: "core", source, timers: false, now: () => Date.UTC(2026, 9, 7) });
    w.writeLegacy("info", "hello", { level: "bogus", at: "1999-01-01T00:00:00.000Z", role: "other", msg: "forged", kept: 1 });
    w.close();
    const [row] = lines(dir);
    assert.equal(row!.level, "info"); assert.equal(row!.at, "2026-10-07T00:00:00.000Z"); assert.equal(row!.role, "core"); assert.equal(row!.msg, "hello");
    assert.equal(row!.kept, 1);
    assert.equal(row!.field_level, "bogus"); assert.equal(row!.field_msg, "forged");
  });

  it("writer: a failing sink never throws into the caller, queues a bounded number of records and recovers", () => {
    const dir = logsDir(); const w = createWriter({ dir, role: "core", source, timers: false });
    const file = path.join(dir, "core.log");
    mkdirSync(file); // an append now fails with "log path is not a regular file"
    for (let i = 0; i < 300; i++) assert.doesNotThrow(() => w.writeLegacy("info", `legacy ${i}`));
    for (let i = 0; i < 20; i++) assert.doesNotThrow(() => w.write("core.process.started", { pid: i }, { source }));
    rmSync(file, { recursive: true });
    w.flush();
    const rows = lines(dir);
    assert.ok(rows.length > 0 && rows.length <= 300, `${rows.length} rows kept`);
    assert.ok(rows.some((r) => r.event === "log.suppressed" && r.attrs.reason === "sink-failed" && r.attrs.dropped > 0), "the loss is reported once the sink works again");
    w.close();
  });
});
