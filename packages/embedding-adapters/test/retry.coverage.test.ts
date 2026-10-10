import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AdapterError, type AdapterErrorKind } from "../src/errors.ts";
import { DEFAULT_RETRY_POLICY, backoffDelayMs, defaultSleep, resolveRetryPolicy, withRetry, type RetryPolicy } from "../src/retry.ts";

const POLICY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 300, maxRetryAfterMs: 1000 };
const isAborted = (e: unknown) => e instanceof AdapterError && e.kind === "aborted";

describe("resolveRetryPolicy", () => {
  it("with no argument returns the documented defaults", () => {
    assert.deepEqual(resolveRetryPolicy(), { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 4000, maxRetryAfterMs: 10_000 });
    assert.deepEqual(resolveRetryPolicy(), DEFAULT_RETRY_POLICY);
  });

  it("overrides only the fields given and leaves the shared defaults untouched", () => {
    const p = resolveRetryPolicy({ maxAttempts: 1 });
    assert.equal(p.maxAttempts, 1);
    assert.equal(p.baseDelayMs, DEFAULT_RETRY_POLICY.baseDelayMs);
    assert.equal(DEFAULT_RETRY_POLICY.maxAttempts, 3);
  });

  it("the shared default object is frozen", () => {
    assert.equal(Object.isFrozen(DEFAULT_RETRY_POLICY), true);
  });
});

describe("backoffDelayMs", () => {
  // [attempt, random, expected]: ceiling = min(maxDelay, base * 2^(attempt-1)); delay = ceiling/2 + random*ceiling/2
  const table: Array<[number, number, number]> = [
    [1, 0, 50],
    [1, 0.999, 100],
    [2, 0.5, 150],
    [3, 0, 150],
    [4, 0, 150],
    [1000, 1, 300],
  ];
  for (const [attempt, random, want] of table) {
    it(`attempt ${attempt} with random ${random} gives ${want} ms`, () => {
      assert.equal(backoffDelayMs(attempt, POLICY, () => random), want);
    });
  }

  it("a zero base delay gives zero delay regardless of jitter", () => {
    assert.equal(backoffDelayMs(5, { ...POLICY, baseDelayMs: 0 }, () => 0.9), 0);
  });

  it("the delay is always an integer number of milliseconds", () => {
    for (const r of [0.1, 0.33, 0.77]) assert.equal(Number.isInteger(backoffDelayMs(2, POLICY, () => r)), true);
  });
});

describe("defaultSleep", () => {
  it("resolves when the timer fires and no signal is given", async () => {
    await assert.doesNotReject(defaultSleep(0));
  });

  it("rejects at once with an aborted AdapterError when the signal is already aborted", async () => {
    const c = new AbortController();
    c.abort();
    await assert.rejects(defaultSleep(60_000, c.signal), (e: unknown) => isAborted(e) && (e as Error).message === "aborted while waiting to retry");
  });

  it("rejects when the signal aborts during the wait", async () => {
    const c = new AbortController();
    const pending = defaultSleep(60_000, c.signal);
    c.abort();
    await assert.rejects(pending, isAborted);
  });

  it("a signal that aborts after the timer has resolved has no effect on the resolved sleep", async () => {
    const c = new AbortController();
    await defaultSleep(0, c.signal);
    assert.doesNotThrow(() => c.abort());
  });
});

describe("withRetry: signal and Retry-After handling", () => {
  const harness = (random = 0) => {
    const sleeps: number[] = [];
    return { sleeps, deps: { sleep: async (ms: number) => { sleeps.push(ms); }, random: () => random } };
  };

  it("an already-aborted signal stops before the first call, and fn is never invoked", async () => {
    const c = new AbortController();
    c.abort();
    let calls = 0;
    await assert.rejects(withRetry(async () => { calls++; return 1; }, POLICY, { ...harness().deps, signal: c.signal }), isAborted);
    assert.equal(calls, 0);
  });

  it("the signal is handed to the injected sleep so a wait can be cancelled", async () => {
    const c = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls++; throw new AdapterError("network", "down"); }, POLICY, {
        random: () => 0,
        signal: c.signal,
        sleep: async (_ms, s) => { seen.push(s); throw new AdapterError("aborted", "aborted while waiting to retry"); },
      }),
      isAborted,
    );
    assert.equal(calls, 1);
    assert.equal(seen[0], c.signal);
  });

  it("Retry-After within the cap is used as the delay, not the jittered backoff", async () => {
    const h = harness(0.9);
    let calls = 0;
    const out = await withRetry(async () => {
      calls++;
      if (calls === 1) throw new AdapterError("rate_limit", "slow down", { retryAfterMs: 700 });
      return "ok";
    }, POLICY, h.deps);
    assert.equal(out, "ok");
    assert.deepEqual(h.sleeps, [700]);
  });

  it("Retry-After exactly at the cap is still slept", async () => {
    const h = harness();
    let calls = 0;
    await withRetry(async () => { calls++; if (calls === 1) throw new AdapterError("overloaded", "x", { retryAfterMs: 1000 }); return 1; }, POLICY, h.deps);
    assert.deepEqual(h.sleeps, [1000]);
  });

  it("Retry-After above the cap is not slept: the error goes back to the caller at once", async () => {
    const h = harness();
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls++; throw new AdapterError("rate_limit", "too long", { retryAfterMs: 1001 }); }, POLICY, h.deps),
      (e: unknown) => e instanceof AdapterError && e.retryAfterMs === 1001,
    );
    assert.equal(calls, 1);
    assert.deepEqual(h.sleeps, []);
  });

  it("a Retry-After of zero is honoured as an immediate retry", async () => {
    const h = harness();
    let calls = 0;
    await withRetry(async () => { calls++; if (calls === 1) throw new AdapterError("rate_limit", "now", { retryAfterMs: 0 }); return 1; }, POLICY, h.deps);
    assert.deepEqual(h.sleeps, [0]);
    assert.equal(calls, 2);
  });

  it("a non-retryable kind is not retried even when it carries a Retry-After", async () => {
    const h = harness();
    let calls = 0;
    await assert.rejects(withRetry(async () => { calls++; throw new AdapterError("auth", "no", { retryAfterMs: 5 }); }, POLICY, h.deps), (e: unknown) => e instanceof AdapterError && e.kind === "auth");
    assert.equal(calls, 1);
    assert.deepEqual(h.sleeps, []);
  });
});

describe("withRetry: attempt budget", () => {
  it("maxAttempts of one disables retrying entirely", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls++; throw new AdapterError("network", "x"); }, { ...POLICY, maxAttempts: 1 }, { sleep: async () => {}, random: () => 0 }),
      (e: unknown) => e instanceof AdapterError && e.kind === "network",
    );
    assert.equal(calls, 1);
  });

  it("the last retryable error after the budget is spent is the one thrown", async () => {
    const kinds: AdapterErrorKind[] = ["network", "timeout", "overloaded", "rate_limit"];
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls++; throw new AdapterError(kinds[calls - 1] ?? "network", `attempt ${calls}`); }, { ...POLICY, maxAttempts: 4 }, { sleep: async () => {}, random: () => 0 }),
      (e: unknown) => e instanceof AdapterError && e.kind === "rate_limit" && e.message === "attempt 4",
    );
    assert.equal(calls, 4);
  });

  it("the attempt number passed to fn counts from 1", async () => {
    const seen: number[] = [];
    let calls = 0;
    await withRetry(async (attempt) => { seen.push(attempt); calls++; if (calls < 3) throw new AdapterError("timeout", "t"); return "done"; }, POLICY, { sleep: async () => {}, random: () => 0 });
    assert.deepEqual(seen, [1, 2, 3]);
  });
});
