import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recommendTargets } from "../../../src/import/prompt/recommend.ts";
import type { ParsedEntry } from "../../../src/import/prompt/types.ts";

function fakeEntry(overrides: Partial<ParsedEntry>): ParsedEntry {
  return {
    category: "Identity",
    sourceType: "memory",
    text: "Sample text",
    warnings: [],
    idempotencyKey: "abc",
    ...overrides,
  };
}

describe("recommendTargets", () => {
  it("recommends user scope for Identity, Career, Preferences when user-binding is present", () => {
    const entries: ParsedEntry[] = [
      fakeEntry({ category: "Identity", text: "Alex, 34" }),
      fakeEntry({ category: "Career", text: "Software architect" }),
      fakeEntry({ category: "Preferences", text: "Prefers TypeScript" }),
    ];
    const targets = recommendTargets(entries, {
      availableAgents: ["bernd"],
      hasUserBinding: true,
    });
    assert.deepEqual(
      targets.map((t) => t.target),
      ["user", "user", "user"],
    );
  });

  it("skips Identity, Career, Preferences when user-binding is absent", () => {
    const entries: ParsedEntry[] = [
      fakeEntry({ category: "Identity", text: "Alex, 34" }),
      fakeEntry({ category: "Career", text: "Software architect" }),
      fakeEntry({ category: "Preferences", text: "Prefers TypeScript" }),
    ];
    const targets = recommendTargets(entries, {
      availableAgents: ["bernd"],
      hasUserBinding: false,
    });
    for (const t of targets) {
      assert.equal(t.target, "skip");
      assert.equal(t.reason, "requires-user-binding");
    }
  });

  it("skips Instructions category and instruction-like patterns under Preferences (B7, M6)", () => {
    const entries: ParsedEntry[] = [
      fakeEntry({ category: "Instructions", text: "Always answer concisely." }),
      fakeEntry({ category: "Preferences", text: "Always reply in German with code." }),
    ];
    const targets = recommendTargets(entries, {
      availableAgents: ["bernd", "karl"],
      currentAgentId: "karl",
      hasUserBinding: true,
    });
    assert.equal(targets[0]!.target, "skip");
    assert.equal(targets[0]!.reason, "instructions-not-imported");
    assert.equal(targets[1]!.target, "skip");
    assert.equal(targets[1]!.reason, "instructions-not-imported");
  });

  it("recommends agent scope for Projects using currentAgentId or first available agent", () => {
    const entries: ParsedEntry[] = [fakeEntry({ category: "Projects" })];
    const targets1 = recommendTargets(entries, {
      availableAgents: ["bernd"],
      currentAgentId: "bernd",
      hasUserBinding: true,
    });
    assert.equal(targets1[0]!.target, "agent");
    assert.deepEqual(targets1[0]!.agentIds, ["bernd"]);

    const targets2 = recommendTargets(entries, {
      availableAgents: ["agentX", "agentY"],
      hasUserBinding: true,
    });
    assert.equal(targets2[0]!.target, "agent");
    assert.deepEqual(targets2[0]!.agentIds, ["agentX"]);
  });

  it("recommends skip for Other category", () => {
    const entries: ParsedEntry[] = [fakeEntry({ category: "Other" })];
    const targets = recommendTargets(entries, {
      availableAgents: ["bernd"],
      hasUserBinding: true,
    });
    assert.equal(targets[0]!.target, "skip");
  });

  it("recommends skip for entries with secret-redacted warning", () => {
    const entries: ParsedEntry[] = [
      fakeEntry({ category: "Identity", warnings: ["secret-redacted"] }),
      fakeEntry({ category: "Instructions", warnings: ["secret-redacted"] }),
    ];
    const targets = recommendTargets(entries, {
      availableAgents: ["bernd"],
      hasUserBinding: true,
    });
    assert.equal(targets[0]!.target, "skip");
    assert.equal(targets[1]!.target, "skip");
    assert.equal(targets[0]!.reason, "secret-redacted");
  });
});
