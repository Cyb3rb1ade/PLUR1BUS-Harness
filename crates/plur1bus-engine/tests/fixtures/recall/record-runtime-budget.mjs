// RE-04/T6: actual exported runtime item-budget oracle, with immutable pin sources.
// PLUR1BUS_ENGINE_SRC=<9f34008c> node record-runtime-budget.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.PLUR1BUS_ENGINE_SRC;
assert.ok(root);
assert.equal(process.version, "v24.21.0");
const source = JSON.parse(readFileSync(new URL("./namespace-sources.json", import.meta.url), "utf8")).runtime;
for (const [file, expected] of Object.entries(source.sha256)) {
  assert.equal(createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex"), expected, file);
}
const { resolveRuntimeRecallBudget } = await import(pathToFileURL(path.join(root, "engine/recall/namespace-recall.js")));
const queries = ["", "short", "x".repeat(49), "x".repeat(50), "x".repeat(200), "x".repeat(201),
  "😀".repeat(26), "😀".repeat(101), "a PLAN now", "Projekt", "éplané", "replan", "plan_2", "roadmap", "milestone", "deadline"];
const ceilings = [undefined, null, NaN, Infinity, -Infinity, -3, 0, 0.5, 1.9, 12, 100, 101, "8"];
const adaptations = [undefined, {}, { enabled: false }, { enabled: true }, { enabled: 1 },
  ...[-1, 0, 0.3, 0.31, 1, 2, NaN, Infinity, null, "0.9"].map(tokenBudgetPct => ({ enabled: true, tokenBudgetPct }))];
const record = () => queries.map(query => ceilings.map(ceiling => adaptations.map(adaptive => resolveRuntimeRecallBudget(query, ceiling, adaptive))));
const expected = record();
assert.deepEqual(record(), expected);
const encode = (_, value) => value === undefined ? { special: "undefined" }
  : typeof value === "number" && !Number.isFinite(value) ? { special: String(value) } : value;
const output = { recordedFrom: { engine: "node", source, node: process.version }, queries, ceilings, adaptations, expected };
writeFileSync(new URL("./golden/runtime-item-budget.json", import.meta.url), `${JSON.stringify(output, encode, 2)}\n`);
console.log(`Recorded ${queries.length * ceilings.length * adaptations.length} runtime budget cases twice`);
