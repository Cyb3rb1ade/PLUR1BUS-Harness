import { test } from "node:test";
import assert from "node:assert/strict";
import { createCollab } from "../../src/collab/service.ts";
import { buildProjectBoardSurface, deliverBoardChange } from "../../src/rpc/project-board-surface.ts";
import { guardMethods, RPC_RULES } from "../../src/rbac/guard.ts";
import type { Principal } from "../../src/rbac/types.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { validateResult } from "@plur1bus/rpc-schema";
import { RpcError } from "../../src/rpc/errors.ts";

const isCode = (code: string) => (e: unknown) => e instanceof RpcError && e.error === code;
function fixture() {
  const service = createCollab({ path: ":memory:" });
  const owner: Principal = { userId: "alice", role: "owner", kind: "person" };
  const project = service.createProject(owner, { name: "Board" });
  service.addMember(owner, project.id, "bob", "member"); service.addAgent(owner, project.id, "agent1");
  let principal: Principal | null = owner;
  const events: { method: string; params: any }[] = [];
  const raw = buildProjectBoardSurface(() => service, e => { events.push(e); });
  const methods = guardMethods(raw, { resolve: () => principal, audit: memoryAuditSink(), now: () => 1000 });
  const call = async (method: string, params: any = {}) => { const result = await methods[method]!({ projectId: project.id, ...params }, { signal: new AbortController().signal, requestId: "1", connectionId: "test" }); assert.deepEqual(validateResult(method, result), { ok: true }, method); return result; };
  return { service, project, events, raw, call, as: (p: Principal | null) => { principal = p; } };
}
test("every board method: guard fails closed for missing/unknown identity, empty scopes, viewer writes and unassigned agents", async () => {
  const f = fixture();
  try {
    for (const method of Object.keys(f.raw)) {
      assert.ok(RPC_RULES[method], method);
      for (const p of [null, { userId: "x", kind: "person", role: "unknown" }, { userId: "alice", kind: "person", role: "owner", tokenScopes: [] }] as (Principal | null)[]) {
        f.as(p); await assert.rejects(f.call(method), isCode(p === null ? "E_UNAUTHORIZED" : "E_DENIED"));
      }
      f.as({ userId: "alice", kind: "person", role: "viewer" });
      if (!method.endsWith(".list") && !method.endsWith(".get")) await assert.rejects(f.call(method), isCode("E_DENIED"));
      f.as({ userId: "outsider", kind: "agent", role: "owner", projectRights: { [f.project.id]: "lead" } });
      await assert.rejects(f.call(method), isCode("E_DENIED"));
      await assert.rejects(f.raw[method]!({ projectId: f.project.id }, { signal: new AbortController().signal, requestId: "raw", connectionId: "raw" }), isCode("E_UNAUTHORIZED"));
    }
  } finally { f.service.close(); }
});
test("all methods succeed with stored rights, emit changes only after commit, WIP override needs manage", async () => {
  const f = fixture();
  try {
    const [backlog, work] = (await f.call("project.column.list") as any).columns;
    const custom = await f.call("project.column.create", { title: "Custom" }) as any;
    await f.call("project.column.update", { columnId: custom.id, title: "New", wipLimit: 3 });
    await f.call("project.column.move", { columnId: custom.id, position: 1 });
    const card = await f.call("project.card.create", { columnId: backlog.id, title: "Task", description: "<script>literal</script>" }) as any;
    await f.call("project.card.update", { cardId: card.id, title: "Changed", labels: ["bug"], links: [{ kind: "session", id: "session1" }, { kind: "job", id: "job1" }, { kind: "media", id: "media1" }, { kind: "url", id: "javascript:literal" }] });
    await f.call("project.card.assign", { cardId: card.id, assignee: { kind: "agent", id: "agent1" } });
    await f.call("project.card.assign", { cardId: card.id, assignee: { kind: "person", id: "bob" } });
    await f.call("project.card.unassign", { cardId: card.id, assignee: { kind: "person", id: "bob" } });
    await f.call("project.card.move", { cardId: card.id, columnId: work.id, position: 0 });
    const comment = await f.call("project.card.comment.add", { cardId: card.id, text: "Markdown **text**" }) as any;
    assert.equal((await f.call("project.card.comment.list", { cardId: card.id }) as any).items[0].id, comment.id);
    assert.ok((await f.call("project.card.activity.list", { cardId: card.id }) as any).items.some((a: any) => a.kind === "assigned"));
    await f.call("project.card.archive", { cardId: card.id }); await f.call("project.card.unarchive", { cardId: card.id });
    assert.equal((await f.call("project.card.get", { cardId: card.id }) as any).description, "<script>literal</script>");
    assert.equal((await f.call("project.card.list", { label: "bug", text: "Changed" }) as any).cards.length, 1);
    await f.call("project.column.delete", { columnId: custom.id });
    await f.call("project.column.update", { columnId: work.id, wipLimit: 1 });
    const second = await f.call("project.card.create", { title: "Other", columnId: backlog.id }) as any;
    const count = f.events.length;
    await assert.rejects(f.call("project.card.move", { cardId: second.id, columnId: work.id, position: 0 }), isCode("E_PROJECT_WIP_LIMIT"));
    assert.equal(f.events.length, count);
    f.as({ userId: "bob", kind: "person", role: "member", projectRights: { [f.project.id]: "lead" } });
    await assert.rejects(f.call("project.column.create", { title: "Spoof" }), isCode("E_DENIED"));
    await assert.rejects(f.call("project.card.move", { cardId: second.id, columnId: work.id, position: 0, overrideWip: true }), isCode("E_DENIED"));
    f.as({ userId: "alice", kind: "person", role: "owner" });
    await f.call("project.card.move", { cardId: second.id, columnId: work.id, position: 0, overrideWip: true });
    assert.ok(f.events.some(e => e.method === "project.column.changed")); assert.ok(f.events.some(e => e.method === "project.card.changed"));
    await assert.rejects(f.call("project.card.get", { cardId: "absent" }), isCode("E_NOT_FOUND"));
    await assert.rejects(f.call("project.card.create", { title: "", columnId: work.id, overrideWip: true }), isCode("E_INVALID_PARAMS"));
  } finally { f.service.close(); }
});
test("project agents can read, comment and move only cards assigned to their trusted id; removal immediately revokes", async () => {
  const f = fixture();
  try {
    const [a, b] = (await f.call("project.column.list") as any).columns;
    const card = await f.call("project.card.create", { title: "Agent task", columnId: a.id }) as any;
    f.as({ userId: "agent1", role: "owner", kind: "agent" });
    await f.call("project.card.get", { cardId: card.id });
    await f.call("project.card.comment.add", { cardId: card.id, text: "Read it" });
    await assert.rejects(f.call("project.card.move", { cardId: card.id, columnId: b.id, position: 0 }), isCode("E_DENIED"));
    f.as({ userId: "alice", role: "owner", kind: "person" });
    await f.call("project.card.assign", { cardId: card.id, assignee: { kind: "agent", id: "agent1" } });
    f.as({ userId: "agent1", role: "owner", kind: "agent" });
    await f.call("project.card.move", { cardId: card.id, columnId: b.id, position: 0 });
    for (const m of ["project.card.assign", "project.card.unassign", "project.card.update", "project.card.archive", "project.card.unarchive", "project.card.create", "project.column.create", "project.column.update", "project.column.move", "project.column.delete"]) await assert.rejects(f.call(m, { cardId: card.id, columnId: b.id, title: "x" }), isCode("E_DENIED"));
    await assert.rejects(f.call("project.card.move", { cardId: card.id, columnId: a.id, overrideWip: true }), isCode("E_DENIED"));
    f.service.removeAgent({ userId: "alice", role: "owner", kind: "person" }, f.project.id, "agent1");
    await assert.rejects(f.call("project.card.get", { cardId: card.id }), isCode("E_DENIED"));
  } finally { f.service.close(); }
});
test("events use live project read rights, narrow scopes and fail closed on resolver errors", async () => {
  const f = fixture();
  try {
    const sent: any[] = [];
    const principals: Record<string, Principal> = {
      bob: { userId: "bob", kind: "person", role: "member" },
      outside: { userId: "outside", kind: "person", role: "member" },
      agent: { userId: "agent1", kind: "agent", role: "member" },
      scoped: { userId: "alice", kind: "person", role: "owner", tokenScopes: [] },
    };
    await deliverBoardChange({ method: "project.card.changed", params: { projectId: f.project.id, cardId: "card", change: "updated" } }, () => f.service, {
      subscriptions: () => [...Object.keys(principals), "broken"].map(connectionId => ({ connectionId })),
      resolve: async id => { if (id === "broken") throw Error("resolver"); return principals[id]; },
      notify: (_m, _p, options) => { sent.push(options); },
    });
    assert.deepEqual(sent[0].audience.sort(), ["agent", "bob"]);
  } finally { f.service.close(); }
});
test("cross-project object ids are denied/not found, and stored leads plus action scopes are required", async () => {
  const f = fixture();
  try {
    const owner: Principal = { userId: "alice", kind: "person", role: "owner" };
    const other = f.service.createProject(owner, { name: "Other" });
    const foreignColumn = f.service.boardStore.columns(other.id)[0]!;
    const foreignCard = f.service.boardStore.createCard(other.id, { title: "Foreign", columnId: foreignColumn.id }, { kind: "person", id: "alice" });
    const columnId = f.service.boardStore.columns(f.project.id)[0]!.id;
    const card = await f.call("project.card.create", { title: "Own", columnId }) as any;
    for (const m of ["project.card.get", "project.card.update", "project.card.assign", "project.card.unassign", "project.card.move", "project.card.archive", "project.card.unarchive", "project.card.comment.add", "project.card.comment.list", "project.card.activity.list"]) await assert.rejects(f.call(m, { cardId: foreignCard.id, columnId, assignee: { kind: "person", id: "bob" }, text: "x" }), isCode("E_NOT_FOUND"));
    for (const m of ["project.column.update", "project.column.move", "project.column.delete"]) await assert.rejects(f.call(m, { columnId: foreignColumn.id, position: 0 }), isCode("E_NOT_FOUND"));
    await assert.rejects(f.call("project.card.move", { cardId: card.id, columnId: foreignColumn.id }), isCode("E_NOT_FOUND"));
    for (const kind of [undefined, "person"] as const) {
      f.as({ userId: "outsider", role: "member", ...(kind ? { kind } : {}), projectRights: { [f.project.id]: "lead" } });
      for (const m of Object.keys(f.raw)) await assert.rejects(f.call(m, { cardId: card.id, columnId }), isCode("E_DENIED"));
    }
    f.service.addMember(owner, f.project.id, "bob", "lead");
    f.as({ userId: "bob", kind: "person", role: "member", tokenScopes: ["project.board.manage"] });
    await f.call("project.column.create", { titleKey: "custom.key" });
    await assert.rejects(f.call("project.card.get", { cardId: card.id }), isCode("E_DENIED"));
    f.as({ userId: "bob", kind: "person", role: "member", tokenScopes: ["project.board.move"] });
    await f.call("project.card.move", { cardId: card.id, columnId, position: 0 });
    await assert.rejects(f.call("project.card.move", { cardId: card.id, columnId, position: 0, overrideWip: true }), isCode("E_DENIED"));
    f.as(owner); f.service.archiveProject(owner, f.project.id);
    await assert.rejects(f.call("project.card.comment.add", { cardId: card.id, text: "Archived" }), isCode("E_CONFLICT"));
    await f.call("project.card.get", { cardId: card.id });
  } finally { f.service.close(); }
});
