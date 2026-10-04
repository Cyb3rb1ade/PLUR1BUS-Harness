import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeClock, sequenceRng } from "../../src/discovery/testing.ts";

describe("FakeClock", () => {
  it("advance fires timers in order and leaves later ones pending", async () => {
    const c = new FakeClock(0); const order: number[] = [];
    c.setTimer(() => { order.push(300); }, 300);
    c.setTimer(() => { order.push(100); }, 100);
    c.setTimer(() => { order.push(700); }, 700);
    c.setTimer(() => { order.push(1500); }, 1500);
    await c.advance(1000);
    assert.deepEqual(order, [100, 300, 700]);
    assert.equal(c.pending(), 1);
    assert.equal(c.now(), 1000);
  });
  it("cancel removes a timer", async () => {
    const c = new FakeClock(0); let fired = 0;
    const h = c.setTimer(() => { fired += 1; }, 10);
    h.cancel();
    assert.equal(c.pending(), 0);
    await c.advance(100);
    assert.equal(fired, 0);
  });
  it("jump fires each pending timer exactly once", async () => {
    const c = new FakeClock(0); let fired = 0;
    c.setTimer(() => { fired += 1; }, 1000);
    c.setTimer(() => { fired += 1; }, 5000);
    await c.jump(3 * 86_400_000);
    assert.equal(fired, 2);
    assert.equal(c.pending(), 0);
  });
  it("sequenceRng cycles", () => {
    const r = sequenceRng([0.1, 0.2]);
    assert.deepEqual([r(), r(), r()], [0.1, 0.2, 0.1]);
  });
});
