// Actual frozen A1 rate limiter with isolated real run-state.json updates.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const pin = "9b935ce1f970bd92a931aa99a58c620669c8085f";
const source = process.env.PLUR1BUS_ENGINE_SRC;
const gitRoot = process.env.PLUR1BUS_ENGINE_GIT;
assert(source && gitRoot && process.version === "v24.21.0");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const sourceHashes = ["package.json", "lib/job-rate-limit.js", "lib/atomic-json.js"].map(path => {
  const bytes = readFileSync(join(source, path));
  assert.equal(sha(bytes), sha(execFileSync("git", ["-C", gitRoot, "show", `${pin}:${path}`])));
  return { path, sha256: sha(bytes) };
});
const { checkJobRateLimit, recordJobRun } = await import(pathToFileURL(join(source, "lib/job-rate-limit.js")).href);
const key = "gc-run:agent:workspace";
const state = entry => ({ untouched: { text: "opaque-\ud800" }, jobRateLimits: { [key]: entry } });
const cases = [
  { name: "absent" },
  ...[9500, 9000, 11000, 0, null, "9500", true, "bad", [9500]].map(lastRunAt => ({
    name: `last-${JSON.stringify(lastRunAt)}`, initial: state({ lastRunAt, runCount: 2 }),
  })),
  ...[2, "2", [2], [], {}, false, -3, 9007199254740992].map(runCount => ({
    name: `count-${JSON.stringify(runCount)}`, initial: state({ lastRunAt: 0, runCount }),
  })),
  { name: "fallback-components", agent: "", workspace: null, initial: { jobRateLimits: {} } },
  { name: "colon-key", agent: "agent:a", workspace: "b", initial: { jobRateLimits: {
    "gc-run:agent:a:b": { lastRunAt: 9500, runCount: 4 },
  } } },
  { name: "false-map", initial: { other: [1, 2], jobRateLimits: false } },
  { name: "null-map", initial: { jobRateLimits: null } },
  { name: "index-order", initial: { "10": "ten", "2": "two", jobRateLimits: {} } },
];
async function capture() {
  const result = [];
  const realNow = Date.now;
  Date.now = () => 10000;
  try {
    for (const input of cases) {
      const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "rx-job-rate-limit-")));
      const path = join(root, "run-state.json");
      try {
        if (input.initial !== undefined) writeFileSync(path, JSON.stringify(input.initial));
        const agent = "agent" in input ? input.agent : "agent";
        const workspace = "workspace" in input ? input.workspace : "workspace";
        const snapshots = [];
        const snapshot = () => snapshots.push({
          checkJson: JSON.stringify(checkJobRateLimit("gc-run", agent, workspace, 1000, path)),
          file: existsSync(path) ? readFileSync(path, "utf8") : null,
        });
        snapshot();
        await recordJobRun("gc-run", agent, workspace, path);
        snapshot();
        await recordJobRun("gc-run", agent, workspace, path);
        snapshot();
        result.push({ name: input.name, agent, workspace,
          initialJson: input.initial === undefined ? null : JSON.stringify(input.initial), snapshots });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  } finally {
    Date.now = realNow;
  }
  return result;
}
globalThis.fetch = async () => { throw new Error("network forbidden"); };
const captured = await capture();
assert.deepEqual(await capture(), captured);
const output = JSON.stringify({ pin, node: process.version, sourceHashes, now: 10000, interval: 1000,
  boundaries: { implementation: "actual rate limiter and atomic JSON file updates", normalization: "none",
    files: "isolated temporary directories", providers: "none" }, cases: captured }, null, 2) + "\n";
writeFileSync(new URL("golden/job-rate-limit.json", import.meta.url), output);
console.log(`Recorded ${captured.length} A1 rate-limit cases twice; SHA-256 ${sha(output)}`);
