import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError } from "../../src/errors.ts";
import { classifyFailure } from "../../src/router/classify.ts";

const k = (kind: ConstructorParameters<typeof ProviderError>[0], init = {}) => classifyFailure(new ProviderError(kind, "x", init));

test("retryable kinds retry and may fall back", () => {
  for (const kind of ["rate_limit", "overloaded", "timeout", "network"] as const) {
    assert.deepEqual(k(kind), { kind, retryable: true, fallback: true, breaker: true });
  }
});

test("quota-exhausted 429 is not retried but may fall back", () => {
  const c = k("rate_limit", { retryable: false });
  assert.equal(c.retryable, false);
  assert.equal(c.fallback, true);
});

test("auth: no retry, no fallback, no breaker (a credential problem is the operator's to see, not to hide)", () => {
  assert.deepEqual(k("auth"), { kind: "auth", retryable: false, fallback: false, breaker: false });
});

test("invalid request (also content filter), context length, unknown: fail closed", () => {
  for (const kind of ["context_length", "invalid_request", "unknown"] as const) {
    assert.deepEqual(k(kind), { kind, retryable: false, fallback: false, breaker: false });
  }
});

test("abort and foreign errors never retry, fall back or trip a breaker", () => {
  assert.deepEqual(k("aborted"), { kind: "aborted", retryable: false, fallback: false, breaker: false });
  assert.deepEqual(classifyFailure(new TypeError("boom")), { kind: "unknown", retryable: false, fallback: false, breaker: false });
});
