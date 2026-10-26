import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CACHE_PROFILES, lookupCacheProfile, normalizeModelId } from "../../src/prompt/model-table.ts";

// Every Anthropic floor of the cache-profile table (packages/providers/schema/cache-profiles.json, checked 2026-10-25), one model id each.
const ANTHROPIC: Array<[string, number]> = [
  ["claude-fable-5-1", 512], ["claude-mythos-5-1", 512], ["claude-opus-5", 512], ["claude-fable-5", 512], ["claude-mythos-5", 512],
  ["claude-opus-5-5", 512], ["claude-sonnet-5-5", 512], ["claude-haiku-5-5", 512],
  ["claude-opus-5-1", 512], // RULING: a minor release of a listed major shares its row
  ["claude-sonnet-5", 1024], ["claude-opus-4-8", 1024], ["claude-sonnet-4-6", 1024], ["claude-sonnet-4-5", 1024],
  ["claude-sonnet-4-5-20250929", 1024], ["claude-opus-4-20250514", 1024], ["claude-opus-4-1-20250805", 1024],
  ["claude-sonnet-4", 1024], ["claude-sonnet-4-20250514", 1024],
  ["claude-mythos-preview", 2048], ["claude-opus-4-7", 2048], ["claude-3-5-haiku-20241022", 2048],
  ["claude-opus-4-5", 4096], ["claude-opus-4-6", 4096], ["claude-haiku-4-5-20251001", 4096],
];

describe("cache profile table (the builder's view)", () => {
  for (const [id, min] of ANTHROPIC) {
    it(`anthropic ${id}: explicit, min ${min}, 4 breakpoints, 20-position lookback`, () => {
      const p = lookupCacheProfile(id);
      assert.equal(p.known, true);
      assert.equal(p.provider, "anthropic");
      assert.equal(p.mechanism, "explicit");
      assert.equal(p.minTokens, min);
      assert.equal(p.maxBreakpoints, 4);
      assert.equal(p.lookbackPositions, 20);
      assert.deepEqual([...p.ttls], ["5m", "1h"]);
    });
  }
  it("OpenAI GPT-5.6+ and GPT-6: explicit, 1 024, 30m first; earlier GPT: implicit, no breakpoints", () => {
    for (const id of ["gpt-5.6", "gpt-5.6-mini", "gpt-5.7", "gpt-5.10", "gpt-6", "gpt-6.1-sol"]) {
      const p = lookupCacheProfile(id);
      assert.deepEqual([p.provider, p.mechanism, p.minTokens, p.maxBreakpoints, [...p.ttls]], ["openai", "explicit", 1024, 4, ["30m", "12h"]], id);
    }
    for (const id of ["gpt-5.5", "gpt-5", "gpt-4o", "o3"]) {
      const p = lookupCacheProfile(id);
      assert.deepEqual([p.provider, p.mechanism, p.maxBreakpoints], ["openai", "implicit", 0], id);
    }
  });
  it("Gemini: implicit; 2.5 -> 2 048, 3.x -> 4 096", () => {
    assert.deepEqual(pick(lookupCacheProfile("gemini-2.5-flash")), ["google", "implicit", 2048, 0]);
    assert.deepEqual(pick(lookupCacheProfile("gemini-2.5-pro")), ["google", "implicit", 2048, 0]);
    assert.deepEqual(pick(lookupCacheProfile("gemini-3.5-flash")), ["google", "implicit", 4096, 0]);
    assert.deepEqual(pick(lookupCacheProfile("gemini-3.1-pro-preview")), ["google", "implicit", 4096, 0]);
  });
  it("provider prefixes (OpenRouter style) and dots resolve to the upstream row", () => {
    assert.equal(normalizeModelId("Anthropic/Claude-Opus-4.5"), "claude-opus-4-5");
    assert.equal(lookupCacheProfile("anthropic/claude-opus-4.5").minTokens, 4096);
  });
  it("an unknown model fails closed: no breakpoints, highest floor, flagged unknown", () => {
    const p = lookupCacheProfile("some-vendor/mystery-1");
    assert.deepEqual([p.known, p.mechanism, p.maxBreakpoints, p.minTokens], [false, "none", 0, Math.max(...CACHE_PROFILES.map((r) => r.minTokens))]);
    assert.equal(p.minTokens, 6144, "Vertex's Gemini floor is the highest in the table");
  });
  it("the other providers are known and implicit: no markers until their emitter exists", () => {
    for (const [id, provider] of [["grok-4.7", "xai"], ["kimi-k3", "moonshot"], ["deepseek-v4.1-flash", "deepseek"], ["qwen3.8-max", "alibaba"], ["glm-5.3", "zai"], ["mistral-large-4", "mistral"]] as const) {
      const p = lookupCacheProfile(id);
      assert.deepEqual([p.known, p.provider, p.mechanism, p.maxBreakpoints], [true, provider, "implicit", 0], id);
    }
  });
  it("a local route is matched by the local row, not by the model id's vendor", () => {
    assert.equal(lookupCacheProfile("qwen3:8b").provider, "alibaba");
    assert.deepEqual(pick(lookupCacheProfile("qwen3:8b", { local: true })), ["local", "implicit", 1, 0]);
  });
  it("the warm window comes from the row: Anthropic 5 min, OpenAI 30 min, Gemini and unknown models none", () => {
    assert.equal(lookupCacheProfile("claude-opus-5").warmMs, 300_000);
    assert.equal(lookupCacheProfile("gpt-4.1").warmMs, 1_800_000);
    assert.equal(lookupCacheProfile("gemini-2.5-pro").warmMs, null);
    assert.equal(lookupCacheProfile("mystery").warmMs, null);
  });
});

const pick = (p: ReturnType<typeof lookupCacheProfile>) => [p.provider, p.mechanism, p.minTokens, p.maxBreakpoints];
