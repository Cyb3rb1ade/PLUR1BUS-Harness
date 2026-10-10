import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { InMemoryMediaIndex } from "../../src/media-search/in-memory.ts";
import { createMediaIndexHook, type MediaRecord } from "../../src/media-search/hook.ts";
import { createCaptionService } from "../../src/media-search/caption/service.ts";
import { recorder, scope, silentLogger } from "./fakes.ts";

const vec = (salt: string, text: string, dim: number): number[] => {
  const h = createHash("sha256").update(`${salt}\0${text}`).digest();
  return Array.from({ length: dim }, (_, i) => (h[i % h.length]! - 127.5) / 127.5);
};
const TEXT_PROVIDERS = [{ name: "text-a", dim: 8 }, { name: "text-b", dim: 12 }];
const MEDIA_PROVIDERS = [{ name: "media-x", dim: 6 }, { name: "media-y", dim: 10 }];
const LABELS = ["fox", "harbour", "violin"];

describe("provider matrix: any text provider x any media provider", () => {
  for (const t of TEXT_PROVIDERS) for (const m of MEDIA_PROVIDERS) {
    it(`${t.name} x ${m.name}: caption in the text path, search in the media path`, async () => {
      // Fake text memory store: what the engine's text index receives, embedded with the TEXT provider.
      const memory: { kind: string; mediaRef: string; text: string; vector: number[]; source: string }[] = [];
      const calls = { textEmbed: 0, mediaEmbedText: 0 };
      const captions = {
        async set(mediaId: string, text: string, source: string) { calls.textEmbed++; memory.push({ kind: "media-caption", mediaRef: mediaId, text, vector: vec(t.name, text, t.dim), source }); },
        async search() { return []; },
        async remove(mediaId: string) { for (let i = memory.length - 1; i >= 0; i--) if (memory[i]!.mediaRef === mediaId) memory.splice(i, 1); },
      };
      const index = new InMemoryMediaIndex({
        provider: m.name, model: m.name, dim: m.dim, fingerprint: `fp-${m.name}`,
        embedText: async text => { calls.mediaEmbedText++; return vec(m.name, text.trim(), m.dim); },
        embedMedia: async req => ({ vectors: [vec(m.name, LABELS[req.source && "bytes" in req.source ? req.source.bytes[0]! : 0]!, m.dim)], segments: [{ idx: 0, startMs: 0, endMs: 0 }] }),
        captions,
      });
      const hook = createMediaIndexHook({
        port: () => index, captions: createCaptionService({ config: () => ({ source: "prompt-then-user-then-auto", maxChars: 280 }), provider: () => undefined }),
        config: () => ({ enabled: true, provider: m.name }), scopeOf: () => scope, events: recorder(), counters: { indexFailed() {} }, logger: silentLogger, timeoutMs: 0,
      });
      const record = (i: number): MediaRecord => ({ mediaId: `media-${i}`, kind: "image", mime: "image/png", source: { bytes: new Uint8Array([i]) }, prompt: `picture of a ${LABELS[i]}` });
      LABELS.forEach((_, i) => hook.onStored(record(i)));
      await hook.idle();

      // Text path: one media-caption entry per medium, embedded by the text provider (its own dimension).
      assert.equal(memory.length, LABELS.length);
      for (const [i, e] of memory.entries()) {
        assert.equal(e.kind, "media-caption");
        assert.equal(e.mediaRef, `media-${i}`);
        assert.equal(e.source, "prompt");
        assert.equal(e.vector.length, t.dim);
      }
      // Media path: the text query is embedded by the MEDIA model's text encoder and hits the media vectors.
      const hits = await index.search({ text: "harbour", limit: 3, scope });
      assert.equal(hits[0]!.mediaId, "media-1");
      assert.equal(calls.mediaEmbedText, 1);
      assert.equal(calls.textEmbed, LABELS.length);
      assert.equal((await index.status()).dim, m.dim);
    });
  }
});
