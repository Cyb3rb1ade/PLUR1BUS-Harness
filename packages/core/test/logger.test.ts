import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/logger.ts";

describe("logger", () => {
  it("writes JSON lines with level, role, fields and honours the level", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "p1b-log-")), "core.log");
    const log = createLogger({ file, level: "info", role: "core" });
    log.debug("hidden"); log.info("hello", { agentId: "bernd" });
    log.child({ requestId: "r1" }).warn("child");
    await log.close();
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.deepEqual({ level: lines[0].level, role: lines[0].role, msg: lines[0].msg, agentId: lines[0].agentId }, { level: "info", role: "core", msg: "hello", agentId: "bernd" });
    assert.equal(lines[1].requestId, "r1"); assert.match(lines[1].at, /^\d{4}-\d{2}-\d{2}T/);
  });
});
