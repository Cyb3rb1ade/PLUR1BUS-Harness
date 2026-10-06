import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPromptBuilder } from "../../src/prompt/builder.ts";
import { createPromptSession } from "../../src/prompt/session.ts";
import { memory, system, tools } from "../fixtures/prompt-corpus.ts";
import type { PromptEvent } from "../../src/prompt/types.ts";

const block = (name: string, text: string, droppable = true) => ({ name, text, droppable, chars: text.length });
const open = (emit?: (e: PromptEvent) => void) =>
  createPromptSession({ builder: createPromptBuilder(), agentId: "bernd", model: "claude-sonnet-5-5", tools, system, memorySnapshot: memory, ...(emit ? { emit } : {}) });

describe("L7: the memory snapshot is frozen within a session", () => {
  it("a recall (with a fact the snapshot lacks) never changes the memory zone, its segment bytes or the prefix hashes", () => {
    const s = open();
    s.append({ role: "user", text: "What is my dog called?" });
    const before = s.render();
    s.recall({ blocks: [block("memories", "- NEWFACT: the dog is called Rex")] });
    const during = s.render();
    s.append({ role: "assistant", text: "Rex." });
    s.append({ role: "user", text: "And the cat?" });
    s.recall({ blocks: [block("memories", "- NEWFACT2: the cat is called Tom")] });
    const after = s.render();
    for (const r of [during, after]) {
      assert.deepEqual(r.segments.filter((x) => x.zone === "memory"), before.segments.filter((x) => x.zone === "memory"));
      assert.deepEqual(r.prefixHashes, before.prefixHashes);
      assert.deepEqual(r.zoneHashes.memory, before.zoneHashes.memory);
      assert.equal(r.segments.filter((x) => x.zone === "memory").some((x) => x.text.includes("NEWFACT")), false);
      assert.equal(r.prefix.status === "invalidated", false);
    }
    assert.equal(s.memorySnapshot, memory);
  });
  it("a recall rides the volatile tail of its own request, after the last breakpoint", () => {
    const s = open();
    s.append({ role: "user", text: "q1" });
    s.recall({ blocks: [block("memories", "- RECALL-A")] });
    const r = s.render();
    const tail = r.segments.at(-1)!;
    assert.deepEqual([tail.zone, tail.text, tail.cache], ["volatile", "- RECALL-A", undefined]);
    assert.ok(r.breakpoints.every((b) => b.segment < r.segments.length - 1));
  });
  it("it then lands in the conversation, at its anchor, and the cached prefix only ever grows (append-only)", () => {
    const s = open();
    s.append({ role: "user", text: "q1" });
    s.recall({ blocks: [block("memories", "- RECALL-A")] });
    const first = s.render();
    s.append({ role: "assistant", text: "a1" });
    s.append({ role: "user", text: "q2" });
    const second = s.render();
    const convo = second.segments.filter((x) => x.zone === "conversation");
    assert.deepEqual(convo.map((x) => [x.kind, x.text]), [["text", "q1"], ["context", "- RECALL-A"], ["text", "a1"], ["text", "q2"]]);
    assert.equal(second.segments.some((x) => x.zone === "volatile"), false, "no longer in the tail");
    // everything the first request had before its tail is a prefix of the second request's segments
    const stable = first.segments.filter((x) => x.zone !== "volatile").map((x) => ({ ...x, cache: undefined }));
    assert.deepEqual(second.segments.slice(0, stable.length).map((x) => ({ ...x, cache: undefined })), stable);
  });
  it("a tool-invoked recall is delivered as the tool_result and stays one in the conversation", () => {
    const s = open();
    s.append({ role: "user", text: "q" });
    s.append({ role: "assistant", kind: "tool_use", id: "t1", text: "{}" });
    s.recall({ blocks: [block("memories", "- R")] }, { delivery: "tool_result", toolUseId: "t1" });
    assert.deepEqual([s.render().segments.at(-1)!.kind, s.render().segments.at(-1)!.id], ["tool_result", "t1"]);
    s.append({ role: "assistant", text: "done" });
    const kinds = s.render().segments.filter((x) => x.zone === "conversation").map((x) => x.kind);
    assert.deepEqual(kinds, ["text", "tool_use", "tool_result", "text"]);
  });
  it("a second recall at the same point replaces the first (RULING: latest wins at an anchor)", () => {
    const s = open();
    s.append({ role: "user", text: "q" });
    s.recall({ blocks: [block("memories", "- OLD")] });
    s.recall({ blocks: [block("memories", "- NEW")] });
    assert.equal(s.render().segments.at(-1)!.text, "- NEW");
    s.append({ role: "assistant", text: "a" });
    assert.equal(s.render().segments.some((x) => x.text === "- OLD"), false);
  });
  it("L3 at recall time: the clip is reported once, when the recall arrives, not again on every render", () => {
    const seen: PromptEvent[] = [];
    const s = open((e) => seen.push(e));
    s.append({ role: "user", text: "q" });
    const ev = s.recall({ capChars: 4, blocks: [block("start", "S", false), block("memories", "0123456789")] });
    assert.equal(ev.length, 1);
    assert.equal(ev[0]!.type, "prompt.block-clipped");
    assert.deepEqual(seen, ev);
    s.render(); s.append({ role: "assistant", text: "a" }); s.render();
    assert.equal(seen.length, 1);
  });
  it("the tools, system and snapshot a session was opened with cannot be changed through the caller's arrays", () => {
    const t = [...tools], sys = [...system];
    const s = createPromptSession({ builder: createPromptBuilder(), agentId: "bernd", model: "claude-sonnet-5-5", tools: t, system: sys, memorySnapshot: memory });
    const a = s.render();
    t.push({ name: "late" }); sys.push("late rule");
    assert.deepEqual(s.render().prefixHashes, a.prefixHashes);
  });
});
