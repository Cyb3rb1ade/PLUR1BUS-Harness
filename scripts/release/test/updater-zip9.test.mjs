import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Qualification cases for GP5 S1; no existing test is replaced or relaxed.
// Owner selected v2-only artifacts instead of a zip >= 9 plugin upgrade.
test("GP5 S1: the desktop lock excludes the zip parser for all targets", () => {
  // The Node-only release-scripts job has no Rust toolchain or registry cache.
  const lock = readFileSync(new URL("../../../apps/desktop/Cargo.lock", import.meta.url), "utf8");
  const names = [...lock.matchAll(/^name = "([^"]+)"$/gm)].map(match => match[1]);
  assert.ok(names.includes("tauri-plugin-updater"), "desktop package inventory must be present");
  assert.equal(names.includes("zip"), false, "no version of zip may enter the desktop lock");
});
test.todo("GP5 S1: modified signature refuses a malicious archive before any extraction write");
test.todo("GP5 S1: selected updater preserves anti-rollback and the exclusive install slot on native targets");
