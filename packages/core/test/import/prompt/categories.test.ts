/** Category metadata is explicit; absent Engine kind vocabulary must never be guessed during import. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { categoryForMemoryCard, kindForMemoryCategory } from "../../../src/import/prompt/categories.ts";
import { MEMORY_CATEGORIES } from "../../../src/import/prompt/model.ts";

describe("prompt category mapping", () => {
  it("recognises the six portable labels on either metadata field and falls back for unknown kinds", () => {
    assert.equal(categoryForMemoryCard({ category: "Instructions" }), "instructions");
    assert.equal(categoryForMemoryCard({ kind: " Identity " }), "identity");
    assert.equal(categoryForMemoryCard({ category: "Career" }), "career");
    assert.equal(categoryForMemoryCard({ kind: "Projects" }), "projects");
    assert.equal(categoryForMemoryCard({ category: "Preferences" }), "preferences");
    assert.equal(categoryForMemoryCard({ kind: "Other" }), "other");
    assert.equal(categoryForMemoryCard({ category: "arbitrary", kind: "identity" }), "identity");
    assert.equal(categoryForMemoryCard({ category: "preferences", kind: "identity" }), "preferences");
    assert.equal(categoryForMemoryCard({ category: "fact", kind: "decision" }), "other");
    assert.equal(categoryForMemoryCard({}), "other");
    assert.equal(categoryForMemoryCard({ category: null, kind: null }), "other");
    assert.equal(categoryForMemoryCard({ category: "__proto__" }), "other");
  });

  it("leaves kind absent because contract 1.17.0 defines no supported category vocabulary", () => {
    for (const category of MEMORY_CATEGORIES) assert.equal(kindForMemoryCategory(category), undefined);
  });
});
