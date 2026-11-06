// Run the real startup composition with isolated module mocks and no OS keyring or model download.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createRedactor, maskSecretsInJson } from "../../src/logs/redact.ts";

for (const mode of ["default", "injected"]) test(`Core ${mode} logger registers config values before startup, live listeners and protocol output`, () => {
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--experimental-strip-types",
    "--conditions=source", fileURLToPath(new URL("./fixtures/config-registration.ts", import.meta.url)), ...(mode === "injected" ? ["--injected"] : [])], {
    env: { ...process.env, PLUR1BUS_ALLOW_TEST_INTERNALS: "1", PLUR1BUS_SECRETS_KEYRING: "memory" },
    encoding: "utf8", timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test("malformed numeric config secrets are masked in log attributes while numeric tool-result failures remain closed", () => {
  const secret = Number.parseInt(randomUUID().slice(0, 8), 16) + 100_000_000;
  const secrets = [String(secret)];
  assert.deepEqual(createRedactor({ secrets }).value({ ordinary: secret, public: 4096 }), { ordinary: 0, public: 4096 });
  assert.throws(() => maskSecretsInJson(JSON.stringify({ ordinary: secret }), { ordinary: secret }, secrets), /outside any string/);
});
