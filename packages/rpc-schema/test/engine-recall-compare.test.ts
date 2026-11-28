import assert from "node:assert/strict";
import { it } from "node:test";

import example from "../fixtures/methods/engine.recall.compare.json" with { type: "json" };
import { validateResult } from "../src/index.ts";

const method = "engine.recall.compare";
const [baseline, middle, wide] = example.result.cases;
assert.ok(baseline && middle && wide);

it("bounds the comparison result to three cases and one hundred ordered IDs per case", () => {
  const orderedIds = Array.from({ length: 100 }, (_, index) => `card-${index}`);
  const cases = [baseline, middle, { ...wide, candidateCount: 100, orderedIds }];
  assert.equal(validateResult(method, { cases }).ok, true);
  assert.equal(validateResult(method, { cases: cases.slice(0, 2) }).ok, false);
  assert.equal(validateResult(method, { cases: [...cases, wide] }).ok, false);
  assert.equal(
    validateResult(method, {
      cases: [baseline, middle, { ...wide, orderedIds: [...orderedIds, "one-more"] }],
    }).ok,
    false,
  );
});

it("accepts per-pool timings and rejects content or invalid timing in the comparison response", () => {
  assert.equal(
    validateResult(method, { cases: [baseline, middle, { ...wide, elapsedMs: 0.25 }] }).ok,
    true,
  );
  assert.equal(
    validateResult(method, { cases: [baseline, middle, { ...wide, elapsedMs: -1 }] }).ok,
    false,
  );
  const { elapsedMs: _elapsedMs, ...withoutDuration } = wide;
  assert.equal(
    validateResult(method, { cases: [baseline, middle, withoutDuration] }).ok,
    false,
  );
  assert.equal(
    validateResult(method, { cases: [baseline, middle, { ...wide, text: "synthetic" }] }).ok,
    false,
  );
});
