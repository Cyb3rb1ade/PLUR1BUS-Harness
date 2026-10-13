// Board administration (Schritt 1): column delete with cards needs a target, WIP refusals name the column, and the card
// priority can be changed after creation. Own seed, because projects.test.ts keeps its fixtures private.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { rpcError, type MockRpc } from "./mock-rpc.ts";
import type { BoardCard, BoardColumn, Project } from "../src/pages/projects/rpc-types.ts";

before(setup);
after(teardown);

const opts = { skip: browserSkip };

const project: Project = {
  id: "prj_alpha",
  name: "Alpha Project",
  owner: "owner",
  members: [{ userId: "owner", role: "lead" }],
  agents: [],
  archivedAt: null,
};

const columns: BoardColumn[] = [
  { id: "col_backlog", title: null, titleKey: "project.board.backlog", position: 0, wipLimit: null },
  { id: "col_progress", title: null, titleKey: "project.board.inProgress", position: 1, wipLimit: 1 },
];

function card(id: string, columnId: string, over: Partial<BoardCard> = {}): BoardCard {
  return {
    id,
    projectId: "prj_alpha",
    title: `Task ${id}`,
    description: "",
    columnId,
    position: 0,
    labels: [],
    priority: "high",
    dueAt: null,
    assignees: [],
    links: [],
    createdBy: { kind: "person", id: "owner" },
    updatedBy: { kind: "person", id: "owner" },
    createdAt: 1000,
    updatedAt: 1000,
    archived: false,
    ...over,
  };
}

function seed(rpc: MockRpc, over: { columns?: BoardColumn[]; cards?: BoardCard[]; deleteError?: boolean } = {}) {
  let cols = over.columns ?? columns;
  const cards = over.cards ?? [card("card_1", "col_backlog"), card("card_2", "col_progress")];
  rpc.handle("project.list", () => ({ projects: [project] }), { write: false });
  rpc.handle("project.column.list", () => ({ columns: cols }), { write: false });
  rpc.handle("project.card.list", (p: any) => {
    let res = cards;
    if (p.columnId) res = res.filter((c) => c.columnId === p.columnId);
    if (p.archived !== undefined) res = res.filter((c) => c.archived === p.archived);
    return { cards: res, nextCursor: null };
  }, { write: false });
  rpc.handle("project.card.comment.list", () => ({ items: [], nextCursor: null }), { write: false });
  rpc.handle("project.card.activity.list", () => ({ items: [], nextCursor: null }), { write: false });
  rpc.handle("project.column.delete", (p: any) => {
    if (over.deleteError) throw rpcError("E_PROJECT_WIP_LIMIT", "project WIP limit exceeded", "project-board-wip");
    cols = cols.filter((c) => c.id !== p.columnId);
    return { deleted: true };
  });
  rpc.handle("project.card.update", (p: any) => {
    const c = cards.find((x) => x.id === p.cardId);
    if (c && p.priority !== undefined) c.priority = p.priority;
    return c;
  });
}

/** Opens "Manage columns" and the delete form of the column whose title is `title`. */
async function openDeleteForm(page: App["page"], title: string): Promise<void> {
  await page.getByRole("button", { name: "Manage columns" }).click();
  const item = page.locator(".column-manage-item", { hasText: title });
  await item.getByRole("button", { name: "Delete column" }).click();
  await page.locator(".column-delete-form").waitFor();
}

describe("projects admin: deleting a column that still holds cards", opts, () => {
  test("the form names the card count, preselects another column and sends it as the target", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc);
      await openRoute(app.page, "#/projects/prj_alpha");
      await app.page.getByText("Task card_1").waitFor();
      await openDeleteForm(app.page, "Backlog");

      assert.match(await app.page.locator(".column-delete-form").innerText(), /holds 1 card/);
      const select = app.page.locator(".column-delete-form select");
      assert.equal(await select.inputValue(), "col_progress");

      await app.page.locator(".column-delete-form button.btn-danger").click();
      await app.page.waitForFunction(() => !document.querySelector(".column-delete-form"));
      const del = app.server.rpc.calls.find((c) => c.method === "project.column.delete");
      assert.deepEqual(del?.params, { projectId: "prj_alpha", columnId: "col_backlog", targetColumnId: "col_progress" });
    });
  });

  test("with no other column to move the cards to, the delete button stays disabled", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc, { columns: [columns[0]!] });
      await openRoute(app.page, "#/projects/prj_alpha");
      await app.page.getByText("Task card_1").waitFor();
      await openDeleteForm(app.page, "Backlog");

      assert.match(await app.page.locator(".column-delete-form").innerText(), /no other column/);
      assert.equal(await app.page.locator(".column-delete-form button.btn-danger").isDisabled(), true);
      assert.equal(app.server.rpc.calls.some((c) => c.method === "project.column.delete"), false);
    });
  });

  test("a WIP refusal on delete shows the message with the target column's name and limit", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc, { deleteError: true });
      await openRoute(app.page, "#/projects/prj_alpha");
      await app.page.getByText("Task card_1").waitFor();
      await openDeleteForm(app.page, "Backlog");
      await app.page.locator(".column-delete-form button.btn-danger").click();

      const alert = app.page.locator(".column-dialog-content > .alert-error");
      await alert.waitFor();
      const text = await alert.innerText();
      assert.match(text, /WIP limit exceeded for column In Progress \(limit: 1\)/);
    });
  });

  test("the column dialog with a delete form open has no axe violations", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc);
      await openRoute(app.page, "#/projects/prj_alpha");
      await app.page.getByText("Task card_1").waitFor();
      await openDeleteForm(app.page, "Backlog");
      await expectAxeClean(app.page, "manage columns, delete form open");
    });
  });
});

describe("projects admin: card priority after creation", opts, () => {
  test("changing the priority in the drawer sends project.card.update with the new value", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc);
      await openRoute(app.page, "#/projects/prj_alpha");
      await app.page.locator('[data-card-id="card_1"]').click();
      const drawer = app.page.locator(".card-drawer");
      await drawer.waitFor();

      const select = app.page.locator("#priority-card_1");
      assert.equal(await select.inputValue(), "high");
      await select.selectOption("urgent");

      // The save refreshes the board, which may close the drawer; the call itself is what matters.
      for (let i = 0; i < 50 && !app.server.rpc.calls.some((c) => c.method === "project.card.update"); i++) await new Promise((r) => setTimeout(r, 100));
      const upd = app.server.rpc.calls.find((c) => c.method === "project.card.update");
      assert.deepEqual(upd?.params, { projectId: "prj_alpha", cardId: "card_1", priority: "urgent" });
    });
  });

  test("the priority control is absent for a read-only viewer", async () => {
    await withApp({ server: { role: "viewer" } }, async (app) => {
      seed(app.server.rpc);
      await openRoute(app.page, "#/projects/prj_alpha");
      await app.page.locator('[data-card-id="card_1"]').click();
      await app.page.locator(".card-drawer").waitFor();
      assert.equal(await app.page.locator("#priority-card_1").count(), 0);
    });
  });
});
