import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// The owner's macOS VM runner (docs/ci.md, "Self-hosted macOS runner") must only ever get code from this repository: a
// fork's pull request and a merge group (which can hold one) stay on GitHub-hosted runners.
const dir = new URL("../../.github/workflows/", import.meta.url);
const LABEL = "plur1bus-macos-vm";
const TRUSTED_EVENTS = ["push", "workflow_dispatch", "schedule", "pull_request"];

function routedJobs() {
  const found = [];
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    for (const line of readFileSync(new URL(file, dir), "utf8").split("\n")) {
      if (line.includes(LABEL)) found.push({ file, line });
    }
  }
  return found;
}

test("only quality and the macOS licence leg use the VM runner label", () => {
  assert.deepEqual(routedJobs().map((j) => j.file), ["dependency-licenses.yml", "release-quality.yml"]);
});

test("every route to the VM runner needs the switch and admits this repository's code only", () => {
  for (const { file, line } of routedJobs()) {
    assert.match(line, /^ {4}runs-on: \$\{\{ \(.*\) && fromJSON\('\["self-hosted","plur1bus-macos-vm"\]'\) \|\| (?:'macos-15'|matrix\.os) \}\}$/, file);
    assert.match(line, /vars\.MACOS_SELF_HOSTED == 'true' && \(/, `${file}: the repository variable switches it`);
    const events = [...line.matchAll(/github\.event_name == '([\w-]+)'/g)].map((m) => m[1]);
    assert.ok(events.length > 0, file);
    for (const event of events) assert.ok(TRUSTED_EVENTS.includes(event), `${file}: ${event} may carry untrusted code`);
    assert.ok(!line.includes("github.event_name != "), `${file}: a deny list would admit new events`);
    if (events.includes("pull_request")) {
      assert.ok(line.includes("(github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository)"),
        `${file}: a pull request only from a branch of this repository`);
    }
  }
});
