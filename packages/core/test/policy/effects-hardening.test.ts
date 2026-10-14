// B08 audit: effect mappings must never lower an effect they cannot read.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fromExtensionEffect, fromMcp, fromSideEffects, pathCovered } from "../../src/policy/index.ts";

describe("effect mappings fail closed", () => {
  it("an extension effect outside read/write/destructive is not read as a local write", () => {
    for (const e of ["exec", "delete", "", "WRITE", undefined]) {
      assert.equal(fromExtensionEffect(e as never, "none"), "external", String(e));
      assert.equal(fromExtensionEffect(e as never, "declared"), "external", String(e));
    }
    assert.equal(fromExtensionEffect("write", "none"), "local-write"); // controls
    assert.equal(fromExtensionEffect("destructive", "none"), "local-destructive");
    assert.equal(fromExtensionEffect("read", undefined), "read");
  });
  it("an MCP effect outside the vocabulary is not lowered by a destructive hint", () => {
    for (const d of ["bogus", "Read", 3, null]) {
      assert.equal(fromMcp(d as never, { destructiveHint: true }), "external", String(d));
      assert.equal(fromMcp(d as never), "external", String(d));
    }
    assert.equal(fromMcp("read", { destructiveHint: true }), "local-destructive"); // control
    assert.equal(fromMcp(undefined), "external");
  });
  it("side effects keep their fail-closed default", () => {
    assert.equal(fromSideEffects("weird" as never), "external");
  });
});

describe("pathCovered on a POSIX path", () => {
  it("a backslash is a file-name character there, not a separator", () => {
    assert.equal(pathCovered("/home/u/a", true, "/home/u/a\\evil"), false);
    assert.equal(pathCovered("/home/u/a", true, "/home/u/a/evil"), true); // control
    assert.equal(pathCovered("/home/u/a\\b", true, "/home/u/a/b"), false);
    assert.equal(pathCovered("/home/u/a\\b", true, "/home/u/a\\b/c"), true);
  });
  it("Windows and UNC spellings still treat both separators alike, and the two families never cover each other", () => {
    assert.equal(pathCovered("C:\\Users\\c", true, "C:/Users/c/x"), true);
    assert.equal(pathCovered("\\\\srv\\share", true, "\\\\srv/share/x"), true);
    assert.equal(pathCovered("/Users/c", true, "C:\\Users\\c\\x"), false);
    assert.equal(pathCovered("C:\\Users\\c", true, "/C:/Users/c/x"), false);
  });
});
