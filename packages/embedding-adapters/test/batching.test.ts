import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, planBatches } from "../src/batching.ts";
import { AdapterError } from "../src/errors.ts";

test("token estimate is about four ASCII characters per token and one per 1.5 other characters", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens("a".repeat(4000)), 1000);
  assert.equal(estimateTokens("日本語"), 2);
  assert.equal(estimateTokens("😀"), 1); // one code point, not two UTF-16 units
});

test("batches are cut by count and keep the original order", () => {
  const texts = ["a", "b", "c", "d", "e"];
  assert.deepEqual(planBatches(texts, { maxBatch: 2, maxInputTokens: 100 }), [[0, 1], [2, 3], [4]]);
  assert.deepEqual(planBatches(texts, { maxBatch: 10, maxInputTokens: 100 }), [[0, 1, 2, 3, 4]]);
  assert.deepEqual(planBatches([], { maxBatch: 2, maxInputTokens: 100 }), []);
});

test("batches are also cut by the estimated token budget, order stable", () => {
  const eight = "x".repeat(32); // 8 tokens
  const one = "y".repeat(4); // 1 token
  const texts = [eight, one, one, eight, eight, one];
  const plan = planBatches(texts, { maxBatch: 100, maxInputTokens: 50, maxBatchTokens: 10 });
  assert.deepEqual(plan, [[0, 1, 2], [3], [4, 5]]);
  assert.deepEqual(plan.flat(), [0, 1, 2, 3, 4, 5]);
});

test("a single input over the per-input limit is refused as too_large before any request", () => {
  const long = "z".repeat(4 * 51); // 51 tokens
  assert.throws(() => planBatches(["ok", "ok", long], { maxBatch: 10, maxInputTokens: 50 }), (e: unknown) => {
    assert.ok(e instanceof AdapterError);
    assert.equal(e.kind, "too_large");
    assert.match(e.message, /input 2\b/);
    return true;
  });
});

test("an input within the per-input limit but over the batch budget travels alone", () => {
  const big = "q".repeat(4 * 20); // 20 tokens
  assert.deepEqual(planBatches([big, "a"], { maxBatch: 10, maxInputTokens: 50, maxBatchTokens: 10 }), [[0], [1]]);
});

test("nonsensical limits are an invalid request, not an endless loop", () => {
  assert.throws(() => planBatches(["a"], { maxBatch: 0, maxInputTokens: 10 }), (e: unknown) => e instanceof AdapterError && e.kind === "invalid_request");
  assert.throws(() => planBatches(["a"], { maxBatch: 1.5, maxInputTokens: 10 }), (e: unknown) => e instanceof AdapterError && e.kind === "invalid_request");
});
