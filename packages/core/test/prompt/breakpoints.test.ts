import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPromptBuilder } from "../../src/prompt/builder.ts";
import { corpusInput, memory } from "../fixtures/prompt-corpus.ts";
import type { ConversationItem, RenderedPrompt } from "../../src/prompt/types.ts";

const marked = (r: RenderedPrompt) => r.segments.flatMap((s, i) => (s.cache ? [[i, s.zone, s.cache.ttl] as const] : []));

describe("zone order and breakpoint placement (ADR-010 §1, R1; docs/provider-matrix.md §3)", () => {
  it("renders tools -> system -> memory -> conversation -> volatile, in that order", () => {
    const r = createPromptBuilder().render(corpusInput(2, { volatile: { blocks: [{ name: "memories", text: "- m", droppable: true, chars: 3 }] } }));
    const order = r.segments.map((s) => s.zone);
    const rank = { tools: 0, system: 1, memory: 2, conversation: 3, volatile: 4 } as const;
    assert.deepEqual(order, [...order].sort((a, b) => rank[a] - rank[b]));
    assert.deepEqual([...new Set(order)], ["tools", "system", "memory", "conversation", "volatile"]);
    assert.equal(r.segments.filter((s) => s.zone === "tools").length, 3);
    assert.deepEqual(r.segments.filter((s) => s.zone === "tools").map((s) => JSON.parse(s.text).name), ["file_read", "memory_recall", "shell"]);
  });
  it("Anthropic: breakpoints at the end of tools, system, memory and the last conversation segment; none on the volatile tail", () => {
    const r = createPromptBuilder().render(corpusInput(2, { volatile: { blocks: [{ name: "memories", text: "- m", droppable: true, chars: 3 }] } }));
    const last = (z: string) => r.segments.map((s) => s.zone).lastIndexOf(z as never);
    assert.deepEqual(marked(r).map(([i, z]) => [i, z]), [[last("tools"), "tools"], [last("system"), "system"], [last("memory"), "memory"], [last("conversation"), "conversation"]]);
    assert.deepEqual(r.breakpoints.map((b) => b.kind), ["zone", "zone", "zone", "trailing"]);
    assert.equal(r.segments.at(-1)!.zone, "volatile");
    assert.equal(r.segments.at(-1)!.cache, undefined);
  });
  it("an empty zone takes no breakpoint; with no conversation the memory breakpoint is the last", () => {
    const r = createPromptBuilder().render(corpusInput(0, { tools: [], memory: "" }));
    assert.deepEqual(marked(r).map(([, z]) => z), ["system"]);
  });
  it("a model without explicit caching (Gemini, pre-5.6 GPT, unknown) gets no markers, same zone order", () => {
    for (const model of ["gemini-2.5-pro", "gpt-5.5", "vendor/unknown"]) {
      const r = createPromptBuilder().render(corpusInput(2, { model }));
      assert.deepEqual(r.breakpoints, [], model);
      assert.equal(r.segments.some((s) => s.cache), false, model);
      assert.equal(r.segments[0]!.zone, "tools");
    }
  });
  it("GPT-5.6+: explicit markers with its only TTL (30m), whatever TTL was asked for", () => {
    const r = createPromptBuilder().render(corpusInput(1, { model: "gpt-5.6", cacheTtl: "1h" }));
    assert.equal(r.breakpoints.length, 4);
    assert.ok(r.breakpoints.every((b) => b.ttl === "30m"));
  });
  it("never more breakpoints than the model's maximum", () => {
    for (const turns of [0, 1, 10, 40, 200]) {
      const r = createPromptBuilder().render(corpusInput(turns));
      assert.ok(r.breakpoints.length <= 4, `${turns} turns`);
    }
  });
  it("1h on the stable zones, 5m on the trailing breakpoint, 1h entries first (Anthropic mixing rule)", () => {
    const r = createPromptBuilder().render(corpusInput(2, { cacheTtl: "1h" }));
    assert.deepEqual(r.breakpoints.map((b) => b.ttl), ["1h", "1h", "1h", "5m"]);
  });
  it("R1: a free slot gets an interior breakpoint 15 positions behind the trailing one once the transcript is long", () => {
    const b = createPromptBuilder();
    const long = b.render(corpusInput(60, { tools: [], system: ["s"], memory: "" })); // tools and memory slots are free
    const kinds = long.breakpoints.map((x) => x.kind);
    assert.deepEqual(kinds, ["zone", "interior", "trailing"]);
    const interior = long.breakpoints[1]!, trailing = long.breakpoints[2]!;
    assert.equal(position(long.segments.map(toItem), trailing.segment) - position(long.segments.map(toItem), interior.segment), 15);
    const short = b.render(corpusInput(5, { tools: [], system: ["s"], memory: "" }));
    assert.deepEqual(short.breakpoints.map((x) => x.kind), ["zone", "trailing"]);
  });
  it("with every stable zone filled the zones win; a transcript past the lookback is reported, not silently uncached", () => {
    const r = createPromptBuilder().render(corpusInput(60));
    assert.deepEqual(r.breakpoints.map((x) => x.kind), ["zone", "zone", "zone", "trailing"]);
    const ev = r.events.find((e) => e.type === "prompt.lookback-risk");
    assert.ok(ev && ev.type === "prompt.lookback-risk");
    assert.equal(ev.lookback, 20);
    assert.ok(ev.positions > 20);
    assert.equal(createPromptBuilder().render(corpusInput(5)).events.some((e) => e.type === "prompt.lookback-risk"), false);
  });
  it("consecutive tool_use / tool_result blocks count as one position (Anthropic lookback rule)", () => {
    const convo: ConversationItem[] = [{ role: "user", text: "q" }];
    for (let i = 0; i < 30; i += 1) convo.push({ role: "assistant", kind: "tool_use", id: `t${i}`, text: "{}" });
    for (let i = 0; i < 30; i += 1) convo.push({ role: "user", kind: "tool_result", id: `t${i}`, text: "ok" });
    convo.push({ role: "assistant", text: "done" });
    const r = createPromptBuilder().render(corpusInput(0, { conversation: convo }));
    assert.equal(r.events.some((e) => e.type === "prompt.lookback-risk"), false, "1 + 1 + 1 + 1 positions");
  });
  it("R2: below the model's minimum there is a typed warning and no padding; above it, none", () => {
    const small = createPromptBuilder().render(corpusInput(1, { model: "claude-haiku-4-5-20251001", tools: [], system: ["tiny"], memory: "" }));
    const ev = small.events.find((e) => e.type === "prompt.below-minimum");
    assert.ok(ev && ev.type === "prompt.below-minimum");
    assert.equal(ev.minTokens, 4096);
    assert.equal(small.segments.filter((s) => s.zone === "system").map((s) => s.text).join(""), "tiny", "never padded");
    assert.equal(createPromptBuilder().render(corpusInput(1, { model: "claude-fable-5-1", system: ["x".repeat(2400)] })).events.some((e) => e.type === "prompt.below-minimum"), false);
    assert.equal(createPromptBuilder().render(corpusInput(1)).events.some((e) => e.type === "prompt.below-minimum"), false, "the corpus clears 1 024");
  });
  it("an unknown model is reported once per render and not also as below-minimum", () => {
    const r = createPromptBuilder().render(corpusInput(1, { model: "vendor/unknown", memory: memory.slice(0, 10) }));
    assert.deepEqual(r.events.map((e) => e.type), ["prompt.unknown-model"]);
  });
});

const toItem = (s: { kind: string }): ConversationItem => ({ role: "user", kind: s.kind as never, text: "" });
/** Position of `index` among the conversation segments, as the builder counts them (collapsing tool runs). */
function position(items: ConversationItem[], index: number): number {
  let pos = 0;
  for (let i = 0; i <= index; i += 1) {
    const k = items[i]!.kind;
    const prev = items[i - 1]?.kind;
    if (!((k === "tool_use" || k === "tool_result") && prev === k)) pos += 1;
  }
  return pos;
}
