import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPromptBuilder, createPromptSession, sha256Hex } from "../../src/prompt/index.ts";
import { corpusInput, memory, system, tools } from "../fixtures/prompt-corpus.ts";

const blocks = ["memories", "temporal", "temporal-continuity", "mood", "reactivation", "reminder"].map((name) => ({ name, text: `live-${name}`, chars: name.length + 5, droppable: true }));

describe("cache-aware render metadata", () => {
  it("reports UTF-8 end offsets, estimates and hashes, keeping every engine block beyond every marker", () => {
    const r = createPromptBuilder().render(corpusInput(2, { volatile: { blocks }, system: [...system, "日本語 😀"] }));
    const rank = ["tools", "system", "memory", "conversation", "volatile"];
    for (let i = 1; i < r.segments.length; i++) assert.ok(rank.indexOf(r.segments[i - 1]!.zone) <= rank.indexOf(r.segments[i]!.zone));
    let offset = 0;
    for (const z of r.zones) {
      const parts = r.segments.filter((s) => s.zone === z.zone);
      offset += parts.reduce((n, s) => n + Buffer.byteLength(s.text), 0);
      assert.equal(z.byteOffset, offset);
      assert.equal(z.tokenEstimate, Math.ceil(parts.reduce((n, s) => n + s.text.length, 0) / 4));
      assert.equal(z.hash, r.zoneHashes[z.zone]);
    }
    for (const bp of r.breakpoints) {
      const prefix = r.segments.slice(0, bp.segment + 1).map((s) => s.text).join("");
      assert.equal(bp.byteOffset, Buffer.byteLength(prefix));
      assert.equal(bp.tokenEstimate, Math.ceil(prefix.length / 4));
      assert.equal(bp.hash, sha256Hex(prefix));
      assert.ok(bp.tokenEstimate >= r.cache.minimumTokens);
      assert.equal(r.segments[bp.segment]!.cache?.ttl, bp.ttl);
      assert.ok(bp.segment < r.segments.findIndex((s) => s.zone === "volatile"));
    }
    for (const b of blocks) assert.ok(r.segments.at(-1)!.text.includes(b.text), b.name);
  });
  it("below the stable floor emits no breakpoint even with a large transcript, and explains why", () => {
    const r = createPromptBuilder().render(corpusInput(200, { tools: [], system: ["tiny"], memory: "" }));
    assert.deepEqual(r.breakpoints, []);
    assert.equal(r.segments.some((s) => s.cache), false);
    assert.equal(r.cache.eligible, false);
    assert.equal(r.cache.reason, "below-minimum");
    const empty = createPromptBuilder().render(corpusInput(0, { tools: [], system: [], memory: "" }));
    assert.equal(empty.cache.reason, "empty-prefix");
  });
  it("checks the exact minimum boundary without padding and explains implicit/unknown models", () => {
    for (const [model, min] of [["claude-fable-5-1", 512], ["claude-sonnet-5", 1024], ["claude-opus-4-7", 2048], ["claude-haiku-4-5", 4096]] as const) {
      for (const n of [min - 1, min]) {
        const r = createPromptBuilder().render(corpusInput(0, { model, tools: [], system: ["x".repeat(n * 4)], memory: "" }));
        assert.equal(r.cache.eligible, n >= min);
        assert.equal(r.breakpoints.length, n >= min ? 1 : 0);
      }
    }
    assert.equal(createPromptBuilder().render(corpusInput(2, { model: "vendor/unknown" })).cache.reason, "unknown-model");
    const implicit = createPromptBuilder().render(corpusInput(2, { model: "gemini-2.5-pro" }));
    assert.equal(implicit.cache.eligible, true);
    assert.equal(implicit.cache.reason, "implicit-provider");
    assert.deepEqual(implicit.breakpoints, []);
  });
  it("model switches report a reason, preserve each model prefix and isolate agents", () => {
    const b = createPromptBuilder({ now: () => 0 });
    const a = b.render(corpusInput(2));
    const other = b.render(corpusInput(2, { model: "gpt-5.6" }));
    assert.ok(other.events.some((e) => e.type === "prompt.prefix-invalidated" && e.reason === "model-changed"));
    const back = b.render(corpusInput(3));
    assert.deepEqual(back.prefixHashes, a.prefixHashes);
    assert.equal(back.prefix.status, "warm");
    assert.equal(back.cache.expected, "warm");
    assert.notEqual(other.prefixKey, back.prefixKey);
    assert.equal(b.render(corpusInput(2, { agentId: "another" })).cache.expected, "cold");
  });
  it("predicts TTL warmth from request time with an injected clock (generation consumes TTL)", () => {
    let now = 1000;
    const b = createPromptBuilder({ now: () => now });
    assert.equal(b.render(corpusInput(2)).cache.expected, "cold");
    now += 240_000;
    const warm = b.render(corpusInput(3));
    assert.equal(warm.cache.expected, "warm");
    assert.equal(warm.cache.ageMs, 240_000);
    now += 300_000;
    assert.equal(b.render(corpusInput(4)).cache.expected, "cold");
    assert.equal(b.render(corpusInput(4, { memory: "changed" })).cache.expected, "cold");
  });
  it("supports provider TTL config, 1h/30m, and fails cold for an unknown TTL or a reversed clock", () => {
    let now = 0;
    const b = createPromptBuilder({ now: () => now, cacheTtlMs: { anthropic: 10, google: 500 } });
    b.render(corpusInput(2)); now = 10;
    assert.equal(b.render(corpusInput(2)).cache.expected, "cold");
    b.render(corpusInput(2, { model: "gemini-2.5-pro" })); now += 499;
    assert.equal(b.render(corpusInput(2, { model: "gemini-2.5-pro" })).cache.expected, "warm");
    assert.equal(createPromptBuilder().render(corpusInput(2, { model: "gemini-2.5-pro" })).cache.ttlMs, null);
    for (const [model, cacheTtl, ttl] of [["claude-sonnet-5", "1h", 3_600_000], ["gpt-5.6", "30m", 1_800_000]] as const) {
      const clock = createPromptBuilder({ now: () => now });
      clock.render(corpusInput(2, { model, cacheTtl })); now += ttl - 1;
      assert.equal(clock.render(corpusInput(2, { model, cacheTtl })).cache.expected, "warm");
      now += ttl;
      assert.equal(clock.render(corpusInput(2, { model, cacheTtl })).cache.expected, "cold");
      now -= 1;
      assert.equal(clock.render(corpusInput(2, { model, cacheTtl })).cache.expected, "cold");
    }
  });
  it("sticky session_id is stable per agent/session, bounded, isolated and absent from prefix bytes", () => {
    const b = createPromptBuilder({ now: () => 0 });
    const a = b.render(corpusInput(2, { sessionId: "session-a" }));
    const same = b.render(corpusInput(3, { sessionId: "session-a", model: "gpt-5.6" }));
    const other = b.render(corpusInput(2, { sessionId: "session-b" }));
    assert.equal(a.session_id, same.session_id);
    assert.notEqual(a.session_id, other.session_id);
    assert.equal(other.cache.expected, "cold");
    assert.deepEqual(a.prefixHashes, other.prefixHashes);
    assert.ok(a.session_id.length <= 256);
    assert.equal(a.segments.some((s) => s.text.includes(a.session_id)), false);
    assert.equal(createPromptBuilder().render(corpusInput(2, { sessionId: "session-a" })).session_id, a.session_id);
  });
});

describe("explicit session transitions", () => {
  it("freezes memory until refresh, reports its invalidation once, and keeps live recall outside it", () => {
    const s = createPromptSession({ builder: createPromptBuilder(), agentId: "a", sessionId: "s", model: "claude-sonnet-5", tools, system, memorySnapshot: memory });
    const before = s.render();
    s.recall({ blocks });
    assert.deepEqual(s.render().prefixHashes, before.prefixHashes);
    s.refreshMemorySnapshot(memory + "\nexplicit fact");
    const refreshed = s.render();
    assert.equal(s.memorySnapshot, memory + "\nexplicit fact");
    assert.notEqual(refreshed.prefixHashes.memory, before.prefixHashes.memory);
    assert.ok(refreshed.events.some((e) => e.type === "prompt.prefix-invalidated" && e.reason === "memory-refresh"));
    assert.equal(s.render().events.some((e) => e.type === "prompt.prefix-invalidated"), false);
    s.setModel("gpt-5.6");
    assert.equal(s.model, "gpt-5.6");
    assert.ok(s.render().events.some((e) => e.type === "prompt.prefix-invalidated" && e.reason === "model-changed"));
    s.setModel("claude-sonnet-5");
    assert.deepEqual(s.render().prefixHashes, refreshed.prefixHashes);
  });
});

describe("cache configuration boundaries", () => {
  it("rejects invalid TTL configuration and clocks", () => {
    for (const ttl of [-1, Infinity, NaN]) assert.throws(() => createPromptBuilder({ cacheTtlMs: { anthropic: ttl } }), /TTL/);
    assert.throws(() => createPromptBuilder({ now: () => NaN }).render(corpusInput(1)), /clock/);
  });
  it("never marks a sub-minimum early zone and respects every explicit model's breakpoint maximum", () => {
    for (const model of ["claude-fable-5-1", "claude-sonnet-5", "claude-opus-4-7", "claude-haiku-4-5", "gpt-5.6"]) {
      const r = createPromptBuilder().render(corpusInput(40, { model, system: ["x".repeat(16_384)] }));
      assert.equal(r.breakpoints.some((bp) => bp.zone === "tools"), false);
      assert.ok(r.breakpoints.every((bp) => bp.tokenEstimate >= r.cache.minimumTokens));
      assert.ok(r.breakpoints.length <= 4);
    }
  });
});

it("long TTL selection cannot retroactively warm an expired short entry; switching back respects expiry", () => {
  let now = 0;
  const b = createPromptBuilder({ now: () => now });
  b.render(corpusInput(2));
  now = 300_000;
  assert.equal(b.render(corpusInput(2, { cacheTtl: "1h" })).cache.expected, "cold");
  b.render(corpusInput(2, { model: "gpt-5.6" }));
  now += 3_600_000;
  const back = b.render(corpusInput(2));
  assert.equal(back.prefix.status, "warm");
  assert.equal(back.cache.expected, "cold");
  const unknownTtl = createPromptBuilder();
  unknownTtl.render(corpusInput(2, { model: "gemini-2.5-pro" }));
  assert.equal(unknownTtl.render(corpusInput(2, { model: "gemini-2.5-pro" })).cache.expected, "cold");
});
