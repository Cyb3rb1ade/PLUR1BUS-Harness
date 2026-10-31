import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

for (const consumer of ["connector", "discovery"]) {
  test(`${consumer} preserves only trusted watchdog cause after ACP stdout closes`, () => {
    const run = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--experimental-strip-types", "--conditions=source",
      fileURLToPath(new URL("./watchdog-consumers.fixture.ts", import.meta.url)), consumer], { encoding: "utf8", timeout: 10000 });
    assert.equal(run.status, 0, run.stderr + run.stdout);
  });
}

test("connector preserves aggregate RSS failure in the actual logged catalogue event", () => {
  const run = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--experimental-strip-types", "--conditions=source",
    fileURLToPath(new URL("./watchdog-consumers.fixture.ts", import.meta.url)), "connector", "aggregate"], { encoding: "utf8", timeout: 10000 });
  assert.equal(run.status, 0, run.stderr + run.stdout);
});
