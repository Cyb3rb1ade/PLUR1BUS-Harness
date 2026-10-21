import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectEngineMedia, EngineMediaIndex } from "../../src/media-search/engine-adapter.ts";
import { scope } from "./helpers.ts";

function stubMedia(calls: unknown[][]) {
  const fn = (name: string) => async (...a: unknown[]) => { calls.push([name, ...a]); return name === "index" ? { segments: 1, state: "indexed" } : name === "search" ? [] : name === "status" ? { enabled: true, backfill: {state:"idle",done:0,total:0} } : undefined; };
  return { index: fn("index"), search: fn("search"), remove: fn("remove"), setCaption: fn("setCaption"), status: fn("status"),
    backfill: { start: fn("start"), pause: fn("pause"), resume: fn("resume"), cancel: fn("cancel") } };
}

describe("detectEngineMedia", () => {
  it("is false without media or with an incomplete shape", () => {
    assert.equal(detectEngineMedia(undefined), false);
    assert.equal(detectEngineMedia({}), false);
    assert.equal(detectEngineMedia({ media: {} }), false);
    const m = stubMedia([]) as Record<string, unknown>;
    delete m["setCaption"];
    assert.equal(detectEngineMedia({ media: m }), false);
    const m2 = stubMedia([]) as Record<string, unknown>;
    m2["backfill"] = { start() {}, pause() {}, resume() {} };
    assert.equal(detectEngineMedia({ media: m2 }), false);
  });
  it("is true for the full shape, regardless of any version field", () => {
    assert.equal(detectEngineMedia({ media: stubMedia([]), version: "0.0.1" }), true);
  });
});

describe("EngineMediaIndex", () => {
  it("delegates all methods through the Engine 1.19 translation", async () => {
    const calls: unknown[][] = [];
    const idx = new EngineMediaIndex(stubMedia(calls) as never, { scopeOfMedia: async () => scope() });
    const req = { text: "x", limit: 3, scope: scope() };
    await idx.search(req);
    await idx.index({ mediaId: "m", kind: "image", mime: "image/png", source: { bytes: new Uint8Array() }, scope: scope() });
    await idx.remove("m"); await idx.setCaption("m", "t", "user"); await idx.status();
    await idx.backfill.start({ reason: "enable" }); await idx.backfill.pause(); await idx.backfill.resume(); await idx.backfill.cancel();
    assert.deepEqual(calls.map((c) => c[0]), ["search", "index", "remove", "setCaption", "status", "start", "pause", "resume", "cancel"]);
    assert.deepEqual((calls[0]![1] as any).scope, { agentId: "a1", scope: "agent-private" });
    assert.deepEqual(calls[5]!.slice(1), [{ reason: "enable" }]);
  });
});
