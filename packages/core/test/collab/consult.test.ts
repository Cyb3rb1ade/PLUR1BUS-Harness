import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeChatProvider } from "../../src/session/provider.ts";
import { isCode, open, owner, projectWithAgents } from "./helpers.ts";

describe("consult", () => {
  it("returns a structured answer with provenance; the callee sees only the passed context", async () => {
    const h = open();
    const p = await projectWithAgents(h);
    const ans = await h.collab.consult({
      principal: owner(), projectId: p.id, fromAgent: "lead", toAgent: "worker",
      question: "how?", context: "only this",
    });
    assert.equal(ans.kind, "consult.answer");
    assert.equal(ans.text, "echo[worker]: how?\n\nonly this");
    assert.equal(ans.provenance.agentId, "worker");
    assert.equal(ans.provenance.projectId, p.id);
    assert.equal(ans.provenance.targetKind, "local");
    assert.match(ans.traceId, /^[0-9a-f]{32}$/);
    assert.match(ans.provenance.spanId, /^[0-9a-f]{16}$/);
    assert.equal(h.seen.length, 1);
    assert.deepEqual(h.seen[0]!.messages, [{ role: "user", text: "how?\n\nonly this" }]);
    assert.deepEqual(h.seen[0]!.summaries, []);
    assert.equal(h.seen[0]!.memory, "");
    assert.equal(h.seen[0]!.agentId, "worker");
  });

  it("abort during consult throws aborted", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const provider = new FakeChatProvider({ gate: async () => { await gate; } });
    const h = open({ provider });
    const p = await projectWithAgents(h);
    const ac = new AbortController();
    const pending = h.collab.consult({
      principal: owner(), projectId: p.id, fromAgent: "lead", toAgent: "worker",
      question: "wait", context: "", signal: ac.signal,
    });
    ac.abort();
    release();
    await assert.rejects(pending, isCode("aborted"));
  });
});
