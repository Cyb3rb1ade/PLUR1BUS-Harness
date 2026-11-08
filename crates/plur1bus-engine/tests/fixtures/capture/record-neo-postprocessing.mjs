// Actual frozen S2 postprocessing decisions; no models, network or workspace mutations.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pin = "b5f8e285a16f1e9e7ae0e44313538d8c353d7eaa";
const root = process.env.PLUR1BUS_ENGINE_SRC;
const git = process.env.PLUR1BUS_ENGINE_GIT;
assert.equal(process.version, "v24.21.0");
assert.ok(root && git, "pinned source and read-only git paths required");
const relative = "lib/episode-watermark.js";
const source = readFileSync(path.join(root, relative));
assert.deepEqual(source, execFileSync("git", ["-C", git, "show", `${pin}:${relative}`]));
const api = await import(pathToFileURL(path.join(root, relative)));
const failures = [0, 1, 4, 5, -1, 0.2, 1.9, NaN, Infinity, Number.MAX_SAFE_INTEGER];
const limits = [0, 1, 5, -1, 0.5, 1.9, NaN, Infinity, Number.MAX_SAFE_INTEGER];
const resultSets = [[], [true], [false], [true, false], [false, false]];
const examples = [
  { previous: [], episodes: [] },
  { previous: [], episodes: [[], ["a"], ["a", "b"]] },
  { previous: ["a"], episodes: [[], ["a"], ["a", "b"], ["b"]] },
  { previous: ["a", "b"], episodes: [["a", "b"], ["b", "a"], ["b", "c"]] },
  { previous: ["a", "a", "b"], episodes: [["a", "c"], ["a", "a"]] },
  { previous: ["\ud800"], episodes: [["\ud800"], ["�"], ["\udc00"]] },
  { previous: ["__proto__", ""], episodes: [[""], ["constructor"], ["__proto__"]] },
];
function run() {
  const retry = [];
  for (const results of resultSets) {
    for (const previous of failures) {
      for (const limit of limits) {
        retry.push({
          results,
          failures: String(previous),
          maxRetries: String(limit),
          output: api.resolveWatermarkAdvance({ results, failures: previous, maxRetries: limit }),
        });
      }
    }
  }
  const episodes = [];
  for (const example of examples) {
    const records = example.episodes.map((memoryIds, index) => ({ id: `ep-${index}`, memoryIds }));
    for (const limit of [0, 0.5, 1, 2, 3, 2000, NaN, Infinity, -1, 1.9]) {
      episodes.push({
        previous: example.previous,
        episodes: records,
        limit: String(limit),
        filtered: api.filterAlreadyEpisoded(records, new Set(example.previous)),
        merged: api.mergeEpisodedTurnIds(example.previous, records, limit),
      });
    }
  }
  return { retry, episodes };
}
const recorded = run();
assert.deepEqual(run(), recorded);
const here = path.dirname(fileURLToPath(import.meta.url));
const provenance = {
  commit: pin,
  node: process.version,
  sourceHashes: { [relative]: createHash("sha256").update(source).digest("hex") },
};
writeFileSync(path.join(here, "golden/neo-postprocessing.json"), `${JSON.stringify({ provenance, ...recorded }, null, 2)}\n`);
console.log(`Recorded ${recorded.retry.length} retry decisions and ${recorded.episodes.length} episode-ID cases twice`);
