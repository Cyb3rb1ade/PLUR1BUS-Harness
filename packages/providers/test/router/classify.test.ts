import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError } from "../../src/errors.ts";
import { classifyFailure } from "../../src/router/classify.ts";

const k = (kind: ConstructorParameters<typeof ProviderError>[0], init = {}) => classifyFailure(new ProviderError(kind, "x", init));

test("retryable kinds retry and may fall back", () => {
  for (const kind of ["rate_limit", "server", "timeout", "network"] as const) {
    assert.deepEqual(k(kind), { kind, retryable: true, fallback: true, breaker: true });
  }
});

test("quota-exhausted 429 is not retried but may fall back", () => {
  const c = k("rate_limit", { retryable: false });
  assert.equal(c.retryable, false);
  assert.equal(c.fallback, true);
});

test("auth: no retry, fallback allowed, counts for the breaker", () => {
  assert.deepEqual(k("auth"), { kind: "auth", retryable: false, fallback: true, breaker: true });
});

test("content filter, context length, bad request, protocol: fail closed", () => {
  for (const kind of ["content_filter", "context_length", "bad_request", "protocol"] as const) {
    assert.deepEqual(k(kind), { kind, retryable: false, fallback: false, breaker: false });
  }
});

test("abort and foreign errors never retry, fall back or trip a breaker", () => {
  assert.deepEqual(k("aborted"), { kind: "aborted", retryable: false, fallback: false, breaker: false });
  assert.deepEqual(classifyFailure(new TypeError("boom")), { kind: "unknown", retryable: false, fallback: false, breaker: false });
});
