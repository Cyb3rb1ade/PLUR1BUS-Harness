// Actual A1 legacy REM migration; real input/rollback files and captured append/write callbacks.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const pin = "9b935ce1f970bd92a931aa99a58c620669c8085f";
const source = process.env.PLUR1BUS_ENGINE_SRC,
  git = process.env.PLUR1BUS_ENGINE_GIT;
assert(source && git && process.version === "v24.21.0");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const paths = [
  "package.json",
  "engine/jobs/run-state-migration.js",
  "engine/jobs/job-registry.js",
  "engine/jobs/job-ledger.js",
  "engine/jobs/job-specs.js",
  "engine/events.js",
  "lib/dreaming/dream-diary.js",
  "lib/host-sdk-loader.js",
  "lib/feature-cron-specs.js",
  "lib/sql-safety.js",
  "lib/log-redact.js",
];
const sourceHashes = paths.map((path) => {
  const bytes = readFileSync(join(source, path));
  assert.equal(sha(bytes), sha(execFileSync("git", ["-C", git, "show", `${pin}:${path}`])));
  return { path, sha256: sha(bytes) };
});
const { migrateRunStateCompletions } = await import(pathToFileURL(join(source, "engine/jobs/run-state-migration.js")));
const now = 1794225600123;
const key = "rem:alpha:workspace:one";
const state = (completed, extra = {}) => ({ untouched: { opaque: "raw-\ud800" }, completed, ...extra });
const entry = (extra = {}) => ({
  completedAt: "2026-11-08T12:00:00.000Z",
  patternsFound: 3,
  memoriesProcessed: 7,
  ...extra,
});
const cases = [
  { name: "absent", raw: null },
  ...["broken\n", "null", "[]", "true", "12", '"text"'].map((raw) => ({ name: `corrupt-${raw}`, raw })),
  { name: "empty", raw: '  { "untouched": 3 } \n' },
  { name: "single", raw: JSON.stringify(state({ [key]: entry() })) },
  {
    name: "mixed-agents",
    raw: JSON.stringify(
      state({ [key]: entry(), "rem:beta:workspace:one": entry(), "light:alpha:workspace:one": entry() }),
    ),
  },
  { name: "legacy-substring-key", raw: JSON.stringify(state({ "rem:workspace:alpha:suffix": entry() })) },
  { name: "opaque-run-key", raw: JSON.stringify(state({ "rem:alpha:raw-\ud800": entry() })) },
  ...[
    {},
    { completedAt: null },
    { completedAt: "" },
    { completedAt: "2026-11-08" },
    { completedAt: "2026" },
    { completedAt: "1970-01-01T00:00:00.000Z" },
    { completedAt: "2026-11-08T13:00:00+01:00" },
    { patternsFound: "3", memoriesProcessed: false },
    { patternsFound: -2.5, memoriesProcessed: 0 },
  ].map((meta, index) => ({
    name: `metadata-${index}`,
    raw: JSON.stringify(state({ [key]: index < 3 ? meta : entry(meta) })),
  })),
  {
    name: "own-marker",
    raw: JSON.stringify(state({ [key]: entry() }, { plur1busLedgerMigratedAt: { alpha: "old" } })),
  },
  {
    name: "foreign-marker",
    raw: JSON.stringify(state({ [key]: entry() }, { plur1busLedgerMigratedAt: { beta: "old" } })),
  },
  {
    name: "false-marker",
    raw: JSON.stringify(state({ [key]: entry() }, { plur1busLedgerMigratedAt: { alpha: false } })),
  },
  { name: "false-completed", raw: JSON.stringify(state(false)) },
  { name: "integer-key-order", raw: JSON.stringify({ 10: "ten", 2: "two", completed: { [key]: entry() } }) },
  { name: "corrupt-then-repaired", raw: "broken first bytes\n", repair: JSON.stringify(state({ [key]: entry() })) },
];
function capture() {
  return cases.map((input) => {
    const root = mkdtempSync(join(tmpdir(), "job-migration-oracle-"));
    const path = join(root, "run-state.json");
    try {
      if (input.raw !== null) writeFileSync(path, input.raw);
      const runs = [];
      for (let index = 0; index < 2; index++) {
        if (index === 1 && input.repair) writeFileSync(path, input.repair);
        const rawBefore = existsSync(path) ? readFileSync(path, "utf8") : null;
        const appended = [];
        let newStateJson = null,
          warnings = 0;
        const result = migrateRunStateCompletions({
          store: {
            paths: { runs: path },
            writeRunState: (state) => {
              newStateJson = JSON.stringify(state);
              writeFileSync(path, newStateJson);
            },
          },
          agentId: "alpha",
          appendRow: (row) => appended.push(row),
          clock: () => now,
          logger: { warn: () => warnings++ },
        });
        runs.push({
          rawBefore,
          result,
          appendedJson: JSON.stringify(appended),
          newStateJson,
          warnings,
          backup: existsSync(path + ".migrated") ? readFileSync(path + ".migrated", "utf8") : null,
        });
      }
      return { name: input.name, runs };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
globalThis.fetch = async () => {
  throw new Error("network forbidden");
};
const recorded = capture();
assert.deepEqual(capture(), recorded);
const output =
  JSON.stringify(
    {
      pin,
      node: process.version,
      sourceHashes,
      agentId: "alpha",
      now,
      boundaries: {
        implementation: "actual migrateRunStateCompletions",
        files: "real isolated input and first rollback copy",
        adapters: "captured appendRow and writeRunState callbacks; not registry startup",
        normalization: "none",
        providers: "none",
      },
      cases: recorded,
    },
    null,
    2,
  ) + "\n";
writeFileSync(new URL("golden/job-migration.json", import.meta.url), output);
console.log(`Recorded ${recorded.length} actual A1 migrations twice; SHA-256 ${sha(output)}`);
