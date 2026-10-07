import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeChatProvider } from "../../src/session/provider.ts";
import { isCode, member, open, owner, projectWithAgents, wait } from "./helpers.ts";

describe("M5 e2e (FakeChatProvider)", () => {
  it("project of three agents: consult chain, capped delegate, cycle/depth/width/budget, member deny, abort cleanup, redacted trace", async () => {
    const h = open();
    const p = await projectWithAgents(h, ["lead", "worker", "spec"], {
      maxDepth: 2, maxFanout: 3, maxPairPerTurn: 2, returnTokens: 8, repeatWindowMs: 0, tokenBudget: 50_000,
    });
    assert.deepEqual(p.agents, ["lead", "spec", "worker"]);

    const hop1 = await h.collab.consult({
      principal: owner(), projectId: p.id, fromAgent: "lead", toAgent: "worker",
      question: "plan SECRETVALUE", context: "ctx-only",
    });
    assert.equal(hop1.text.includes("echo[worker]"), true);
    assert.deepEqual(h.seen[0]!.messages.map((m) => m.text), ["plan SECRETVALUE\n\nctx-only"]);

    const hop2 = await h.collab.consult({
      principal: owner(), projectId: p.id, fromAgent: "worker", toAgent: "spec",
      question: "specialize", context: "from-worker", traceId: hop1.traceId, path: hop1.path,
    });
    assert.equal(hop2.traceId, hop1.traceId);
    assert.equal(hop2.provenance.agentId, "spec");

    await assert.rejects(
      h.collab.consult({
        principal: owner(), projectId: p.id, fromAgent: "spec", toAgent: "lead",
        question: "cycle", context: "", traceId: hop1.traceId, path: hop2.path,
      }),
      isCode("guardrail", "cycle"),
    );

    const capped = await h.collab.delegate({
      principal: owner(), projectId: p.id, fromAgent: "lead", toAgent: "worker",
      task: "BODY ".repeat(60), acceptanceCriteria: "short",
    }).done;
    assert.equal(capped.status, "succeeded");
    assert.equal(capped.truncated, true);
    assert.ok(capped.artifactPointer);

    const pFan = await projectWithAgents(h, ["lead", "w1", "w2", "w3", "w4"], { maxFanout: 2, maxPairPerTurn: 8, maxDepth: 1, repeatWindowMs: 0 });
    const f1 = await h.collab.consult({ principal: owner(), projectId: pFan.id, fromAgent: "lead", toAgent: "w1", question: "f1", context: "" });
    await h.collab.consult({ principal: owner(), projectId: pFan.id, fromAgent: "lead", toAgent: "w2", question: "f2", context: "", traceId: f1.traceId, path: ["lead"] });
    await assert.rejects(
      h.collab.consult({ principal: owner(), projectId: pFan.id, fromAgent: "lead", toAgent: "w3", question: "f3", context: "", traceId: f1.traceId, path: ["lead"] }),
      isCode("guardrail", "fanout"),
    );

    const pBud = await projectWithAgents(h, ["lead", "worker"], { tokenBudget: 2, repeatWindowMs: 0 });
    await assert.rejects(
      h.collab.consult({ principal: owner(), projectId: pBud.id, fromAgent: "lead", toAgent: "worker", question: "token-heavy question for the budget gate", context: "more" }),
      isCode("guardrail", "token-budget"),
    );

    h.collab.addMember(owner(), p.id, "u-member", "member");
    const outsider = member({ projectRights: { [p.id]: "member" }, agentRights: { lead: "use" } });
    await assert.rejects(
      h.collab.consult({ principal: outsider, projectId: p.id, fromAgent: "lead", toAgent: "worker", question: "nope", context: "" }),
      isCode("unauthorized"),
    );

    const trace = h.collab.getTrace(owner(), hop1.traceId);
    assert.ok(trace.spans.some((s) => s.kind === "consult" && s.agentId === "worker"));
    assert.ok(trace.spans.some((s) => s.kind === "consult" && s.agentId === "spec"));
    assert.ok(trace.spans.some((s) => s.kind === "guardrail" && s.guardrail === "cycle"));
    const dumped = h.collab.exportTrace(owner(), hop1.traceId);
    assert.equal(dumped.includes("SECRETVALUE"), false);
    assert.ok(trace.spans.every((s) => s.startedAt > 0));

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const provider = new FakeChatProvider({ gate: async () => { await gate; } });
    const h2 = open({ provider });
    const p2 = await projectWithAgents(h2, ["lead", "worker", "spec"], { maxFanout: 4, maxDepth: 2 });
    const ac = new AbortController();
    const d1 = h2.collab.delegate({
      principal: owner(), projectId: p2.id, fromAgent: "lead", toAgent: "worker",
      task: "one", acceptanceCriteria: "ok", signal: ac.signal,
    });
    await wait(15);
    const d2 = h2.collab.delegate({
      principal: owner(), projectId: p2.id, fromAgent: "lead", toAgent: "spec",
      task: "two", acceptanceCriteria: "ok", traceId: d1.task.traceId, signal: ac.signal,
    });
    await wait(15);
    ac.abort();
    release();
    const [x, y] = await Promise.all([d1.done, d2.done]);
    assert.equal(x.status, "cancelled");
    assert.equal(y.status, "cancelled");
  });
});
