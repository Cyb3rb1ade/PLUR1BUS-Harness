import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nextRegularAt, backoffDelayMs, retryDelayMs } from "../../src/discovery/schedule.ts";

describe("schedule math", () => {
  it("jitter stays within +/-10% over 1000 draws and spreads providers", () => {
    const draws: number[] = [];
    const base = 0;
    const intervalHours = 24;
    const intervalMs = 24 * 3600_000;
    const min = 0.9 * intervalMs;
    const max = 1.1 * intervalMs;

    for (let i = 0; i < 1000; i++) {
      const at = nextRegularAt(base, intervalHours, Math.random);
      assert.ok(at >= min, `at (${at}) >= min (${min})`);
      assert.ok(at <= max, `at (${at}) <= max (${max})`);
      draws.push(at);
    }
    const distinct = new Set(draws).size;
    assert.ok(distinct >= 900, `expected at least 900 distinct values, got ${distinct}`);
  });

  it("the 1 h floor applies after jitter", () => {
    // intervalHours = 1, u = 0 -> 0.9 * 3600_000 = 3240_000, floored to 3600_000
    const at = nextRegularAt(0, 1, () => 0);
    assert.equal(at, 3_600_000);
  });

  it("backoff doubles to the 6 h cap", () => {
    const noJitter = () => 0.5; // u = 0.5 -> 2*0.5 - 1 = 0 -> jitter = 0
    assert.equal(backoffDelayMs(1, noJitter), 300_000);
    assert.equal(backoffDelayMs(2, noJitter), 600_000);
    assert.equal(backoffDelayMs(3, noJitter), 1_200_000);
    assert.equal(backoffDelayMs(4, noJitter), 2_400_000);
    assert.equal(backoffDelayMs(5, noJitter), 4_800_000);
    assert.equal(backoffDelayMs(6, noJitter), 9_600_000);
    assert.equal(backoffDelayMs(7, noJitter), 19_200_000);
    assert.equal(backoffDelayMs(8, noJitter), 21_600_000);
    assert.equal(backoffDelayMs(20, noJitter), 21_600_000);

    // rng = 0 gives -10%, rng = 0.999999 gives ~ +10%
    assert.equal(backoffDelayMs(1, () => 0), 270_000);
    assert.equal(backoffDelayMs(1, () => 0.999999), 330_000);
  });

  it("Retry-After replaces the step when larger", () => {
    const rng = () => 0.5;
    assert.equal(retryDelayMs(1, 7_200_000, rng), 7_200_000);
    assert.equal(retryDelayMs(1, 1000, rng), 300_000);
    assert.equal(retryDelayMs(1, undefined, rng), 300_000);
  });
});
