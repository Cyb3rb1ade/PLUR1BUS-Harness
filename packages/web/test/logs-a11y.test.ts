// Log viewer accessibility (K8): axe WCAG 2.1 AA in every state, 400 px layout without page scroll, 200 % zoom.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Page } from "playwright";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";
import { installLogsMocks, makeLines, makeRecord } from "./logs-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const rows = (p: Page) => p.locator('[role="row"][data-row]');
const noPageScroll = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

describe("logs axe", opts, () => {
  test("loaded list, paused tail, detail dialog", async () => {
    await withApp({}, async (app) => {
      const m = installLogsMocks(app.server, { lines: [...makeLines(20), makeRecord(21, { level: "error" })] });
      await openRoute(app.page, "#/logs");
      await rows(app.page).first().waitFor();
      await app.page.locator(".logs-tail-state").getByText("Live").waitFor();
      await expectAxeClean(app.page, "loaded");
      await app.page.getByRole("button", { name: "Pause live tail" }).click();
      m.push(makeRecord(40));
      await app.page.locator(".logs-new").waitFor();
      await expectAxeClean(app.page, "paused with new entries");
      await app.page.getByRole("search", { name: "Log filters" }).getByLabel("Time range").selectOption("custom");
      await expectAxeClean(app.page, "custom range");
      await rows(app.page).nth(6).click();
      await app.page.getByRole("dialog", { name: "Log entry" }).waitFor();
      await expectAxeClean(app.page, "detail");
    });
  });

  test("redacted detail, empty, error, forbidden, unavailable", async () => {
    await withApp({}, async (app) => {
      installLogsMocks(app.server, { lines: [makeRecord(7)], tail: false });
      await openRoute(app.page, "#/logs");
      await rows(app.page).first().click();
      await app.page.getByRole("dialog", { name: "Log entry" }).getByText("[REDACTED:secret-key]").waitFor();
      await expectAxeClean(app.page, "redacted detail");
      await app.page.keyboard.press("Escape");
      for (const [scenario, heading] of [["empty", "No matching entries"], ["error", "Something went wrong"], ["forbidden", "Not allowed"], ["unavailable", "Not available"]] as const) {
        app.server.rpc.scenario("logs.query", scenario === "empty" ? "success" : scenario);
        if (scenario === "empty") app.server.rpc.handle("logs.query", () => ({ records: [], nextCursor: null, corrupt: 0, scanned: { files: 1, bytes: 1 }, truncated: false }), { write: false });
        await app.page.getByRole("search", { name: "Log filters" }).getByLabel("Search text").fill("x");
        await app.page.getByRole("search", { name: "Log filters" }).getByRole("button", { name: "Apply filters" }).click();
        await app.page.getByRole("heading", { name: heading }).waitFor();
        await expectAxeClean(app.page, scenario);
      }
    });
    await withApp({}, async (app) => {
      installLogsMocks(app.server, { query: false, tail: false });
      await openRoute(app.page, "#/logs");
      await app.page.getByRole("heading", { name: "Logs are not available" }).waitFor();
      await expectAxeClean(app.page, "unavailable (no method)");
    });
  });

  test("German, dark theme", async () => {
    await withApp({ locale: "de-DE", colorScheme: "dark" }, async (app) => {
      installLogsMocks(app.server, { lines: makeLines(20), tail: false });
      await openRoute(app.page, "#/logs", "de");
      await rows(app.page).first().waitFor();
      await expectAxeClean(app.page, "de dark");
    });
  });
});

describe("logs layout", opts, () => {
  for (const width of [400, 960, 1440]) {
    test(`${width} px: no horizontal page scroll, rows readable, filters reachable`, async () => {
      await withApp({ width, height: 800 }, async (app) => {
        installLogsMocks(app.server, { lines: makeLines(60), tail: false });
        await openRoute(app.page, "#/logs");
        await rows(app.page).first().waitFor();
        assert.equal(await noPageScroll(app.page), true);
        const box = await rows(app.page).first().boundingBox();
        assert.ok(box && box.width <= width, `row width ${box?.width}`);
        await app.page.getByRole("search", { name: "Log filters" }).getByRole("button", { name: "Apply filters" }).scrollIntoViewIfNeeded();
        await app.page.getByRole("dialog").count();
        if (width === 400) {
          await expectAxeClean(app.page, "400px");
          await rows(app.page).first().click();
          const dlg = app.page.getByRole("dialog", { name: "Log entry" });
          await dlg.waitFor();
          assert.equal(await noPageScroll(app.page), true);
          const b = await dlg.boundingBox();
          assert.ok(b && b.x >= 0 && b.x + b.width <= 401, "dialog fits the window");
          await expectAxeClean(app.page, "400px detail");
        }
      });
    });
  }

  test("200 % zoom at 1280 px (an effective 640 px window) keeps the page free of horizontal scroll", async () => {
    await withApp({ width: 640, height: 600 }, async (app) => {
      installLogsMocks(app.server, { lines: makeLines(60), tail: false });
      await openRoute(app.page, "#/logs");
      await rows(app.page).first().waitFor();
      await app.page.addStyleTag({ content: "html { zoom: 2; }" });
      assert.equal(await noPageScroll(app.page), true);
    });
  });
});
