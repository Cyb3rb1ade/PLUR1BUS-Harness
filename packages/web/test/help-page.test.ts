import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { axeViolations } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

describe("Help page (docs/user)", opts, () => {
  test("renders handbook without HTML injection and shows table of contents", async () => {
    await withApp({}, async ({ page }) => {
      await openRoute(page, "#/help");
      await page.getByRole("heading", { name: "User Handbook", level: 1 }).waitFor();

      // Table of contents navigation should have quickstart, operations, etc.
      const toc = page.locator(".help-toc-list");
      await toc.waitFor();
      assert.ok(await page.locator('.help-toc-link[href="#/help/quickstart"]').count() > 0);
      assert.ok(await page.locator('.help-toc-link[href="#/help/operations"]').count() > 0);

      // Markdown rendered content
      const article = page.locator("#help-article");
      await article.waitFor();
      assert.ok(await article.locator("h2, h3, p").count() > 0);

      // Ensure no raw unescaped script tag executed or injected into DOM
      assert.equal(await article.locator("script").count(), 0);
    });
  });

  test("deep-linking to a page (#/help/operations) loads that page", async () => {
    await withApp({}, async ({ page }) => {
      await openRoute(page, "#/help/operations");
      await page.getByRole("heading", { name: "User Handbook", level: 1 }).waitFor();

      // Check active link in TOC
      const activeLink = page.locator('.help-toc-link.active[href="#/help/operations"]');
      await activeLink.waitFor();
      assert.equal(await activeLink.textContent(), "Operations handbook");

      // Verify page content contains operations text
      const article = page.locator("#help-article");
      await page.waitForFunction(() => location.hash === "#/help/operations");
      assert.ok(await article.innerText().then((t) => t.includes("Operations") || t.includes("home")));
    });
  });

  test("local search filters the table of contents", async () => {
    await withApp({}, async ({ page }) => {
      await openRoute(page, "#/help");
      await page.getByRole("heading", { name: "User Handbook", level: 1 }).waitFor();

      const searchInput = page.locator(".help-search-input");
      await searchInput.fill("voice");

      // Only matching items should remain
      assert.ok(await page.locator('.help-toc-link[href="#/help/voice"]').count() > 0);
      assert.equal(await page.locator('.help-toc-link[href="#/help/quickstart"]').count(), 0);
    });
  });

  test("language switch: UI in German loads German docs/user", async () => {
    await withApp({ locale: "de-DE" }, async ({ page }) => {
      await openRoute(page, "#/help", "de");
      await page.getByRole("heading", { name: "Benutzerhandbuch", level: 1 }).waitFor();

      // German TOC entries
      assert.ok(await page.locator('.help-toc-link[href="#/help/schnellstart"]').count() > 0 || await page.locator('.help-toc-link[href="#/help/quickstart"]').count() > 0);
      assert.ok(await page.locator('.help-toc-link[href="#/help/betriebshandbuch"]').count() > 0 || await page.locator('.help-toc-link[href="#/help/operations"]').count() > 0);
    });
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`no serious or critical axe violations on handbook pages with links and code blocks (${scheme})`, async () => {
      for (const route of ["#/help", "#/help/quickstart", "#/help/operations"]) {
        await withApp({ colorScheme: scheme, width: 1280, height: 800 }, async ({ page }) => {
          await openRoute(page, route);
          await page.locator("#help-article h2").first().waitFor();
          const bad = (await axeViolations(page)).filter((v) => v.impact === "serious" || v.impact === "critical");
          assert.deepEqual(bad.map((v) => `${route}: ${v.id}`), []);
        });
      }
    });
  }
});
