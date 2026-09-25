import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platformCapabilities } from "../src/platform.ts";

describe("platform", () => {
  it("securePath chmods on posix and reports the mechanism", { skip: process.platform === "win32" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "p1b-plat-")); const f = join(dir, "t"); writeFileSync(f, "x");
    assert.deepEqual(platformCapabilities.securePath(f, { mode: 0o600 }), { applied: true, mechanism: "chmod" });
    assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.deepEqual(platformCapabilities.securePath(join(dir, "missing")), { applied: false, reason: "missing" });
  });
  it("isUnsafeLink is true for a symlink and false for a file", { skip: process.platform === "win32" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "p1b-plat-")); writeFileSync(join(dir, "f"), ""); symlinkSync(join(dir, "f"), join(dir, "l"));
    assert.equal(platformCapabilities.isUnsafeLink(join(dir, "l")), true);
    assert.equal(platformCapabilities.isUnsafeLink(join(dir, "f")), false);
  });
  it("ipcAddress and canonicalIdentityPath", () => {
    const a = platformCapabilities.ipcAddress("/h/.plur1bus/state");
    assert.ok(["unix-socket", "named-pipe"].includes(a.kind));
    assert.equal(platformCapabilities.canonicalIdentityPath("/a/./b/../c"), process.platform === "win32" ? "\\a\\c" : "/a/c");
  });
});
