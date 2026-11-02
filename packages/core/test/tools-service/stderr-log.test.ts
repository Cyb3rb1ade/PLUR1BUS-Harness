/** Private tools stderr rotation has a finite disk footprint even when a child repeatedly fails at startup. */
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openToolsLog } from "../../src/tools-service/stderr-log.ts";

test("tools stderr rotates into at most three private generations", async () => {
  const home = mkdtempSync(join(tmpdir(), "p1b-tools-log-"));
  const logger = openToolsLog(home);
  try {
    for (let i = 0; i < 600; i++) logger.error(`refusal ${i}: ${"x".repeat(8192)}`);
    const directory = join(home, "logs");
    const files = readdirSync(directory);
    assert.deepEqual(files.sort(), ["tools.out.log", "tools.out.log.1", "tools.out.log.2", "tools.out.log.3"]);
    for (const name of files) {
      const file = join(directory, name);
      assert.ok(lstatSync(file).size <= 1 << 20, name);
      if (process.platform !== "win32") assert.equal(lstatSync(file).mode & 0o777, 0o600);
    }
    assert.match(readFileSync(join(directory, "tools.out.log"), "utf8"), /refusal 599/);
  } finally { await logger.close(); rmSync(home, { recursive: true, force: true }); }
});
