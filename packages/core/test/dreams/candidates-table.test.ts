// dreams/candidates: the promotion gates (ADR-009 / docs/dreams.md "Candidates"): never recalls = 0, >= 3 recalls,
// >= 3 distinct queries, score >= 0.75, 72 h expiry; every gate evaluated, the first failure named.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contentHash, DEFAULT_GATES, evaluate } from "../../src/dreams/candidates.ts";

const NOW = 1_000_000;
const base = { expiresAt: NOW + 1, recalls: 3, uniqueQueries: 3, score: 0.75 as number | null };
const ok = (over: Partial<typeof base>) => evaluate({ ...base, ...over }, NOW);

describe("dreams/candidates evaluate: documented defaults", () => {
  it("the default gates are 0.75 / 3 recalls / 3 queries", () => { assert.deepEqual(DEFAULT_GATES, { minScore: 0.75, minRecallCount: 3, minUniqueQueries: 3 }); });

  it("a candidate exactly on every boundary is promoted", () => {
    const d = ok({});
    assert.equal(d.promote, true); assert.equal(d.rejectedBy, null);
    assert.deepEqual(d.gates.map((g) => g.passed), [true, true, true, true, true]);
    assert.equal(d.at, NOW);
  });

  const table: [string, Partial<typeof base>, string][] = [
    ["recalls 2", { recalls: 2 }, "recall-count"],
    ["recalls 0 (utility gate comes first)", { recalls: 0 }, "utility"],
    ["unique queries 2", { uniqueQueries: 2 }, "unique-queries"],
    ["unique queries 0", { uniqueQueries: 0 }, "unique-queries"],
    ["score 0.7499", { score: 0.7499 }, "score"],
    ["score 0", { score: 0 }, "score"],
    ["score -1", { score: -1 }, "score"],
    ["expired exactly now", { expiresAt: NOW }, "expiry"],
    ["expired long ago", { expiresAt: 0 }, "expiry"],
  ];
  for (const [name, over, gate] of table) {
    it(`${name} is rejected by ${gate}`, () => {
      const d = ok(over);
      assert.equal(d.promote, false); assert.equal(d.rejectedBy, gate);
      assert.equal(d.gates.find((g) => g.gate === gate)!.passed, false);
      assert.match(d.gates.find((g) => g.gate === gate)!.detail ?? "", /./, "a failed gate explains itself");
    });
  }

  it("a candidate without a score is not rejected for it (score is optional)", () => { assert.equal(ok({ score: null }).promote, true); });
  it("a very high score does not rescue a candidate nobody recalled (#142393)", () => {
    const d = ok({ recalls: 0, score: 1 });
    assert.equal(d.promote, false); assert.equal(d.rejectedBy, "utility");
  });
  it("every gate is evaluated, so the record shows all failures; rejectedBy is the first in gate order", () => {
    const d = ok({ expiresAt: 0, recalls: 0, uniqueQueries: 0, score: 0 });
    assert.deepEqual(d.gates.map((g) => g.gate), ["expiry", "utility", "recall-count", "unique-queries", "score"]);
    assert.deepEqual(d.gates.map((g) => g.passed), [false, false, false, false, false]);
    assert.equal(d.rejectedBy, "expiry");
  });
  it("custom gates are honoured", () => {
    const g = { minScore: 0.5, minRecallCount: 1, minUniqueQueries: 1 };
    assert.equal(evaluate({ expiresAt: NOW + 1, recalls: 1, uniqueQueries: 1, score: 0.5 }, NOW, g).promote, true);
    assert.equal(evaluate({ expiresAt: NOW + 1, recalls: 1, uniqueQueries: 1, score: 0.49 }, NOW, g).promote, false);
    const strict = { minScore: 0.99, minRecallCount: 10, minUniqueQueries: 10 };
    assert.equal(evaluate({ expiresAt: NOW + 1, recalls: 9, uniqueQueries: 10, score: 1 }, NOW, strict).rejectedBy, "recall-count");
  });
  it("custom gates cannot switch the utility gate off: recalls = 0 still fails with minRecallCount 0", () => {
    const d = evaluate({ expiresAt: NOW + 1, recalls: 0, uniqueQueries: 0, score: 1 }, NOW, { minScore: 0, minRecallCount: 0, minUniqueQueries: 0 });
    assert.equal(d.promote, false); assert.equal(d.rejectedBy, "utility");
  });
});

describe("dreams/candidates contentHash", () => {
  it("is the sha256 of the text (known vector for 'abc')", () => {
    assert.equal(contentHash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("trims the ends", () => { assert.equal(contentHash("  abc \n"), contentHash("abc")); });
  it("unifies unicode normal forms (NFC)", () => { assert.equal(contentHash("é"), contentHash("é")); });
  it("is case-sensitive and distinguishes different texts", () => {
    assert.notEqual(contentHash("Abc"), contentHash("abc"));
    assert.notEqual(contentHash("a"), contentHash("b"));
  });
  it("the empty string hashes (sha256 of the empty input)", () => {
    assert.equal(contentHash(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(contentHash("   "), contentHash(""));
  });
  it("characterization: Ist-Verhalten, nicht spezifiziert: inner whitespace is not collapsed, so 'a  b' and 'a b' are different candidates", () => {
    assert.notEqual(contentHash("a  b"), contentHash("a b"));
    assert.notEqual(contentHash("a\nb"), contentHash("a b"));
  });
});
