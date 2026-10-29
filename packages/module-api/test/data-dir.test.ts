// The shared A12 data-directory boundary rejects unsafe identity components before touching the filesystem.
import { it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createExtensionDataDir, createSecurePath } from "../src/index.ts";
import { tempDir } from "./helpers/temp-dir.ts";

it("refuses unsafe extension names without creating a data tree or a traversed target", () => {
  const invalid = ["", ".", "..", "../../../escaped", "nested/name", "nested\\name", "/absolute", "C:\\absolute",
    "name:stream", "name.", "name ", "name\0", "name\n", "con", "prn", "aux", "nul", "com1", "lpt9",
    "con.txt", "nul.tar.gz", "a".repeat(65)];
  for (const name of invalid) {
    const root = tempDir("p1b-data-name-");
    const home = path.join(root, "home");
    mkdirSync(home);
    assert.throws(() => createExtensionDataDir(home, name, createSecurePath()), /extension name/, JSON.stringify(name));
    assert.equal(existsSync(path.join(home, "data")), false, JSON.stringify(name));
    assert.equal(existsSync(path.join(root, "escaped")), false, JSON.stringify(name));
  }
});

it("creates data for dotted extension names and the 64-character extension-name boundary", () => {
  for (const name of ["1search.v2_local", "a".repeat(64)]) {
    const home = tempDir("p1b-data-ext-name-");
    const expected = path.join(home, "data", "ext", name);
    assert.equal(createExtensionDataDir(home, name, createSecurePath()), expected);
    assert.equal(existsSync(expected), true);
  }
});
