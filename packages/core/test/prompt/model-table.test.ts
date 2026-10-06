import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CACHE_PROFILES, lookupCacheProfile, normalizeModelId } from "../../src/prompt/model-table.ts";

// Every row of docs/provider-matrix.md §3 (prompt caching), one model id each.
const ANTHROPIC: Array<[string, number]> = [
  ["claude-fable-5-1", 512], ["claude-mythos-5-1", 512], ["claude-opus-5", 512], ["claude-fable-5", 512], ["claude-mythos-5", 512],
  ["claude-opus-5-5", 512], // RULING: a minor release of a listed major shares its row
  ["claude-sonnet-5", 1024], ["claude-sonnet-5-5", 1024], ["claude-sonnet-4-6", 1024], ["claude-sonnet-4-5", 1024],
  ["claude-sonnet-4-5-20250929", 1024], ["claude-opus-4-20250514", 1024], ["claude-opus-4-1-20250805", 1024],
  ["claude-mythos-preview", 2048], ["claude-opus-4-7", 2048], ["claude-3-5-haiku-20241022", 2048],
  ["claude-opus-4-5", 4096], ["claude-opus-4-6", 4096], ["claude-haiku-4-5-20251001", 4096],
];

describe("cache profile table (docs/provider-matrix.md §3)", () => {
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
  it("OpenAI GPT-5.6+: explicit, 1 024, 30m only; earlier GPT: implicit, no breakpoints", () => {
    for (const id of ["gpt-5.6", "gpt-5.6-mini", "gpt-5.7", "gpt-5.10"]) {
      const p = lookupCacheProfile(id);
      assert.deepEqual([p.provider, p.mechanism, p.minTokens, p.maxBreakpoints, [...p.ttls]], ["openai", "explicit", 1024, 4, ["30m"]], id);
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
    assert.deepEqual([p.known, p.mechanism, p.maxBreakpoints, p.minTokens], [false, "none", 0, 4096]);
  });
  it("every row carries a source and the table has no duplicate ids", () => {
    const ids = CACHE_PROFILES.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const r of CACHE_PROFILES) assert.match(r.source, /provider-matrix\.md|RULING/);
  });
});

const pick = (p: ReturnType<typeof lookupCacheProfile>) => [p.provider, p.mechanism, p.minTokens, p.maxBreakpoints];
