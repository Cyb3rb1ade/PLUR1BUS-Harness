// Shared layout components through the pattern gallery: Tabs, Dialog, ListDetail, Page actions, More menus, Card/Badge.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const active = (page: import("playwright").Page): Promise<string> => page.evaluate(() => { const e = document.activeElement as HTMLElement | null; return `${e?.tagName}:${(e?.textContent ?? "").trim() || e?.getAttribute("aria-label") || e?.id || ""}`; });

describe("Tabs", opts, () => {
  test("ARIA roles, roving tabindex, Arrow/Home/End keys select and move focus, panel follows", async () => {
    await withApp({}, async ({ page }) => {
      await openRoute(page, "#/gallery/patterns");
      const list = page.getByRole("tablist", { name: "Example tabs" });
      await list.waitFor();
      const tabs = list.getByRole("tab");
      assert.equal(await tabs.count(), 3);
      assert.deepEqual(await tabs.evaluateAll((els) => els.map((e) => [e.getAttribute("aria-selected"), e.getAttribute("tabindex")])), [["true", "0"], ["false", "-1"], ["false", "-1"]]);
      assert.equal(await page.getByRole("tabpanel").textContent(), "Panel one");
      await tabs.nth(0).focus();
      await page.keyboard.press("ArrowRight");
      assert.equal(await active(page), "BUTTON:Two");
      assert.equal(await page.getByRole("tabpanel").textContent(), "Panel two");
      await page.keyboard.press("End");
      assert.equal(await active(page), "BUTTON:Three");
      await page.keyboard.press("ArrowRight"); // wraps
      assert.equal(await active(page), "BUTTON:One");
      await page.keyboard.press("ArrowLeft"); // wraps back
      assert.equal(await active(page), "BUTTON:Three");
      await page.keyboard.press("Home");
      assert.equal(await active(page), "BUTTON:One");
      assert.equal(await page.getByRole("tabpanel").textContent(), "Panel one");
      // Tab leaves the tab list for the panel (only the selected tab is a tab stop)
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("role")), "tabpanel");
      await expectAxeClean(page, "tabs");
    });
  });

  test("clicking a tab selects it; every aria-controls resolves to a panel", async () => {
    await withApp({ width: 400, height: 800 }, async ({ page }) => {
      await openRoute(page, "#/gallery/patterns");
      await page.getByRole("tab", { name: "Three" }).click();
      assert.equal(await page.getByRole("tabpanel").textContent(), "Panel three");
      const ok = await page.evaluate(() => Array.from(document.querySelectorAll("[role=tab]")).every((t) => document.getElementById(t.getAttribute("aria-controls")!)));
      assert.equal(ok, true);
    });
  });
});

describe("Dialog", opts, () => {
  for (const [width, expected] of [[1440, 680], [400, 368]] as const) {
    test(`modal at ${width} px: width ${expected}, inert background, focus trap, Esc closes, focus returns`, async () => {
      await withApp({ width, height: 800 }, async ({ page }) => {
        await openRoute(page, "#/gallery/dialog");
        const opener = page.getByRole("button", { name: "Open dialog" });
        await opener.focus();
        await opener.press("Enter");
        const dialog = page.getByRole("dialog", { name: "Example dialog" });
        await dialog.waitFor();
        assert.equal(Math.round((await dialog.boundingBox())!.width), expected);
        assert.equal(await page.evaluate(() => !!document.activeElement?.closest("dialog")), true, "focus starts inside");
        for (let i = 0; i < 8; i++) {
          await page.keyboard.press("Tab");
          assert.equal(await page.evaluate(() => !!document.activeElement?.closest("dialog")), true, `Tab ${i + 1} stayed inside`);
        }
        for (let i = 0; i < 8; i++) {
          await page.keyboard.press("Shift+Tab");
          assert.equal(await page.evaluate(() => !!document.activeElement?.closest("dialog")), true, `Shift+Tab ${i + 1} stayed inside`);
        }
        await expectAxeClean(page, "dialog open");
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached" });
        assert.equal(await active(page), "BUTTON:Open dialog");
      });
    });
  }

  test("the close button, the Done action and a backdrop click each close it and return focus", async () => {
    await withApp({}, async ({ page }) => {
      await openRoute(page, "#/gallery/dialog");
      const opener = page.getByRole("button", { name: "Open dialog" });
      const dialog = page.getByRole("dialog");
      for (const close of [() => dialog.getByRole("button", { name: "Close" }).click(), () => dialog.getByRole("button", { name: "Done" }).click(), () => page.mouse.click(10, 10)]) {
        await opener.click();
        await dialog.waitFor();
        await close();
        await dialog.waitFor({ state: "detached" });
        assert.equal(await active(page), "BUTTON:Open dialog");
      }
    });
  });

  test("German close label", async () => {
    await withApp({ locale: "de-DE" }, async ({ page }) => {
      await openRoute(page, "#/gallery/dialog", "de");
      await page.getByRole("button", { name: "Open dialog" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Schließen" }).waitFor();
    });
  });
});

describe("ListDetail", opts, () => {
  test("normal: two columns, selection shows the detail beside the list, no Back button", async () => {
    await withApp({ width: 1440, height: 800 }, async ({ page }) => {
      await openRoute(page, "#/gallery/list-detail");
      const list = page.getByRole("region", { name: "Items" });
      const detail = page.getByRole("region", { name: "Item details" });
      await list.waitFor();
      assert.equal(await detail.isVisible(), true);
      assert.equal(await detail.getByText("Select an item to see its details.").isVisible(), true);
      await list.getByRole("link", { name: "Beta" }).click();
      await detail.getByRole("heading", { name: "Beta" }).waitFor();
      assert.equal(await list.isVisible(), true);
      assert.equal(await page.getByRole("button", { name: "Back to list" }).isVisible(), false);
      const [l, d] = [await list.boundingBox(), await detail.boundingBox()];
      assert.ok(l!.x + l!.width <= d!.x, "side by side");
      assert.ok(l!.width <= 340);
      await expectAxeClean(page, "list-detail normal");
    });
  });

  test("compact: list OR detail; Back returns to the list; focus follows; the browser Back button works too", async () => {
    await withApp({ width: 400, height: 800 }, async ({ page }) => {
      await openRoute(page, "#/gallery/list-detail");
      const list = page.getByRole("region", { name: "Items" });
      const detail = page.getByRole("region", { name: "Item details" });
      await list.waitFor();
      assert.equal(await detail.isVisible(), false);
      await expectAxeClean(page, "list-detail compact list");
      await list.getByRole("link", { name: "Gamma" }).click();
      await detail.getByRole("heading", { name: "Gamma" }).waitFor();
      assert.equal(await list.isVisible(), false);
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Item details");
      const back = page.getByRole("button", { name: "Back to list" });
      assert.ok((await back.boundingBox())!.height >= 44);
      await expectAxeClean(page, "list-detail compact detail");
      await back.click();
      await list.waitFor();
      assert.equal(await detail.isVisible(), false);
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Items");
      await list.getByRole("link", { name: "Alpha" }).click();
      await detail.getByRole("heading", { name: "Alpha" }).waitFor();
      await page.goBack();
      await list.waitFor();
    });
  });

  test("a deep link to an item opens it; resizing from compact to normal shows both", async () => {
    await withApp({ width: 400, height: 800 }, async ({ page }) => {
      await openRoute(page, "#/gallery/list-detail/2");
      await page.getByRole("region", { name: "Item details" }).getByRole("heading", { name: "Beta" }).waitFor();
      await page.setViewportSize({ width: 1440, height: 800 });
      assert.equal(await page.getByRole("region", { name: "Items" }).isVisible(), true);
      assert.equal(await page.getByRole("region", { name: "Item details" }).isVisible(), true);
    });
  });
});

describe("Page actions and More menus", opts, () => {
  test("normal: actions inline, no More button on the page", async () => {
    await withApp({ width: 1440, height: 800 }, async ({ page }) => {
      await openRoute(page, "#/gallery/actions");
      await page.getByRole("button", { name: "First" }).waitFor();
      assert.equal(await page.getByRole("button", { name: "More actions" }).count(), 0);
      await expectAxeClean(page, "page actions normal");
    });
  });

  test("compact: actions live in a More actions menu; Esc closes it and returns focus; an outside press closes it", async () => {
    await withApp({ width: 400, height: 800 }, async ({ page }) => {
      await openRoute(page, "#/gallery/actions");
      const more = page.getByRole("button", { name: "More actions" });
      await more.waitFor();
      assert.equal(await page.getByRole("button", { name: "First" }).count(), 0);
      assert.ok((await more.boundingBox())!.width >= 44);
      await more.click();
      assert.equal(await more.getAttribute("aria-expanded"), "true");
      await page.getByRole("button", { name: "First" }).waitFor();
      await expectAxeClean(page, "page actions menu open");
      await page.keyboard.press("Escape");
      await page.locator("#page-actions-panel").waitFor({ state: "detached" });
      assert.equal(await active(page), "BUTTON:More actions");
      await more.click();
      await page.locator("h1").click();
      await page.locator("#page-actions-panel").waitFor({ state: "detached" });
    });
  });

  test("the header More menu and the page More menu are independent", async () => {
    await withApp({ width: 400, height: 800 }, async ({ page }) => {
      await openRoute(page, "#/gallery/actions");
      await page.getByRole("button", { name: "More actions" }).click();
      await page.getByRole("button", { name: "More", exact: true }).click();
      await page.locator("#more-panel").waitFor();
      assert.equal(await page.locator("#page-actions-panel").count(), 0, "pressing outside the page menu closed it");
      await page.keyboard.press("Escape");
      await page.locator("#more-panel").waitFor({ state: "detached" });
    });
  });
});

describe("Card and Badge", opts, () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`axe clean in ${scheme}`, async () => {
      await withApp({ colorScheme: scheme }, async ({ page }) => {
        await openRoute(page, "#/gallery/patterns");
        await page.getByRole("group", { name: "Card" }).waitFor();
        await expectAxeClean(page, `cards ${scheme}`);
      });
    });
  }
});
