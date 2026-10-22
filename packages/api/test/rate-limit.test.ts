import assert from "node:assert/strict";
import test from "node:test";
import { FakeClock } from "../src/clock.ts";
import { ConcurrencyLimit, DEFAULT_RATE_CLASSES, RateLimiter } from "../src/rate-limit.ts";

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

test("the seven route classes include rpc and expensive alongside auth, read, write, stream and totp; a configuration that names only the first three still gets the defaults for the others", () => {
  assert.deepEqual(Object.keys(DEFAULT_RATE_CLASSES).sort(), ["auth", "expensive", "read", "rpc", "stream", "totp", "write"]);
  const clock = new FakeClock(); const rl = new RateLimiter(clock, classes);
  let ok = 0; while (rl.take("stream", "ip:1").ok) ok++;
  assert.equal(ok, DEFAULT_RATE_CLASSES.stream.capacity);
  ok = 0; while (rl.take("totp", "user:1").ok) ok++;
  assert.equal(ok, DEFAULT_RATE_CLASSES.totp.capacity);
});

test("TOTP and login are the strictest classes: fewer attempts, slower refill than any other class", () => {
  const { totp, auth, read, write, stream } = DEFAULT_RATE_CLASSES;
  for (const other of [read, write, stream]) { assert.ok(totp.capacity <= other.capacity && auth.capacity <= other.capacity); assert.ok(totp.refillPerSec < other.refillPerSec && auth.refillPerSec < other.refillPerSec); }
  assert.ok(totp.refillPerSec <= auth.refillPerSec, "TOTP is at least as slow as login");
});

test("a class given explicitly overrides its default; an invalid new class is refused like an invalid old one", () => {
  const clock = new FakeClock();
  const rl = new RateLimiter(clock, { ...classes, stream: { capacity: 1, refillPerSec: 1 } });
  assert.equal(rl.take("stream", "k").ok, true); assert.equal(rl.take("stream", "k").ok, false);
  assert.throws(() => new RateLimiter(clock, { ...classes, totp: { capacity: 0, refillPerSec: 1 } }), /totp/);
  assert.throws(() => new RateLimiter(clock, { ...classes, stream: { capacity: 1, refillPerSec: 0 } }), /stream/);
});

test("classes do not share buckets: draining totp for a key leaves its read and auth buckets full", () => {
  const rl = new RateLimiter(new FakeClock(), classes);
  while (rl.take("totp", "user:1").ok) { /* drain */ }
  assert.equal(rl.take("read", "user:1").ok, true); assert.equal(rl.take("auth", "user:1").ok, true);
});

test("a scaled bucket is an upper bound that is wider in capacity and refill, and its eviction judges fullness by its own size", () => {
  const clock = new FakeClock(); const rl = new RateLimiter(clock, classes, 2);
  rl.take("write", "x");
  let ok = 0; while (rl.take("write", "ip:gw", 10).ok) ok++;
  assert.equal(ok, 10, "capacity 1 x 10");
  clock.advance(150); // 1.5 tokens: full by the unscaled capacity (1), far from full by its own (10)
  rl.take("write", "y"); // the key cap is reached: an eviction pass runs
  assert.equal(rl.take("write", "ip:gw", 10).ok, true, "refill 1/s x 10 gave it 1.5 tokens");
  assert.equal(rl.take("write", "ip:gw", 10).ok, false, "the bucket survived the eviction pass instead of being reset to full");
});

test("the concurrency limit hands out at most max slots, a release frees one, and releasing twice frees only one", () => {
  const c = new ConcurrencyLimit(2);
  const a = c.tryAcquire()!; const b = c.tryAcquire()!;
  assert.equal(typeof a, "function"); assert.equal(typeof b, "function"); assert.equal(c.tryAcquire(), undefined); assert.equal(c.active, 2);
  a(); a(); assert.equal(c.active, 1);
  assert.ok(c.tryAcquire()); assert.equal(c.tryAcquire(), undefined);
  assert.throws(() => new ConcurrencyLimit(0)); assert.throws(() => new ConcurrencyLimit(1.5));
  b();
});
