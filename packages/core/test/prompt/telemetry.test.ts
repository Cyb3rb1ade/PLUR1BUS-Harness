import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPromptBuilder, createCacheTelemetry, CACHE_SESSION_STATE_LIMIT, CACHE_MISS_CAUSES } from "../../src/prompt/index.ts";
import { corpusInput, memory as corpusMemory, tools as corpusTools } from "../fixtures/prompt-corpus.ts";

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

describe("H2-1 miss attribution", () => {
  const zero = { cache_read: 0, cache_creation: 0, input: 50 };
  const hit = (r: { stableTokensEstimate: number }) => ({ cache_read: r.stableTokensEstimate, cache_creation: 0, input: 50 });
  const extraTool = { ...corpusTools[0]!, name: "extra_tool" };

  it("first record is a first-request miss; a full hit follows", () => {
    const t = createCacheTelemetry(); const b = createPromptBuilder();
    const r1 = b.render(corpusInput(1, { sessionId: "s-1" }));
    const a = t.record(r1, zero);
    assert.equal(a.outcome, "miss"); assert.equal(a.cause, "first-request");
    const r2 = b.render(corpusInput(2, { sessionId: "s-1" }));
    const h = t.record(r2, hit(r2));
    assert.equal(h.outcome, "hit"); assert.equal(h.cause, undefined);
  });
  it("attributes tool additions and removals", () => {
    const t = createCacheTelemetry(); const b = createPromptBuilder();
    t.record(b.render(corpusInput(1, { sessionId: "s-1" })), zero);
    const added = t.record(b.render(corpusInput(1, { sessionId: "s-1", tools: [...corpusTools, extraTool] })), zero);
    assert.equal(added.cause, "tools-changed"); assert.equal(added.toolsAdded, 1); assert.equal(added.toolsRemoved, 0);
    const removed = t.record(b.render(corpusInput(1, { sessionId: "s-1" })), zero);
    assert.equal(removed.cause, "tools-changed"); assert.equal(removed.toolsAdded, 0); assert.equal(removed.toolsRemoved, 1);
  });
  it("attributes system, snapshot and model changes", () => {
    const t = createCacheTelemetry(); const b = createPromptBuilder();
    const base = (over = {}) => b.render(corpusInput(1, { sessionId: "s-1", ...over }));
    t.record(base(), zero);
    assert.equal(t.record(base({ system: ["changed system"] }), zero).cause, "system-changed");
    assert.equal(t.record(base({ system: ["changed system"], memory: `${corpusMemory}\nmore` }), zero).cause, "snapshot-changed");
    assert.equal(t.record(base({ system: ["changed system"], memory: `${corpusMemory}\nmore`, model: "claude-opus-5-5" }), zero).cause, "model-changed");
  });
  it("applies precedence between causes", () => {
    const run = (first: object, second: object) => {
      const t = createCacheTelemetry(); const b = createPromptBuilder();
      t.record(b.render(corpusInput(1, { sessionId: "p", ...first })), zero);
      return t.record(b.render(corpusInput(1, { sessionId: "p", ...second })), zero).cause;
    };
    assert.equal(run({}, { model: "claude-opus-5-5", tools: [extraTool] }), "model-changed");
    assert.equal(run({}, { tools: [extraTool], system: ["x system"] }), "tools-changed");
    assert.equal(run({}, { system: ["x system"], memory: `${corpusMemory}\nmore` }), "system-changed");
  });
  it("distinguishes ttl-expired from provider", () => {
    let now = 0;
    const t = createCacheTelemetry(); const b = createPromptBuilder({ now: () => now, cacheTtlMs: { anthropic: 1000 } });
    assert.equal(t.record(b.render(corpusInput(1, { sessionId: "s-1" })), zero).cause, "first-request");
    now = 2000;
    assert.equal(t.record(b.render(corpusInput(1, { sessionId: "s-1" })), zero).cause, "ttl-expired");
    now = 0;
    t.record(b.render(corpusInput(1, { sessionId: "s-2" })), zero);
    now = 500;
    assert.equal(t.record(b.render(corpusInput(1, { sessionId: "s-2" })), zero).cause, "provider");
  });
  it("reports uncacheable prompts as not-cacheable, never as misses", () => {
    const t = createCacheTelemetry(); const b = createPromptBuilder();
    const cases: Array<[object, string]> = [
      [{ tools: [], system: [], memory: "" }, "empty-prefix"],
      [{ tools: [], system: ["x"], memory: "" }, "below-minimum"],
      [{ model: "no-such-model-x" }, "unknown-model"],
      [{ cacheHint: "none" }, "no-breakpoints"],
    ];
    for (const [over, reason] of cases) {
      const rec = t.record(b.render(corpusInput(1, { sessionId: "n", ...over })), zero);
      assert.equal(rec.outcome, "not-cacheable"); assert.equal(rec.notCacheableReason, reason); assert.equal(rec.misses, 0);
    }
  });
  it("tolerates 128 tokens for implicit caches", () => {
    const t = createCacheTelemetry(); const b = createPromptBuilder();
    const r = b.render(corpusInput(1, { sessionId: "i-1", model: "deepseek-chat" }));
    assert.equal(r.cache.mechanism, "implicit");
    t.record(r, zero);
    assert.equal(t.record(r, { cache_read: r.stableTokensEstimate - 100, cache_creation: 0, input: 50 }).outcome, "hit");
    const r2 = b.render(corpusInput(1, { sessionId: "i-2", model: "deepseek-chat" }));
    t.record(r2, zero);
    assert.equal(t.record(r2, { cache_read: r2.stableTokensEstimate - 200, cache_creation: 0, input: 50 }).outcome, "miss");
  });
  it("keeps counters in agent+model and session totals", () => {
    const t = createCacheTelemetry(); const b = createPromptBuilder();
    const r = b.render(corpusInput(1, { sessionId: "s-1" }));
    t.record(r, zero); t.record(r, hit(r)); t.record(r, hit(r));
    t.record(b.render(corpusInput(1, { sessionId: "s-1", tools: [extraTool] })), zero);
    t.record(b.render(corpusInput(1, { sessionId: "s-1", tools: [], system: [], memory: "" })), zero);
    for (const s of [t.summary("bernd", "claude-sonnet-5-5")!, t.summary("bernd", "claude-sonnet-5-5", "s-1")!]) {
      assert.equal(s.hits, 2); assert.equal(s.misses, 2); assert.equal(s.notCacheable, 1);
      for (const c of CACHE_MISS_CAUSES) assert.equal(s.missCauses[c], c === "first-request" || c === "tools-changed" ? 1 : 0);
    }
  });
  it("lists per-model session summaries as detached copies", () => {
    const t = createCacheTelemetry(); const b = createPromptBuilder();
    t.record(b.render(corpusInput(1, { sessionId: "s-1", model: "claude-opus-5-5" })), zero);
    t.record(b.render(corpusInput(1, { sessionId: "s-1" })), zero);
    const list = t.sessionModels("bernd", "s-1");
    assert.deepEqual(list.map((e) => e.model), ["claude-opus-5-5", "claude-sonnet-5-5"]);
    assert.equal(list[0]!.summary.turns, 1);
    assert.deepEqual(t.sessionModels("bernd", "unknown"), []);
    list[0]!.summary.turns = 99; list[0]!.summary.missCauses["provider"] = 9;
    assert.equal(t.sessionModels("bernd", "s-1")[0]!.summary.turns, 1);
    assert.equal(t.sessionModels("bernd", "s-1")[0]!.summary.missCauses["provider"], 0);
  });
  it("gives per-turn records a one-turn shape", () => {
    const t = createCacheTelemetry(); const b = createPromptBuilder();
    const first = t.record(b.render(corpusInput(1, { sessionId: "s-1" })), zero);
    assert.deepEqual([first.hits, first.misses, first.notCacheable], [0, 1, 0]);
    assert.equal(Object.values(first.missCauses).reduce((a, n) => a + n, 0), 1);
    assert.equal("toolsAdded" in first, false); assert.equal("toolsRemoved" in first, false);
    const r = b.render(corpusInput(1, { sessionId: "s-1" }));
    const h = t.record(r, hit(r));
    assert.deepEqual([h.hits, h.misses, h.notCacheable], [1, 0, 0]);
    assert.equal(Object.values(h.missCauses).reduce((a, n) => a + n, 0), 0);
  });
  it("bounds the retained session state", () => {
    const t = createCacheTelemetry(); const b = createPromptBuilder();
    for (let i = 0; i <= CACHE_SESSION_STATE_LIMIT; i++) t.record(b.render(corpusInput(1, { sessionId: `x-${i}` })), zero);
    assert.equal(t.record(b.render(corpusInput(1, { sessionId: "x-0" })), zero).cause, "first-request");
    assert.notEqual(t.record(b.render(corpusInput(1, { sessionId: `x-${CACHE_SESSION_STATE_LIMIT}` })), zero).cause, "first-request");
  });
  it("leaves state and counters untouched when usage is invalid", () => {
    const t = createCacheTelemetry(); const b = createPromptBuilder();
    const r = b.render(corpusInput(1, { sessionId: "s-1" }));
    assert.throws(() => t.record(r, { cache_read: -1, cache_creation: 0, input: 0 }), /usage/);
    assert.equal(t.summary("bernd", "claude-sonnet-5-5"), undefined);
    assert.equal(t.record(r, zero).cause, "first-request");
  });
  it("counts tool changes beyond one and definition-only changes", () => {
    const t = createCacheTelemetry(); const b = createPromptBuilder();
    const more = [{ ...corpusTools[0]!, name: "extra_a" }, { ...corpusTools[0]!, name: "extra_b" }];
    t.record(b.render(corpusInput(1, { sessionId: "s-1" })), zero);
    const two = t.record(b.render(corpusInput(1, { sessionId: "s-1", tools: [...corpusTools, ...more] })), zero);
    assert.deepEqual([two.cause, two.toolsAdded, two.toolsRemoved], ["tools-changed", 2, 0]);
    const swap = t.record(b.render(corpusInput(1, { sessionId: "s-1", tools: [corpusTools[0]!, corpusTools[1]!, { ...corpusTools[2]!, name: "renamed" }] })), zero);
    assert.deepEqual([swap.cause, swap.toolsAdded, swap.toolsRemoved], ["tools-changed", 1, 3]);
    const redefined = t.record(b.render(corpusInput(1, { sessionId: "s-1", tools: [corpusTools[0]!, corpusTools[1]!, { ...corpusTools[2]!, name: "renamed", description: "Changed." }] })), zero);
    assert.deepEqual([redefined.cause, redefined.toolsAdded, redefined.toolsRemoved], ["tools-changed", 0, 0]);
  });
  it("evicts the per-session model index together with the session state", () => {
    const t = createCacheTelemetry(); const b = createPromptBuilder();
    for (let i = 0; i <= CACHE_SESSION_STATE_LIMIT; i++) t.record(b.render(corpusInput(1, { sessionId: `x-${i}` })), zero);
    assert.deepEqual(t.sessionModels("bernd", "x-0"), []);
    assert.equal(t.sessionModels("bernd", `x-${CACHE_SESSION_STATE_LIMIT}`).length, 1);
    assert.equal(t.sessionModels("bernd", "x-1").length, 1);
  });
  it("keeps session state intact when an aggregate overflow is rejected", () => {
    const t = createCacheTelemetry(); const b = createPromptBuilder();
    t.record(b.render(corpusInput(1, { sessionId: "s-1" })), zero);
    const changed = b.render(corpusInput(1, { sessionId: "s-1", system: ["changed system"] }));
    assert.throws(() => t.record(changed, { cache_read: Number.MAX_SAFE_INTEGER, cache_creation: 0, input: 0 }), /aggregate/);
    assert.equal(t.record(changed, zero).cause, "system-changed");
  });
});
