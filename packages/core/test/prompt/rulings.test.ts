// ADR-010 open questions Q1-Q3 (docs/adr/ADR-010-latency-and-caching.md): each default taken here is the ADR's own
// proposal, recorded as a RULING in the ADR's implementation record and in the PR.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chooseCacheTtl, createPromptBuilder, createPromptSession } from "../../src/prompt/index.ts";
import { corpusInput, memory, system, tools } from "../fixtures/prompt-corpus.ts";

describe("Q1: Anthropic 1-hour TTL is automatic once the scheduler projects >= 3 reads (proposed default)", () => {
  it("1h from 3 projected reads, 5m below", () => {
    assert.equal(chooseCacheTtl({ model: "claude-sonnet-5-5", projectedReads: 3 }), "1h");
    assert.equal(chooseCacheTtl({ model: "claude-sonnet-5-5", projectedReads: 10 }), "1h");
    assert.equal(chooseCacheTtl({ model: "claude-sonnet-5-5", projectedReads: 2 }), "5m");
    assert.equal(chooseCacheTtl({ model: "claude-sonnet-5-5", projectedReads: 0 }), "5m");
  });
  it("a model that has no 1h TTL gets its own (GPT-5.6+: 30m), and an unknown model gets 5m", () => {
    assert.equal(chooseCacheTtl({ model: "gpt-5.6", projectedReads: 9 }), "30m");
    assert.equal(chooseCacheTtl({ model: "vendor/unknown", projectedReads: 9 }), "5m");
  });
  it("policy 'never' keeps 5m whatever is projected; a non-finite or negative projection is treated as none", () => {
    assert.equal(chooseCacheTtl({ model: "claude-sonnet-5-5", projectedReads: 9, policy: "never" }), "5m");
    assert.equal(chooseCacheTtl({ model: "claude-sonnet-5-5", projectedReads: Number.NaN }), "5m");
    assert.equal(chooseCacheTtl({ model: "claude-sonnet-5-5", projectedReads: -1 }), "5m");
  });
  it("the chosen TTL reaches the render: 1h stable breakpoints, 5m trailing", () => {
    const ttl = chooseCacheTtl({ model: "claude-sonnet-5-5", projectedReads: 4 });
    const r = createPromptBuilder().render(corpusInput(2, { cacheTtl: ttl }));
    assert.deepEqual(r.breakpoints.map((b) => b.ttl), ["1h", "1h", "1h", "5m"]);
  });
});

describe("Q2: the snapshot stays frozen until the next session (no automatic refresh, however long the session)", () => {
  it("after 200 turns and many recalls the snapshot zone is byte-identical and the session offers no refresh", () => {
    const s = createPromptSession({ builder: createPromptBuilder(), agentId: "bernd", model: "claude-sonnet-5-5", tools, system, memorySnapshot: memory });
    const first = s.render();
    for (let i = 0; i < 200; i += 1) {
      s.append({ role: "user", text: `q${i}` });
      if (i % 10 === 0) s.recall({ blocks: [{ name: "memories", text: `- fact ${i}`, droppable: true, chars: 10 }] });
      s.append({ role: "assistant", text: `a${i}` });
    }
    const last = s.render();
    assert.deepEqual(last.prefixHashes, first.prefixHashes);
    assert.deepEqual(Object.keys(s).sort(), ["agentId", "append", "memorySnapshot", "model", "recall", "render"]);
  });
});

describe("Q3: small prompts stay uncacheable and are reported, never padded (proposed default)", () => {
  it("a stable prefix below the floor gets prompt.below-minimum and not one extra byte", () => {
    const input = corpusInput(1, { model: "claude-opus-4-5", tools: [], system: ["tiny"], memory: "" });
    const r = createPromptBuilder().render(input);
    assert.ok(r.events.some((e) => e.type === "prompt.below-minimum" && e.minTokens === 4096));
    assert.deepEqual(r.segments.filter((s) => s.zone !== "conversation").map((s) => s.text), ["tiny"]);
  });
  it("there is no padding switch on the render input", () => {
    const keys = Object.keys(corpusInput(1, { cacheTtl: "5m", zoneCaps: {}, volatile: { blocks: [] } })).sort();
    assert.deepEqual(keys, ["agentId", "cacheTtl", "conversation", "memory", "model", "system", "tools", "volatile", "zoneCaps"]);
  });
});
