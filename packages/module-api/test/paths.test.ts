import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { moduleAddress, supervisorAddress, unitAddress } from "../src/paths.ts";

describe("address rule (parity with paths.rs)", () => {
  it("the platform decides the format, not the characters in the home", () => {
    assert.equal(unitAddress("/tmp/a\\b", "core", "linux"), "/tmp/a\\b/run/core.sock", "a POSIX home with a backslash stays POSIX");
    assert.equal(unitAddress("/h/.plur1bus/", "core", "darwin"), "/h/.plur1bus/run/core.sock", "a trailing '/' is trimmed");
    assert.equal(supervisorAddress("/h/.plur1bus", "linux"), "/h/.plur1bus/run/supervisor.sock");
  });

  it("the Windows pipe name matches the Rust fixture", () => {
    const home = "C:\\Users\\c\\AppData\\Local\\PLUR1BUS";
    assert.equal(unitAddress(home, "core", "win32"), "\\\\.\\pipe\\plur1bus-741b3e0a44818d49-core");
    assert.equal(supervisorAddress(home, "win32"), "\\\\.\\pipe\\plur1bus-741b3e0a44818d49-supervisor");
    assert.equal(unitAddress(home, "module-fixture", "win32"), "\\\\.\\pipe\\plur1bus-741b3e0a44818d49-module-fixture");
  });

  it("module address parity", () => {
    assert.equal(moduleAddress("/tmp/p1b", "fixture", "linux"), "/tmp/p1b/run/module-fixture.sock");
    assert.equal(moduleAddress("/tmp/p1b", "fixture", "darwin"), "/tmp/p1b/run/module-fixture.sock");
    const home = "C:\\Users\\A B\\AppData\\Local\\PLUR1BUS";
    const hash16 = createHash("sha256").update("c:\\users\\a b\\appdata\\local\\plur1bus").digest("hex").slice(0, 16);
    assert.equal(moduleAddress(home, "fixture", "win32"), `\\\\.\\pipe\\plur1bus-${hash16}-module-fixture`);
  });
});
