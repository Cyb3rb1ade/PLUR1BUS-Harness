// Log viewer list (K8): fixed-height windowing with 10 000 rows, grid semantics, keyboard navigation.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Page } from "playwright";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { installLogsMocks, makeLines } from "./logs-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const grid = (p: Page) => p.getByRole("grid", { name: "Log entries" });
const rowEls = (p: Page) => p.locator('[role="row"][data-row]');

async function openMany(app: App, n: number): Promise<void> {
  const m = installLogsMocks(app.server, { lines: makeLines(n), tail: false });
  // one page with every row, whatever the client asked for: the list must cope with 10 000 loaded rows
  app.server.rpc.handle("logs.query", () => ({ records: m.lines.slice().reverse(), nextCursor: null, corrupt: 0, scanned: { files: 1, bytes: 1 }, truncated: false }), { write: false });
  await openRoute(app.page, "#/logs");
  await rowEls(app.page).first().waitFor();
}
const active = (p: Page) => p.evaluate(() => {
  const g = document.querySelector('[role="grid"]')!;
  const id = g.getAttribute("aria-activedescendant");
  const el = id ? document.getElementById(id) : null;
  return { id, index: el?.getAttribute("aria-rowindex") ?? null, text: el?.textContent ?? "" };
});

describe("logs virtual list", opts, () => {
  test("10 000 rows render only the visible window and report the full size", async () => {
    await withApp({ height: 900 }, async (app) => {
      await openMany(app, 10_000);
      const g = grid(app.page);
      assert.equal(await g.getAttribute("aria-rowcount"), "10001");
      const n = await rowEls(app.page).count();
      assert.ok(n > 5 && n < 80, `rendered ${n} rows`);
      assert.equal(await app.page.evaluate(() => document.querySelectorAll('[role="row"]').length < 90), true);
      await app.page.getByText("10,000 entries loaded").waitFor();
      const idx = await rowEls(app.page).first().getAttribute("aria-rowindex");
      assert.equal(idx, "2", "row indexes are 1-based after the header row");
    });
  });

  test("scrolling moves the window: the middle of the list shows its own rows, and the DOM stays small", async () => {
    await withApp({}, async (app) => {
      await openMany(app, 10_000);
      await app.page.evaluate(() => { const v = document.querySelector<HTMLElement>(".logs-viewport")!; v.scrollTop = v.scrollHeight / 2; });
      await app.page.waitForFunction(() => { const r = [...document.querySelectorAll('[role="row"][data-row]')].map((e) => Number(e.getAttribute("aria-rowindex"))); return r.length > 0 && Math.min(...r) > 4000 && Math.max(...r) < 6100; });
      assert.ok(await rowEls(app.page).count() < 80);
      const text = await rowEls(app.page).first().textContent();
      assert.match(text ?? "", /entry 0[45]\d{3}/);
    });
  });

  test("keyboard: arrows, PageDown, End and Home move the active row and keep it in view; Enter opens the entry", async () => {
    await withApp({}, async (app) => {
      await openMany(app, 10_000);
      await grid(app.page).focus();
      assert.equal((await active(app.page)).index, "2", "first row is active on focus");
      await app.page.keyboard.press("ArrowDown");
      await app.page.keyboard.press("ArrowDown");
      assert.equal((await active(app.page)).index, "4");
      await app.page.keyboard.press("ArrowUp");
      assert.equal((await active(app.page)).index, "3");
      await app.page.keyboard.press("PageDown");
      const afterPage = Number((await active(app.page)).index);
      assert.ok(afterPage > 8 && afterPage < 80, `PageDown moved to ${afterPage}`);
      await app.page.keyboard.press("End");
      const end = await active(app.page);
      assert.equal(end.index, "10001");
      assert.match(end.text, /entry 00001/);
      assert.equal(await app.page.evaluate((id) => { const el = document.getElementById(id!); const v = document.querySelector(".logs-viewport")!.getBoundingClientRect(); const r = el!.getBoundingClientRect(); return r.top >= v.top - 1 && r.bottom <= v.bottom + 1; }, end.id), true, "the active row is visible");
      await app.page.keyboard.press("Enter");
      const dlg = app.page.getByRole("dialog", { name: "Log entry" });
      await dlg.getByText("entry 00001").first().waitFor();
      await app.page.keyboard.press("Escape");
      await app.page.keyboard.press("Home");
      const home = await active(app.page);
      assert.equal(home.index, "2");
      assert.match(home.text, /entry 10000/);
      assert.ok(await rowEls(app.page).count() < 80);
    });
  });

  test("clicking a row makes it active and opens its details", async () => {
    await withApp({}, async (app) => {
      await openMany(app, 100);
      await rowEls(app.page).nth(3).click();
      await app.page.getByRole("dialog", { name: "Log entry" }).getByText("entry 00097").first().waitFor();
    });
  });

  test("the list has a name, a description for the keys, and is not a live region", async () => {
    await withApp({}, async (app) => {
      await openMany(app, 50);
      const g = grid(app.page);
      assert.equal(await g.getAttribute("tabindex"), "0");
      const desc = await g.getAttribute("aria-describedby");
      assert.ok(desc);
      assert.match((await app.page.locator(`#${desc}`).textContent()) ?? "", /Arrow keys/);
      assert.equal(await g.getAttribute("aria-live"), null);
      assert.equal(await g.getAttribute("aria-colcount"), "4");
      assert.equal(await app.page.locator('[role="columnheader"]').count(), 4);
    });
  });
});
