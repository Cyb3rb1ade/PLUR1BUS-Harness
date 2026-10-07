import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPromptBuilder, createCacheTelemetry } from "../../src/prompt/index.ts";
import { corpusInput } from "../fixtures/prompt-corpus.ts";

describe("R8 / B5 cache telemetry (synthetic usage; no provider calls)", () => {
  it("records each turn and reaches >= 0.90 from turn 3 on a 20-turn session", () => {
    const t = createCacheTelemetry();
    const b = createPromptBuilder();
    for (let turn = 1; turn <= 20; turn++) {
      const r = b.render(corpusInput(turn, { sessionId: "b5" }));
      const row = t.record(r, turn === 1 ? { cache_read: 0, cache_creation: 950, input: 50 } : { cache_read: 950, cache_creation: 0, input: 50 });
      assert.equal(row.turn, turn);
      assert.equal(row.totalInputTokens, 1000);
      assert.equal(row.breakpointCount, r.breakpoints.length);
      assert.deepEqual(row.zoneHashes, r.zoneHashes);
      if (turn >= 3) assert.ok(row.hitRatio >= 0.90, `B5 turn ${turn}`);
    }
    assert.equal(t.summary("bernd", "claude-sonnet-5-5")?.hitRatio, 0.9025);
    assert.equal(t.summary("bernd", "claude-sonnet-5-5", "b5")?.turns, 20);
  });
  it("isolates agent, model and session, handles zero usage and returns detached snapshots", () => {
    const t = createCacheTelemetry();
    const a = createPromptBuilder().render(corpusInput(1, { sessionId: "s" }));
    t.record(a, { cache_read: 90, cache_creation: 0, input: 10 });
    t.record({ ...a, model: "gpt-5.6" }, { cache_read: 0, cache_creation: 90, input: 10 });
    t.record({ ...a, agentId: "other" }, { cache_read: 0, cache_creation: 0, input: 0 });
    assert.equal(t.summary("bernd", "gpt-5.6")?.hitRatio, 0);
    assert.equal(t.summary("other", a.model)?.hitRatio, 0);
    assert.equal(t.summary("missing", a.model), undefined);
    const s = t.summary("bernd", a.model)!; s.cacheReadTokens = 0;
    assert.equal(t.summary("bernd", a.model)?.cacheReadTokens, 90);
    const row = t.record(a, { cache_read: 90, cache_creation: 0, input: 10 });
    row.zoneHashes.tools = "mutated";
    assert.notEqual(a.zoneHashes.tools, "mutated");
    assert.equal(row.turn, 2);
  });
  it("rejects invalid usage atomically", () => {
    const t = createCacheTelemetry();
    const r = createPromptBuilder().render(corpusInput(1));
    for (const n of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => t.record(r, { cache_read: n, cache_creation: 0, input: 0 }), /usage/);
    }
    assert.equal(t.summary(r.agentId, r.model), undefined);
  });
});

describe("telemetry aggregation boundaries", () => {
  it("weights by tokens, keeps independent session turn numbers, and rejects aggregate overflow atomically", () => {
    const t = createCacheTelemetry();
    const b = createPromptBuilder();
    const a = b.render(corpusInput(1, { sessionId: "a" }));
    const other = b.render(corpusInput(1, { sessionId: "other" }));
    t.record(a, { cache_read: 9, cache_creation: 0, input: 1 });
    const row = t.record(other, { cache_read: 0, cache_creation: 0, input: 90 });
    assert.equal(row.turn, 1);
    assert.equal(t.summary(a.agentId, a.model)?.hitRatio, 0.09);
    const before = t.summary(a.agentId, a.model);
    assert.throws(() => t.record(a, { cache_read: Number.MAX_SAFE_INTEGER, cache_creation: 0, input: 0 }), /aggregate/);
    assert.deepEqual(t.summary(a.agentId, a.model), before);
    assert.equal(t.summary(a.agentId, a.model, "a")?.turns, 1);
  });
});
