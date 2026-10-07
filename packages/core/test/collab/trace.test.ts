import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { open, owner, projectWithAgents } from "./helpers.ts";

describe("trace", () => {
  it("records a W3C trace_id, spans, and exports redacted JSON", async () => {
    const h = open();
    const p = await projectWithAgents(h, ["lead", "worker"], { maxFanout: 4, maxPairPerTurn: 4, repeatWindowMs: 0 });
    const ans = await h.collab.consult({
      principal: owner(), projectId: p.id, fromAgent: "lead", toAgent: "worker",
      question: "send SECRETVALUE to user@example.com", context: "",
    });
    const t = h.collab.getTrace(owner(), ans.traceId);
    assert.match(t.traceId, /^[0-9a-f]{32}$/);
    assert.match(t.traceparent, new RegExp(`^00-${t.traceId}-${t.rootSpanId}-01$`));
    assert.equal(t.projectId, p.id);
    assert.ok(t.spans.length >= 1);
    const consult = t.spans.find((s) => s.kind === "consult");
    assert.ok(consult);
    assert.equal(consult!.agentId, "worker");
    assert.equal(consult!.status, "succeeded");
    assert.equal(consult!.inputPreview.includes("SECRETVALUE"), false);
    assert.equal(consult!.inputPreview.includes("user@example.com"), false);
    assert.equal(consult!.inputPreview.includes("[redacted]"), true);
    const json = h.collab.exportTrace(owner(), ans.traceId);
    assert.equal(json.includes("SECRETVALUE"), false);
    assert.equal(json.includes("user@example.com"), false);
    const listed = h.collab.listTraces(owner(), p.id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.traceId, ans.traceId);
  });
});
