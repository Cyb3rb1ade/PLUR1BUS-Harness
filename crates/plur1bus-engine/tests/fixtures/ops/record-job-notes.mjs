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
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceHashes = [
  "package.json",
  "engine/jobs/job-registry.js",
  "engine/jobs/job-ledger.js",
  "engine/jobs/job-specs.js",
  "engine/events.js",
  "lib/dreaming/dream-diary.js",
  "lib/host-sdk-loader.js",
  "lib/feature-cron-specs.js",
  "lib/sql-safety.js",
  "lib/log-redact.js",
].map((path) => {
  const bytes = readFileSync(join(source, path));
  assert.equal(sha(bytes), sha(execFileSync("git", ["-C", gitRoot, "show", `${pin}:${path}`])));
  return { path, sha256: sha(bytes) };
});
const { createJobRegistry } = await import(pathToFileURL(join(source, "engine/jobs/job-registry.js")).href);
const now = 1800000000000;
const scenarios = [
  { name: "ordered-unique", steps: [{ keys: ["second", "first", "second", ""], pending: ["p2", "p1", "p2", ""] }] },
  { name: "completed-idempotency", steps: [{ keys: ["done"] }] },
  { name: "opaque-unicode", steps: [{ keys: ["nul\u0000key", "emoji-😀", "../opaque"], pending: ["e\u0301"] }] },
  {
    name: "same-pending-abandons",
    steps: Array.from({ length: 3 }, () => ({ outcome: "incomplete", pending: ["same"] })),
  },
  {
    name: "different-pending-resets",
    steps: ["a", "a", "b"].map((key) => ({ outcome: "incomplete", pending: [key] })),
  },
  {
    name: "overlap-continues",
    steps: [["a"], ["a", "b"], ["b"]].map((pending) => ({ outcome: "incomplete", pending })),
  },
  { name: "empty-pending-continues", steps: [["a"], [], ["z"]].map((pending) => ({ outcome: "incomplete", pending })) },
  {
    name: "skipped-preserves-streak",
    steps: [
      { outcome: "incomplete", pending: ["a"] },
      { outcome: "skipped", reason: "disabled", pending: ["x"] },
      { outcome: "incomplete", pending: ["a"] },
    ],
  },
  {
    name: "completed-breaks-streak",
    steps: [{ outcome: "incomplete", pending: ["a"] }, {}, { outcome: "incomplete", pending: ["a"] }],
  },
  {
    name: "abandoned-already-processed",
    steps: [{ outcome: "skipped", reason: "already_processed", abandoned: ["a"] }],
  },
  { name: "abandoned-other-skip", steps: [{ outcome: "skipped", reason: "disabled", abandoned: ["a"] }] },
  {
    name: "noted-diary",
    steps: [{ diary: { written: true, reason: "synthetic" } }, { diary: { written: false, reason: "" } }],
  },
  {
    name: "abandoned-diary-disabled",
    steps: Array.from({ length: 3 }, () => ({ outcome: "incomplete", pending: ["same"], diaryDisabled: true })),
  },
  { name: "failed-keeps-notes", steps: [{ outcome: "failed", keys: ["done"], pending: ["left"] }] },
  {
    name: "snapshot-key-queries",
    steps: [
      { keys: ["done"] },
      { outcome: "incomplete", pending: ["left"] },
      { outcome: "incomplete", pending: ["left"] },
      { outcome: "incomplete", pending: ["left"] },
      { queries: ["done", "left", "other"] },
    ],
  },
];
async function capture() {
  const cases = [];
  for (const input of scenarios) {
    let id = 0,
      step = 0;
    const rows = [],
      events = [],
      queries = [];
    const ledger = {
      readAll: () => [...rows],
      snapshot: () => ({ rows: [...rows], unreadable: 0 }),
      orphanMarkers: () => [],
      writeMarker() {},
      removeMarker() {},
      append: (row) => rows.push({ v: 1, ...row }),
    };
    const host = {
      clock: () => now,
      logger: { warn() {}, debug() {}, info() {} },
      events: { emit: (name, value) => events.push({ name, value: JSON.stringify(value) }) },
    };
    const registry = createJobRegistry({
      host,
      jobsRoot: "synthetic-ledger-port",
      createLedger: () => ledger,
      idFactory: () => `run-${++id}`,
    });
    registry.bind("knowledge-update", async (_, context) => {
      const instruction = input.steps[step++];
      for (const key of instruction.keys || []) context.markCompletedKey(key);
      for (const key of instruction.pending || []) context.notePendingKey(key);
      for (const key of instruction.abandoned || []) context.noteAbandonedKey(key);
      if (instruction.diary) context.noteDiary(instruction.diary);
      if (instruction.diaryDisabled) context.setDiaryTarget(null, { disabled: true });
      queries.push(
        (instruction.queries || []).map((key) => ({
          key,
          completed: context.hasCompletedKey(key),
          abandoned: context.isAbandonedKey(key),
        })),
      );
      if (instruction.outcome === "failed") throw new Error("synthetic failure");
      if (instruction.outcome === "skipped") return context.skip(instruction.reason || "disabled");
      if (instruction.outcome === "incomplete") return context.incomplete("pending");
      return { integrated: 1 };
    });
    const results = [];
    for (const _ of input.steps) results.push(JSON.stringify(await registry.run("knowledge-update", "alpha")));
    cases.push({ input, results, rows: rows.map((row) => JSON.stringify(row)), events, queries });
  }
  return cases;
}
globalThis.fetch = async () => {
  throw new Error("network forbidden");
};
const cases = await capture();
assert.deepEqual(await capture(), cases);
const output =
  JSON.stringify(
    {
      pin,
      node: process.version,
      sourceHashes,
      now,
      boundaries: {
        registry: "actual A1 registry execution",
        body: "scripted metadata notes only; no memory access",
        ledger: "explicit in-memory port; persistence tested separately",
        diary: "noted metadata, disabled or no workspace; no diary file writer",
        clock: "fixed UTC milliseconds",
        normalization: "none",
        providers: "none",
      },
      cases,
    },
    null,
    2,
  ) + "\n";
writeFileSync(new URL("golden/job-notes.json", import.meta.url), output);
console.log(`Recorded ${cases.length} A1 note cases twice; SHA-256 ${sha(output)}`);
