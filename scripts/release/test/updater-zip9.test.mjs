import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Qualification cases for GP5 S1; no existing test is replaced or relaxed.
// Owner selected v2-only artifacts instead of a zip >= 9 plugin upgrade.
test("GP5 S1: the locked desktop graph has no zip parser across all features and targets", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const result = spawnSync("cargo", ["metadata", "--manifest-path", "apps/desktop/Cargo.toml", "--format-version", "1", "--offline", "--locked", "--all-features"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).packages.filter(pkg => pkg.name === "zip"), []);
});
test.todo("GP5 S1: modified signature refuses a malicious archive before any extraction write");
test.todo("GP5 S1: selected updater preserves anti-rollback and the exclusive install slot on native targets");
