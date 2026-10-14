import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPromptBuilder } from "../../src/prompt/builder.ts";
import { createPromptSession } from "../../src/prompt/session.ts";
import { corpusInput } from "../fixtures/prompt-corpus.ts";

const NFC = "é"; // é, sorts after "f" in UTF-8 bytes
const NFD = "é"; // sorts before "f"

describe("b09: tool zone determinism over Unicode-equivalent names", () => {
  const tool = (name: string) => ({ name, description: "d" });
  it("NFC and NFD spellings of the same tool names render byte-identical segments and hashes", () => {
    const a = createPromptBuilder().render(corpusInput(0, { tools: [tool(NFC), tool("f")] }));
    const b = createPromptBuilder().render(corpusInput(0, { tools: [tool(NFD), tool("f")] }));
    assert.deepEqual(a.segments.filter((s) => s.zone === "tools").map((s) => s.text), b.segments.filter((s) => s.zone === "tools").map((s) => s.text));
    assert.equal(a.zoneHashes.tools, b.zoneHashes.tools);
  });
  it("names that collide after NFC normalisation are duplicates", () => {
    assert.throws(() => createPromptBuilder().render(corpusInput(0, { tools: [tool(NFC), tool(NFD)] })), /duplicate tool name/);
  });
});

describe("b09: conversation roles cannot be confused", () => {
  const render = (item: { role: "user" | "assistant"; kind: "tool_use" | "tool_result" | "context"; text: string; id?: string }) =>
    () => createPromptBuilder().render(corpusInput(0, { conversation: [item] }));
  it("a tool_result or context item cannot claim the assistant role; a tool_use cannot claim the user role", () => {
    assert.throws(render({ role: "assistant", kind: "tool_result", id: "t1", text: "x" }), /tool_result.*user/);
    assert.throws(render({ role: "assistant", kind: "context", text: "x" }), /context.*user/);
    assert.throws(render({ role: "user", kind: "tool_use", id: "t1", text: "x" }), /tool_use.*assistant/);
  });
  it("the session refuses such an item at append, so one bad item cannot brick every later render", () => {
    const s = createPromptSession({ builder: createPromptBuilder(), agentId: "a", model: "claude-sonnet-5-5", tools: [], system: ["s"], memorySnapshot: "" });
    assert.throws(() => s.append({ role: "assistant", kind: "tool_result", id: "t1", text: "x" }), TypeError);
    assert.throws(() => s.append({ role: "user", kind: "tool_result", text: "no id" }), /needs an id/);
    s.append({ role: "user", text: "ok" });
    assert.equal(s.render().segments.filter((x) => x.zone === "conversation").length, 1);
  });
  it("valid shapes still render", () => {
    const r = createPromptBuilder().render(corpusInput(0, { conversation: [
      { role: "assistant", kind: "tool_use", id: "t1", text: "{}" }, { role: "user", kind: "tool_result", id: "t1", text: "ok" }, { role: "user", kind: "context", text: "c" } ] }));
    assert.equal(r.segments.filter((x) => x.zone === "conversation").length, 3);
  });
});

describe("b09: caps are validated, never silently disabled", () => {
  it("a NaN, negative or non-numeric memory cap is refused instead of leaving the snapshot unbounded", () => {
    for (const cap of [NaN, -1, Number.NEGATIVE_INFINITY]) {
      assert.throws(() => createPromptBuilder().render(corpusInput(0, { zoneCaps: { memory: cap } })), TypeError, String(cap));
    }
  });
  it("a NaN or negative volatile capChars is refused; Infinity (uncapped) stays valid", () => {
    const blocks = [{ name: "m", text: "abc", droppable: true, chars: 3 }];
    for (const capChars of [NaN, -5]) {
      assert.throws(() => createPromptBuilder().render(corpusInput(0, { volatile: { blocks, capChars } })), TypeError, String(capChars));
    }
    assert.doesNotThrow(() => createPromptBuilder().render(corpusInput(0, { volatile: { blocks, capChars: Infinity } })));
    assert.doesNotThrow(() => createPromptBuilder().render(corpusInput(0, { zoneCaps: { memory: Infinity } })));
  });
});
