import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const fixture = new URL("../../../tests/engine-parity/config/startup.json", import.meta.url);

test("startup config parity fixture is generated from the current Core rules", async () => {
  const committed = readFileSync(fixture, "utf8");
  const { renderEngineConfigVectors } = await import("./fixtures/engine-config-vectors.ts");
  assert.equal(committed, renderEngineConfigVectors(), "run pnpm --filter @plur1bus/core gen");
});

test("startup parity vectors cover privacy, ownership, providers, receipt and timestamp boundaries", async () => {
  const { engineConfigVectorInputs } = await import("./fixtures/engine-config-vectors.ts");
  const names = new Set(engineConfigVectorInputs().map(vector => vector.name));
  for (const name of ["host-owned-paths-and-budgets", "absolute-database-override", "cloud-refused-by-installation", "cloud-refused-by-any-agent", "missing-privacy-ack", "reranker-needs-own-ack", "conditional-model-exact-receipt", "conditional-model-wrong-revision", "receipt-time-and-actor-have-no-expiry-rule", "irrelevant-null-receipt", "prototype-key-is-refused", "ack-time:2026-10-18T23:59:60Z"])
    assert.ok(names.has(name), `missing startup parity boundary: ${name}`);
});

test("startup vector drift check refuses a changed committed result", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { pathToFileURL } = await import("node:url");
  const { checkEngineConfigVectors } = await import("./fixtures/engine-config-vectors.ts");
  const root = mkdtempSync(join(tmpdir(), "p1b-config-drift-"));
  try {
    const path = join(root, "candidate.json");
    writeFileSync(path, readFileSync(fixture, "utf8") + " ");
    assert.throws(() => checkEngineConfigVectors(pathToFileURL(path)), {
      name: "EngineConfigVectorMismatch",
      message: /startup config vectors stale/,
    });
    assert.throws(() => checkEngineConfigVectors(pathToFileURL(join(root, "missing.json"))), { code: "ENOENT" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
