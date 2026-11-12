// RX1/C1: record only the controller-authorized recall changes from engine #257.
// PLUR1BUS_ENGINE_SRC=<immutable #257 head> node record-c1.mjs
// Providers are synthetic; the oracle uses real production namespace/store code.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { recordStages } from "./record-stages.mjs";
import { recordRuntimeCases } from "./record-namespace-runtime.mjs";

const root = process.env.PLUR1BUS_ENGINE_SRC;
assert.ok(root, "PLUR1BUS_ENGINE_SRC must identify the immutable C1 oracle");
assert.equal(process.version, "v24.21.0");
const sources = JSON.parse(readFileSync(new URL("./c1-sources.json", import.meta.url), "utf8"));
assert.equal(sources.commit, "432313664242fc6c29c0b9bf3bcea8b9e5ad93c0");
for (const [file, expected] of Object.entries(sources.sha256)) {
  const actual = createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex");
  assert.equal(actual, expected, `immutable C1 source mismatch: ${file}`);
}
await recordStages(root, {
  commit: sources.commit,
  pipelineSha256: sources.sha256["lib/recall-pipeline.js"],
  onlyNames: ["knowledge-section-failed-not-cached"],
});
const names = [
  "namespaces-foreign-identities-rerank",
  "namespaces-foreign-identities-rerank-fallback",
  "namespaces-fusion-rerank-fallback-disabled",
  "namespaces-canonical-exceeds-top-n-budget-enabled",
  "namespaces-canonical-exceeds-top-n-budget-disabled",
  "namespaces-canonical-budget-below-max-items-enabled",
  "namespaces-canonical-budget-below-max-items-disabled",
];
// These cases use only the runtime source, never the older plugin merge oracle.
const first = await recordRuntimeCases(root, undefined, names);
assert.deepEqual(await recordRuntimeCases(root, undefined, names), first, "C1 recordings must agree");
assert.deepEqual(Object.keys(first).sort(), [...names].sort());
for (const [name, runtime] of Object.entries(first)) {
  const recordedFrom = {
    engine: "node", runtimeCommit: sources.commit, node: process.version,
    unicode: process.versions.unicode, icu: process.versions.icu, sources,
  };
  const text = `${JSON.stringify({ recordedFrom, runtime }, null, 2)}\n`;
  assert.equal(text.toLowerCase().includes("open" + "claw"), false);
  writeFileSync(new URL(`./golden/namespaces/${name}.json`, import.meta.url), text);
}
console.log(`Recorded ${names.length} C1 namespace goldens twice`);
