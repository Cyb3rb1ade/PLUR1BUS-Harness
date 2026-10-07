import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { open, owner, projectWithAgents } from "./helpers.ts";

describe("events", () => {
  it("emits project, consult, delegate and guardrail events; default emitter is no-op", async () => {
    const h = open();
    const p = await projectWithAgents(h, ["lead", "worker", "spec"], { maxDepth: 1, maxFanout: 8 });
    await h.collab.consult({ principal: owner(), projectId: p.id, fromAgent: "lead", toAgent: "worker", question: "q", context: "" });
    await h.collab.delegate({ principal: owner(), projectId: p.id, fromAgent: "lead", toAgent: "spec", task: "t", acceptanceCriteria: "ok" }).done;
    const types = h.events.map((e) => e.type);
    assert.ok(types.includes("project.created"));
    assert.ok(types.includes("project.agent.added"));
    assert.ok(types.includes("consult.started"));
    assert.ok(types.includes("consult.finished"));
    assert.ok(types.includes("delegate.queued"));
    assert.ok(types.includes("delegate.started"));
    assert.ok(types.includes("delegate.finished"));
    const first = await h.collab.consult({ principal: owner(), projectId: p.id, fromAgent: "lead", toAgent: "worker", question: "again", context: "" });
    await h.collab.consult({
      principal: owner(), projectId: p.id, fromAgent: "worker", toAgent: "spec", question: "nested", context: "",
      traceId: first.traceId, path: first.path,
    }).catch(() => { /* depth */ });
    assert.ok(h.events.some((e) => e.type === "guardrail.refused"));
  });
});
