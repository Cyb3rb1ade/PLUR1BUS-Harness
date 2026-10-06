import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPromptBuilder } from "../../src/prompt/builder.ts";
import { corpusInput, memory, system, tools } from "../fixtures/prompt-corpus.ts";

describe("prefix stability (ADR-010 §1, R3, R5)", () => {
  it("a change only in the conversation zone leaves tools/system/memory zone hashes and prefix hashes unchanged", () => {
    const b = createPromptBuilder();
    const a = b.render(corpusInput(3));
    const c = b.render(corpusInput(4));
    assert.notEqual(a.zoneHashes.conversation, c.zoneHashes.conversation);
    for (const z of ["tools", "system", "memory"] as const) {
      assert.equal(a.zoneHashes[z], c.zoneHashes[z], z);
      assert.equal(a.prefixHashes[z], c.prefixHashes[z], z);
    }
    assert.deepEqual(c.prefix, { status: "warm" });
  });
  it("a volatile recall block never moves any stable hash", () => {
    const b = createPromptBuilder();
    const a = b.render(corpusInput(2));
    const c = b.render(corpusInput(2, { volatile: { blocks: [{ name: "memories", text: "- new fact", droppable: true, chars: 10 }] } }));
    assert.equal(a.prefixHashes.memory, c.prefixHashes.memory);
    assert.notEqual(a.zoneHashes.volatile, c.zoneHashes.volatile);
  });
  it("each stable zone change moves its own hash and every later prefix hash, and nothing earlier", () => {
    const b = createPromptBuilder();
    const base = b.render(corpusInput(1));
    const memChanged = b.render(corpusInput(1, { memory: memory + "\nFact new" }));
    assert.equal(memChanged.prefixHashes.tools, base.prefixHashes.tools);
    assert.equal(memChanged.prefixHashes.system, base.prefixHashes.system);
    assert.notEqual(memChanged.prefixHashes.memory, base.prefixHashes.memory);
    assert.deepEqual(memChanged.prefix, { status: "invalidated", changedFrom: "memory" });
    const sysChanged = b.render(corpusInput(1, { system: [...system, "one more rule"] }));
    assert.notEqual(sysChanged.prefixHashes.system, memChanged.prefixHashes.system);
    assert.equal(sysChanged.zoneHashes.tools, base.zoneHashes.tools);
    assert.equal(sysChanged.prefix.changedFrom, "system");
    const toolChanged = b.render(corpusInput(1, { tools: [...tools, { name: "extra" }] }));
    assert.equal(toolChanged.prefix.changedFrom, "tools");
    // The provider's cache keys on the whole prefix: system and memory text are identical, their prefix hashes are not.
    assert.equal(toolChanged.zoneHashes.system, base.zoneHashes.system);
    assert.equal(toolChanged.zoneHashes.memory, base.zoneHashes.memory);
    assert.notEqual(toolChanged.prefixHashes.system, base.prefixHashes.system);
    assert.notEqual(toolChanged.prefixHashes.memory, base.prefixHashes.memory);
    assert.ok(toolChanged.events.some((e) => e.type === "prompt.prefix-invalidated" && e.from === "tools"));
  });
  it("tool registration order and object key order do not matter; case, unicode form and line endings are normalised", () => {
    const b = createPromptBuilder();
    const a = b.render(corpusInput(1));
    const shuffled = [...tools].reverse().map((t) => Object.fromEntries(Object.entries(t).reverse()));
    const c = b.render(corpusInput(1, { tools: shuffled as never, system: system.map((s) => s.replace(/\n/g, "\r\n")), memory: memory.normalize("NFD") }));
    assert.deepEqual(c.prefixHashes, a.prefixHashes);
  });
  it("R5: one prefix per (agent, model): a model switch is cold for the new model and leaves the other's warm state alone", () => {
    const b = createPromptBuilder();
    assert.equal(b.render(corpusInput(1)).prefix.status, "cold");
    const other = b.render(corpusInput(1, { model: "claude-opus-4-5" }));
    assert.equal(other.prefix.status, "cold");
    assert.notEqual(other.prefixKey, b.render(corpusInput(1)).prefixKey);
    assert.equal(b.render(corpusInput(2)).prefix.status, "warm", "the first model's prefix survived the switch");
    assert.equal(b.render(corpusInput(1, { agentId: "other" })).prefix.status, "cold");
  });
  it("duplicate tool names are refused", () => {
    assert.throws(() => createPromptBuilder().render(corpusInput(1, { tools: [{ name: "a" }, { name: "a" }] })), /duplicate tool/);
  });
});
