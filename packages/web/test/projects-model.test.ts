import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canManageColumns,
  canMoveCard,
  canWriteCards,
  countActiveCardsByColumn,
  filterCards,
  optimisticallyMoveCard,
  wouldExceedWip,
  calculateProjectStats,
  type BoardFilters,
} from "../src/pages/projects/model.ts";
import type { BoardCard, BoardColumn } from "../src/pages/projects/rpc-types.ts";

const cardFixture = (over: Partial<BoardCard> = {}): BoardCard => ({
  id: "card_1",
  projectId: "prj_1",
  title: "Test Task",
  description: "Task description",
  columnId: "col_1",
  position: 0,
  labels: ["bug"],
  priority: "normal",
  dueAt: 1000,
  assignees: [{ kind: "agent", id: "agent_dev" }],
  links: [],
  createdBy: { kind: "person", id: "owner" },
  updatedBy: { kind: "person", id: "owner" },
  createdAt: 100,
  updatedAt: 100,
  archived: false,
  ...over,
});

test("model: rights checks adhere to RBAC and project roles", () => {
  const card = cardFixture();

  // Column management: lead, owner, admin can manage; member, viewer, agent cannot
  assert.equal(canManageColumns("owner", "member"), true);
  assert.equal(canManageColumns("admin", "member"), true);
  assert.equal(canManageColumns("operator", "lead"), true);
  assert.equal(canManageColumns("member", "member"), false);
  assert.equal(canManageColumns("viewer", "member"), false);
  assert.equal(canManageColumns("owner", "lead", true), false); // agent cannot manage columns

  // Writing cards: viewer cannot write, agent cannot write, members can
  assert.equal(canWriteCards("owner", null), true);
  assert.equal(canWriteCards("member", "member"), true);
  assert.equal(canWriteCards("viewer", "member"), false);
  assert.equal(canWriteCards("member", "member", true), false); // agent cannot write cards

  // Moving cards:
  // Viewer cannot move
  assert.equal(canMoveCard(card, "viewer", "member", false, null), false);
  // Human member can move
  assert.equal(canMoveCard(card, "member", "member", false, null), true);
  // Agent can move ONLY own assigned card
  assert.equal(canMoveCard(card, "agent", null, true, "agent_dev"), true);
  assert.equal(canMoveCard(card, "agent", null, true, "other_agent"), false);
});

test("model: filtering by text, assignee, label, archived", () => {
  const c1 = cardFixture({ id: "c1", title: "Urgent fix", description: "crash on startup", labels: ["bug"], assignees: [{ kind: "person", id: "alice" }] });
  const c2 = cardFixture({ id: "c2", title: "Refactor API", description: "clean up routes", labels: ["refactor"], assignees: [{ kind: "person", id: "bob" }] });
  const c3 = cardFixture({ id: "c3", title: "Archived task", archived: true, labels: ["bug"] });
  const cards = [c1, c2, c3];

  const defaultFilters: BoardFilters = { search: "", assignee: null, label: null, archived: false };
  assert.deepEqual(filterCards(cards, defaultFilters).map(c => c.id), ["c1", "c2"]);

  // Search filter
  assert.deepEqual(filterCards(cards, { ...defaultFilters, search: "crash" }).map(c => c.id), ["c1"]);
  assert.deepEqual(filterCards(cards, { ...defaultFilters, search: "API" }).map(c => c.id), ["c2"]);

  // Assignee filter
  assert.deepEqual(filterCards(cards, { ...defaultFilters, assignee: "bob" }).map(c => c.id), ["c2"]);

  // Label filter
  assert.deepEqual(filterCards(cards, { ...defaultFilters, label: "bug" }).map(c => c.id), ["c1"]);

  // Archived filter
  assert.deepEqual(filterCards(cards, { ...defaultFilters, archived: true }).map(c => c.id), ["c3"]);
});

test("model: WIP limit calculation and optimistic move", () => {
  const col: BoardColumn = { id: "col_2", title: "In Progress", titleKey: null, position: 1, wipLimit: 2 };
  assert.equal(wouldExceedWip(col, 1, false), false);
  assert.equal(wouldExceedWip(col, 2, false), true);
  assert.equal(wouldExceedWip(col, 2, true), false); // reordering within same column allowed

  const c1 = cardFixture({ id: "c1", columnId: "col_1", position: 0 });
  const c2 = cardFixture({ id: "c2", columnId: "col_1", position: 1 });
  const c3 = cardFixture({ id: "c3", columnId: "col_2", position: 0 });
  const initial = [c1, c2, c3];

  // Move c1 to col_2 at position 0
  const moved = optimisticallyMoveCard(initial, "c1", "col_2", 0);
  const targetCards = moved.filter(c => c.columnId === "col_2").sort((a, b) => a.position - b.position);
  assert.equal(targetCards.length, 2);
  assert.equal(targetCards[0]!.id, "c1");
  assert.equal(targetCards[0]!.position, 0);
  assert.equal(targetCards[1]!.id, "c3");
  assert.equal(targetCards[1]!.position, 1);

  // Old column renumbered
  const oldCards = moved.filter(c => c.columnId === "col_1");
  assert.equal(oldCards.length, 1);
  assert.equal(oldCards[0]!.id, "c2");
  assert.equal(oldCards[0]!.position, 0);
});

test("model: project stats count open cards and overdue cards", () => {
  const c1 = cardFixture({ id: "c1", archived: false, dueAt: 500 });
  const c2 = cardFixture({ id: "c2", archived: false, dueAt: 2000 });
  const c3 = cardFixture({ id: "c3", archived: true, dueAt: 100 });
  const stats = calculateProjectStats([c1, c2, c3], 1000);
  assert.equal(stats.openCount, 2);
  assert.equal(stats.dueCount, 1); // c1 has dueAt 500 < now 1000
});
