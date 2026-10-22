import { spawnSync } from "node:child_process";
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
  files = selectShard(files, shard);
  if (process.env.PLUR1BUS_TEST_SHARD_MANIFEST) writeManifest(process.env.PLUR1BUS_TEST_SHARD_MANIFEST, shard, files);
  console.log(`shard ${shard.index}/${shard.total}: ${files.length} test files`);
}
if (files.length === 0) { console.log("no tests"); process.exit(0); }
const r = spawnSync(process.execPath, ["--import", new URL("./test-prerequisites.mjs", import.meta.url).href, "--experimental-strip-types", "--conditions=source", "--no-warnings=ExperimentalWarning", "--test", "--test-concurrency=1", `--test-timeout=${TEST_TIMEOUT_MS}`, ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
