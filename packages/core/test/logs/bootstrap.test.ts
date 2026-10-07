import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { validateRecord } from "@plur1bus/log-schema";
import { createCoreLog } from "../../src/logs/bootstrap.ts";
import { mkHarness } from "../helpers/dreams.ts";
import { logsDir } from "./helpers.ts";
it("bootstrap maps core lifecycle and real scheduler skip to catalogued sources", async () => {
  const dir = logsDir(); const h = mkHarness();
  const log = createCoreLog({ dir, role: "core", source: { kind: "harness", id: "core", version: "0.1.0" }, now: () => h.clock.now(), timers: false });
  try {
    log.info("core ready");
    h.sched = h.make({ logger: log });
    const run = await h.sched.runPhase("bernd", "rem", { trigger: "manual" }); assert.equal(run.outcome, "skipped");
    log.info("core stopped"); await log.close();
    const rs = readFileSync(path.join(dir, "core.log"), "utf8").trim().split("\n").map(s => JSON.parse(s)).filter(r => r.event);
    assert.deepEqual(rs.map(r => r.event), ["core.process.started", "core.process.ready", "scheduler.run.skipped", "core.process.stopping"]);
    assert.equal(rs[2].source.id, "scheduler"); assert.equal(rs[2].attrs.reason, run.reason);
    for (const row of rs) assert.equal(validateRecord(row).ok, true);
  } finally { await log.close(); await h.sched.stop(); h.store.close(); }
});
it("an uncaught crash flushes buffered, redacted records without swallowing the exit", async () => {
  const { spawn } = await import("node:child_process"); const { fileURLToPath } = await import("node:url"); const dir = logsDir();
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--conditions=source", fileURLToPath(new URL("./crash-worker.ts", import.meta.url)), dir], { stdio: "ignore" });
    child.on("error", reject); child.on("close", resolve);
  });
  assert.equal(code, 1); const text = readFileSync(path.join(dir, "core.log"), "utf8");
  assert.ok(text.includes("core.process.started") && text.includes("core.process.stopping") && text.includes("buffered crash fixture")); assert.ok(!text.includes("fixture-crash-canary"));
});
it("legacy scan failure remains synchronously readable by existing diagnostics", async () => {
  const dir = logsDir(); const log = createCoreLog({ dir, role: "core", source: { kind: "harness", id: "core", version: null }, timers: false });
  try {
    log.warn("model.scan.failed", { source: "provider:fixture", password: "fixture-legacy-canary" });
    const text = readFileSync(path.join(dir, "core.log"), "utf8");
    assert.ok(text.includes("model.scan.failed")); assert.ok(!text.includes("fixture-legacy-canary"));
  } finally { await log.close(); }
});
