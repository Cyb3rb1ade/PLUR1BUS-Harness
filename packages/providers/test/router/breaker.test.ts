import assert from "node:assert/strict";
import { test } from "node:test";
import { CircuitBreaker } from "../../src/router/breaker.ts";
import type { BreakerState } from "../../src/router/types.ts";
import { FakeClock } from "./helpers.ts";

function mk() {
  const clock = new FakeClock();
  const changes: string[] = [];
  const b = new CircuitBreaker({ failureThreshold: 2, openMs: 1000 }, clock, (f: BreakerState, t: BreakerState) => changes.push(`${f}>${t}`));
  return { clock, changes, b };
}

test("closed admits and stays closed below the threshold; success resets the count", () => {
  const { b } = mk();
  assert.equal(b.state, "closed");
  b.failure();
  b.success();
  b.failure();
  assert.equal(b.state, "closed");
  assert.deepEqual(b.admit(), { allowed: true });
});

test("threshold failures open it; open refuses until openMs has passed", () => {
  const { b, clock, changes } = mk();
  b.failure(); b.failure();
  assert.equal(b.state, "open");
  assert.deepEqual(b.admit(), { allowed: false, reason: "breaker_open" });
  clock.t = 999;
  assert.equal(b.state, "open");
  clock.t = 1000;
  assert.equal(b.state, "half_open");
  assert.deepEqual(changes, ["closed>open", "open>half_open"]);
});

test("half-open admits exactly one probe; the second caller is refused", () => {
  const { b, clock } = mk();
  b.failure(); b.failure();
  clock.t = 1000;
  assert.deepEqual(b.admit(), { allowed: true });
  assert.deepEqual(b.admit(), { allowed: false, reason: "half_open_busy" });
});

test("a successful probe closes the circuit", () => {
  const { b, clock, changes } = mk();
  b.failure(); b.failure();
  clock.t = 1000;
  b.admit();
  b.success();
  assert.equal(b.state, "closed");
  assert.deepEqual(b.admit(), { allowed: true });
  assert.equal(changes.at(-1), "half_open>closed");
});

test("a failed probe re-opens it with a fresh timer", () => {
  const { b, clock } = mk();
  b.failure(); b.failure();
  clock.t = 1000;
  b.admit();
  b.failure();
  assert.equal(b.state, "open");
  clock.t = 1999;
  assert.equal(b.state, "open");
  clock.t = 2000;
  assert.equal(b.state, "half_open");
});

test("release frees the probe slot without changing state", () => {
  const { b, clock } = mk();
  b.failure(); b.failure();
  clock.t = 1000;
  b.admit();
  b.release();
  assert.equal(b.state, "half_open");
  assert.deepEqual(b.admit(), { allowed: true });
});
