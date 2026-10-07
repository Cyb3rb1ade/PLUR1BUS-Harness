import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPromptBuilder } from "../../src/prompt/builder.ts";
import { corpusInput, memory } from "../fixtures/prompt-corpus.ts";
import type { PromptEvent } from "../../src/prompt/types.ts";

const block = (name: string, text: string, droppable = true) => ({ name, text, droppable, chars: text.length });

describe("L3: clipping emits a typed event, never silently", () => {
  it("a frozen snapshot over the zone cap is clipped on a line boundary and reports prompt.zone-clipped", () => {
    const seen: PromptEvent[] = [];
    const b = createPromptBuilder({ emit: (e) => seen.push(e) });
    const r = b.render(corpusInput(1, { memory, zoneCaps: { memory: 1000 } }));
    const mem = r.segments.filter((s) => s.zone === "memory").map((s) => s.text).join("");
    assert.ok(mem.length <= 1000);
    assert.ok(memory.startsWith(mem));
    assert.equal(memory[mem.length], "\n", "cut on a record (line) boundary");
    const ev = r.events.filter((e) => e.type === "prompt.zone-clipped");
    assert.deepEqual(ev, [{ type: "prompt.zone-clipped", agentId: "bernd", model: "claude-sonnet-5-5", zone: "memory", from: memory.length, to: mem.length, cap: 1000, reason: "zone-cap" }]);
    assert.deepEqual(seen, r.events, "the emit callback sees exactly the returned events, in order");
  });
  it("the default memory cap is the engine's 17 000-char inject budget (ADR-010 §caps)", () => {
    const big = Array.from({ length: 3000 }, (_, i) => `Fact ${i}: ${"x".repeat(20)}`).join("\n");
    const r = createPromptBuilder().render(corpusInput(1, { memory: big }));
    const ev = r.events.find((e) => e.type === "prompt.zone-clipped");
    assert.ok(ev && ev.type === "prompt.zone-clipped");
    assert.equal(ev.cap, 17_000);
  });
  it("a snapshot within the cap is untouched and emits nothing", () => {
    const r = createPromptBuilder().render(corpusInput(1, { memory }));
    assert.equal(r.events.some((e) => e.type === "prompt.zone-clipped"), false);
  });
  it("clipping never splits a surrogate pair", () => {
    const text = "a".repeat(9) + "\u{1F600}" + "b".repeat(10); // no newline: hard cut falls inside the pair at cap 10
    const r = createPromptBuilder().render(corpusInput(1, { memory: text, zoneCaps: { memory: 10 } }));
    const mem = r.segments.find((s) => s.zone === "memory")!.text;
    assert.equal(mem, "a".repeat(9));
    assert.equal(mem.isWellFormed(), true);
  });
  it("volatile engine blocks over the host cap emit block-clipped / block-dropped with the engine's from/to", () => {
    const r = createPromptBuilder().render(corpusInput(1, {
      volatile: { capChars: 6, blocks: [block("start", "SSSSS", false), block("memories", "MMMMM"), block("reminder", "RRRRR")] },
    }));
    const tail = r.segments.filter((s) => s.zone === "volatile").map((s) => s.text);
    assert.deepEqual(tail, ["SSSSS"]);
    assert.deepEqual(r.events.filter((e) => e.type.startsWith("prompt.block")).map((e) => [e.type, (e as { block: string }).block, (e as { from: number }).from, (e as { to: number }).to]),
      [["prompt.block-dropped", "memories", 5, 0], ["prompt.block-dropped", "reminder", 5, 0]]);
    const clipped = createPromptBuilder().render(corpusInput(1, { volatile: { capChars: 8, blocks: [block("start", "S", false), block("memories", "0123456789")] } }));
    assert.equal(clipped.events.filter((e) => e.type === "prompt.block-clipped").length, 1);
    assert.ok(clipped.segments.find((s) => s.zone === "volatile")!.text.length <= 8);
  });
  it("volatile delivery: a tool_result carries its tool-use id, otherwise a trailing context block; no breakpoint either way", () => {
    const blocks = [block("memories", "- fact")];
    const asResult = createPromptBuilder().render(corpusInput(1, { volatile: { blocks, delivery: "tool_result", toolUseId: "t1" } }));
    assert.deepEqual([asResult.segments.at(-1)!.kind, asResult.segments.at(-1)!.id, asResult.segments.at(-1)!.cache], ["tool_result", "t1", undefined]);
    const asContext = createPromptBuilder().render(corpusInput(1, { volatile: { blocks } }));
    assert.deepEqual([asContext.segments.at(-1)!.kind, asContext.segments.at(-1)!.role], ["context", "user"]);
    assert.throws(() => createPromptBuilder().render(corpusInput(1, { volatile: { blocks, delivery: "tool_result" } })), /toolUseId/);
  });
  it("all-empty volatile blocks add no segment", () => {
    const r = createPromptBuilder().render(corpusInput(1, { volatile: { blocks: [block("memories", "")] } }));
    assert.equal(r.segments.some((s) => s.zone === "volatile"), false);
  });
});
