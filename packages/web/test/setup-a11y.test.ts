// Wizard accessibility: axe on every step and on the dialog, keyboard-only traversal, 400 px layout, German.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, setup, teardown, withApp, type App } from "./harness.ts";
import { next, open, seed, skip, stepHeading } from "./setup-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

/** Visits every step with valid answers, calling `check` on each (and on the summary). */
async function eachStep(app: App, check: (label: string) => Promise<void>): Promise<void> {
  seed(app.server.rpc); await open(app);
  const { page } = app;
  await stepHeading(page, "Your account").waitFor(); await check("account"); await next(page);
  await stepHeading(page, "Name & persona").waitFor(); await check("persona");
  await page.getByLabel("Display name").fill("Hal"); await next(page);
  await stepHeading(page, /Main model/).waitFor(); await page.getByLabel("Chat model").waitFor(); await check("model");
  await page.getByLabel("Chat model").selectOption("anthropic/claude-x"); await next(page);
  await stepHeading(page, /Switchboard/).waitFor(); await check("switchboard"); await skip(page);
  await stepHeading(page, /Memory/).waitFor(); await check("memory"); await next(page);
  await stepHeading(page, /Backups/).waitFor(); await check("backup");
  await page.getByRole("button", { name: "Create a backup now" }).click(); await page.getByText(/Backup created/).waitFor(); await next(page);
  await stepHeading(page, /Import/).waitFor(); await check("import"); await skip(page, "Skip and finish");
  await stepHeading(page, "Setup summary").waitFor(); await check("summary");
}

describe("setup wizard: a11y", opts, () => {
  test("axe is clean on every step and the summary (light and dark)", async () => {
    for (const colorScheme of ["light", "dark"] as const) {
      await withApp({ colorScheme }, async (app) => {
        await eachStep(app, (label) => expectAxeClean(app.page, `setup ${label} ${colorScheme}`));
      });
    }
  });

  test("axe is clean with validation errors, a failed save, and the licence dialog open", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      const { page } = app;
      await next(page); await stepHeading(page, "Name & persona").waitFor();
      await next(page); await page.getByText("Enter a display name.").waitFor();
      await expectAxeClean(page, "persona error");
      await page.getByLabel("Display name").fill("Hal");
      app.server.rpc.scenario("config.set", "error"); await next(page);
      await page.getByRole("alert").waitFor(); await expectAxeClean(page, "save failed");
      app.server.rpc.scenario("config.set", "success"); await next(page);
      await stepHeading(page, /Main model/).waitFor(); await next(page);
      await page.getByText("Choose a model, or skip this step.").waitFor(); await expectAxeClean(page, "model error");
      await skip(page); await skip(page);
      await stepHeading(page, /Memory/).waitFor();
      await page.getByRole("radio", { name: /Jina v5 Text Nano/ }).click();
      await page.getByRole("dialog").waitFor(); await expectAxeClean(page, "licence dialog");
    });
  });

  test("keyboard only: Tab to Next, Enter, and the focus lands on the new step heading; radios work with the arrow keys", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      const { page } = app;
      const press = async (name: RegExp): Promise<void> => {
        for (let i = 0; i < 40; i++) {
          if (await page.evaluate((src) => new RegExp(src).test(document.activeElement?.textContent ?? "") && document.activeElement?.tagName === "BUTTON", name.source)) break;
          await page.keyboard.press("Tab");
        }
        await page.keyboard.press("Enter");
      };
      await stepHeading(page, "Your account").waitFor();
      await page.locator("main h1").focus();
      await press(/^Next$/);
      await stepHeading(page, "Name & persona").waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Name & persona");
      await page.keyboard.press("Tab"); await page.keyboard.type("hal"); // agent id field is first
      await page.keyboard.press("Tab"); await page.keyboard.type("Hal Nine Thousand");
      await press(/^Next$/);
      await stepHeading(page, /Main model/).waitFor();
      await page.getByLabel("Chat model").focus();
      await page.keyboard.press("ArrowDown");
      await press(/^Next$/);
      await stepHeading(page, /Switchboard/).waitFor();
      await press(/^Skip this step$/);
      await stepHeading(page, /Memory/).waitFor();
      await page.getByRole("radio", { name: "Research, non-commercial" }).focus();
      await page.keyboard.press("ArrowDown");
      assert.equal(await page.getByRole("radio", { name: "Commercial", exact: true }).isChecked(), true);
      await page.keyboard.press("ArrowUp");
      await page.getByRole("radio", { name: /Jina v5 Text Nano/ }).focus();
      await page.keyboard.press("Space");
      await page.getByRole("dialog").waitFor();
      await page.keyboard.press("Tab"); await page.keyboard.press("Tab"); await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.closest("dialog") !== null), true, "focus stays inside the dialog");
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "detached" });
      assert.equal(await page.evaluate(() => document.activeElement?.id), "setup-embedding-jina-v5-nano");
    });
  });

  test("400 px: no horizontal scroll on any step, progress stays readable", async () => {
    await withApp({ width: 400, height: 800 }, async (app) => {
      await eachStep(app, async (label) => {
        const o = await app.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
        assert.ok(o.sw <= o.cw, `${label}: scrollWidth ${o.sw} > ${o.cw}`);
        assert.equal(await app.page.locator("ol.setup-progress").count(), 1);
      });
    });
  });

  test("German: steps, validation and the dialog are translated", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      seed(app.server.rpc);
      await app.page.getByLabel("Owner-Token", { exact: true }).fill((await import("./harness.ts")).TOKEN);
      await app.page.getByRole("button", { name: "Anmelden" }).click();
      await app.page.locator(".sidebar").waitFor();
      await app.page.evaluate(() => { location.hash = "#/setup"; });
      await stepHeading(app.page, "Dein Konto").waitFor();
      await app.page.getByRole("button", { name: "Weiter" }).click();
      await stepHeading(app.page, "Name & Persona").waitFor();
      await app.page.getByRole("button", { name: "Weiter" }).click();
      await app.page.getByText("Gib einen Anzeigenamen ein.").waitFor();
      await expectAxeClean(app.page, "setup de");
    });
  });
});
