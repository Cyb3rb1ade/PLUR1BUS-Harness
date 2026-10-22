import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const workflowDir = new URL("../../.github/workflows/", import.meta.url);

// Read the repository's block-style job steps, preserving expressions as configuration. This is deliberately
// limited to that layout; actionlint separately checks full YAML/GitHub Actions syntax.
function steps() {
  const found = [];
  for (const file of readdirSync(workflowDir).filter(file => /\.ya?ml$/.test(file))) {
    let job = "", current;
    for (const line of readFileSync(new URL(file, workflowDir), "utf8").split("\n")) {
      const heading = /^  ([\w-]+):\s*$/.exec(line);
      if (heading) { job = heading[1]; current = undefined; }
      if (/^      - /.test(line)) {
        current = { file, job, lines: [] };
        found.push(current);
      }
      if (current) current.lines.push(line);
    }
  }
  return found.map(step => ({ ...step, body: step.lines.join("\n") }));
}

function field(step, name) {
  const match = new RegExp(`^ {6}(?:- |  )${name}: (.+)$`, "m").exec(step.body);
  return match?.[1].replace(/ #.*$/, "").trim();
}

// Interpret only the atoms used by standalone cache saves. Unknown syntax fails the test instead of being skipped.
// An if expression without an explicit status function has GitHub's implicit success() guard.
function saveRuns(condition, { status, hit, populated }) {
  assert.ok(condition, "a cache save must declare its condition");
  const expression = condition.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  if (!/\b(?:always|success|failure|cancelled)\(\)/.test(expression) && status !== "success") return false;
  return expression.split(/\s*&&\s*/).map(atom => {
    if (atom === "success()") return status === "success";
    if (atom === "always()") return true;
    if (/^steps\.[\w-]+\.outputs\.cache-hit != 'true'$/.test(atom)) return !hit;
    if (atom === "hashFiles('.models-cache/**') != ''") return populated;
    assert.fail(`uninterpreted cache save condition: ${atom}`);
  }).every(Boolean);
}

test("standalone cache saves run only after success, with populated content and a cache miss", () => {
  const saves = steps().filter(step => field(step, "uses")?.startsWith("actions/cache/save@"));
  assert.ok(saves.length > 0, "exercise the standalone model-cache saves");
  for (const step of saves) {
    for (const status of ["success", "failure", "cancelled"]) {
      for (const hit of [false, true]) for (const populated of [false, true]) {
        assert.equal(saveRuns(field(step, "if"), { status, hit, populated }),
          status === "success" && !hit && populated, `${step.file}/${step.job}: ${status}, hit=${hit}, populated=${populated}`);
      }
    }
  }
});

test("Playwright cache keys isolate lockfile changes, runner OS and architecture", () => {
  const browsers = steps().filter(step => /path: (?:~\/\.cache|~\/Library\/Caches)\/ms-playwright/.test(step.body));
  assert.equal(browsers.length, 2, "exercise both Linux and macOS browser caches");
  for (const browser of browsers) {
  const template = /^          key: (.+)$/m.exec(browser.body)?.[1];
  assert.ok(template);
  const key = ({ os = "Linux", arch = "X64", lock = "lock-one" } = {}) => template.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression) => {
    if (expression === "runner.os") return os;
    if (expression === "runner.arch") return arch;
    if (expression === "hashFiles('pnpm-lock.yaml')") return lock;
    assert.fail(`uninterpreted browser cache key: ${expression}`);
  });
  assert.notEqual(key(), key({ os: "macOS" }), "another operating system must miss");
  assert.notEqual(key(), key({ arch: "ARM64" }), "another architecture must miss");
  assert.notEqual(key(), key({ lock: "lock-two" }), "another Playwright/browser revision must miss");
  }
});

test("existing cache actions cannot opt into failed saves or expanded credential-bearing paths", () => {
  for (const step of steps()) {
    const action = field(step, "uses") ?? "";
    if (action.startsWith("Swatinem/rust-cache@")) {
      assert.doesNotMatch(step.body, /cache-on-failure:\s*["']?true/);
      assert.doesNotMatch(step.body, /add-rust-environment-hash-key:\s*["']?false/);
      assert.doesNotMatch(step.body, /cache-directories:/, "keep the reviewed Cargo dependency/target paths");
    }
    if (/^actions\/cache(?:\/save|\/restore)?@/.test(action)) {
      assert.doesNotMatch(step.body, /save-always:\s*["']?true/);
      const path = /^          path: (.+)$/m.exec(step.body)?.[1];
      assert.ok(["~/.cache/ms-playwright", "${{ github.workspace }}/.models-cache"].includes(path) ||
        (step.file === "ci.yml" && step.job === "web-browser-macos" && path === "~/Library/Caches/ms-playwright"), `${step.file}/${step.job}: unreviewed cache path ${path}`);
      assert.doesNotMatch(step.body, /^          (?:path|key):.*secrets\./m);
    }
  }
});
