import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const root = new URL("../../", import.meta.url);
const jobOf = (workflow, name) => workflow.split(`\n  ${name}:\n`)[1].split(/\n  [a-z][\w-]*:\n/)[0];
test("licence workflow is required, bounded and writes evidence even on a failed check", () => {
  const workflow = readFileSync(new URL(".github/workflows/dependency-licenses.yml", root), "utf8");
  assert.doesNotMatch(workflow, /continue-on-error/);
  assert.match(workflow, /timeout-minutes: 20/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /node scripts\/audit-deps.mjs --json/);
  assert.match(workflow, /exit-code.txt/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.doesNotMatch(workflow, /--allow-incomplete/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /branches: \[main\]/);
  for (const line of workflow.split("\n").filter((l) => /uses:/.test(l))) assert.match(line, /uses: [^@]+@[0-9a-f]{40} # \S+/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(workflow, /retention-days: 14/);
});

test("licence workflow checks every platform's native packages, Linux alone on a main push", () => {
  const workflow = readFileSync(new URL(".github/workflows/dependency-licenses.yml", root), "utf8");
  assert.match(workflow, /fail-fast: false/);
  assert.match(workflow, /os: \[ubuntu-24\.04, macos-15, windows-2025\]/);
  assert.match(workflow, /runs-on: \$\{\{ matrix\.os \}\}/);
  assert.ok(workflow.includes(`exclude: \${{ fromJSON(github.event_name == 'push' && '[{"os":"macos-15"},{"os":"windows-2025"}]' || '[]') }}`));
  assert.match(workflow, /name: dependency-licenses-\$\{\{ matrix\.os \}\}/, "one artifact per leg");
  for (const step of workflow.split(/\n(?=      - )/).filter((s) => /\brun: \|/.test(s))) assert.match(step, /shell: bash/, "bash on every OS");
});

test("the gate reports on every pull request and merge group, and the legs run only when selected", () => {
  const workflow = readFileSync(new URL(".github/workflows/dependency-licenses.yml", root), "utf8");
  const on = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));
  assert.match(on, /^  pull_request:\n/m);
  assert.doesNotMatch(on, /^\s+(?:paths|paths-ignore|branches-ignore):/m, "a required check must report on every pull request");
  assert.match(on, /^  merge_group:\n    types: \[checks_requested\]$/m);
  assert.match(jobOf(workflow, "changes"), /run: node scripts\/ci\/license-changes\.mjs/);
  const legs = jobOf(workflow, "dependency-licenses");
  assert.match(legs, /^    needs: changes$/m);
  assert.match(legs, /^    if: needs\.changes\.outputs\.relevant == 'true'$/m);
  const gate = jobOf(workflow, "dependency-licenses-gate");
  assert.match(gate, /^    needs: \[changes, dependency-licenses\]$/m);
  assert.match(gate, /^    if: always\(\)$/m);
  assert.match(gate, /^    timeout-minutes: 5$/m);
});

test("the gate passes only for a successful selection with every selected leg green", () => {
  const workflow = readFileSync(new URL(".github/workflows/dependency-licenses.yml", root), "utf8");
  const script = jobOf(workflow, "dependency-licenses-gate").split("        run: |\n")[1].replace(/^ {10}/gm, "");
  const gate = (PLAN, RELEVANT, LEGS) => spawnSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: process.env.PATH, PLAN, RELEVANT, LEGS } }).status;
  assert.equal(gate("success", "true", "success"), 0);
  assert.equal(gate("success", "false", "skipped"), 0, "no input of the report changed");
  for (const legs of ["failure", "cancelled", "skipped", ""]) assert.equal(gate("success", "true", legs), 1, `selected legs: ${legs}`);
  assert.equal(gate("success", "false", "success"), 1, "legs that ran although none was selected");
  for (const plan of ["failure", "cancelled", "skipped"]) assert.equal(gate(plan, "", "skipped"), 1, `selection: ${plan}`);
});
