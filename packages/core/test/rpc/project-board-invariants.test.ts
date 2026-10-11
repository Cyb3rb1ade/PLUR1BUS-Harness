// Project board invariants that the existing board tests only touch from one side: a long seeded run of moves across
// columns (dense positions, exact clamping, one history entry per move), refused positions that change nothing, a column
// delete that moves cards into a full target only with the override, the change events a delete emits, and the paging
// edges (empty, exact page, one more than a page, and cursors that must not cross projects). The PRNG is seeded and no
// timers are used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CollabStore } from "../../src/collab/store.ts";
import { createCollab } from "../../src/collab/service.ts";
import { buildProjectBoardSurface } from "../../src/rpc/project-board-surface.ts";
import { guardMethods } from "../../src/rbac/guard.ts";
import type { Principal } from "../../src/rbac/types.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { validateResult } from "@plur1bus/rpc-schema";
import { RpcError } from "../../src/rpc/errors.ts";

const actor = { kind: "person" as const, id: "alice" };

// mulberry32: small, seeded, the same generator the kill-soak system test documents.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function storeFixture() {
  const store = new CollabStore({ path: ":memory:" });
  const project = store.createProject({ name: "Board", owner: actor.id });
  return { store, board: store.board, projectId: project.id };
}

test("800 seeded moves across four columns keep every column dense and place each card where it was asked", () => {
  const { store, board, projectId } = storeFixture();
  try {
    const columnIds = board.columns(projectId).map(c => c.id);
    const cards = Array.from({ length: 30 }, (_, i) => board.createCard(projectId, { title: `Card ${i}`, columnId: columnIds[i % columnIds.length]! }, actor));
    const next = rng(20261011);
    const movesPerCard = new Map(cards.map(c => [c.id, 0]));
    const assertDense = () => {
      const all = board.cards(projectId, { limit: 100 }).cards;
      assert.equal(all.length, cards.length);
      assert.equal(new Set(all.map(c => c.id)).size, cards.length);
      for (const columnId of columnIds) {
        const positions = all.filter(c => c.columnId === columnId).map(c => c.position);
        assert.deepEqual(positions, positions.map((_, i) => i), `column ${columnId} is not dense`);
      }
    };
    for (let step = 0; step < 800; step++) {
      const card = cards[Math.floor(next() * cards.length)]!;
      const target = columnIds[Math.floor(next() * columnIds.length)]!;
      // Positions up to 39 in a column that holds at most 30 cards: anything past the end must clamp to the end.
      const requested = Math.floor(next() * 40);
      const others = board.cards(projectId, { columnId: target, limit: 100 }).cards.filter(c => c.id !== card.id).length;
      const moved = board.moveCard(projectId, card.id, target, requested, actor);
      assert.equal(moved.columnId, target);
      assert.equal(moved.position, Math.min(requested, others), `step ${step}`);
      movesPerCard.set(card.id, movesPerCard.get(card.id)! + 1);
      if (step % 100 === 99) assertDense();
    }
    assertDense();
    for (const card of cards) {
      const moves = board.activity(projectId, card.id, { limit: 100 }).items.filter(a => a.kind === "moved");
      assert.equal(moves.length, movesPerCard.get(card.id), `history of ${card.title}`);
    }
  } finally { store.close(); }
});

test("a negative or fractional position is refused and leaves the card, its column and history untouched", () => {
  const { store, board, projectId } = storeFixture();
  try {
    const [backlog, work] = board.columns(projectId);
    const card = board.createCard(projectId, { title: "Stays put", columnId: backlog!.id }, actor);
    for (const position of [-1, 1.5]) {
      assert.throws(() => board.moveCard(projectId, card.id, work!.id, position, actor), (e: unknown) => /invalid position/.test(String(e)));
    }
    const after = board.getCard(projectId, card.id);
    assert.equal(after.columnId, backlog!.id);
    assert.equal(after.position, 0);
    assert.equal(board.activity(projectId, card.id, {}).items.length, 1);
  } finally { store.close(); }
});

test("deleting a column into a full target needs the override, and then appends the moved cards after the existing ones", () => {
  const { store, board, projectId } = storeFixture();
  try {
    const [backlog, work] = board.columns(projectId);
    board.updateColumn(projectId, work!.id, { wipLimit: 1 });
    const existing = board.createCard(projectId, { title: "Existing", columnId: work!.id }, actor);
    const moving = board.createCard(projectId, { title: "Moving", columnId: backlog!.id }, actor);
    assert.throws(() => board.deleteColumn(projectId, backlog!.id, work!.id, actor), /WIP/);
    assert.equal(board.getCard(projectId, moving.id).columnId, backlog!.id);
    board.deleteColumn(projectId, backlog!.id, work!.id, actor, true);
    const inWork = board.cards(projectId, { columnId: work!.id }).cards;
    assert.deepEqual(inWork.map(c => c.id), [existing.id, moving.id]);
    assert.deepEqual(inWork.map(c => c.position), [0, 1]);
    assert.equal(board.columns(projectId).some(c => c.id === backlog!.id), false);
    const moveEntry = board.activity(projectId, moving.id, {}).items.find(a => a.kind === "moved");
    assert.deepEqual(JSON.parse(moveEntry!.detail), { from: backlog!.id, to: work!.id, override: true });
  } finally { store.close(); }
});

test("cursors are bound to their project: a page from one board cannot be replayed on another", () => {
  const { store, board, projectId } = storeFixture();
  try {
    const columnId = board.columns(projectId)[0]!.id;
    board.createCard(projectId, { title: "A1", columnId }, actor);
    board.createCard(projectId, { title: "A2", columnId }, actor);
    const other = store.createProject({ name: "Other", owner: actor.id });
    const otherColumn = board.columns(other.id)[0]!.id;
    board.createCard(other.id, { title: "B1", columnId: otherColumn }, actor);
    board.createCard(other.id, { title: "B2", columnId: otherColumn }, actor);
    const page = board.cards(projectId, { limit: 1 });
    assert.notEqual(page.nextCursor, null);
    assert.throws(() => board.cards(other.id, { limit: 1, cursor: page.nextCursor! }), /cursor/);
  } finally { store.close(); }
});

// Surface-level: the change events a board delete emits, and the paging edges through the real guard and result schema.
const isCode = (code: string) => (e: unknown) => e instanceof RpcError && e.error === code;
function surfaceFixture() {
  const service = createCollab({ path: ":memory:" });
  const owner: Principal = { userId: "alice", role: "owner", kind: "person" };
  const project = service.createProject(owner, { name: "Board" });
  const events: { method: string; params: any }[] = [];
  const raw = buildProjectBoardSurface(() => service, e => { events.push(e); });
  const methods = guardMethods(raw, { resolve: () => owner, audit: memoryAuditSink(), now: () => 1000 });
  const call = async (method: string, params: any = {}) => {
    const result = await methods[method]!({ projectId: project.id, ...params }, { signal: new AbortController().signal, requestId: "1", connectionId: "test" });
    assert.deepEqual(validateResult(method, result), { ok: true }, method);
    return result as any;
  };
  return { service, project, events, call };
}

test("deleting a column with a target emits the column change and one card change saying the cards moved; an empty delete emits only the column change", async () => {
  const f = surfaceFixture();
  try {
    const [backlog, work] = (await f.call("project.column.list")).columns;
    await f.call("project.card.create", { columnId: backlog.id, title: "Task" });
    f.events.length = 0;
    await f.call("project.column.delete", { columnId: backlog.id, targetColumnId: work.id });
    assert.deepEqual(f.events.map(e => `${e.method}:${e.params.change}`), ["project.column.changed:delete", "project.card.changed:column-deleted"]);
    const empty = await f.call("project.column.create", { titleKey: "empty.column" });
    f.events.length = 0;
    await f.call("project.column.delete", { columnId: empty.id });
    assert.deepEqual(f.events.map(e => `${e.method}:${e.params.change}`), ["project.column.changed:delete"]);
  } finally { f.service.close(); }
});

test("card lists at the page edges: empty board, exactly one full page, and one card more than a page", async () => {
  const f = surfaceFixture();
  try {
    const [backlog] = (await f.call("project.column.list")).columns;
    const none = await f.call("project.card.list", {});
    assert.deepEqual(none.cards, []);
    assert.equal(none.nextCursor, null);
    await f.call("project.card.create", { columnId: backlog.id, title: "One" });
    await f.call("project.card.create", { columnId: backlog.id, title: "Two" });
    const exact = await f.call("project.card.list", { limit: 2 });
    assert.equal(exact.cards.length, 2);
    assert.equal(exact.nextCursor, null);
    const first = await f.call("project.card.list", { limit: 1 });
    assert.equal(first.cards.length, 1);
    assert.notEqual(first.nextCursor, null);
    const second = await f.call("project.card.list", { limit: 1, cursor: first.nextCursor });
    assert.equal(second.cards.length, 1);
    assert.notEqual(second.cards[0].id, first.cards[0].id);
    assert.equal(second.nextCursor, null);
    await assert.rejects(f.call("project.card.list", { limit: 0 }), isCode("E_INVALID_PARAMS"));
    await assert.rejects(f.call("project.card.list", { limit: 101 }), isCode("E_INVALID_PARAMS"));
  } finally { f.service.close(); }
});
