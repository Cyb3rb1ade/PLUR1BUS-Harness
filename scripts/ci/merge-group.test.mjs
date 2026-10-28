import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { selections, evaluateGate, UNGATED } from "./gate.mjs";

test("the CI workflow requests checks for merge groups", () => {
  const yaml = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(yaml.slice(0, yaml.indexOf("\njobs:")), /^  merge_group:\n    types: \[checks_requested\]$/m);
});

test("a merge group without PR metadata selects the full matrix and requires every selected job", async () => {
  const { spawnSync } = await import("node:child_process");
  const cwd = mkdtempSync(join(tmpdir(), "p1b-merge-group-"));
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./changes.mjs", import.meta.url))], {
      cwd, encoding: "utf8", env: { PATH: process.env.PATH, EVENT_NAME: "merge_group", ACTION: "checks_requested" },
    });
    assert.equal(result.status, 0, result.stderr);
    const outputs = Object.fromEntries(result.stdout.trim().split("\n").map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    for (const key of ["proceed", "macos", "rust", "ts-core", "web", "python", "documents"]) assert.equal(outputs[key], "true", key);
    assert.equal(outputs["docs-only"], "false");
    assert.ok(JSON.parse(outputs.python_matrix).some(entry => entry.os === "macos-15"));
    const selected = selections(outputs);
    assert.ok(Object.values(selected).every(Boolean));
    for (const job of UNGATED) assert.equal(job in selected, false, `${job}: remains wholly ungated`);
    const needs = { changes: { result: "success", outputs }, ...Object.fromEntries(Object.keys(selected).map(job => [job, { result: "success" }])) };
    assert.deepEqual(evaluateGate(needs), []);
    for (const job of Object.keys(selected)) for (const status of ["failure", "cancelled", "skipped", undefined]) {
      const broken = { ...needs, [job]: status === undefined ? undefined : { result: status } };
      assert(evaluateGate(broken).some(error => error.includes(job)), `${job}:${status}`);
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
