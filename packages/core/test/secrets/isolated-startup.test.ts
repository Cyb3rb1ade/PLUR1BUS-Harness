// A synchronous keyring call must not occupy Core's event loop or prevent startup/stop.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

for (const mode of ["default", "injected", "file-hang"]) test(`Core ${mode} startup survives synchronously blocked Store I/O and discards unsafe diagnostics`, () => {
  const env: NodeJS.ProcessEnv = { ...process.env, PLUR1BUS_ALLOW_TEST_INTERNALS: "1" };
  delete env.PLUR1BUS_SECRETS_KEYRING;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--experimental-test-module-mocks",
    "--conditions=source", fileURLToPath(new URL("./fixtures/isolated-core-startup.ts", import.meta.url)), mode], {
    env, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.error, undefined, `Core startup/stop did not finish while getPassword blocked: ${result.error?.message}`);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.ok(result.stdout.includes("synchronous-keyring-entered"), "the blocking native stand-in did not run");
  assert.ok(result.stdout.includes("core-heartbeat"), "Core's event loop did not run while the keyring was blocked");
});

for (const mode of ["test-internals", "production", "acl-refused", "failed-composition", "ungated-memory", "ungated-off", "stop-starting", "stop-before-store"]) test(`Core ${mode} keeps test isolation and startup cleanup bounded`, () => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PLUR1BUS_SECRETS_KEYRING;
  delete env.PLUR1BUS_ALLOW_TEST_INTERNALS;
  if (mode.startsWith("ungated-")) env.PLUR1BUS_SECRETS_KEYRING = mode.slice("ungated-".length);
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--experimental-test-module-mocks",
    "--conditions=source", fileURLToPath(new URL("./fixtures/isolated-core-startup.ts", import.meta.url)), mode], {
    env, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.ok(result.stdout.includes(mode === "test-internals" ? "test-internals-memory" : "startup-refusal-cleaned"));
});
