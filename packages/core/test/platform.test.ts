import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync, writeFileSync, statSync } from "node:fs";
import { createPlatformCapabilities } from "../src/platform.ts";
import { join } from "node:path";
import { platformCapabilities } from "../src/platform.ts";
import { tempDir } from "./helpers/temp-dir.ts";

describe("platform", () => {
  it("securePath chmods on posix and reports the mechanism", { skip: process.platform === "win32" }, () => {
    const dir = tempDir("p1b-plat-"); const f = join(dir, "t"); writeFileSync(f, "x");
    assert.deepEqual(platformCapabilities.securePath(f, { mode: 0o600 }), { applied: true, mechanism: "chmod" });
    assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.deepEqual(platformCapabilities.securePath(join(dir, "missing")), { applied: false, reason: "missing" });
  });
  it("isUnsafeLink is true for a symlink and false for a file", { skip: process.platform === "win32" }, () => {
    const dir = tempDir("p1b-plat-"); writeFileSync(join(dir, "f"), ""); symlinkSync(join(dir, "f"), join(dir, "l"));
    assert.equal(platformCapabilities.isUnsafeLink(join(dir, "l")), true);
    assert.equal(platformCapabilities.isUnsafeLink(join(dir, "f")), false);
  });
  it("ipcAddress and canonicalIdentityPath", () => {
    const a = platformCapabilities.ipcAddress("/h/.plur1bus/state");
    assert.ok(["unix-socket", "named-pipe"].includes(a.kind));
    assert.equal(platformCapabilities.canonicalIdentityPath("/a/./b/../c"), process.platform === "win32" ? "\\a\\c" : "/a/c");
  });
  it("audit: distinct state roots that share a 16-byte prefix get distinct pipe names, equal roots (any case) the same one", () => {
    const w = createPlatformCapabilities({ platform: "win32" });
    const a = w.ipcAddress("C:\\Users\\alice\\AppData\\Local\\PLUR1BUS\\state").address;
    const b = w.ipcAddress("C:\\Users\\alice\\AppData\\Local\\PLUR1BUS-2\\state").address;
    assert.notEqual(a, b);
    assert.match(a, /^\\\\\.\\pipe\\plur1bus-embed-[0-9a-f]{32}$/);
    assert.equal(w.ipcAddress("c:/users/ALICE/appdata/local/plur1bus/state/").address, w.ipcAddress("C:\\Users\\alice\\AppData\\Local\\PLUR1BUS\\state").address);
  });
  it("audit: canonicalIdentityPath ignores a trailing separator and the \\\\?\\ prefix", () => {
    const w = createPlatformCapabilities({ platform: "win32" });
    assert.equal(w.canonicalIdentityPath("C:\\Data\\X\\"), "c:\\data\\x");
    assert.equal(w.canonicalIdentityPath("\\\\?\\C:\\Data\\X"), "c:\\data\\x");
    assert.equal(w.canonicalIdentityPath("\\\\?\\UNC\\Srv\\Share\\X"), "\\\\srv\\share\\x");
    assert.equal(w.canonicalIdentityPath("C:\\"), "c:\\", "a drive root keeps its separator");
    const p = createPlatformCapabilities({ platform: "linux" });
    assert.equal(p.canonicalIdentityPath("/a/b/"), "/a/b");
    assert.equal(p.canonicalIdentityPath("/"), "/");
    assert.equal(p.canonicalIdentityPath("/Ab"), "/Ab", "POSIX stays case-sensitive");
  });
  it("audit: on macOS the identity path is NFC like the default volume, so NFD and NFC spellings are one identity", () => {
    const d = createPlatformCapabilities({ platform: "darwin" });
    assert.equal(d.canonicalIdentityPath("/Users/c/Caf\u0065\u0301"), d.canonicalIdentityPath("/Users/c/Caf\u00e9"));
  });
  it("audit: isUnsafeLink fails closed on an error other than not-found", { skip: process.platform === "win32" }, () => {
    const dir = tempDir("p1b-plat-");
    assert.equal(platformCapabilities.isUnsafeLink(join(dir, "missing")), false);
    writeFileSync(join(dir, "f"), "");
    assert.equal(platformCapabilities.isUnsafeLink(join(dir, "f", "child")), false, "ENOTDIR is a plain absence");
    assert.equal(platformCapabilities.isUnsafeLink(join(dir, "x".repeat(300))), true, "ENAMETOOLONG: cannot be vouched for");
    symlinkSync(join(dir, "b"), join(dir, "a")); symlinkSync(join(dir, "a"), join(dir, "b"));
    assert.equal(platformCapabilities.isUnsafeLink(join(dir, "a", "x")), true, "ELOOP");
  });
  it("KNOWN GAP: a unix socket path over the platform limit is not detected or shortened by ipcAddress", { todo: "needs an address fallback decided with the engine owner (path length 103 on darwin, 107 on linux)" }, () => {
    const long = "/" + "d".repeat(120);
    assert.ok(Buffer.byteLength(createPlatformCapabilities({ platform: "linux" }).ipcAddress(long).address) <= 107);
  });
});
