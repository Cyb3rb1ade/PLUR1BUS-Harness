import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CAPTION_MODELS, DEFAULT_CAPTION_MODEL, createLocalCaptionProvider, localTranscriber, captionModelNotice, type CaptionLoader } from "../../src/media-search/caption/local.ts";
import { mergeFrameCaptions, spread } from "../../src/media-search/caption/keyframes.ts";

const img = { kind: "image" as const, mime: "image/png", source: { bytes: new Uint8Array([9]) } };

describe("local caption provider", () => {
  it("loads lazily once and captions an image", async () => {
    let loads = 0;
    const loader: CaptionLoader = async () => { loads++; return { captionImage: async () => "a dog in a park" }; };
    const p = createLocalCaptionProvider({ modelDir: "/nowhere", loader, maxChars: () => 100 });
    assert.equal(loads, 0);
    assert.equal(p.local, true);
    assert.equal(await p.caption(img), "a dog in a park");
    await p.caption(img);
    assert.equal(loads, 1);
  });
  it("video: keyframes captioned individually, merged by time, deduped", async () => {
    const texts = ["a beach", "a dog", "A beach.", "sunset"];
    // the image byte is the frame index; frames arrive unordered on purpose
    const extractor = { async *frames() { for (const i of [3, 0, 2, 1]) yield { tsMs: i * 1000, image: new Uint8Array([i]), mime: "image/jpeg" }; } };
    const p = createLocalCaptionProvider({ modelDir: "/x", loader: async () => ({ captionImage: async b => texts[b[0]!]! }), maxChars: () => 200, extractor });
    assert.equal(await p.caption({ kind: "video", mime: "video/mp4", source: { path: "/tmp/x.mp4" } }), "a beach; a dog; sunset");
  });
  it("video without extractor is unsupported", async () => {
    const p = createLocalCaptionProvider({ modelDir: "/x", loader: async () => ({ captionImage: async () => "x" }), maxChars: () => 50 });
    await assert.rejects(p.caption({ kind: "video", mime: "video/mp4", source: { path: "/x" } }), (e: any) => (e.error ?? e.code) === "E_MEDIA_UNSUPPORTED_KIND");
  });
  it("audio: local ASR transcript truncated to maxChars", async () => {
    const decoder = { async *pcm() { for (let i = 0; i < 3; i++) yield { startMs: i * 30000, samples: new Float32Array(160) }; } };
    const asr = { async transcribe() { return { text: "hello world this is a long transcript chunk" }; } };
    const transcribe = localTranscriber({ asr: asr as any, decoder, maxChars: () => 40 });
    const p = createLocalCaptionProvider({ modelDir: "/x", loader: async () => ({ captionImage: async () => "" }), maxChars: () => 40, transcribe });
    const out = await p.caption({ kind: "audio", mime: "audio/wav", source: { bytes: new Uint8Array(1) } });
    assert.ok(out.length <= 40 && out.endsWith("…"));
  });
  it("a failing loader is retried next time", async () => {
    let n = 0;
    const p = createLocalCaptionProvider({ modelDir: "/x", maxChars: () => 50, loader: async () => { if (n++ === 0) throw new Error("boom"); return { captionImage: async () => "ok" }; } });
    await assert.rejects(p.caption(img));
    assert.equal(await p.caption(img), "ok");
  });
});

describe("keyframe helpers", () => {
  it("spread keeps first and last", () => assert.deepEqual(spread([1, 2, 3, 4, 5, 6, 7, 8, 9], 3), [1, 5, 9]));
  it("merge orders by time and dedupes", () => assert.equal(mergeFrameCaptions([{ tsMs: 5, text: "b" }, { tsMs: 1, text: "A." }, { tsMs: 9, text: "a" }], 50), "A; b"));
});

describe("model pins", () => {
  it("default is MIT Florence-2 and notice names the licence", () => {
    const pin = CAPTION_MODELS[DEFAULT_CAPTION_MODEL]!;
    assert.equal(pin.licence.id, "MIT");
    assert.match(captionModelNotice(pin), /MIT/);
  });
});
