/** Canonical text keys must merge formatting differences without changing the entry's meaning. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeMemoryText } from "../../../src/import/prompt/model.ts";

describe("normalizeMemoryText", () => {
  it("merges Unicode composition and whitespace while retaining case and punctuation", () => {
    assert.equal(normalizeMemoryText("  Cafe\u0301\twith\n  Tea!  "), "Café with Tea!");
    assert.notEqual(normalizeMemoryText("Read README"), normalizeMemoryText("read README"));
    assert.notEqual(normalizeMemoryText("x-y"), normalizeMemoryText("x y"));
  });
});
