import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { plan, matchesAny, SENSITIVE, pythonMatrix, changedFiles } from "./macos-plan.mjs";

const pr = (files, labels = [], extra = []) => plan({ event: "pull_request", action: "synchronize", labelName: "", labels, files, extra });

test("PR touching only docs/TS app code: no extra macOS legs", () => {
  assert.deepEqual(pr(["docs/ci.md", "packages/core/src/import/x.ts", "apps/web/a.ts"]), { proceed: true, macos: false });
});
test("platform-sensitive paths gate macOS", () => {
  for (const f of ["crates/plur1bus/src/a.rs", "Cargo.lock", "packages/core/src/platform.ts", "packages/core/src/platform/x.ts",
    "packages/core/src/a/b/acl-check.ts", "packages/core/src/acl.ts", "packages/module-api/src/i.ts", "packages/core/src/rpc/h.ts",
    "packages/core/src/secrets/k.ts", "hosts/hermes/p.py", "clients/python/x/y.py", "scripts/install/install.sh", ".github/workflows/ci.yml"]) {
    assert.equal(pr([f]).macos, true, f);
  }
  assert.equal(pr(["packages/core/src/platformer/x.ts"]).macos, true); // trailing * is a prefix match, by design
  assert.equal(pr(["packages/core/src/other/x.ts", "apps/desktop/a.ts"]).macos, false);
});
test("desktop extra glob", () => {
  assert.equal(pr(["apps/desktop/src/a.rs"], [], ["apps/desktop/**"]).macos, true);
  assert.equal(pr(["apps/desktop/src/a.rs"]).macos, false);
});
test("label ci:macos forces macOS", () => assert.equal(pr(["README.md"], ["ci:macos", "x"]).macos, true));
test("labeled with another label is a no-op; labeled ci:macos proceeds", () => {
  const base = { event: "pull_request", action: "labeled", labels: ["bug"], files: [] };
  assert.deepEqual(plan({ ...base, labelName: "bug" }), { proceed: false, macos: false });
  assert.deepEqual(plan({ ...base, labelName: "ci:macos", labels: ["ci:macos"] }), { proceed: true, macos: true });
});
test("push, schedule, workflow_dispatch: full matrix", () => {
  for (const event of ["push", "schedule", "workflow_dispatch"]) assert.deepEqual(plan({ event, action: "", labelName: "", labels: [], files: [] }), { proceed: true, macos: true });
});
test("python matrix", () => {
  assert.equal(pythonMatrix(false).some((e) => e.os === "macos-15"), false);
  assert.equal(pythonMatrix(true).some((e) => e.os === "macos-15"), true);
  assert.ok(matchesAny(["Cargo.lock"], SENSITIVE));
});

const script = fileURLToPath(new URL("./macos-plan.mjs", import.meta.url));
const git = (cwd, ...args) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.quotePath=true", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

test("the command line runs from a path with spaces (the entry guard used to compare against a raw file:// string)", () => {
  const root = mkdtempSync(join(tmpdir(), "p1b-macos-plan-"));
  try {
    const dir = join(root, "with space");
    mkdirSync(dir);
    copyFileSync(script, join(dir, "macos-plan.mjs"));
    const r = spawnSync(process.execPath, [join(dir, "macos-plan.mjs")], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", EVENT_NAME: "push" } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^proceed=true\nmacos=true\n/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("changedFiles lists non-ASCII paths verbatim and both sides of a rename", () => {
  const root = mkdtempSync(join(tmpdir(), "p1b-macos-diff-"));
  try {
    git(root, "init", "--quiet", "-b", "main");
    mkdirSync(join(root, "crates/x"), { recursive: true });
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "crates/x/lib.rs"), "fn main() {}\n".repeat(20));
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", "base");
    const base = git(root, "rev-parse", "HEAD");
    // The same bytes move out of crates/**: with rename detection only the new path would be listed.
    renameSync(join(root, "crates/x/lib.rs"), join(root, "docs/lib-moved.md"));
    writeFileSync(join(root, "crates/x/ä.rs"), "// umlaut\n");
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", "head");
    const files = changedFiles(base, git(root, "rev-parse", "HEAD"), root);
    assert.deepEqual([...files].sort(), ["crates/x/lib.rs", "crates/x/ä.rs", "docs/lib-moved.md"]);
    assert.equal(plan({ event: "pull_request", action: "synchronize", labelName: "", labels: [], files }).macos, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
