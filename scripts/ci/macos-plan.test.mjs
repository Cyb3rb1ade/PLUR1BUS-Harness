import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, matchesAny, SENSITIVE, pythonMatrix } from "./macos-plan.mjs";

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
