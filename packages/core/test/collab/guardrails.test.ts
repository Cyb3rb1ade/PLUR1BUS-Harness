import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateGuardrails } from "../../src/collab/guardrails.ts";
import { DEFAULT_COLLAB_SETTINGS } from "../../src/collab/defaults.ts";
import { isCode, open, owner, projectWithAgents } from "./helpers.ts";
import type { GuardrailInput } from "../../src/collab/guardrails.ts";

function base(over: Partial<GuardrailInput> = {}): GuardrailInput {
  return {
    settings: DEFAULT_COLLAB_SETTINGS, fromAgent: "a", toAgent: "b", path: ["a"], fanout: 0, pairCount: 0,
    now: 1000, chainStartedAt: 0, lastRepeatAt: null, sameProject: true, tokensUsed: 0, nextTokens: 1, costUsed: 0, nextCost: 0,
    ...over,
  };
}

describe("guardrails (pure)", () => {
  it("refuses self-call, cycle, depth, fanout, pair, timeout, repeat, boundary, budgets", () => {
    assert.equal(evaluateGuardrails(base({ toAgent: "a" })), "self-call");
    assert.equal(evaluateGuardrails(base({ fromAgent: "b", path: ["a", "b"], toAgent: "a" })), "cycle");
    assert.equal(evaluateGuardrails(base({ path: ["a", "b"], toAgent: "c" })), "depth");
    assert.equal(evaluateGuardrails(base({ fanout: 3 })), "fanout");
    assert.equal(evaluateGuardrails(base({ pairCount: 2 })), "pair-limit");
    assert.equal(evaluateGuardrails(base({ now: 5 * 60 * 1000, chainStartedAt: 0 })), "timeout");
    assert.equal(evaluateGuardrails(base({ lastRepeatAt: 990, now: 1000 })), "repeat");
    assert.equal(evaluateGuardrails(base({ sameProject: false })), "project-boundary");
    assert.equal(evaluateGuardrails(base({ settings: { ...DEFAULT_COLLAB_SETTINGS, tokenBudget: 1 }, tokensUsed: 1, nextTokens: 1 })), "token-budget");
    assert.equal(evaluateGuardrails(base({ settings: { ...DEFAULT_COLLAB_SETTINGS, costBudget: 1 }, costUsed: 1, nextCost: 1 })), "cost-budget");
    assert.equal(evaluateGuardrails(base()), null);
  });
});

describe("guardrails (service)", () => {
  it("blocks a cycle A→B→A", async () => {
    const h = open();
    const p = await projectWithAgents(h, ["a", "b"], { maxDepth: 2 });
    const first = await h.collab.consult({ principal: owner(), projectId: p.id, fromAgent: "a", toAgent: "b", question: "q1", context: "" });
    await assert.rejects(
      h.collab.consult({
        principal: owner(), projectId: p.id, fromAgent: "b", toAgent: "a", question: "q2", context: "",
        traceId: first.traceId, path: first.path,
      }),
      isCode("guardrail", "cycle"),
    );
  });

  it("blocks a second hop when maxDepth is 1", async () => {
    const h = open();
    const p = await projectWithAgents(h);
    const first = await h.collab.consult({ principal: owner(), projectId: p.id, fromAgent: "lead", toAgent: "worker", question: "q1", context: "" });
    await assert.rejects(
      h.collab.consult({
        principal: owner(), projectId: p.id, fromAgent: "worker", toAgent: "spec", question: "q2", context: "",
        traceId: first.traceId, path: first.path,
      }),
      isCode("guardrail", "depth"),
    );
  });

  it("blocks fan-out beyond maxFanout", async () => {
    const h = open();
    const p = await projectWithAgents(h, ["lead", "a", "b", "c", "d"], { maxFanout: 2, maxPairPerTurn: 8 });
    const x = await h.collab.consult({ principal: owner(), projectId: p.id, fromAgent: "lead", toAgent: "a", question: "1", context: "" });
    await h.collab.consult({ principal: owner(), projectId: p.id, fromAgent: "lead", toAgent: "b", question: "2", context: "", traceId: x.traceId, path: ["lead"] });
    await assert.rejects(
      h.collab.consult({ principal: owner(), projectId: p.id, fromAgent: "lead", toAgent: "c", question: "3", context: "", traceId: x.traceId, path: ["lead"] }),
      isCode("guardrail", "fanout"),
    );
  });

  it("blocks the same question to the same agent inside the repeat window", async () => {
    const h = open();
    const p = await projectWithAgents(h, ["lead", "worker"], { repeatWindowMs: 60_000, maxFanout: 8, maxPairPerTurn: 8 });
    await h.collab.consult({ principal: owner(), projectId: p.id, fromAgent: "lead", toAgent: "worker", question: "same", context: "" });
    await assert.rejects(
      h.collab.consult({ principal: owner(), projectId: p.id, fromAgent: "lead", toAgent: "worker", question: "same", context: "" }),
      isCode("guardrail", "repeat"),
    );
  });

  it("blocks a target that is not in the project", async () => {
    const h = open();
    const p = await projectWithAgents(h, ["lead", "worker"]);
    h.collab.createProject(owner(), { name: "other" });
    // "spec" is known to the directory (active) but not assigned to this project
    await assert.rejects(
      h.collab.consult({ principal: owner(), projectId: p.id, fromAgent: "lead", toAgent: "spec", question: "q", context: "" }),
      isCode("guardrail", "project-boundary"),
    );
  });

  it("blocks when the chain token budget would be exceeded", async () => {
    const h = open();
    const p = await projectWithAgents(h, ["lead", "worker", "spec"], { tokenBudget: 1, maxFanout: 8, maxPairPerTurn: 8, repeatWindowMs: 0 });
    await assert.rejects(
      h.collab.consult({ principal: owner(), projectId: p.id, fromAgent: "lead", toAgent: "worker", question: "a long enough question to cost more than one token", context: "ctx" }),
      isCode("guardrail", "token-budget"),
    );
  });
});
