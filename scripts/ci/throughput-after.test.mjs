import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./throughput-after.mjs", import.meta.url));

test("post-integration measurement gate excludes old/pending runs and requires integrated source plus complete Core checks", () => {
  const root = mkdtempSync(join(tmpdir(), "p1b-after-gate-"));
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  try {
    git("init", "--quiet");
    writeFileSync(join(root, "source"), "before"); git("add", "."); git("commit", "-qm", "before");
    const before = git("rev-parse", "HEAD");
    writeFileSync(join(root, "source"), "integrated"); git("add", "."); git("commit", "-qm", "integrated");
    const integrated = git("rev-parse", "HEAD");
    const requirements = join(root, "requirements.json");
    writeFileSync(requirements, JSON.stringify({ P1: integrated, P2: integrated, P3: integrated, P4: integrated, P5: integrated }));
    const input = join(root, "snapshot.json"), output = join(root, "after.json");
    const run = (id, head_sha, status = "completed") => ({ id, head_sha, status, conclusion: "success", created_at: "2090-01-01T00:00:00Z", event: "push", head_branch: "main" });
    const names = ["ci-gate", "core-unit", ...[1, 2, 3].map(i => `core unit shard ${i}/3 (ubuntu-24.04)`)];
    const jobs = names.map(name => ({ name, status: "completed", conclusion: "success" }));
    const snapshot = { repo: "Cyb3rb1ade/PLUR1BUS-Harness", workflow: "ci.yml", runs: [run(1, before), run(2, integrated), run(3, integrated, "queued")],
      jobs: [1, 2, 3].map(runId => ({ runId, jobs })) };
    const invoke = () => spawnSync(process.execPath, [script, "--input", input, "--integration", integrated, "--requirements", requirements, "--out", output], { cwd: root, encoding: "utf8" });
    writeFileSync(input, JSON.stringify(snapshot));
    const valid = invoke();
    assert.equal(valid.status, 0, valid.stderr);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")).runs.map(r => r.id), [2]);
    const preflight = spawnSync(process.execPath, [script, "--integration", integrated, "--requirements", requirements, "--check-integration"], { cwd: root, encoding: "utf8" });
    assert.equal(preflight.status, 0, "integration preflight must work before collecting a snapshot");
    writeFileSync(requirements, JSON.stringify({ P1: integrated, P2: integrated, P3: integrated, P4: "f".repeat(40), P5: integrated }));
    assert.notEqual(invoke().status, 0, "a missing phase must block the after measurement");
    writeFileSync(requirements, JSON.stringify({ P1: integrated, P2: integrated, P3: integrated, P4: integrated, P5: integrated }));
    snapshot.jobs[1].jobs = jobs.filter(j => !j.name.includes("3/3"));
    writeFileSync(input, JSON.stringify(snapshot));
    assert.notEqual(invoke().status, 0, "a cohort without all successful Core checks must be refused");
    snapshot.runs = [run(1, before)];
    writeFileSync(input, JSON.stringify(snapshot));
    assert.notEqual(invoke().status, 0, "a historical snapshot cannot be reported as after");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
