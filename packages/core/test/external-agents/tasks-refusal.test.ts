import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("the production ACP launcher refuses root's not-enforced task probe before target spawn", () => {
  const run = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--experimental-strip-types", "--conditions=source",
    fileURLToPath(new URL("./tasks-refusal.fixture.ts", import.meta.url))], { encoding: "utf8", timeout: 10000 });
  assert.equal(run.status, 0, run.stderr + run.stdout);
});
