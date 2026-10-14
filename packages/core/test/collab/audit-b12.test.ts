import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CollabStore } from "../../src/collab/store.ts";
import { createCollab } from "../../src/collab/service.ts";
import { isCode, member, open, owner, projectWithAgents, secretRedactor, wait } from "./helpers.ts";

const alice = { kind: "person" as const, id: "alice" };

describe("collab audit b12", () => {
  it("a live chain of project A cannot be joined from project B by passing its traceId", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const h = open({ runner: { run: async (i) => { if (i.question.startsWith("block")) await gate; return { text: "ok", inputTokens: 1, outputTokens: 1 }; } } });
    const a = await projectWithAgents(h, ["lead", "worker"]);
    const b = h.collab.createProject(owner(), { name: "other" });
    for (const id of ["lead", "worker"]) h.collab.addAgent(owner(), b.id, id);
    const handle = h.collab.delegate({ principal: owner(), projectId: a.id, fromAgent: "lead", toAgent: "worker", task: "block A", acceptanceCriteria: "x" });
    await wait(5);
    await assert.rejects(
      h.collab.consult({ principal: owner(), projectId: b.id, fromAgent: "lead", toAgent: "worker", question: "spy", context: "", traceId: handle.task.traceId }),
      isCode("not-found"),
    );
    assert.equal(h.collab.getTrace(owner(), handle.task.traceId).spans.length, 1, "foreign span must not land in A's trace");
    release();
    await handle.done;
  });

  it("getTask redacts task, acceptance criteria and error, not only the result", async () => {
    const h = open({ redact: secretRedactor(), runner: { run: async () => { throw new Error("boom SECRETVALUE"); } } });
    const p = await projectWithAgents(h, ["lead", "worker"]);
    const done = await h.collab.delegate({ principal: owner(), projectId: p.id, fromAgent: "lead", toAgent: "worker", task: "use SECRETVALUE", acceptanceCriteria: "never SECRETVALUE" }).done;
    assert.equal(done.status, "failed");
    const json = JSON.stringify(h.collab.getTask(owner(), done.id));
    assert.equal(json.includes("SECRETVALUE"), false);
  });

  it("a non-member sees nothing of a project: get, list, traces and tasks are refused the same way as for a missing project", async () => {
    const h = open();
    const p = await projectWithAgents(h, ["lead", "worker"]);
    const done = await h.collab.delegate({ principal: owner(), projectId: p.id, fromAgent: "lead", toAgent: "worker", task: "t", acceptanceCriteria: "x" }).done;
    const stranger = member({ userId: "u-stranger" });
    const codeOf = (fn: () => unknown): unknown => { try { fn(); return "none"; } catch (e) { return (e as { code?: string }).code; } };
    assert.equal(codeOf(() => h.collab.getProject(stranger, p.id)), "unauthorized");
    assert.equal(codeOf(() => h.collab.getProject(stranger, "prj_does-not-exist")), "unauthorized");
    assert.deepEqual(h.collab.listProjects(stranger), []);
    assert.equal(codeOf(() => h.collab.listTraces(stranger, p.id)), "unauthorized");
    assert.equal(codeOf(() => h.collab.getTask(stranger, done.id)), "unauthorized");
    assert.equal(codeOf(() => h.collab.getTrace(stranger, done.traceId)), "unauthorized");
    h.collab.addMember(owner(), p.id, "u-stranger", "member");
    assert.equal(h.collab.getProject(stranger, p.id).id, p.id);
    assert.equal(h.collab.listProjects(stranger).length, 1);
    assert.equal(h.collab.getTask(stranger, done.id).id, done.id);
    assert.equal(h.collab.listProjects(owner({ userId: "u-other-owner" })).length, 1, "privileged roles keep their overview");
  });

  it("a timeoutMs beyond the 32-bit timer range does not abort the chain at once", async () => {
    const h = open({ runner: { run: async (i) => { await wait(40); i.signal.throwIfAborted(); return { text: "ok", inputTokens: 1, outputTokens: 1 }; } } });
    const p = await projectWithAgents(h, ["lead", "worker"], { timeoutMs: 2 ** 31 + 10 });
    const ans = await h.collab.consult({ principal: owner(), projectId: p.id, fromAgent: "lead", toAgent: "worker", question: "slow", context: "" });
    assert.equal(ans.text, "ok");
  });

  it("the owner cannot be demoted from lead through addMember", () => {
    const s = new CollabStore({ path: ":memory:" });
    const p = s.createProject({ name: "p", owner: "alice" });
    assert.throws(() => s.addMember(p.id, "alice", "member"), isCode("conflict"));
    assert.deepEqual(s.getProject(p.id)!.members, [{ userId: "alice", role: "lead" }]);
    s.close();
  });

  it("project names are validated on create like on update (type and length)", () => {
    const s = new CollabStore({ path: ":memory:" });
    assert.throws(() => s.createProject({ name: "x".repeat(257), owner: "alice" }), isCode("invalid"));
    assert.throws(() => s.createProject({ name: 5 as unknown as string, owner: "alice" }), isCode("invalid"));
    s.close();
  });

  it("renaming an archived project reports the archived code like every other write", () => {
    const s = new CollabStore({ path: ":memory:" });
    const p = s.createProject({ name: "p", owner: "alice" });
    s.archiveProject(p.id);
    assert.throws(() => s.updateProject(p.id, "new"), isCode("archived"));
    s.close();
  });

  it("close is idempotent (shutdown followed by close must not throw)", async () => {
    const h = open();
    await h.collab.shutdown(10);
    assert.doesNotThrow(() => h.collab.close());
    const c = createCollab({ path: ":memory:" });
    c.close();
    assert.doesNotThrow(() => c.close());
  });

  it("removing a member or an agent releases their card assignments in the same transaction", () => {
    const s = new CollabStore({ path: ":memory:" });
    const p = s.createProject({ name: "p", owner: "alice" });
    s.addMember(p.id, "bob", "member");
    s.addAgent(p.id, "bot");
    const col = s.board.columns(p.id)[0]!.id;
    const card = s.board.createCard(p.id, { title: "t", columnId: col }, alice);
    s.board.assign(p.id, card.id, { kind: "person", id: "bob" }, true, alice);
    s.board.assign(p.id, card.id, { kind: "agent", id: "bot" }, true, alice);
    s.removeMember(p.id, "bob");
    s.removeAgent(p.id, "bot");
    assert.deepEqual(s.board.getCard(p.id, card.id).assignees, []);
    const kinds = s.board.activity(p.id, card.id, {}).items.map(a => a.kind);
    assert.equal(kinds.filter(k => k === "unassigned").length, 2);
    s.close();
  });
});
