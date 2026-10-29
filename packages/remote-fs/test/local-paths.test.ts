/** Local native authority spans volumes, while configured roots retain lexical containment on every platform. */
import assert from "node:assert/strict";
import { win32 } from "node:path";
import { test } from "node:test";
import { localSourceRelativePath } from "../src/local-paths.ts";

test("native Windows source paths retain their own drive or UNC volume independently of the working drive", () => {
  const cases = [
    ["C:\\Users\\runneradmin\\source", "Users\\runneradmin\\source"],
    ["D:\\repo\\source", "repo\\source"],
    ["\\\\wsl.localhost\\Ubuntu\\home\\alice\\.source", "home\\alice\\.source"],
    ["\\\\server\\share\\source", "source"],
    ["\\\\?\\C:\\Users\\runneradmin\\source", "Users\\runneradmin\\source"],
  ] as const;
  for (const [path, suffix] of cases) {
    assert.equal(localSourceRelativePath(path, undefined, win32), suffix);
    assert.throws(() => localSourceRelativePath(path, "E:\\configured", win32), { reason: "path-denied" });
    assert.equal(localSourceRelativePath(win32.join(path, "selected"), path, win32), "selected");
    assert.throws(() => localSourceRelativePath(path + "-other\\selected", path, win32),
      { reason: "path-denied" });
  }
  assert.equal(localSourceRelativePath("C:\\configured\\selected", "c:\\configured", win32), "selected");
  assert.throws(() => localSourceRelativePath("C:\\configured-other\\selected", "C:\\configured", win32),
    { reason: "path-denied" });
  assert.throws(() => localSourceRelativePath("C:\\outside", "C:\\configured", win32), { reason: "path-denied" });
});
