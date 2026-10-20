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

      // Table of contents navigation should have quickstart, operations, privacy, etc.
      const toc = page.locator(".help-toc-list");
      await toc.waitFor();
      assert.ok(await page.locator('.help-toc-link[href="#/help/quickstart"]').count() > 0);
      assert.ok(await page.locator('.help-toc-link[href="#/help/operations"]').count() > 0);
      assert.ok(await page.locator('.help-toc-link[href="#/help/privacy"]').count() > 0);
      assert.ok(await page.locator('.help-toc-link[href="#/help/secrets"]').count() > 0);
      assert.ok(await page.locator('.help-toc-link[href="#/help/reembed"]').count() > 0);
      assert.ok(await page.locator('.help-toc-link[href="#/help/chat-models"]').count() > 0);
      assert.ok(await page.locator('.help-toc-link[href="#/help/cloud-embeddings"]').count() > 0);
      assert.ok(await page.locator('.help-toc-link[href="#/help/import-rollback"]').count() > 0);

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
      assert.ok(await page.locator('.help-toc-link[href="#/help/datenschutz"]').count() > 0);
      assert.ok(await page.locator('.help-toc-link[href="#/help/secrets"]').count() > 0);
      assert.ok(await page.locator('.help-toc-link[href="#/help/reembed"]').count() > 0);
      assert.ok(await page.locator('.help-toc-link[href="#/help/chat-modelle"]').count() > 0);
      assert.ok(await page.locator('.help-toc-link[href="#/help/cloud-embeddings"]').count() > 0);
      assert.ok(await page.locator('.help-toc-link[href="#/help/import-rollback"]').count() > 0);
    });
  });

  test("the other-language link of a page opens that page, for different and for equal slugs, and links back", async () => {
    await withApp({}, async ({ page }) => {
      for (const [from, toHref, deHeading, enHeading] of [
        ["recurring-tasks", "#/help/de/wiederkehrende-aufgaben", "Wiederkehrende Aufgaben", "Recurring tasks"],
        ["breakglass", "#/help/de/breakglass", "Break-Glass-Zugriff", "Break-glass access"],
      ] as const) {
        if (from === "recurring-tasks") await openRoute(page, `#/help/${from}`);
        else await page.evaluate((h) => { location.hash = h; }, `#/help/${from}`);
        const article = page.locator("#help-article");
        await article.locator("h2").filter({ hasText: enHeading }).waitFor();
        await article.locator(`a[href="${toHref}"]`).click();
        await article.locator("h2").filter({ hasText: deHeading }).waitFor();
        // The German page keeps its own table of contents and links back to the English one.
        await page.locator(`.help-toc-link.active[href="${toHref}"]`).waitFor();
        await article.locator(`a[href="#/help/${from}"]`).click();
        await article.locator("h2").filter({ hasText: enHeading }).waitFor();
      }
    });
  });

  test("a German page opened from the English UI keeps its anchors and bare links in German", async () => {
    await withApp({}, async ({ page }) => {
      await openRoute(page, "#/help/de/quickstart");
      const article = page.locator("#help-article");
      await article.locator("h2").first().waitFor();
      const bare = await article.locator('a[href^="#/help/"]').evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""));
      assert.ok(bare.length > 0);
      for (const href of bare) assert.ok(href.startsWith("#/help/de/") || href === "#/help/quickstart", href);
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
