import assert from "node:assert/strict";
import test from "node:test";
import { FakeClock } from "../src/clock.ts";
import { RateLimiter } from "../src/rate-limit.ts";

const classes = { auth: { capacity: 2, refillPerSec: 0.5 }, read: { capacity: 3, refillPerSec: 1 }, write: { capacity: 1, refillPerSec: 1 } };

test("a bucket trips once empty, answers Retry-After, and recovers as the clock advances", () => {
  const clock = new FakeClock(); const rl = new RateLimiter(clock, classes);
  assert.deepEqual(rl.take("read", "ip:1"), { ok: true });
  assert.deepEqual(rl.take("read", "ip:1"), { ok: true });
  assert.deepEqual(rl.take("read", "ip:1"), { ok: true });
  const v = rl.take("read", "ip:1");
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.retryAfterSec, 1);
  clock.advance(999); assert.equal(rl.take("read", "ip:1").ok, false);
  clock.advance(1); assert.equal(rl.take("read", "ip:1").ok, true);
  assert.equal(rl.take("read", "ip:1").ok, false);
});

test("refill is capped at the capacity and the retry hint follows the refill rate", () => {
  const clock = new FakeClock(); const rl = new RateLimiter(clock, classes);
  rl.take("auth", "k"); rl.take("auth", "k");
  const v = rl.take("auth", "k");
  assert.equal(v.ok === false && v.retryAfterSec, 2); // 0.5 token/s: one token in 2 s
  clock.advance(3_600_000);
  assert.equal(rl.take("auth", "k").ok, true); assert.equal(rl.take("auth", "k").ok, true); assert.equal(rl.take("auth", "k").ok, false);
});

test("keys and classes are independent", () => {
  const clock = new FakeClock(); const rl = new RateLimiter(clock, classes);
  rl.take("write", "ip:1"); assert.equal(rl.take("write", "ip:1").ok, false);
  assert.equal(rl.take("write", "ip:2").ok, true);
  assert.equal(rl.take("read", "ip:1").ok, true);
});

test("takeAll draws on both the IP and the principal bucket and reports the first that is empty", () => {
  const clock = new FakeClock(); const rl = new RateLimiter(clock, classes);
  assert.equal(rl.takeAll("write", ["ip:1", "principal:owner"]).ok, true);
  assert.equal(rl.takeAll("write", ["ip:2", "principal:owner"]).ok, false); // the principal bucket is empty although ip:2 is fresh
  assert.equal(rl.takeAll("write", ["ip:1", "principal:other"]).ok, false);  // the IP bucket is empty although the principal is fresh
});

test("memory follows the active keys: full buckets are dropped, the oldest goes at the cap", () => {
  const clock = new FakeClock(); const rl = new RateLimiter(clock, classes, 4);
  for (let i = 0; i < 4; i++) rl.take("write", `k${i}`);
  assert.equal(rl.size, 4);
  clock.advance(5_000);              // all four have refilled
  rl.take("write", "new");
  assert.equal(rl.size, 1);
  for (let i = 0; i < 10; i++) rl.take("write", `burst${i}`); // none refills: the cap holds by evicting the oldest
  assert.ok(rl.size <= 4);
});

test("a nonsensical class is refused at construction", () => {
  assert.throws(() => new RateLimiter(new FakeClock(), { ...classes, read: { capacity: 0, refillPerSec: 1 } }));
  assert.throws(() => new RateLimiter(new FakeClock(), { ...classes, read: { capacity: 1, refillPerSec: 0 } }));
});
