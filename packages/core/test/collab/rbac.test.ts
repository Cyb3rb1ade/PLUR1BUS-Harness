import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isCode, member, open, owner, viewer } from "./helpers.ts";

describe("collab rights", () => {
  it("owner may create, a member without object rights may not", () => {
    const h = open();
    const p = h.collab.createProject(owner(), { name: "p" });
    assert.equal(p.owner, "u-owner");
    assert.throws(() => h.collab.createProject(member(), { name: "nope" }), isCode("unauthorized"));
    assert.throws(() => h.collab.createProject(viewer(), { name: "nope" }), isCode("unauthorized"));
  });

  it("member with project member + agent use may consult a shared agent; without agent use is refused", async () => {
    const h = open();
    const p = h.collab.createProject(owner(), { name: "p" });
    h.collab.addAgent(owner(), p.id, "shared");
    h.collab.addAgent(owner(), p.id, "private");
    h.collab.addMember(owner(), p.id, "u-member", "member");
    h.collab.addAgent(owner(), p.id, "helper");
    const ok = member({ projectRights: { [p.id]: "member" }, agentRights: { shared: "use", helper: "use" } });
    const ans = await h.collab.consult({ principal: ok, projectId: p.id, fromAgent: "shared", toAgent: "helper", question: "hi", context: "" });
    assert.equal(ans.provenance.agentId, "helper");
    const noUse = member({ projectRights: { [p.id]: "member" }, agentRights: { shared: "use" } });
    await assert.rejects(
      h.collab.consult({ principal: noUse, projectId: p.id, fromAgent: "shared", toAgent: "helper", question: "hi", context: "" }),
      isCode("unauthorized"),
    );
  });

  it("member without project lead cannot archive; lead can", () => {
    const h = open();
    const p = h.collab.createProject(owner(), { name: "p" });
    h.collab.addMember(owner(), p.id, "u-member", "member");
    assert.throws(
      () => h.collab.archiveProject(member({ projectRights: { [p.id]: "member" } }), p.id),
      isCode("unauthorized"),
    );
    const lead = member({ userId: "u-lead", projectRights: { [p.id]: "lead" } });
    h.collab.addMember(owner(), p.id, "u-lead", "lead");
    const archived = h.collab.archiveProject(lead, p.id);
    assert.ok(archived.archivedAt !== null);
  });

  it("viewer cannot consult even with object rights (role has no agent.use)", async () => {
    const h = open();
    const p = h.collab.createProject(owner(), { name: "p" });
    h.collab.addAgent(owner(), p.id, "a");
    h.collab.addAgent(owner(), p.id, "b");
    const v = viewer({ projectRights: { [p.id]: "lead" }, agentRights: { a: "manage", b: "manage" } });
    await assert.rejects(
      h.collab.consult({ principal: v, projectId: p.id, fromAgent: "a", toAgent: "b", question: "q", context: "" }),
      isCode("unauthorized"),
    );
  });
});
