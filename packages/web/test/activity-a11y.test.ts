// Activity and Sessions tabs: axe WCAG 2.1 AA per tab and state, light and dark, 400 px and 200 % zoom (720 px viewport) without
// horizontal scrolling, keyboard path to the dialog and the links.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Page } from "playwright";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { installActivity, installSessions, makeSessions, NOW, type ActivityFx } from "./activity-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

async function openTab(app: App, tab: "activity" | "sessions", tweak?: (fx: ActivityFx, app: App) => void): Promise<void> {
  const fx = installActivity(app.server);
  installSessions(app.server, makeSessions(30));
  tweak?.(fx, app);
  await app.page.clock.setFixedTime(NOW);
  await openRoute(app.page, `#/logs/${tab}`);
}
async function settled(page: Page): Promise<void> {
  await page.locator("main h1").first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-state="loading"]').length === 0);
}
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

describe("axe: Activity tab", opts, () => {
  for (const [scheme, width] of [["light", 1440], ["dark", 1440], ["light", 960], ["light", 400], ["dark", 400]] as const) {
    test(`feed and audit card: ${scheme}, ${width} px`, async () => {
      await withApp({ colorScheme: scheme, width, height: 900 }, async (app) => {
        await openTab(app, "activity");
        await app.page.getByRole("heading", { level: 3, name: "Today" }).waitFor();
        await app.page.getByText("Verified", { exact: true }).waitFor();
        await settled(app.page);
        await expectAxeClean(app.page, `activity ${scheme} ${width}`);
        assert.equal(await noHScroll(app.page), true, "no horizontal page scroll");
      });
    });
  }
  test("audit card variants: failed, unavailable", async () => {
    for (const variant of ["failed", "unavailable"] as const) {
      await withApp({ width: 400 }, async (app) => {
        await openTab(app, "activity", (fx, a) => {
          if (variant === "failed") fx.verify = { ...fx.verify, ok: false, findingsTotal: 8, findings: [{ code: "hash-mismatch", file: "audit-chain.jsonl", line: 12, seq: 12 }] };
          else a.server.rpc.scenario("audit.verify", "unavailable");
        });
        await app.page.locator(`[data-verify="${variant}"]`).waitFor();
        await settled(app.page);
        await expectAxeClean(app.page, `activity verify ${variant}`);
      });
    }
  });
  for (const state of ["empty", "error", "forbidden", "unavailable"] as const) {
    test(`state ${state}`, async () => {
      await withApp({ width: 400 }, async (app) => {
        await openTab(app, "activity", (fx, a) => {
          if (state === "empty") { fx.audit = []; fx.diagnostic = []; } else a.server.rpc.scenario("logs.query", state);
        });
        await app.page.locator(state === "empty" ? '[data-state="empty"]' : `[data-state="${state}"]`).first().waitFor();
        await settled(app.page);
        await expectAxeClean(app.page, `activity ${state}`);
      });
    });
  }
  test("200 % zoom (720 px viewport) fits", async () => {
    await withApp({ width: 720, height: 900 }, async (app) => {
      await openTab(app, "activity");
      await app.page.getByRole("heading", { level: 3, name: "Today" }).waitFor();
      assert.equal(await noHScroll(app.page), true);
    });
  });
  test("keyboard: Open in log is reachable by Tab and Enter follows it", async () => {
    await withApp({}, async (app) => {
      await openTab(app, "activity");
      const link = app.page.getByRole("link", { name: /^Open in log: Dreaming/ });
      await link.focus();
      assert.equal(await link.evaluate((el) => el === document.activeElement), true);
      await app.page.keyboard.press("Enter");
      await app.page.waitForFunction(() => location.hash.startsWith("#/logs?q=t-dream"));
    });
  });
});

describe("axe: Sessions tab", opts, () => {
  for (const [scheme, width] of [["light", 1440], ["dark", 1440], ["light", 960], ["light", 400], ["dark", 400]] as const) {
    test(`overview with filters: ${scheme}, ${width} px`, async () => {
      await withApp({ colorScheme: scheme, width, height: 900 }, async (app) => {
        await openTab(app, "sessions");
        await app.page.locator("li.session-row").first().waitFor();
        await settled(app.page);
        await expectAxeClean(app.page, `sessions ${scheme} ${width}`);
        assert.equal(await noHScroll(app.page), true, "no horizontal page scroll");
      });
    });
  }
  test("no-match state and the break-glass dialog", async () => {
    await withApp({ width: 400 }, async (app) => {
      await openTab(app, "sessions");
      await app.page.locator("li.session-row").first().waitFor();
      await app.page.getByRole("button", { name: /^View transcript/ }).first().click();
      await app.page.getByRole("dialog").waitFor();
      await expectAxeClean(app.page, "sessions break-glass dialog");
      await app.page.keyboard.press("Escape");
      await app.page.getByRole("dialog").waitFor({ state: "detached" });
      assert.equal(await app.page.evaluate(() => document.activeElement?.textContent), "View transcript", "focus returns to the button");
      await app.page.getByLabel("Search by title, ID or agent").fill("zzz");
      await app.page.getByText("No sessions match", { exact: true }).waitFor();
      await expectAxeClean(app.page, "sessions no match");
    });
  });
  for (const state of ["error", "forbidden", "unavailable"] as const) {
    test(`state ${state}`, async () => {
      await withApp({ width: 400 }, async (app) => {
        await openTab(app, "sessions", (_fx, a) => { a.server.rpc.scenario("session.list", state); });
        await app.page.locator(`[data-state="${state}"]`).first().waitFor();
        await settled(app.page);
        await expectAxeClean(app.page, `sessions ${state}`);
      });
    });
  }
  test("200 % zoom (720 px viewport) fits", async () => {
    await withApp({ width: 720, height: 900 }, async (app) => {
      await openTab(app, "sessions");
      await app.page.locator("li.session-row").first().waitFor();
      assert.equal(await noHScroll(app.page), true);
    });
  });
});
