import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { CollabStore } from "../../src/collab/store.ts";
import { MIGRATIONS, migrate } from "../../src/collab/migrations.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const actor = { kind: "person" as const, id: "alice" };
function fixture() {
  const store = new CollabStore({ path: ":memory:" });
  const project = store.createProject({ name: "Board", owner: actor.id });
  return { store, board: store.board, projectId: project.id };
}
test("default columns, durable cards, many moves keep exact stable positions", () => {
  const { store, board, projectId } = fixture();
  try {
    const columns = board.columns(projectId);
    assert.deepEqual(columns.map(c => c.titleKey), ["project.board.backlog", "project.board.inProgress", "project.board.review", "project.board.done"]);
    const cards = Array.from({ length: 20 }, (_, i) => board.createCard(projectId, { title: `Card ${i}`, columnId: columns[0]!.id }, actor));
    for (let i = 0; i < 500; i++) board.moveCard(projectId, cards[i % 20]!.id, columns[0]!.id, i % 20, actor);
    const page = board.cards(projectId, { limit: 100 });
    assert.deepEqual(page.cards.map(c => c.position), Array.from({ length: 20 }, (_, i) => i));
    assert.equal(new Set(page.cards.map(c => c.id)).size, 20);
    assert.equal(board.activity(projectId, cards[0]!.id, {}).items[0]!.kind, "created");
  } finally { store.close(); }
});
test("column deletion and WIP failures roll back card, activity and columns together", () => {
  const { store, board, projectId } = fixture();
  try {
    const [backlog, work] = board.columns(projectId);
    board.updateColumn(projectId, work!.id, { wipLimit: 1 });
    const a = board.createCard(projectId, { title: "A", columnId: backlog!.id }, actor);
    const b = board.createCard(projectId, { title: "B", columnId: work!.id }, actor);
    assert.throws(() => board.moveCard(projectId, a.id, work!.id, 0, actor), /WIP/);
    assert.equal(board.getCard(projectId, a.id).columnId, backlog!.id);
    assert.equal(board.activity(projectId, a.id, {}).items.length, 1);
    assert.throws(() => board.deleteColumn(projectId, backlog!.id, undefined, actor), /empty/);
    assert.throws(() => board.deleteColumn(projectId, backlog!.id, work!.id, actor), /WIP/);
    board.archiveCard(projectId, b.id, true, actor);
    board.deleteColumn(projectId, backlog!.id, work!.id, actor);
    assert.equal(board.getCard(projectId, a.id).columnId, work!.id);
    assert.throws(() => board.archiveCard(projectId, b.id, false, actor), /WIP/);
  } finally { store.close(); }
});
test("filters and cursor pages have no duplicates; text is literal; cursor is bound to filters", () => {
  const { store, board, projectId } = fixture();
  try {
    const columnId = board.columns(projectId)[0]!.id;
    store.addMember(projectId, "bob", "member");
    const ids = Array.from({ length: 7 }, (_, i) => board.createCard(projectId, { title: `100% ${i}`, columnId, labels: ["bug"] }, actor).id);
    board.assign(projectId, ids[0]!, { kind: "person", id: "bob" }, true, actor);
    const first = board.cards(projectId, { label: "bug", text: "%", limit: 3 });
    const second = board.cards(projectId, { label: "bug", text: "%", limit: 3, cursor: first.nextCursor! });
    assert.equal(first.cards.length, 3); assert.equal(second.cards.length, 3);
    assert.equal(new Set([...first.cards, ...second.cards].map(c => c.id)).size, 6);
    assert.throws(() => board.cards(projectId, { text: "other", cursor: first.nextCursor! }), /cursor/);
    assert.equal(board.cards(projectId, { assignee: { kind: "person", id: "bob" } }).cards.length, 1);
    assert.throws(() => board.assign(projectId, ids[0]!, { kind: "agent", id: "outsider" }, true, actor), /project/);
  } finally { store.close(); }
});
test("v1 projects migrate additively and persist defaults exactly once", () => {
  const path = join(tempDir("board-migration-"), "collab.sqlite");
  const raw = new DatabaseSync(path);
  migrate(raw, [MIGRATIONS[0]!]);
  raw.prepare("INSERT INTO projects VALUES (?,?,?,?,?,?,?)").run("legacy", "Old", "alice", "{}", 1, 2, null);
  raw.prepare("INSERT INTO project_members VALUES (?,?,?,?)").run("legacy", "alice", "lead", 1);
  raw.close();
  let store = new CollabStore({ path });
  assert.equal(store.getProject("legacy")!.name, "Old");
  const columns = store.board.columns("legacy"); assert.equal(columns.length, 4);
  store.board.createCard("legacy", { title: "Persisted", columnId: columns[0]!.id }, actor);
  store.close(); store = new CollabStore({ path });
  assert.deepEqual(store.board.columns("legacy"), columns);
  assert.equal(store.board.cards("legacy", {}).cards[0]!.title, "Persisted");
  assert.equal(store.getProject("legacy")!.members[0]!.role, "lead");
  store.close();
});
test("column order, archive filtering and paging invalidation survive mutations", () => {
  const { store, board, projectId } = fixture();
  try {
    const columns = board.columns(projectId), columnId = columns[0]!.id;
    const custom = board.createColumn(projectId, { titleKey: "custom", position: 0 });
    board.moveColumn(projectId, custom.id, 99);
    assert.equal(board.columns(projectId).at(-1)!.id, custom.id);
    const a = board.createCard(projectId, { title: "A", columnId }, actor);
    const b = board.createCard(projectId, { title: "B", columnId }, actor);
    const page = board.cards(projectId, { limit: 1 });
    board.moveCard(projectId, b.id, columnId, 0, actor);
    assert.throws(() => board.cards(projectId, { limit: 1, cursor: page.nextCursor! }), /cursor/);
    board.archiveCard(projectId, a.id, true, actor);
    assert.equal(board.cards(projectId, { archived: true }).cards[0]!.id, a.id);
    assert.equal(board.cards(projectId, {}).cards.length, 1);
    const comment = board.comment(projectId, b.id, "**One**", actor);
    board.comment(projectId, b.id, "Two", actor);
    const comments = board.comments(projectId, b.id, { limit: 1 });
    assert.equal(comments.items[0]!.id, comment.id);
    board.comment(projectId, b.id, "Three", actor);
    assert.equal(board.comments(projectId, b.id, { cursor: comments.nextCursor!, limit: 10 }).items.length, 2);
    for (const c of board.columns(projectId).slice(1)) board.deleteColumn(projectId, c.id, columnId, actor);
    assert.throws(() => board.deleteColumn(projectId, columnId, undefined, actor), /empty/);
    const empty = store.createProject({ name: "Empty", owner: "alice" });
    for (const c of board.columns(empty.id)) board.deleteColumn(empty.id, c.id, undefined, actor);
    assert.deepEqual(board.columns(empty.id), []);
  } finally { store.close(); }
});
