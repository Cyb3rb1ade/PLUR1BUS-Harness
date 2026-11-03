/** Q13/Q14: use the actual D115 board and its pagination; only an unambiguous assigned card supplies a root. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCollab } from "../../src/collab/service.ts";
import { SessionStore } from "../../src/session/store.ts";
import { rewindProjectContext } from "../../src/session/rewind-project.ts";

test("a linked card must assign the session agent and a second active binding refuses rewind", t => {
  const collab = createCollab({ path: ":memory:" });
  const store = new SessionStore({ path: ":memory:" });
  t.after(() => { collab.close(); store.close(); });
  const owner = { kind: "person", role: "owner", userId: "owner" } as const;
  const project = collab.createProject(owner, { name: "Coding" });
  collab.addAgent(owner, project.id, "worker");
  const session = store.createSession({ kind: "card", agentId: "worker", owner: owner.userId });
  const actor = { kind: "person", id: owner.userId } as const;
  const create = () => collab.boardStore.createCard(project.id, { title: "Task", columnId: collab.boardStore.columns(project.id)[0]!.id,
    links: [{ kind: "session", id: session.id }] }, actor);
  const context = () => rewindProjectContext(session, owner, collab, { root: () => "/shared/worktree" });
  const card = create();
  assert.equal(context(), null, "a link without an agent assignment conveys no worktree authority");
  collab.boardStore.assign(project.id, card.id, { kind: "agent", id: "worker" }, true, actor);
  assert.deepEqual(context(), { projectId: project.id, cardId: card.id, root: "/shared/worktree" });
  const second = create();
  collab.boardStore.assign(project.id, second.id, { kind: "agent", id: "worker" }, true, actor);
  assert.equal(context(), null, "ambiguous links cannot select a destructive restore target");
  collab.boardStore.archiveCard(project.id, second.id, true, actor);
  assert.equal(context()?.cardId, card.id, "an archived binding no longer competes with the active card");
  collab.removeAgent(owner, project.id, "worker");
  assert.equal(context(), null, "removing project membership revokes the binding");
  assert.equal(rewindProjectContext(session, { ...owner, kind: "agent" }, collab, { root: () => "/shared/worktree" }), null);
});

test("a D115 binding beyond the first board page is still resolved", t => {
  let nextId = 0;
  const collab = createCollab({ path: ":memory:", newId: prefix => `${prefix}_${String(++nextId).padStart(6, "0")}` });
  const store = new SessionStore({ path: ":memory:" });
  t.after(() => { collab.close(); store.close(); });
  const owner = { kind: "person", role: "owner", userId: "owner" } as const;
  const project = collab.createProject(owner, { name: "Large coding project" });
  collab.addAgent(owner, project.id, "worker");
  const session = store.createSession({ kind: "card", agentId: "worker", owner: owner.userId });
  const actor = { kind: "person", id: owner.userId } as const;
  const columnId = collab.boardStore.columns(project.id)[0]!.id;
  for (let index = 0; index < 100; index++) collab.boardStore.createCard(project.id, { title: `Other task ${index}`, columnId }, actor);
  const card = collab.boardStore.createCard(project.id, { title: "Bound task", columnId, links: [{ kind: "session", id: session.id }] }, actor);
  collab.boardStore.assign(project.id, card.id, { kind: "agent", id: "worker" }, true, actor);
  assert.deepEqual(rewindProjectContext(session, owner, collab, { root: () => "/shared/worktree" }),
    { projectId: project.id, cardId: card.id, root: "/shared/worktree" });
});
