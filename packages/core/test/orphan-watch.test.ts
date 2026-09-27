import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createOrphanWatch } from "../src/orphan-watch.ts";

function harness(graceMs = 1000) {
  const events: string[] = []; let now = 1_000;
  const w = createOrphanWatch({
    graceMs, clock: () => now,
    onOrphaned: (since) => events.push(`orphaned:${since}`), onReattached: () => events.push("reattached"), onGraceExpired: () => events.push("expired"),
  });
  return { w, events, advance: (ms: number) => { now += ms; mock.timers.tick(ms); } };
}
const flush = () => new Promise<void>((r) => setImmediate(r));

describe("orphan watch", () => {
  afterEach(() => mock.timers.reset());

  it("stream end orphans and grace expiry fires once", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { w, events, advance } = harness();
    const s = new PassThrough(); w.watchStream(s);
    s.end(); await flush();
    assert.deepEqual(events, ["orphaned:1000"]); assert.equal(w.orphanedSince, 1000);
    s.destroy(); await flush(); // 'close' after 'end' is the same loss, not a second one
    advance(999); assert.deepEqual(events, ["orphaned:1000"]);
    advance(1); assert.deepEqual(events, ["orphaned:1000", "expired"]);
    advance(5000); assert.deepEqual(events, ["orphaned:1000", "expired"]);
    w.dispose();
  });

  it("setGraceMs applies to the next orphaning; a running timer keeps its deadline", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { w, events, advance } = harness(1000);
    const s = new PassThrough(); w.watchStream(s);
    s.end(); await flush();
    w.setGraceMs(5000); // while the 1 s grace runs
    advance(1000); assert.deepEqual(events, ["orphaned:1000", "expired"], "the running timer keeps its 1 s");
    w.watchConnection("c1"); w.connectionClosed("c1");
    advance(4999); assert.deepEqual(events, ["orphaned:1000", "expired", "reattached", "orphaned:2000"]);
    advance(1); assert.equal(events.at(-1), "expired", "the next orphaning waits 5 s");
    w.dispose();
  });

  it("watchConnection before expiry cancels the timer and calls onReattached", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { w, events, advance } = harness();
    const s = new PassThrough(); w.watchStream(s);
    s.end(); await flush(); advance(500);
    w.watchConnection("c1");
    assert.deepEqual(events, ["orphaned:1000", "reattached"]); assert.equal(w.orphanedSince, null);
    advance(5000); assert.deepEqual(events, ["orphaned:1000", "reattached"]);
    w.connectionClosed("c1");
    assert.deepEqual(events, ["orphaned:1000", "reattached", "orphaned:6500"]);
    advance(1000); assert.deepEqual(events.at(-1), "expired");
    w.dispose();
  });

  it("closing a connection that is not the current source is ignored", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { w, events, advance } = harness();
    w.watchConnection("c1");
    w.connectionClosed("other"); advance(5000);
    assert.deepEqual(events, []); assert.equal(w.orphanedSince, null);
    w.dispose();
  });

  it("a replaced source's close no longer orphans", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { w, events, advance } = harness();
    const s = new PassThrough(); w.watchStream(s);
    w.watchConnection("c1");
    s.end(); await flush();
    assert.deepEqual(events, []);
    w.watchConnection("c2");
    w.connectionClosed("c1"); advance(5000);
    assert.deepEqual(events, []);
    w.connectionClosed("c2");
    assert.deepEqual(events, ["orphaned:6000"]);
    w.dispose(); advance(5000);
    assert.deepEqual(events, ["orphaned:6000"], "dispose cancels the grace timer");
  });

  it("a stream that already ended orphans at once", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { w, events } = harness();
    const s = new PassThrough(); s.resume(); s.destroy();
    w.watchStream(s);
    assert.deepEqual(events, ["orphaned:1000"]);
    w.dispose();
  });
});
