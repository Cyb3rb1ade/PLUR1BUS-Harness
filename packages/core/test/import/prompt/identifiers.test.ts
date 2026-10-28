/** Import identifiers must survive bounded provenance and distinguish every destination without leaking entry text. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPromptIdempotencyKey, createPromptSourceRef } from "../../../src/import/prompt/identifiers.ts";

describe("createPromptSourceRef", () => {
  const input = {
    provider: "chatgpt", category: "preferences" as const, index: 2,
    originalDate: "2026-10", source: "memory" as const, runId: "run-123",
  };

  it("preserves the original date and source alongside the caller's run identifier", () => {
    assert.equal(createPromptSourceRef(input),
      "prompt:chatgpt:preferences#2;date=2026-10;src=memory;run=run-123");
    assert.equal(createPromptSourceRef({ ...input, originalDate: "unbekannt", source: "chat" }),
      "prompt:chatgpt:preferences#2;date=unbekannt;src=chat;run=run-123");
  });

  it("bounds long provider metadata while preserving the entire rollback selector", () => {
    const ref = createPromptSourceRef({ ...input, provider: "a".repeat(900), runId: "r".repeat(120) });
    assert.equal(ref.length, 500);
    assert.ok(ref.startsWith("prompt:"));
    assert.ok(ref.endsWith(`:preferences#2;date=2026-10;src=memory;run=${"r".repeat(120)}`));
  });

  it("escapes delimiter-bearing metadata so a provider cannot inject another run", () => {
    const ref = createPromptSourceRef({ ...input, provider: "other;run=wrong", originalDate: "unknown;src=chat" });
    assert.equal(ref,
      "prompt:other%3Brun%3Dwrong:preferences#2;date=unknown%3Bsrc%3Dchat;src=memory;run=run-123");
    assert.equal(ref.split(";run=").length, 2);
  });

  it("refuses impossible metadata and malformed run selectors without including their values", () => {
    for (const runId of ["", "bad;run=another", "bad\nvalue", "r".repeat(500)]) {
      assert.throws(() => createPromptSourceRef({ ...input, runId }), (error: unknown) => {
        assert.ok(error instanceof RangeError);
        if (runId) assert.ok(!error.message.includes(runId));
        return true;
      });
    }
    for (const index of [-1, 0, 1.5, Infinity]) {
      assert.throws(() => createPromptSourceRef({ ...input, index }), RangeError);
    }
    assert.throws(() => createPromptSourceRef({ ...input, originalDate: "x".repeat(500) }), RangeError);
    assert.throws(() => createPromptSourceRef({ ...input, provider: "\ud800" }), RangeError);
  });
});

describe("createPromptIdempotencyKey", () => {
  const input = {
    provider: "claude", category: "projects" as const, target: "agent-private:agent-1", text: "Café plans",
  };

  it("hashes an unambiguous tuple with normalized text, independent of formatting and import runs", () => {
    // SHA-256 of ["claude","projects","agent-private:agent-1","Café plans"], checked independently.
    const expected = "a4847848db99b6f7a84f9888137c615542aaf349c4cdb9670c29aad45978fc07";
    assert.equal(createPromptIdempotencyKey(input), expected);
    assert.equal(createPromptIdempotencyKey({ ...input, text: " Cafe\u0301\t\nplans " }), expected);
    assert.match(createPromptIdempotencyKey(input), /^[a-f0-9]{64}$/);
    assert.ok(!createPromptIdempotencyKey(input).includes(input.text));
  });

  it("distinguishes provider, category, target, case, and text", () => {
    const original = createPromptIdempotencyKey(input);
    for (const changed of [
      { provider: "gemini" }, { category: "other" as const }, { target: "agent-private:agent-2" },
      { target: "user:person-1" }, { text: "café plans" }, { text: "Café plans!" },
    ]) {
      assert.notEqual(createPromptIdempotencyKey({ ...input, ...changed }), original);
    }
  });

  it("cannot collide just by moving separators between tuple fields", () => {
    assert.notEqual(
      createPromptIdempotencyKey({ ...input, provider: "a|b", target: "c" }),
      createPromptIdempotencyKey({ ...input, provider: "a", target: "b|c" }),
    );
  });
});
