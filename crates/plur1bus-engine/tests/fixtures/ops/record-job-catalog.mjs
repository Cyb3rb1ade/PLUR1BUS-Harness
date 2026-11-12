// Actual A1 job specs. Never edit the resulting golden by hand.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const pin = "9b935ce1f970bd92a931aa99a58c620669c8085f";
const source = process.env.PLUR1BUS_ENGINE_SRC;
const gitRoot = process.env.PLUR1BUS_ENGINE_GIT;
if (!source || !gitRoot || process.version !== "v24.21.0") {
  throw new Error("verified source, Git source and Node24.21 required");
}
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const sourceHashes = ["package.json", "engine/jobs/job-specs.js", "lib/feature-cron-specs.js"].map(path => {
  const bytes = readFileSync(join(source, path));
  assert.equal(sha(bytes), sha(execFileSync("git", ["-C", gitRoot, "show", `${pin}:${path}`])));
  return { path, sha256: sha(bytes) };
});
globalThis.fetch = async () => {
  throw new Error("network forbidden");
};
async function capture(pass) {
  const url = pathToFileURL(join(source, "engine/jobs/job-specs.js"));
  url.searchParams.set("record", pass);
  const { JOB_NAMES, INTERNAL_JOB_NAMES, JOB_SPECS } = await import(url.href);
  return JSON.parse(JSON.stringify({ names: JOB_NAMES, internalNames: INTERNAL_JOB_NAMES, specs: JOB_SPECS }));
}
const catalog = await capture("first");
assert.deepEqual(await capture("second"), catalog);
const output = JSON.stringify({
  pin,
  node: process.version,
  sourceHashes,
  boundaries: {
    catalog: "actual A1 JOB_SPECS and required cron defaults",
    execution: "not invoked",
    providers: "none",
    normalization: "none",
  },
  catalog,
}, null, 2) + "\n";
writeFileSync(new URL("golden/job-catalog.json", import.meta.url), output);
console.log(`Recorded ${catalog.specs.length} A1 job specs twice; SHA-256 ${sha(output)}`);
