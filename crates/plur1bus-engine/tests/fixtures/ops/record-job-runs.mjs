// Actual A1 registry execution over explicitly scripted bodies and a synthetic ledger port.
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
const sourceHashes = ["package.json", "engine/jobs/job-registry.js", "engine/jobs/job-ledger.js",
  "engine/jobs/job-specs.js", "engine/events.js", "lib/dreaming/dream-diary.js", "lib/host-sdk-loader.js",
  "lib/feature-cron-specs.js", "lib/sql-safety.js", "lib/log-redact.js"].map(path => {
  const bytes = readFileSync(join(source, path));
  assert.equal(sha(bytes), sha(execFileSync("git", ["-C", gitRoot, "show", `${pin}:${path}`])));
  return { path, sha256: sha(bytes) };
});
const { createJobRegistry } = await import(pathToFileURL(join(source, "engine/jobs/job-registry.js")).href);
const now = 1800000000000;
const scenarios = [
  { name: "completed", body: "completed", options: {} },
  { name: "skipped", body: "skipped", options: {} },
  { name: "failed", body: "failed", options: {} },
  { name: "incomplete", body: "incomplete", options: {} },
  { name: "dry-run", body: "completed", options: { dryRun: true } },
  { name: "harness-trigger", body: "completed", options: { trigger: "harness" } },
  { name: "cron-trigger", body: "completed", options: { trigger: "cron" } },
  { name: "rem-breaker", job: "rem-dream", body: "completed", repeat: 4, options: {} },
  { name: "rem-abandonment", job: "rem-dream", body: "incomplete", repeat: 4, options: {} },
  { name: "singleton-overlap", body: "concurrent", options: {} },
];
async function capture() {
  const cases = [];
  for (const input of scenarios) {
    let calls = 0;
    let id = 0;
    const rows = [];
    const markers = [];
    const removed = [];
    const events = [];
    const ledger = {
      readAll: () => [...rows],
      snapshot: () => ({ rows: [...rows], unreadable: 0 }),
      orphanMarkers: () => [],
      writeMarker: marker => markers.push({ runId: marker.runId, job: marker.job, phase: marker.phase,
        trigger: marker.trigger, startedAt: marker.startedAt }),
      removeMarker: id => removed.push(id),
      append: row => rows.push({ v: 1, ...row }),
    };
    const host = { clock: () => now, logger: { warn() {}, debug() {}, info() {} },
      events: { emit: (name, value) => events.push({ name, value: JSON.stringify(value) }) } };
    const registry = createJobRegistry({ host, jobsRoot: "synthetic-ledger-port", createLedger: () => ledger,
      idFactory: () => `run-${++id}` });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const job = input.job || "knowledge-update";
    registry.bind(job, async (_, context) => {
      calls += 1;
      if (input.body === "failed") throw new Error("synthetic failure");
      if (input.body === "skipped") return context.skip("disabled");
      if (input.body === "incomplete") return context.incomplete("pending");
      if (input.body === "concurrent") await gate;
      return { integrated: 1 };
    });
    let results;
    if (input.body === "concurrent") {
      const first = registry.run(job, "alpha", input.options);
      const second = await registry.run(job, "alpha", input.options);
      release();
      results = [await first, second];
    } else {
      results = [];
      for (let i = 0; i < (input.repeat || 1); i += 1) results.push(await registry.run(job, "alpha", input.options));
    }
    cases.push({ input, calls, results: results.map(value => JSON.stringify(value)),
      rows: rows.map(value => JSON.stringify(value)), markers, removed, events });
  }
  return cases;
}
globalThis.fetch = async () => { throw new Error("network forbidden"); };
const cases = await capture();
assert.deepEqual(await capture(), cases);
const output = JSON.stringify({ pin, node: process.version, sourceHashes, now,
  boundaries: { registry: "actual A1 registry execution", body: "explicit synthetic body; no memory access",
    ledger: "explicit in-memory port; durable files tested separately", clock: "fixed UTC milliseconds",
    normalization: "none", providers: "none" }, cases }, null, 2) + "\n";
writeFileSync(new URL("golden/job-runs.json", import.meta.url), output);
console.log(`Recorded ${cases.length} A1 run cases twice; SHA-256 ${sha(output)}`);
