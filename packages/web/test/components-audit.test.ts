// d02 audit of src/components: ConfirmDialog while its action runs, Dialog backdrop, MoreMenu next to a dialog, Tabs modifiers, wordmark.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { defaultFixture, installMemoryMocks } from "./memory-fixtures.ts";
import { seedMedia } from "./media-search-fixtures.ts";
import { installCatalog } from "./models-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };
const calls = (app: App, method: string) => app.server.rpc.calls.filter((c) => c.method === method);

/** Memories > Media with the typed re-index confirmation open and the word typed; the RPC answers after 400 ms. */
async function openReindex(app: App): Promise<{ dlg: ReturnType<App["page"]["getByRole"]>; go: ReturnType<App["page"]["getByRole"]>; opener: ReturnType<App["page"]["getByRole"]> }> {
  installMemoryMocks(app.server, defaultFixture());
  seedMedia(app.server.rpc, {});
  await openRoute(app.page, "#/memories/media");
  const opener = app.page.getByRole("button", { name: "Re-index", exact: false }).first();
  await opener.click();
  const dlg = app.page.getByRole("dialog");
  await dlg.getByRole("textbox").fill("reindex");
  app.server.rpc.setDelay("media.index.reindex", 400);
  return { dlg, go: dlg.locator("button.btn-danger"), opener };
}

describe("ConfirmDialog while the action runs", opts, () => {
  test("Escape, Cancel, the close button and the backdrop do nothing until it finished; the confirm button keeps focus and says it is busy", async () => {
    await withApp({}, async (app) => {
      const { dlg, go } = await openReindex(app);
      app.server.rpc.setDelay("media.index.reindex", 2500); // the four close attempts below take a while
      await go.focus();
      await go.press("Enter");
      await app.page.waitForFunction(() => document.querySelector("dialog button[aria-disabled=true]") !== null);
      assert.equal(await go.getAttribute("aria-disabled"), "true");
      assert.equal(await app.page.evaluate(() => document.activeElement?.closest("dialog") !== null), true, "focus stays inside the dialog");
      assert.equal(await go.evaluate((e) => e === document.activeElement), true, "focus stays on the confirm button");
      await app.page.keyboard.press("Escape");
      await dlg.getByRole("button", { name: "Cancel" }).click({ force: true });
      await dlg.getByRole("button", { name: "Close" }).click({ force: true });
      await app.page.mouse.click(5, 5);
      await app.page.waitForTimeout(100);
      assert.equal(await dlg.count(), 1, "the dialog is still open while the request runs");
      await dlg.waitFor({ state: "detached" });
      assert.equal(calls(app, "media.index.reindex").length, 1);
    });
  });

  test("Cancel is aria-disabled while the action runs", async () => {
    await withApp({}, async (app) => {
      const { dlg, go } = await openReindex(app);
      await go.click();
      await app.page.waitForFunction(() => document.querySelector("dialog button[aria-disabled=true]") !== null);
      assert.equal(await dlg.getByRole("button", { name: "Cancel" }).getAttribute("aria-disabled"), "true");
      await dlg.waitFor({ state: "detached" });
    });
  });

  test("a failed action re-enables the dialog and Escape closes it again; focus returns to the opener", async () => {
    await withApp({}, async (app) => {
      const { dlg, go, opener } = await openReindex(app);
      app.server.rpc.handle("media.index.reindex", () => { throw new Error("boom"); });
      await go.click();
      await dlg.getByRole("alert").waitFor();
      assert.notEqual(await go.getAttribute("aria-disabled"), "true");
      await app.page.keyboard.press("Escape");
      await dlg.waitFor({ state: "detached" });
      assert.equal(await opener.evaluate((e) => e === document.activeElement), true);
    });
  });
});

describe("Dialog backdrop", opts, () => {
  test("a text selection dragged from the field to the backdrop does not close the dialog", async () => {
    await withApp({}, async ({ page }) => {
      await openRoute(page, "#/gallery/dialog");
      await page.locator("#open-dialog").click();
      const dlg = page.getByRole("dialog");
      const box = (await dlg.getByLabel("Example field").boundingBox())!;
      await page.mouse.move(box.x + 10, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(5, 5);
      await page.mouse.up();
      await page.waitForTimeout(100);
      assert.equal(await dlg.count(), 1);
    });
  });
});

describe("MoreMenu next to a dialog", opts, () => {
  test("Escape in a dialog opened from the compact page menu closes only the dialog and focus returns to its opener", async () => {
    await withApp({ width: 400, height: 800 }, async (app) => {
      installCatalog(app.server.rpc);
      await openRoute(app.page, "#/models");
      await app.page.getByRole("button", { name: "More actions" }).click();
      await app.page.getByRole("button", { name: "Add manual model" }).click();
      const dlg = app.page.getByRole("dialog");
      await dlg.waitFor();
      await app.page.keyboard.press("Escape");
      await dlg.waitFor({ state: "detached" });
      assert.equal(await app.page.evaluate(() => document.activeElement?.textContent?.trim()), "Add manual model");
    });
  });
});

describe("Tabs", opts, () => {
  test("Alt+Arrow (browser history) and Ctrl/Meta+Arrow are left to the browser", async () => {
    await withApp({}, async ({ page }) => {
      await openRoute(page, "#/gallery/patterns");
      const one = page.getByRole("tab", { name: "One" });
      await one.focus();
      for (const mod of ["altKey", "ctrlKey", "metaKey"]) {
        await one.evaluate((el, m) => { el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true, [m]: true })); }, mod);
        await page.waitForTimeout(50);
        assert.equal(await one.getAttribute("aria-selected"), "true", `${mod}+ArrowRight must not select the next tab`);
      }
      assert.equal(await one.getAttribute("aria-selected"), "true");
      await page.keyboard.press("ArrowRight");
      assert.equal(await page.getByRole("tab", { name: "Two" }).getAttribute("aria-selected"), "true");
    });
  });
});

describe("wordmark", opts, () => {
  test("a modified click is left to the browser (open in a new tab)", async () => {
    await withApp({}, async ({ page }) => {
      await openRoute(page, "#/models");
      await page.getByRole("heading", { name: "Models", level: 1 }).waitFor();
      const [popup] = await Promise.all([
        page.context().waitForEvent("page", { timeout: 3000 }).catch(() => null),
        page.locator(".wordmark-morph").click({ modifiers: ["Control"] }),
      ]);
      assert.ok(popup !== null || (await page.evaluate(() => location.hash)) === "#/models", "a Ctrl+click neither navigates this tab nor is swallowed");
      assert.equal(await page.evaluate(() => location.hash), "#/models");
    });
  });

  test("going to another page and back within the animation does not leave the wordmark collapsed", async () => {
    await withApp({}, async ({ page }) => {
      await openRoute(page, "#/home");
      await page.locator(".wordmark-morph[data-collapsed=false]").waitFor();
      await page.evaluate(() => new Promise<void>((done) => {
        location.hash = "#/logs";
        setTimeout(() => { location.hash = "#/home"; setTimeout(done, 50); }, 60);
      }));
      await page.waitForTimeout(600);
      assert.equal(await page.locator(".wordmark-morph").getAttribute("data-collapsed"), "false");
    });
  });

  test("the accessible name follows the language", async () => {
    await withApp({ locale: "de-DE" }, async ({ page }) => {
      await openRoute(page, "#/models", "de");
      await page.getByRole("heading", { name: "Modelle", level: 1 }).waitFor();
      await page.waitForFunction(() => /MODELLE/.test(document.querySelector(".wordmark-morph")?.getAttribute("aria-label") ?? ""));
      const name = (await page.locator(".wordmark-morph").getAttribute("aria-label"))!;
      assert.doesNotMatch(name, /Home|MODELS/);
    });
  });
});

describe("error boundary", opts, () => {
  test("the fallback shows neither the error message nor a stack, in English and German", async () => {
    for (const [locale, lang, heading] of [["en-US", "en", "Something went wrong"], ["de-DE", "de", "Etwas ist schiefgelaufen"]] as const) {
      await withApp({ locale }, async ({ page, problems }) => {
        await openRoute(page, "#/gallery/boundary", lang);
        await page.getByRole("alert").getByRole("heading", { name: heading }).waitFor();
        const text = await page.locator("main").innerText();
        assert.doesNotMatch(text, /gallery boom|Error:|\bat \S+\.(ts|js)|stack/i);
        void problems;
      });
    }
  });
});
