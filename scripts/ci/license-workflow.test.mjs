import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const root = new URL("../../", import.meta.url);
test("licence workflow is advisory, bounded and writes evidence even on a failed check", () => {
  const workflow = readFileSync(new URL(".github/workflows/dependency-licenses.yml", root), "utf8");
  assert.match(workflow, /continue-on-error: true/);
  assert.match(workflow, /timeout-minutes: 20/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /node scripts\/audit-deps.mjs --json/);
  assert.match(workflow, /exit-code.txt/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.doesNotMatch(workflow, /--allow-incomplete/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /branches: \[main\]/);
  assert.match(workflow, /paths:/);
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
