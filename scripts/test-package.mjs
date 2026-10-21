import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { listTestFiles, parseShard, selectShard, writeManifest } from "./ci/test-shards.mjs";

// Default per-test timeout: a hung test fails with its own name instead of silently eating the CI job budget (the job
// timeout cancels every later file). Slowest legitimate test today is ~13 s; this leaves ~9x headroom for slow runners.
// A test that passes its own `{ timeout }` keeps it. Note: it cannot interrupt a blocking spawnSync inside a test.
const TEST_TIMEOUT_MS = 120_000;

// Sorted: glob order is the filesystem's, and the files run one after the other, so the log order would vary per machine.
let files = listTestFiles();
// CI sharding (scripts/ci/test-shards.mjs): PLUR1BUS_TEST_SHARD=i/N runs only shard i's files and, with
// PLUR1BUS_TEST_SHARD_MANIFEST, records them so the gate job can prove every file ran exactly once.
if (process.env.PLUR1BUS_TEST_SHARD !== undefined) {
  let shard;
  try { shard = parseShard(process.env.PLUR1BUS_TEST_SHARD); } catch (e) { console.error(`PLUR1BUS_TEST_SHARD: ${e.message}`); process.exit(1); }
  let timings;
  try {
    if (process.env.PLUR1BUS_TEST_SHARD_TIMINGS) {
      const profile = JSON.parse(readFileSync(process.env.PLUR1BUS_TEST_SHARD_TIMINGS, "utf8"));
      if (profile.version !== 1 || !profile.durationsMs) throw new Error("unsupported timing profile: expected version 1 and durationsMs");
      timings = profile.durationsMs;
    }
    files = selectShard(files, shard, timings);
  } catch (e) { console.error(`PLUR1BUS_TEST_SHARD_TIMINGS: ${e.message}`); process.exit(1); }
  if (process.env.PLUR1BUS_TEST_SHARD_MANIFEST) writeManifest(process.env.PLUR1BUS_TEST_SHARD_MANIFEST, shard, files);
  console.log(`shard ${shard.index}/${shard.total}: ${files.length} test files`);
}
if (files.length === 0) { console.log("no tests"); process.exit(0); }
const r = spawnSync(process.execPath, ["--experimental-strip-types", "--conditions=source", "--no-warnings=ExperimentalWarning", "--test", "--test-concurrency=1", `--test-timeout=${TEST_TIMEOUT_MS}`, ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
