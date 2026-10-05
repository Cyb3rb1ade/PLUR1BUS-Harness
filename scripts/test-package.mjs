import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";

// Default per-test timeout: a hung test fails with its own name instead of silently eating the CI job budget (the job
// timeout cancels every later file). Slowest legitimate test today is ~13 s; this leaves ~9x headroom for slow runners.
// A test that passes its own `{ timeout }` keeps it. Note: it cannot interrupt a blocking spawnSync inside a test.
const TEST_TIMEOUT_MS = 120_000;

const files = globSync("test/**/*.test.ts");
if (files.length === 0) { console.log("no tests"); process.exit(0); }
const r = spawnSync(process.execPath, ["--experimental-strip-types", "--conditions=source", "--no-warnings=ExperimentalWarning", "--test", "--test-concurrency=1", `--test-timeout=${TEST_TIMEOUT_MS}`, ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
