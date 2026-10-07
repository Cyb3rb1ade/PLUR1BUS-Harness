import { test } from "node:test";
import assert from "node:assert/strict";
import { ADAPTER_ERROR_KINDS, AdapterError, RETRYABLE_KINDS, errorSummary, isAdapterError } from "../src/errors.ts";

test("the taxonomy is exactly the agreed nine kinds", () => {
  assert.deepEqual([...ADAPTER_ERROR_KINDS].sort(), ["aborted", "auth", "bad_response", "invalid_request", "network", "overloaded", "rate_limit", "timeout", "too_large"]);
});

test("only transient kinds are retryable", () => {
  assert.deepEqual([...RETRYABLE_KINDS].sort(), ["network", "overloaded", "rate_limit", "timeout"]);
  assert.equal(new AdapterError("rate_limit", "slow down").retryable, true);
  assert.equal(new AdapterError("auth", "nope").retryable, false);
  assert.equal(new AdapterError("aborted", "stop").retryable, false);
  assert.equal(new AdapterError("too_large", "big").retryable, false);
});

test("carries provider, status and retryAfterMs", () => {
  const e = new AdapterError("rate_limit", "429", { provider: "cohere", status: 429, retryAfterMs: 1500 });
  assert.equal(e.kind, "rate_limit");
  assert.equal(e.provider, "cohere");
  assert.equal(e.status, 429);
  assert.equal(e.retryAfterMs, 1500);
  assert.equal(e.name, "AdapterError");
  assert.ok(e instanceof Error);
  assert.ok(isAdapterError(e));
  assert.equal(isAdapterError(new Error("x")), false);
});

test("secrets never survive into message, stack or json", () => {
  const secret = "sk-test-0123456789abcdef";
  const e = new AdapterError("auth", `rejected key ${secret}`, { secrets: [secret], cause: new Error(`inner ${secret}`) });
  assert.equal(e.message.includes(secret), false);
  assert.equal((e.stack ?? "").includes(secret), false);
  assert.equal(JSON.stringify(e).includes(secret), false);
  assert.equal("cause" in e, false);
});

test("messages are bounded", () => {
  const e = new AdapterError("bad_response", "x".repeat(5000));
  assert.ok(e.message.length <= 600);
});

test("errorSummary renders any thrown value without leaking secrets", () => {
  const secret = "topsecretvalue99";
  assert.equal(errorSummary(new TypeError(`fetch failed ${secret}`), [secret]), "TypeError: fetch failed [redacted]");
  assert.equal(errorSummary("plain string", []), "plain string");
  assert.equal(errorSummary({ weird: true }, []), "non-error value thrown");
  assert.ok(errorSummary(new Error("y".repeat(1000)), []).length <= 220);
});
