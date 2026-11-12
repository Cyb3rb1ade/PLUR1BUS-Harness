// Actual A1 registry recovery/history with an explicit synthetic in-memory ledger port.
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
const marker = { runId: "old-001", job: "knowledge-update", phase: null, trigger: "manual", startedAt: now - 10 };
const recovery = [
  { name: "empty", markers: [] },
  { name: "unfinished", markers: [marker] },
  { name: "finished", markers: [marker], rows: [{ runId: marker.runId, outcome: "completed" }] },
  { name: "corrupt", markers: [{ runId: "old-001", corrupt: true }] },
  { name: "legacy-fields-absent", markers: [{ runId: "old-001" }] },
  { name: "non-numeric-time", markers: [{ ...marker, startedAt: "10" }] },
  { name: "negative-fraction-time", markers: [{ ...marker, startedAt: -0.5 }] },
  { name: "extended-year", markers: [{ ...marker, startedAt: 253402300800000 }] },
  { name: "future-time", markers: [{ ...marker, startedAt: now + 10 }] },
  { name: "rem-crash-counts-session", markers: [{ ...marker, job: "rem-dream", phase: "rem" }] },
  { name: "deep-crash-counts-session", markers: [{ ...marker, job: "consolidate-daily", phase: "deep" }] },
  { name: "light-crash-no-session", markers: [{ ...marker, job: "light-dream", phase: "light" }] },
  { name: "legacy-nullish", markers: [{ runId: "old-001", job: null, phase: null, trigger: null, startedAt: 0 }] },
];
const rows = [
  { runId: "one", job: "gc-run", startedAt: 300, extra: "retained" },
  { runId: "two", job: "knowledge-update", startedAt: 100 },
  { runId: "three", job: "gc-run", startedAt: 200 },
];
const history = [
  { name: "append-order-not-time", rows, filter: {} },
  { name: "job", rows, filter: { job: "gc-run" } },
  { name: "since-inclusive", rows, filter: { since: 200 } },
  { name: "filter-before-limit", rows, filter: { job: "gc-run", since: 200, limit: 1 } },
  { name: "zero", rows, filter: { limit: 0 } },
  { name: "negative-ignored", rows, filter: { limit: -1 } },
  { name: "fraction-ignored", rows, filter: { limit: 0.5 } },
  { name: "unknown-job", rows, filter: { job: "unknown" } },
  { name: "empty-job-ignored", rows, filter: { job: "" } },
  { name: "legacy-coercion", rows: [null, true, false, " 0x10 ", [20], [], {}, "bad"].map((v, i) =>
    ({ runId: String(i), startedAt: v })), filter: { since: 1 } },
  { name: "opaque-field", rows: [{ runId: "opaque", extra: "\ud800" }], filter: {} },
];
function fixture(input) {
  const persisted = structuredClone(input.rows || []);
  const markers = structuredClone(input.markers || []);
  const appended = [];
  const removed = [];
  let counter = 0;
  const ledger = {
    readAll: () => [...persisted],
    snapshot: () => ({ rows: [...persisted], unreadable: 0 }),
    orphanMarkers: () => [...markers],
    writeMarker() {},
    removeMarker(id) { removed.push(id); },
    append(row) {
      const saved = { v: 1, ...row };
      persisted.push(saved);
      appended.push(saved);
    },
  };
  const host = { clock: () => now, logger: { warn() {}, debug() {}, info() {} } };
  return { registry: createJobRegistry({ host, jobsRoot: "synthetic-ledger-port", createLedger: () => ledger,
    idFactory: () => `new-${++counter}` }), appended, removed };
}
async function capture() {
  const recovered = [];
  for (const input of recovery) {
    const { registry, appended, removed } = fixture(input);
    await registry.run("knowledge-update", "alpha");
    await registry.run("knowledge-update", "alpha");
    recovered.push({ input, rowsJson: appended.filter(r => r.runId.startsWith("old-")).map(r => JSON.stringify(r)),
      removed: removed.filter(id => id.startsWith("old-")) });
  }
  const histories = [];
  for (const input of history) {
    const { registry } = fixture(input);
    histories.push({ input, rowsJson: (await registry.history("alpha", input.filter)).map(r => JSON.stringify(r)) });
  }
  return { recovered, histories };
}
globalThis.fetch = async () => { throw new Error("network forbidden"); };
const captured = await capture();
assert.deepEqual(await capture(), captured);
const output = JSON.stringify({ pin, node: process.version, sourceHashes, now,
  boundaries: { registry: "actual A1 recovery and history", ledger: "explicit in-memory collaborator; file protocol separately tested",
    clock: "fixed UTC milliseconds", providers: "none", normalization: "none" }, ...captured }, null, 2) + "\n";
writeFileSync(new URL("golden/job-metadata.json", import.meta.url), output);
console.log(`Recorded ${recovery.length + history.length} A1 metadata cases twice; SHA-256 ${sha(output)}`);
