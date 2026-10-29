// Projects robustness (audit b19): paging, stale answers, a failed refresh, roles of human project members, the focus of the
// card drawer and a double "create project". Own seed (projects.test.ts keeps its fixtures private).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";
import { rpcError, type MockRpc } from "./mock-rpc.ts";
import type { BoardCard, BoardColumn, Project } from "../src/pages/projects/rpc-types.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const proj = (id: string, name: string, members: Project["members"] = [{ userId: "owner", role: "lead" }]): Project =>
  ({ id, name, owner: "owner", members, agents: [], archivedAt: null });
const columns: BoardColumn[] = [
  { id: "col_a", title: "Todo", titleKey: null, position: 0, wipLimit: null },
  { id: "col_b", title: "Doing", titleKey: null, position: 1, wipLimit: null },
];
const card = (id: string, projectId = "p1", columnId = "col_a", position = 0): BoardCard => ({
  id, projectId, title: `Task ${id}`, description: "", columnId, position, labels: [], priority: "normal", dueAt: null, assignees: [], links: [],
  createdBy: { kind: "person", id: "owner" }, updatedBy: { kind: "person", id: "owner" }, createdAt: 1, updatedAt: 1, archived: false,
});

function seed(rpc: MockRpc, projects: Project[], cardsOf: (projectId: string, cursor?: string) => { cards: BoardCard[]; nextCursor: string | null }): void {
  rpc.handle("project.list", () => ({ projects }), { write: false });
  rpc.handle("project.column.list", () => ({ columns }), { write: false });
  rpc.handle("project.card.list", (p: any) => cardsOf(p.projectId, p.cursor), { write: false });
  rpc.handle("project.card.comment.list", () => ({ items: [], nextCursor: null }), { write: false });
  rpc.handle("project.card.activity.list", () => ({ items: [], nextCursor: null }), { write: false });
  rpc.handle("project.card.move", (p: any) => card(p.cardId, p.projectId, p.columnId));
}

describe("projects: robustness", opts, () => {
  test("cards beyond the first page are loaded (nextCursor is followed)", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc, [proj("p1", "One")], (_p, cursor) =>
        cursor === undefined ? { cards: [card("c1")], nextCursor: "next" } : { cards: [card("c2", "p1", "col_a", 1)], nextCursor: null });
      await openRoute(app.page, "#/projects/p1");
      await app.page.getByText("Task c1").waitFor();
      await app.page.getByText("Task c2").waitFor({ timeout: 3000 });
    });
  });

  test("a slow answer for the previously selected project never replaces the board of the current one", async () => {
    await withApp({}, async (app) => {
      app.server.rpc.handle("project.list", () => ({ projects: [proj("p1", "One"), proj("p2", "Two")] }), { write: false });
      app.server.rpc.handle("project.column.list", () => ({ columns }), { write: false });
      app.server.rpc.handle("project.card.list", async (p: any) => {
        if (p.projectId === "p1") await new Promise((r) => setTimeout(r, 900));
        return { cards: [card(`only_${p.projectId}`, p.projectId)], nextCursor: null };
      }, { write: false });
      await openRoute(app.page, "#/projects");
      await app.page.getByRole("link", { name: /One/ }).waitFor();
      await app.page.evaluate(() => { location.hash = "#/projects/p1"; });
      await app.page.waitForTimeout(150);
      await app.page.evaluate(() => { location.hash = "#/projects/p2"; });
      await app.page.getByText("Task only_p2").waitFor();
      await app.page.waitForTimeout(1200);
      assert.equal(await app.page.getByText("Task only_p1").count(), 0);
      assert.equal(await app.page.getByText("Task only_p2").count(), 1);
    });
  });

  test("a failed background refresh keeps the board; a failed first load is an error state, not an empty board", async () => {
    await withApp({}, async (app) => {
      let fail = false;
      seed(app.server.rpc, [proj("p1", "One")], () => {
        if (fail) throw rpcError("E_INTERNAL", "boom");
        return { cards: [card("c1")], nextCursor: null };
      });
      await openRoute(app.page, "#/projects/p1");
      const c1 = app.page.locator('[data-card-id="c1"]');
      await c1.waitFor();
      fail = true;
      await c1.focus();
      await app.page.keyboard.press("ArrowRight");
      await app.page.waitForTimeout(800);
      assert.equal(await app.page.locator('[data-card-id="c1"]').count(), 1, "the board is still there");
    });
    await withApp({}, async (app) => {
      seed(app.server.rpc, [proj("p1", "One")], () => { throw rpcError("E_INTERNAL", "boom"); });
      await openRoute(app.page, "#/projects/p1");
      await app.page.getByRole("button", { name: /try again/i }).waitFor({ timeout: 4000 });
    });
  });

  for (const role of ["operator", "member"]) {
    test(`a human project member with role ${role} may add cards (docs/projects-board.md)`, async () => {
      await withApp({ server: { role } }, async (app) => {
        seed(app.server.rpc, [proj("p1", "One", [{ userId: role, role: "member" }])], () => ({ cards: [card("c1")], nextCursor: null }));
        await openRoute(app.page, "#/projects/p1");
        await app.page.getByText("Task c1").waitFor();
        await app.page.getByRole("button", { name: "Add card" }).first().waitFor({ timeout: 3000 });
      });
    });
  }

  test("the card drawer takes focus when opened by keyboard and gives it back on Escape", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc, [proj("p1", "One")], () => ({ cards: [card("c1")], nextCursor: null }));
      await openRoute(app.page, "#/projects/p1");
      const c1 = app.page.locator('[data-card-id="c1"]');
      await c1.focus();
      await app.page.keyboard.press("Enter");
      await app.page.locator(".card-drawer").waitFor();
      await app.page.waitForFunction(() => document.activeElement?.closest(".card-drawer") !== null);
      await app.page.keyboard.press("Escape");
      await app.page.locator(".card-drawer").waitFor({ state: "detached" });
      await app.page.waitForFunction(() => document.activeElement?.getAttribute("data-card-id") === "c1");
    });
  });

  test("an Esc pressed in the draw that shows the card drawer closes it", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc, [proj("p1", "One")], () => ({ cards: [card("c1")], nextCursor: null }));
      await openRoute(app.page, "#/projects/p1");
      // Esc reaches the focused element in a MutationObserver callback: the microtask right after the draw that inserts the
      // drawer, before any passive effect of that draw has run (those run after the next paint; a fast keyboard user, or a
      // test driver on a slow runner, gets there first).
      await app.page.evaluate(() => {
        const mo = new MutationObserver(() => {
          const drawer = document.querySelector(".card-drawer");
          if (!drawer) return;
          mo.disconnect();
          (document.activeElement ?? drawer).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
          document.documentElement.dataset.escSent = "1";
        });
        mo.observe(document, { childList: true, subtree: true });
      });
      await app.page.locator('[data-card-id="c1"]').focus();
      await app.page.keyboard.press("Enter");
      await app.page.locator("html[data-esc-sent]").waitFor({ state: "attached" });
      await app.page.locator(".card-drawer").waitFor({ state: "detached" });
      await app.page.waitForFunction(() => document.activeElement?.getAttribute("data-card-id") === "c1");
    });
  });

  test("submitting the new-project form twice in one task creates one project", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc, [proj("p1", "One")], () => ({ cards: [], nextCursor: null }));
      app.server.rpc.handle("project.create", async (p: any) => { await new Promise((r) => setTimeout(r, 300)); return proj("p9", p.name); });
      await openRoute(app.page, "#/projects");
      await app.page.getByRole("button", { name: "New project" }).click();
      await app.page.locator("#new-proj-name").fill("Fresh");
      await app.page.evaluate(() => {
        const f = document.querySelector("form.project-create-inline") as HTMLFormElement;
        f.requestSubmit();
        f.requestSubmit();
      });
      await app.page.waitForTimeout(900);
      assert.equal(app.server.rpc.calls.filter((c) => c.method === "project.create").length, 1);
    });
  });
});
