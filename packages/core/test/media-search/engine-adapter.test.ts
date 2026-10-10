import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectEngineMedia, EngineMediaIndex } from "../../src/media-search/engine-adapter.ts";
import { scope } from "./helpers.ts";

function stubMedia(calls: unknown[][]) {
  const fn = (name: string) => async (...a: unknown[]) => { calls.push([name, ...a]); return name === "index" ? { segments: 1, state: "indexed" } : name === "search" ? [] : name === "status" ? { enabled: true } : undefined; };
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
  it("delegates 1:1", async () => {
    const calls: unknown[][] = [];
    const idx = new EngineMediaIndex(stubMedia(calls) as never);
    const req = { text: "x", limit: 3, scope: scope() };
    await idx.search(req);
    await idx.index({ mediaId: "m", kind: "image", mime: "image/png", source: { bytes: new Uint8Array() }, scope: scope() });
    await idx.remove("m"); await idx.setCaption("m", "t", "user"); await idx.status();
    await idx.backfill.start({ reason: "enable" }); await idx.backfill.pause(); await idx.backfill.resume(); await idx.backfill.cancel();
    assert.deepEqual(calls.map((c) => c[0]), ["search", "index", "remove", "setCaption", "status", "start", "pause", "resume", "cancel"]);
    assert.equal(calls[0]![1], req);
    assert.deepEqual(calls[5]!.slice(1), [{ reason: "enable" }]);
  });
});
