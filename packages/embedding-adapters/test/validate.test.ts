import { test } from "node:test";
import assert from "node:assert/strict";
import { orderedEmbeddings, toFloat32Vectors } from "../src/validate.ts";
import { cosine, l2Normalize, norm } from "../src/vector.ts";
import { AdapterError } from "../src/errors.ts";

const ctx = { provider: "test", expectedCount: 2, dimensions: 3 };

function badResponse(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof AdapterError, String(e));
    assert.equal(e.kind, "bad_response");
    assert.match(e.message, pattern);
    return true;
  });
}

test("valid vectors become Float32Arrays in input order", () => {
  const out = toFloat32Vectors([[0.1, 0.2, 0.3], [1, 2, 3]], ctx);
  assert.equal(out.length, 2);
  assert.ok(out[0] instanceof Float32Array);
  assert.deepEqual([...out[1]!], [1, 2, 3]);
  assert.ok(Math.abs(out[0]![0]! - 0.1) < 1e-7);
});

test("the number of vectors must equal the number of inputs", () => {
  badResponse(() => toFloat32Vectors([[1, 2, 3]], ctx), /expected 2 embeddings, got 1/);
  badResponse(() => toFloat32Vectors([[1, 2, 3], [1, 2, 3], [1, 2, 3]], ctx), /expected 2 embeddings, got 3/);
  badResponse(() => toFloat32Vectors({ not: "an array" }, ctx), /array of embeddings/);
});

test("every vector must have the configured dimension", () => {
  badResponse(() => toFloat32Vectors([[1, 2, 3], [1, 2]], ctx), /embedding 1 has 2 dimensions, expected 3/);
  badResponse(() => toFloat32Vectors([[1, 2, 3], "nope"], ctx), /embedding 1 is not an array/);
});

test("NaN, Infinity, null, strings and float32 overflow are refused without echoing values", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null, "0.5", true, 1e39]) {
    badResponse(() => toFloat32Vectors([[1, 2, 3], [1, bad as number, 3]], ctx), /embedding 1.*(non-finite|not a number)/);
  }
  assert.throws(() => toFloat32Vectors([[1, 2, 3], [1, "secret-looking-value-AAAA", 3] as unknown as number[]], ctx), (e: unknown) => e instanceof AdapterError && !e.message.includes("secret-looking"));
});

test("l2Normalize returns a unit vector and leaves the input alone", () => {
  const v = Float32Array.from([3, 4, 0]);
  const n = l2Normalize(v, "test");
  assert.notEqual(n, v);
  assert.deepEqual([...v], [3, 4, 0]);
  assert.ok(Math.abs(norm(n) - 1) < 1e-6);
  assert.ok(Math.abs(n[0]! - 0.6) < 1e-6);
});

test("a zero vector cannot be normalised", () => {
  badResponse(() => l2Normalize(new Float32Array(3), "test"), /zero vector/);
});

test("cosine is 1 for equal, 0 for orthogonal, -1 for opposite vectors", () => {
  const a = Float32Array.from([1, 0]);
  assert.ok(Math.abs(cosine(a, Float32Array.from([2, 0])) - 1) < 1e-9);
  assert.ok(Math.abs(cosine(a, Float32Array.from([0, 3]))) < 1e-9);
  assert.ok(Math.abs(cosine(a, Float32Array.from([-1, 0])) + 1) < 1e-9);
  assert.throws(() => cosine(a, Float32Array.from([1, 0, 0])), RangeError);
});

test("orderedEmbeddings sorts by index and demands a complete permutation", () => {
  const data = [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }];
  assert.deepEqual(orderedEmbeddings(data, 2, "test"), [[1], [2]]);
  badResponse(() => orderedEmbeddings([{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }], 2, "test"), /duplicate index 0/);
  badResponse(() => orderedEmbeddings([{ index: 0, embedding: [1] }, { index: 5, embedding: [2] }], 2, "test"), /index 5 out of range/);
  badResponse(() => orderedEmbeddings([{ embedding: [1] }, { embedding: [2] }], 2, "test"), /integer index/);
  badResponse(() => orderedEmbeddings([{ index: 0 }, { index: 1 }], 2, "test"), /embedding/);
  badResponse(() => orderedEmbeddings([{ index: 0, embedding: [1] }], 2, "test"), /expected 2 .* got 1/);
  badResponse(() => orderedEmbeddings("nope", 2, "test"), /array/);
  assert.deepEqual(orderedEmbeddings([{ index: 0, vector: [7] }], 1, "test", "vector"), [[7]]);
});
