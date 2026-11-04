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

test("only quality, the macOS licence leg and macOS unit tests use the VM runner label", () => {
  assert.deepEqual(routedJobs().map((j) => j.file), ["ci.yml", "dependency-licenses.yml", "release-quality.yml"]);
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


test("the unit route keeps Windows, forks, merge groups and a disabled switch on hosted runners", () => {
  const workflow = readFileSync(new URL("ci.yml", dir), "utf8");
  const block = workflow.split("\n  unit-os:\n")[1].split(/\n  [a-z][\w-]*:\n/)[0];
  const line = block.split("\n").find((line) => line.startsWith("    runs-on:"));
  assert.ok(line?.includes(LABEL), "only the macOS unit matrix leg joins the existing VM routes");
  const expression = line.slice(line.indexOf("${{") + 3, line.lastIndexOf("}}"));
  const evaluate = Function("matrix", "vars", "github", "fromJSON", `return (${expression});`);
  const nameLine = block.split("\n").find((line) => line.startsWith("    name:"));
  const nameExpression = nameLine.slice(nameLine.indexOf("${{") + 3, nameLine.lastIndexOf("}}"));
  const evaluateName = Function("matrix", "vars", "github", `return (${nameExpression});`);
  const ownContext = { event_name: "pull_request", repository: "owner/harness", event: { pull_request: { head: { repo: { full_name: "owner/harness" } } } } };
  assert.equal(evaluateName({ os: "macos-15" }, { MACOS_SELF_HOSTED: "true" }, ownContext), "macOS VM");
  assert.equal(evaluateName({ os: "macos-15" }, { MACOS_SELF_HOSTED: "false" }, ownContext), "macos-15");
  assert.equal(evaluateName({ os: "windows-2025" }, { MACOS_SELF_HOSTED: "true" }, ownContext), "windows-2025");
  assert.equal(evaluateName({ os: "macos-15" }, { MACOS_SELF_HOSTED: "true" }, { ...ownContext, event_name: "merge_group" }), "macos-15");
  const forkContext = { ...ownContext, event: { pull_request: { head: { repo: { full_name: "fork/harness" } } } } };
  assert.equal(evaluateName({ os: "macos-15" }, { MACOS_SELF_HOSTED: "true" }, forkContext), "macos-15");
  const route = (os, enabled, event, own = true) => evaluate(
    { os }, { MACOS_SELF_HOSTED: enabled ? "true" : "false" },
    { event_name: event, repository: "owner/harness", event: { pull_request: { head: { repo: { full_name: own ? "owner/harness" : "fork/harness" } } } } },
    JSON.parse,
  );
  assert.deepEqual(route("macos-15", true, "pull_request"), ["self-hosted", LABEL]);
  for (const os of ["windows-2025", "ubuntu-24.04"]) assert.equal(route(os, true, "pull_request"), os);
  assert.equal(route("macos-15", false, "pull_request"), "macos-15");
  assert.equal(route("macos-15", true, "pull_request", false), "macos-15");
  for (const event of ["merge_group", "pull_request_target", "unknown"]) assert.equal(route("macos-15", true, event), "macos-15");
  for (const event of ["push", "workflow_dispatch", "schedule"]) assert.deepEqual(route("macos-15", true, event), ["self-hosted", LABEL]);
});
