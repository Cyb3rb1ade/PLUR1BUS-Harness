import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffDelay, DEFAULT_BACKOFF } from "../../src/channels/index.ts";

test("exponential, capped", () => {
  const p = { baseMs: 1000, maxMs: 8000 };
  assert.deepEqual([0, 1, 2, 3, 4, 10].map((n) => backoffDelay(p, n)), [1000, 2000, 4000, 8000, 8000, 8000]);
});

test("huge attempt counts do not overflow", () => {
  assert.equal(backoffDelay({ baseMs: 1000, maxMs: 60_000 }, 5000), 60_000);
});

test("defaults are sane", () => {
  assert.ok(DEFAULT_BACKOFF.baseMs > 0 && DEFAULT_BACKOFF.maxMs >= DEFAULT_BACKOFF.baseMs);
});
