import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMediaIndexHook, type MediaRecord } from "../../src/media-search/hook.ts";
import { createCaptionService } from "../../src/media-search/caption/service.ts";
import { DisabledMediaIndex } from "../../src/media-search/disabled.ts";
import type { MediaIndexPort } from "../../src/media-search/types.ts";
import { FakeCaptionProvider, FakePort, recorder, scope, silentLogger } from "./fakes.ts";

const rec = (extra: Partial<MediaRecord> = {}): MediaRecord => ({ mediaId: "m1", kind: "image", mime: "image/png", source: { bytes: new Uint8Array([1]) }, ...extra });

function setup(o: { port?: MediaIndexPort; enabled?: boolean; provider?: string; captionProvider?: FakeCaptionProvider } = {}) {
  const port = o.port ?? new FakePort();
  const ev = recorder();
  const failed: string[] = [];
  const hook = createMediaIndexHook({
    port: () => port,
    captions: createCaptionService({ config: () => ({ source: "prompt-then-user-then-auto", maxChars: 280 }), provider: () => o.captionProvider }),
    config: () => ({ enabled: o.enabled ?? true, provider: o.provider ?? "local" }),
    scopeOf: () => scope, events: ev, counters: { indexFailed: s => { failed.push(s); } }, logger: silentLogger, timeoutMs: 0,
  });
  return { port, ev, failed, hook };
}

describe("media index hook", () => {
  it("generation: prompt becomes the caption (source prompt)", async () => {
    const { port, hook } = setup();
    hook.onStored(rec({ prompt: "a lighthouse at dusk" }));
    await hook.idle();
    const p = port as FakePort;
    assert.equal(p.indexed.length, 1);
    assert.equal(p.indexed[0]!.caption, "a lighthouse at dusk");
    assert.equal(p.indexed[0]!.captionSource, "prompt");
    assert.equal(p.indexed[0]!.scope, scope);
  });
  it("upload: user caption (source user); prompt is not used", async () => {
    const { port, hook } = setup();
    hook.onUploaded(rec({ userCaption: "holiday photo", prompt: "ignored" }));
    await hook.idle();
    assert.equal((port as FakePort).indexed[0]!.captionSource, "user");
    assert.equal((port as FakePort).indexed[0]!.caption, "holiday photo");
  });
  it("upload without caption falls back to auto when a provider exists", async () => {
    const { port, hook } = setup({ captionProvider: new FakeCaptionProvider() });
    hook.onUploaded(rec());
    await hook.idle();
    assert.equal((port as FakePort).indexed[0]!.captionSource, "auto");
  });
  it("delete removes", async () => {
    const { port, hook } = setup();
    hook.onDeleted("m9");
    await hook.idle();
    assert.deepEqual((port as FakePort).removed, ["m9"]);
  });
  it("never blocks: a never-resolving index does not delay the caller", async () => {
    const p = new FakePort();
    p.indexImpl = () => new Promise(() => {});
    const { hook } = setup({ port: p });
    const t0 = Date.now();
    hook.onStored(rec({ prompt: "x" }));
    hook.onStored(rec({ mediaId: "m2", prompt: "y" }));
    hook.onDeleted("m3");
    assert.ok(Date.now() - t0 < 50);
    await new Promise(r => setImmediate(r));
    assert.equal(p.indexed.length, 2);
  });
  it("a throwing index yields event + counter and does not reject", async () => {
    const p = new FakePort();
    p.indexImpl = async () => { throw new Error("engine down"); };
    const { hook, ev, failed } = setup({ port: p });
    assert.doesNotThrow(() => hook.onStored(rec({ prompt: "x" })));
    await hook.idle();
    assert.deepEqual(failed, ["index"]);
    assert.equal(ev.events[0]!.name, "media.index.failed");
    assert.equal(ev.events[0]!.payload.mediaId, "m1");
    assert.equal(ev.events[0]!.payload.stage, "index");
  });
  it("a throwing remove is reported too", async () => {
    const p = new FakePort();
    p.remove = async () => { throw new Error("nope"); };
    const { hook, ev, failed } = setup({ port: p });
    hook.onDeleted("m1");
    await hook.idle();
    assert.deepEqual(failed, ["remove"]);
    assert.equal(ev.events[0]!.name, "media.index.failed");
  });
  it("a failing auto caption is reported but the medium is still indexed", async () => {
    const bad = new FakeCaptionProvider(); bad.caption = async () => { throw new Error("model missing"); };
    const { port, hook, failed } = setup({ captionProvider: bad });
    hook.onUploaded(rec());
    await hook.idle();
    assert.deepEqual(failed, ["caption"]);
    assert.equal((port as FakePort).indexed.length, 1);
    assert.equal((port as FakePort).indexed[0]!.caption, undefined);
  });
  it("skips silently when disabled, provider off, or port Disabled", async () => {
    for (const o of [{ enabled: false }, { provider: "off" }]) {
      const { port, hook, ev } = setup(o);
      hook.onStored(rec({ prompt: "x" })); hook.onDeleted("m1");
      await hook.idle();
      assert.equal((port as FakePort).indexed.length + (port as FakePort).removed.length, 0);
      assert.equal(ev.events.length, 0);
    }
    const { hook, ev, failed } = setup({ port: new DisabledMediaIndex() });
    hook.onStored(rec({ prompt: "x" })); hook.onDeleted("m1");
    await hook.idle();
    assert.equal(ev.events.length, 0);
    assert.equal(failed.length, 0);
  });
  it("bounds concurrency", async () => {
    const p = new FakePort();
    let running = 0, peak = 0;
    p.indexImpl = async () => { running++; peak = Math.max(peak, running); await new Promise(r => setImmediate(r)); running--; return { segments: 1, state: "indexed" }; };
    const ev = recorder();
    const hook = createMediaIndexHook({ port: () => p, captions: createCaptionService({ config: () => ({ source: "off", maxChars: 50 }), provider: () => undefined }), config: () => ({ enabled: true }), scopeOf: () => scope, events: ev, counters: { indexFailed() {} }, logger: silentLogger, concurrency: 2, timeoutMs: 0 });
    for (let i = 0; i < 6; i++) hook.onStored(rec({ mediaId: `m${i}` }));
    await hook.idle();
    assert.equal(p.indexed.length, 6);
    assert.equal(peak, 2);
  });
});
