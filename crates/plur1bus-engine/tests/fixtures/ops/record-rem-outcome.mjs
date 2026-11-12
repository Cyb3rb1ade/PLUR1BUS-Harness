// Actual A1 pure REM outcome helper; the REM job body remains outside RX.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const pin = "9b935ce1f970bd92a931aa99a58c620669c8085f";
const source = process.env.PLUR1BUS_ENGINE_SRC;
const gitRoot = process.env.PLUR1BUS_ENGINE_GIT;
assert(source && gitRoot && process.version === "v24.21.0");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const sourceHashes = [
  "package.json", "engine/jobs/rem-outcome.js", "engine/jobs/run-state-migration.js",
  "engine/jobs/job-registry.js", "engine/jobs/job-ledger.js", "engine/jobs/job-specs.js", "engine/events.js",
  "lib/dreaming/dream-diary.js", "lib/host-sdk-loader.js", "lib/feature-cron-specs.js", "lib/sql-safety.js",
  "lib/log-redact.js",
].map(path => {
  const bytes = readFileSync(join(source, path));
  assert.equal(sha(bytes), sha(execFileSync("git", ["-C", gitRoot, "show", `${pin}:${path}`])));
  return { path, sha256: sha(bytes) };
});
const { remJobOutcome } = await import(pathToFileURL(join(source, "engine/jobs/rem-outcome.js")).href);
const report = (runKey, narrative) => ({ result: { report: { runKey, narrative } } });
const inputs = [
  [], [null, {}, { result: null }], [{ result: { skipped: true } }],
  [{ result: { skipped: true, reason: "already_processed" } }, { result: { skipped: true, reason: "later" } }],
  [{ result: { skipped: true, reason: "" } }], [{ result: { skipped: false, reason: "ignored" } }],
  [{ result: { report: {} } }], [report("one", "story")], [report("one", "")],
  [report("one", null), report("two", "story")], [report("same", ""), report("same", "")],
  [{ result: { skipped: true, reason: "first" } }, report("one", "story")],
  [{ result: { skipped: true, reason: "ignored", report: { runKey: "one" } } }],
  [{ result: { report: true } }], [{ result: { report: [] } }],
  [report(null, null), report(4.5, false), report("raw-\ud800-key", 0)],
  [{ result: { skipped: true, reason: ["opaque"] } }],
  [{ result: { skipped: true, reason: { opaque: "\udc00" } } }],
  [report("one", []), report("two", {})],
];
function capture() {
  const cases = [];
  for (const runs of inputs) {
    for (const narrativeExpected of [false, true]) {
      for (const dryRun of [false, true]) {
        const options = { narrativeExpected, dryRun };
        cases.push({ inputJson: JSON.stringify(runs), options, outputJson: JSON.stringify(remJobOutcome(runs, options)) });
      }
    }
  }
  return cases;
}
globalThis.fetch = async () => { throw new Error("network forbidden"); };
const cases = capture();
assert.deepEqual(capture(), cases);
const output = JSON.stringify({ pin, node: process.version, sourceHashes,
  boundaries: { implementation: "actual pure remJobOutcome", normalization: "none", providers: "none" }, cases }, null, 2);
writeFileSync(new URL("golden/rem-outcome.json", import.meta.url), output + "\n");
console.log(`Recorded ${cases.length} A1 outcome cases twice; SHA-256 ${sha(output + "\n")}`);
