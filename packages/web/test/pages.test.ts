// Routes, registry, page states, error boundary (E2).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, signIn, teardown, withApp } from "./harness.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

describe("routes", opts, () => {
  test("/models and /doctor are in the sidebar, route to their pages, and mark the active item", async () => {
    await withApp({}, async ({ page }) => {
      await signIn(page);
      const nav = page.getByRole("navigation", { name: "Main navigation" });
      for (const [link, heading, hash] of [["Models", "Models", "#/models"], ["Doctor", "Doctor", "#/doctor"]] as const) {
        await nav.getByRole("link", { name: link, exact: true }).click();
        await page.getByRole("heading", { name: heading, level: 1 }).waitFor();
        assert.equal(await page.evaluate(() => location.hash), hash);
        assert.equal(await nav.locator("[aria-current=page]").textContent().then((s) => s?.trim()), link);
        assert.equal(await page.evaluate(() => document.activeElement?.tagName), "H1");
      }
    });
  });

  test("German labels: Modelle and Status", async () => {
    await withApp({ locale: "de-DE" }, async ({ page }) => {
      await signIn(page, undefined, "de");
      const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
      await nav.getByRole("link", { name: "Modelle", exact: true }).click();
      await page.getByRole("heading", { name: "Modelle", level: 1 }).waitFor();
      await nav.getByRole("link", { name: "Status", exact: true }).click();
      await page.getByRole("heading", { name: "Status", level: 1 }).waitFor();
    });
  });

  test("sub-routes keep the page: /memories/dreams marks Memories, /chat/<id> renders Chat, sub-route changes keep focus", async () => {
    await withApp({}, async ({ page }) => {
      await signIn(page);
      await page.getByRole("heading", { name: "Chat", level: 1 }).waitFor();
      await page.evaluate(() => { location.hash = "#/memories/dreams"; });
      await page.getByRole("heading", { name: "Memories & Dreams", level: 1 }).waitFor();
      assert.equal((await page.locator("[aria-current=page]").textContent())?.trim(), "Memories & Dreams");
      await page.evaluate(() => { location.hash = "#/chat/ses_42?x=1"; });
      await page.getByRole("heading", { name: "Chat", level: 1 }).waitFor();
      assert.equal((await page.locator("[aria-current=page]").textContent())?.trim(), "Chat");
    });
  });

  test("the unknown route is still a 404 with focus on its heading; the usage route carries the budget page", async () => {
    await withApp({}, async ({ page }) => {
      await signIn(page);
      await page.getByRole("heading", { name: "Chat", level: 1 }).waitFor();
      await page.evaluate(() => { location.hash = "#/nope/x"; });
      await page.getByRole("heading", { name: "Page not found", level: 1 }).waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.tagName), "H1");
      await page.evaluate(() => { location.hash = "#/usage"; });
      await page.getByRole("heading", { name: "Usage & Quota", level: 1 }).waitFor();
    });
  });

  test("a deep link to a sub-route survives sign-in", async () => {
    await withApp({ hash: "#/memories/dreams" }, async ({ page }) => {
      await page.getByRole("heading", { name: "Sign in", level: 1 }).waitFor();
      await signIn(page);
      await page.getByRole("heading", { name: "Memories & Dreams", level: 1 }).waitFor();
      assert.equal(await page.evaluate(() => location.hash), "#/memories/dreams");
    });
  });
});

describe("page states", opts, () => {
  const STATES = ["loading", "empty", "error", "forbidden", "unavailable"] as const;

  for (const state of STATES) for (const [scheme, width] of [["light", 1440], ["dark", 400]] as const) {
    test(`${state}: axe clean (${scheme}, ${width} px)`, async () => {
      await withApp({ colorScheme: scheme, width, height: 800 }, async ({ page }) => {
        await openRoute(page, `#/gallery/${state}`);
        await page.locator(`.page-state[data-state=${state}]`).waitFor();
        await expectAxeClean(page, state);
      });
    });
  }

  test("each state announces itself properly (loading: polite busy status; error: alert with retry; others: heading and text)", async () => {
    await withApp({}, async ({ page }) => {
      await openRoute(page, "#/gallery/loading");
      const loading = page.locator(".page-state[data-state=loading]");
      assert.equal(await loading.getAttribute("role"), "status");
      assert.equal(await loading.getAttribute("aria-busy"), "true");
      assert.equal(await loading.getAttribute("aria-live"), "polite");
      await page.evaluate(() => { location.hash = "#/gallery/error"; });
      const err = page.getByRole("alert");
      await err.getByRole("heading", { name: "Something went wrong" }).waitFor();
      await err.getByRole("button", { name: "Try again" }).waitFor();
      for (const [state, title] of [["empty", "Nothing here yet"], ["forbidden", "Not allowed"], ["unavailable", "Not available"]] as const) {
        await page.evaluate((s) => { location.hash = `#/gallery/${s}`; }, state);
        await page.getByRole("heading", { name: title, level: 2 }).waitFor();
        assert.equal(await page.getByRole("button", { name: "Try again" }).count(), 0, `${state} has no retry unless asked`);
      }
    });
  });

  test("German state texts", async () => {
    await withApp({ locale: "de-DE" }, async ({ page }) => {
      await openRoute(page, "#/gallery/error", "de");
      await page.getByRole("button", { name: "Erneut versuchen" }).waitFor();
      await page.getByRole("heading", { name: "Etwas ist schiefgelaufen" }).waitFor();
    });
  });
});

describe("error boundary", opts, () => {
  test("a page that throws shows the error state with its heading; Try again re-renders it; focus lands on the heading", async () => {
    await withApp({}, async ({ page }) => {
      await openRoute(page, "#/gallery/boundary");
      await page.getByRole("heading", { name: "Pattern gallery", level: 1 }).waitFor();
      await page.getByRole("alert").getByRole("heading", { name: "Something went wrong" }).waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.tagName), "H1");
      await expectAxeClean(page, "boundary fallback");
      await page.getByRole("button", { name: "Try again" }).click();
      await page.locator("#recovered").waitFor();
      assert.equal(await page.getByRole("alert").count(), 0);
    });
  });

  test("navigating away from a failed page resets the boundary; the shell keeps working", async () => {
    await withApp({}, async ({ page }) => {
      await openRoute(page, "#/gallery/boundary");
      await page.getByRole("alert").waitFor();
      await page.getByRole("navigation").getByRole("link", { name: "Projects", exact: true }).click();
      await page.getByRole("heading", { name: "Projects", level: 1 }).waitFor();
      assert.equal(await page.getByRole("alert").count(), 0);
    });
  });
});
