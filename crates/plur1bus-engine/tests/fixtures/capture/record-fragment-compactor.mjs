// Record `engine/store/fragment-compactor.js` at the Node pin for the native port (RE-D161).
//
//   node record-fragment-compactor.mjs --source <directory> --out <file>
//
// <directory> holds copies of the three pinned files below at their pin paths (for example
// extracted with `git show 9f34008c:<path>`). Every hash is checked before any import. The
// compactor runs with scripted `fragmentCount`/`optimize` ports, a fixed clock and captured
// timers; every port call, log line, timer and explicit outcome is recorded in order.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const COMMIT = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
const SOURCES = {
  "engine/store/fragment-compactor.js": "6a795b75780530732d1ee1d56c198fd96c6c0ef9227cb018c57f4e0fb684e878",
  "lib/log-redact.js": "f64f7d2e2fbf13684ad16fe045a1e43a9755c57be00ee7532479286eed0068e3",
  "lib/lancedb-optimize.js": "147709b52fb0693be1df9f5fcfc4fa2a92a36158a9430cb5b30b0745eaf8c27e",
};

const argument = (name) => {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${name}`);
  return process.argv[index + 1];
};
const root = argument("--source");
for (const [path, sha256] of Object.entries(SOURCES)) {
  const actual = createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
  if (actual !== sha256) throw new Error(`${path} does not match the pin`);
}
const { createFragmentCompactor, resolveLancedbCompaction } = await import(
  pathToFileURL(join(root, "engine/store/fragment-compactor.js")).href
);
const { resolveLancedbOptimizePlan } = await import(pathToFileURL(join(root, "lib/lancedb-optimize.js")).href);

const CLOCK = 1_768_305_600_000;

const compactionInputs = [
  null, "x", [], 5, {}, { enabled: false }, { enabled: "false" }, { enabled: 0 }, { enabled: true },
  { fragmentThreshold: 7 }, { fragmentThreshold: 8 }, { fragmentThreshold: 8.5 }, { fragmentThreshold: "64" },
  { fragmentThreshold: 1e9 }, { fragmentThreshold: -1 }, { fragmentThreshold: null },
  { checkEveryWrites: 0 }, { checkEveryWrites: 1 }, { checkEveryWrites: 16.0 }, { checkEveryWrites: true },
  { checkIntervalMs: 59_999 }, { checkIntervalMs: 60_000 }, { checkIntervalMs: 3_600_000 },
  { timeoutMs: 9_999 }, { timeoutMs: 10_000 }, { timeoutMs: 120_000 },
  { enabled: false, fragmentThreshold: 9, checkEveryWrites: 2, checkIntervalMs: 70_000, timeoutMs: 11_000, other: 1 },
];
const planInputs = [
  undefined, null, "x", [], {}, { keepVersionsHours: 1 }, { keepVersionsHours: 0.5 }, { keepVersionsHours: 0.999 },
  { keepVersionsHours: 1.5 }, { keepVersionsHours: 48 }, { keepVersionsHours: 1e-3 }, { keepVersionsHours: -5 },
  { keepVersionsHours: null }, { keepVersionsHours: true }, { keepVersionsHours: false }, { keepVersionsHours: "12" },
  { keepVersionsHours: " 2 " }, { keepVersionsHours: "" }, { keepVersionsHours: "abc" },
  { keepVersionsHours: 2.0000001 }, { enabled: false, keepVersionsHours: 3 },
];

const OK = { ok: true };
const conflict = { ok: false, reason: "Retryable commit conflict for version 7", conflict: true };
const scenarios = [
  {
    name: "defaults-below-threshold-then-due",
    config: {},
    counts: [10],
    optimizes: [],
    ops: [{ op: "note", agent: "a", n: 15 }, { op: "note", agent: "a", n: 1 }, { op: "check", agent: "a" }],
  },
  {
    name: "threshold-reached-compacts-once",
    config: {},
    counts: [64, 12, 12],
    optimizes: [OK],
    ops: [{ op: "note", agent: "a", n: 16 }, { op: "check", agent: "a" }],
  },
  {
    name: "unknown-count-falls-back-to-writes",
    config: { fragmentThreshold: 8, checkEveryWrites: 4 },
    counts: [null, null, null, null, null],
    optimizes: [OK],
    ops: [
      { op: "note", agent: "a", n: 4 }, { op: "note", agent: "a", n: 4 }, { op: "note", agent: "a", n: 4 },
      { op: "check", agent: "a" },
    ],
  },
  {
    name: "count-throws-or-is-not-finite",
    config: { fragmentThreshold: 8, checkEveryWrites: 8 },
    counts: ["throw", "nan", "string", 9],
    optimizes: [OK, OK],
    ops: [{ op: "note", agent: "a", n: 8 }, { op: "check", agent: "a" }, { op: "check", agent: "a" }],
  },
  {
    name: "busy-no-table-shutdown-skip",
    config: { fragmentThreshold: 8, checkEveryWrites: 1 },
    counts: [20, 20, 20, 20],
    optimizes: [{ ok: false, reason: "busy", busy: true }, { ok: false, reason: "no-table" }, { ok: false, reason: "shutdown" },
      { ok: false, reason: "busy: lock wait exceeded timeoutMs", busy: true }],
    ops: [{ op: "check", agent: "a" }, { op: "check", agent: "a" }, { op: "check", agent: "a" }, { op: "check", agent: "a" }],
  },
  {
    name: "conflict-streak-warns-at-five-and-resets-on-success",
    config: { fragmentThreshold: 8 },
    counts: [9, 9, 9, 9, 9, 9, 9, 3, 9],
    optimizes: [conflict, conflict, conflict, conflict, conflict, conflict, OK, conflict],
    ops: [
      { op: "check", agent: "a" }, { op: "check", agent: "a" }, { op: "check", agent: "a" }, { op: "check", agent: "a" },
      { op: "check", agent: "a" }, { op: "check", agent: "a" }, { op: "check", agent: "a" }, { op: "check", agent: "a" },
    ],
  },
  {
    name: "other-failure-resets-the-conflict-streak",
    config: { fragmentThreshold: 8 },
    counts: [9, 9, 9, 9],
    optimizes: [conflict, conflict, { ok: false, reason: "disk full" }, conflict],
    ops: [{ op: "check", agent: "a" }, { op: "check", agent: "a" }, { op: "check", agent: "a" }, { op: "check", agent: "a" }],
  },
  {
    name: "optimize-throws-or-fails-without-reason",
    config: { fragmentThreshold: 8 },
    counts: [9, 9, 9],
    optimizes: ["throw", { ok: false }, null],
    ops: [{ op: "check", agent: "a" }, { op: "check", agent: "a" }, { op: "check", agent: "a" }],
  },
  {
    name: "failure-keeps-the-write-count",
    config: { fragmentThreshold: 8, checkEveryWrites: 8 },
    counts: [null, null, null],
    optimizes: [{ ok: false, reason: "disk full" }, OK],
    ops: [{ op: "note", agent: "a", n: 8 }, { op: "tick" }, { op: "tick" }],
  },
  {
    name: "disabled-never-runs",
    config: { enabled: false, fragmentThreshold: 8, checkEveryWrites: 1 },
    counts: [100],
    optimizes: [OK],
    ops: [{ op: "note", agent: "a", n: 50 }, { op: "tick" }, { op: "check", agent: "a" }],
  },
  {
    name: "timer-checks-every-written-agent-in-first-write-order",
    config: { fragmentThreshold: 8, checkEveryWrites: 100 },
    counts: [1, 30, 2, 1, 30, 2],
    optimizes: [OK, OK],
    ops: [
      { op: "note", agent: "b", n: 1 }, { op: "note", agent: "a", n: 2 }, { op: "note", agent: "c", n: 1 },
      { op: "note", agent: "b", n: 1 }, { op: "tick" }, { op: "tick" },
    ],
  },
  {
    name: "one-capture-crossing-several-multiples-checks-once",
    config: { fragmentThreshold: 8, checkEveryWrites: 1 },
    counts: [9, 9],
    optimizes: [OK, OK],
    ops: [{ op: "note", agent: "a", n: 3 }, { op: "note", agent: "a", n: 1 }],
  },
  {
    name: "writes-keep-counting-across-compactions",
    config: { fragmentThreshold: 8, checkEveryWrites: 4 },
    counts: [64, 8, 64, 8, 2],
    optimizes: [OK, OK],
    ops: [{ op: "note", agent: "a", n: 4 }, { op: "note", agent: "a", n: 3 }, { op: "note", agent: "a", n: 1 },
      { op: "note", agent: "a", n: 4 }],
  },
  {
    name: "empty-agent-is-ignored",
    config: { fragmentThreshold: 8, checkEveryWrites: 1 },
    counts: [9],
    optimizes: [OK],
    ops: [{ op: "note", agent: "", n: 5 }, { op: "tick" }],
  },
  {
    name: "closed-runs-nothing",
    config: { fragmentThreshold: 8, checkEveryWrites: 1 },
    counts: [9],
    optimizes: [OK],
    ops: [{ op: "note", agent: "a", n: 0 }, { op: "close" }, { op: "note", agent: "a", n: 5 }, { op: "tick" },
      { op: "check", agent: "a" }],
  },
  {
    name: "keep-versions-hours-reaches-optimize",
    config: { fragmentThreshold: 8 },
    plan: { keepVersionsHours: 1.5 },
    counts: [9],
    optimizes: [OK],
    ops: [{ op: "check", agent: "a" }],
  },
  {
    name: "keep-versions-hours-below-minimum-uses-default",
    config: { fragmentThreshold: 8, timeoutMs: 15_000 },
    plan: { keepVersionsHours: 0.5 },
    counts: [9],
    optimizes: [OK],
    ops: [{ op: "check", agent: "a" }],
  },
];

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
};

async function run(scenario) {
  const events = [];
  const counts = [...scenario.counts];
  const optimizes = [...scenario.optimizes];
  let intervalCallback = null;
  const logger = {
    warn: (message) => events.push({ type: "log", level: "warn", message }),
    debug: (message) => events.push({ type: "log", level: "debug", message }),
  };
  const compactor = createFragmentCompactor({
    config: scenario.config,
    fragmentCount: async (agentId) => {
      events.push({ type: "count", agent: agentId });
      const next = counts.length ? counts.shift() : null;
      if (next === "throw") throw new Error("stats failed");
      if (next === "nan") return Number.NaN;
      if (next === "string") return "12";
      return next;
    },
    optimize: async (agentId, opts) => {
      events.push({
        type: "optimize",
        agent: agentId,
        cleanupAgoMs: CLOCK - opts.cleanupOlderThan.getTime(),
        timeoutMs: opts.timeoutMs,
        maxAttempts: opts.maxAttempts,
        retryDelayMs: opts.retryDelayMs,
        ifBusy: opts.ifBusy,
        quietConflicts: opts.quietConflicts,
      });
      const next = optimizes.length ? optimizes.shift() : { ok: true };
      if (next === "throw") throw new Error("optimize exploded");
      return next;
    },
    keepVersionsHours: resolveLancedbOptimizePlan(scenario.plan ?? {}).keepVersionsHours,
    logger,
    clock: () => CLOCK,
    timers: {
      setInterval: (callback, ms) => {
        events.push({ type: "timer", intervalMs: ms });
        intervalCallback = callback;
        return { unref() {} };
      },
      clearInterval: () => events.push({ type: "timer-cleared" }),
    },
  });
  for (const op of scenario.ops) {
    if (op.op === "note") {
      for (let i = 0; i < op.n; i++) compactor.noteWrite(op.agent);
    } else if (op.op === "tick") {
      if (intervalCallback) intervalCallback();
    } else if (op.op === "check") {
      const outcome = await compactor.check(op.agent);
      const { ms: _ms, ...rest } = outcome;
      events.push({ type: "outcome", ...rest });
    } else if (op.op === "close") {
      await compactor.close();
      events.push({ type: "closed" });
    }
    await flush();
  }
  return events;
}

const output = {
  source: { commit: COMMIT, sha256: SOURCES },
  node: { version: process.version },
  clock: CLOCK,
  compaction: compactionInputs.map((input) => ({ input, output: { ...resolveLancedbCompaction(input) } })),
  keepVersionsHours: planInputs.map((input) => ({
    input: input === undefined ? "__undefined__" : input,
    output: resolveLancedbOptimizePlan(input, CLOCK).keepVersionsHours,
  })),
  scenarios: [],
};
for (const scenario of scenarios) {
  output.scenarios.push({ ...scenario, events: await run(scenario) });
}
writeFileSync(argument("--out"), `${JSON.stringify(output, null, 2)}\n`);
