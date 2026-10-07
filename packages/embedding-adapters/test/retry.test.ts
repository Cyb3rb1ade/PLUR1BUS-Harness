import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RETRY_POLICY, backoffDelayMs, defaultSleep, resolveRetryPolicy, withRetry, type RetryPolicy } from "../src/retry.ts";
import { AdapterError, type AdapterErrorKind } from "../src/errors.ts";

const POLICY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 300, maxRetryAfterMs: 1000 };

function harness(random = 0) {
  const sleeps: number[] = [];
  return { sleeps, deps: { sleep: async (ms: number) => { sleeps.push(ms); }, random: () => random } };
}

function failing(kind: AdapterErrorKind, times: number, init: { retryAfterMs?: number } = {}) {
  let calls = 0;
  const fn = async (): Promise<string> => {
    calls++;
    if (calls <= times) throw new AdapterError(kind, `${kind} #${calls}`, init);
    return "ok";
  };
  return { fn, calls: () => calls };
}

test("equal-jitter backoff doubles per attempt, is capped, and never drops below half the ceiling", () => {
  assert.equal(backoffDelayMs(1, POLICY, () => 0), 50);
  assert.equal(backoffDelayMs(1, POLICY, () => 1), 100);
  assert.equal(backoffDelayMs(2, POLICY, () => 0), 100);
  assert.equal(backoffDelayMs(2, POLICY, () => 1), 200);
  assert.equal(backoffDelayMs(3, POLICY, () => 0), 150); // ceiling capped at 300
  assert.equal(backoffDelayMs(9, POLICY, () => 1), 300);
});

test("a first-try success makes one call and never sleeps", async () => {
  const h = harness();
  const f = failing("network", 0);
  assert.equal(await withRetry(f.fn, POLICY, h.deps), "ok");
  assert.equal(f.calls(), 1);
  assert.deepEqual(h.sleeps, []);
});

test("every transient kind is retried until it succeeds", async () => {
  for (const kind of ["rate_limit", "overloaded", "network", "timeout"] as const) {
    const h = harness();
    const f = failing(kind, 2);
    assert.equal(await withRetry(f.fn, POLICY, h.deps), "ok", kind);
    assert.equal(f.calls(), 3, kind);
    assert.deepEqual(h.sleeps, [50, 100], kind);
  }
});

test("permanent kinds are thrown at once", async () => {
  for (const kind of ["auth", "invalid_request", "too_large", "aborted", "bad_response"] as const) {
    const h = harness();
    const f = failing(kind, 5);
    await assert.rejects(withRetry(f.fn, POLICY, h.deps), (e: unknown) => e instanceof AdapterError && e.kind === kind);
    assert.equal(f.calls(), 1, kind);
    assert.deepEqual(h.sleeps, [], kind);
  }
});

test("a non-adapter error is never retried", async () => {
  const h = harness();
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw new TypeError("bug"); }, POLICY, h.deps), TypeError);
  assert.equal(calls, 1);
});

test("the last error is thrown once attempts are exhausted", async () => {
  const h = harness();
  const f = failing("overloaded", 99);
  await assert.rejects(withRetry(f.fn, POLICY, h.deps), (e: unknown) => e instanceof AdapterError && e.message === "overloaded #4");
  assert.equal(f.calls(), 4);
  assert.equal(h.sleeps.length, 3);
});

test("Retry-After wins over backoff", async () => {
  const h = harness();
  const f = failing("rate_limit", 1, { retryAfterMs: 700 });
  assert.equal(await withRetry(f.fn, POLICY, h.deps), "ok");
  assert.deepEqual(h.sleeps, [700]);
});

test("a Retry-After beyond the budget is handed back to the caller instead of slept", async () => {
  const h = harness();
  const f = failing("rate_limit", 5, { retryAfterMs: 60_000 });
  await assert.rejects(withRetry(f.fn, POLICY, h.deps), (e: unknown) => e instanceof AdapterError && e.kind === "rate_limit" && e.retryAfterMs === 60_000);
  assert.equal(f.calls(), 1);
  assert.deepEqual(h.sleeps, []);
});

test("a signal that is already aborted stops before the first attempt", async () => {
  const h = harness();
  const ctrl = new AbortController();
  ctrl.abort();
  const f = failing("network", 0);
  await assert.rejects(withRetry(f.fn, POLICY, { ...h.deps, signal: ctrl.signal }), (e: unknown) => e instanceof AdapterError && e.kind === "aborted");
  assert.equal(f.calls(), 0);
});

test("aborting while waiting to retry stops the loop", async () => {
  const ctrl = new AbortController();
  const f = failing("network", 99);
  const deps = { random: () => 0, signal: ctrl.signal, sleep: defaultSleep };
  const slowPolicy: RetryPolicy = { ...POLICY, baseDelayMs: 5000, maxDelayMs: 5000 };
  setTimeout(() => ctrl.abort(), 20);
  await assert.rejects(withRetry(f.fn, slowPolicy, deps), (e: unknown) => e instanceof AdapterError && e.kind === "aborted");
  assert.equal(f.calls(), 1);
});

test("defaultSleep resolves after the delay", async () => {
  const t0 = Date.now();
  await defaultSleep(20);
  assert.ok(Date.now() - t0 >= 15);
});

test("resolveRetryPolicy merges over the defaults", () => {
  assert.deepEqual(resolveRetryPolicy(), DEFAULT_RETRY_POLICY);
  assert.deepEqual(resolveRetryPolicy({ maxAttempts: 1 }), { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 });
  assert.equal(Object.isFrozen(DEFAULT_RETRY_POLICY), true);
});
