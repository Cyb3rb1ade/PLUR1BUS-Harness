// Check live startup defaults without re-recording or changing any golden.
// --config-module is a test-only candidate module used to simulate a future pin.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const require = createRequire(join(root, "packages/core/package.json"));
const engine = dirname(require.resolve("@cyb3rb1ade/plur1bus-memory/package.json"));
const candidate = process.argv.indexOf("--config-module");
const modulePath = candidate < 0 ? join(engine, "lib/setup/config-contract.js") : process.argv[candidate + 1];
const { resolveEffectiveConfig } = await import(pathToFileURL(resolve(modulePath)));
const current = resolveEffectiveConfig({}, { path: "" });
const ledger = JSON.parse(readFileSync(join(root, "crates/plur1bus-engine/schema/DRIFT.json"), "utf8"));
for (const issue of ledger.issues) {
  const expected = issue.kind === "runtime-default" ? issue.runtimeValue : issue.runtimeSchema?.default;
  if (expected === undefined) continue;
  const actual = issue.path.split(".").reduce((value, key) => value?.[key], current);
  assert.deepEqual(actual, expected, `${issue.path} drift: reconcile the live runtime and ledger`);
}
console.log("live runtime defaults match the drift ledger");
