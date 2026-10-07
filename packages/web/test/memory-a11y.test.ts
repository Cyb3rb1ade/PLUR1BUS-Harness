// Memories & Dreams (M3 E7): axe WCAG 2.1 AA per tab and state, layout at 400/960/1440/2560 px and 200 % zoom, keyboard paths.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Page } from "playwright";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { defaultFixture, installMemoryMocks, makePhase, type Fixture } from "./memory-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

async function open(app: App, hash: string, tweak?: (fx: Fixture, app: App) => void): Promise<Fixture> {
  const fx = installMemoryMocks(app.server, defaultFixture());
  tweak?.(fx, app);
  await openRoute(app.page, hash);
  return fx;
}

/** Waits until the page has settled (no loading state left) so axe sees the final content. */
async function settled(page: Page): Promise<void> {
  await page.locator("main h1").first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-state="loading"]').length === 0);
}

const phase = (page: Page, name: "Light" | "REM" | "Deep") => page.getByRole("group", { name, exact: true });

describe("axe: Memories tab", opts, () => {
  for (const [scheme, width] of [["light", 1440], ["dark", 1440], ["light", 960], ["dark", 400], ["light", 400]] as const) {
    test(`list, health, search and reviews: ${scheme}, ${width} px`, async () => {
      await withApp({ colorScheme: scheme, width, height: 900 }, async (app) => {
        await open(app, "#/memories");
        await app.page.getByLabel("Search memories").fill("memory 00");
        await app.page.getByRole("button", { name: "Search", exact: true }).click();
        await app.page.getByRole("region", { name: "Search results" }).locator("details summary").click();
        await settled(app.page);
        await expectAxeClean(app.page, `memories ${scheme} ${width}`);
      });
    });

    test(`card detail: ${scheme}, ${width} px`, async () => {
      await withApp({ colorScheme: scheme, width, height: 900 }, async (app) => {
        await open(app, "#/memories/mem_002");
        await app.page.getByRole("region", { name: "Memory details" }).getByRole("heading", { name: "Summary of memory 002" }).waitFor();
        await settled(app.page);
        await expectAxeClean(app.page, `detail ${scheme} ${width}`);
      });
    });
  }

  for (const state of ["empty", "error", "forbidden", "unavailable", "notfound"] as const) {
    test(`list state ${state}`, async () => {
      await withApp({ width: 960, height: 900 }, async (app) => {
        await open(app, state === "notfound" ? "#/memories/nope" : "#/memories", (fx, a) => {
          if (state === "empty") fx.cards = [];
          else if (state === "error") a.server.rpc.scenario("memory.list", "error", { code: "E_INTERNAL", message: "boom" });
          else if (state === "forbidden") a.server.rpc.scenario("memory.list", "forbidden");
          else if (state === "unavailable") { a.server.rpc.scenario("memory.list", "unavailable"); a.server.rpc.scenario("memory.state", "unavailable"); a.server.rpc.scenario("memory.proposals.list", "unavailable"); }
        });
        await settled(app.page);
        await expectAxeClean(app.page, `list ${state}`);
      });
    });
  }

  test("whole backend missing (page-level unavailable) and a search that failed", async () => {
    await withApp({ width: 400, height: 800 }, async (app) => {
      await openRoute(app.page, "#/memories");
      await app.page.getByRole("heading", { name: "Memory is not available" }).waitFor();
      await expectAxeClean(app.page, "page unavailable");
    });
    await withApp({ width: 960, height: 800 }, async (app) => {
      await open(app, "#/memories", (_fx, a) => { a.server.rpc.scenario("memory.recall", "error", { code: "E_INTERNAL", message: "x" }); });
      await app.page.getByLabel("Search memories").fill("abc");
      await app.page.getByRole("button", { name: "Search", exact: true }).click();
      await app.page.getByRole("region", { name: "Search results" }).getByRole("alert").waitFor();
      await expectAxeClean(app.page, "search failed");
    });
  });

  test("German", async () => {
    await withApp({ locale: "de-DE", width: 1440, height: 900 }, async (app) => {
      installMemoryMocks(app.server);
      await openRoute(app.page, "#/memories/mem_002", "de");
      await app.page.getByRole("region", { name: "Details der Erinnerung" }).getByRole("heading", { name: "Summary of memory 002" }).waitFor();
      await settled(app.page);
      await expectAxeClean(app.page, "memories de");
    });
  });
});

describe("axe: Dreams tab", opts, () => {
  for (const [scheme, width] of [["light", 1440], ["dark", 960], ["dark", 400], ["light", 400]] as const) {
    test(`status and run log: ${scheme}, ${width} px`, async () => {
      await withApp({ colorScheme: scheme, width, height: 900 }, async (app) => {
        await open(app, "#/memories/dreams", (_fx, a) => { a.server.events.enable(); });
        await phase(app.page, "Light").waitFor();
        await settled(app.page);
        await expectAxeClean(app.page, `dreams ${scheme} ${width}`);
      });
    });

    test(`run detail with log: ${scheme}, ${width} px`, async () => {
      await withApp({ colorScheme: scheme, width, height: 900 }, async (app) => {
        await open(app, "#/memories/dreams/run_003");
        await app.page.getByRole("region", { name: "Run details" }).getByLabel("Run log").waitFor();
        await settled(app.page);
        await expectAxeClean(app.page, `run ${scheme} ${width}`);
      });
    });
  }

  test("never ran, breaker open, role refusals", async () => {
    await withApp({ width: 960, height: 900 }, async (app) => {
      await open(app, "#/memories/dreams", (fx) => {
        fx.runs = [];
        fx.phases = [makePhase("light"), makePhase("rem", { breaker: { state: "open", until: 1_790_000_000_000, reason: "breaker_sessions", sessionsUsed: 3, limit: 3 }, running: true }), makePhase("deep")];
      });
      await settled(app.page);
      await expectAxeClean(app.page, "never ran");
    });
    await withApp({ width: 960, height: 900 }, async (app) => {
      await open(app, "#/memories/dreams", (_fx, a) => { a.server.rpc.scenario("dreams.run", "forbidden"); });
      await phase(app.page, "Light").getByRole("button", { name: "Run now" }).click();
      await app.page.getByRole("dialog").getByRole("alert").waitFor();
      await expectAxeClean(app.page, "dialog with refusal");
      await app.page.getByRole("button", { name: "Cancel" }).click();
      await app.page.getByText(/The server refused this/).first().waitFor();
      await expectAxeClean(app.page, "disabled action with reason");
    });
  });

  for (const state of ["unavailable", "error", "forbidden"] as const) {
    test(`status ${state}`, async () => {
      await withApp({ width: 400, height: 800 }, async (app) => {
        await open(app, "#/memories/dreams", (_fx, a) => { a.server.rpc.scenario("dreams.status", state, state === "error" ? { code: "E_INTERNAL", message: "boom" } : undefined); });
        await settled(app.page);
        await expectAxeClean(app.page, `dreams ${state}`);
      });
    });
  }

  test("run dialog (plan, would-not-run) and enable/disable dialog, dark and compact", async () => {
    await withApp({ colorScheme: "dark", width: 400, height: 800 }, async (app) => {
      await open(app, "#/memories/dreams");
      await phase(app.page, "Light").getByRole("button", { name: "Run now" }).click();
      await app.page.getByRole("dialog").getByText("The guards allow this run").waitFor();
      await expectAxeClean(app.page, "run dialog");
      await app.page.getByRole("button", { name: "Cancel" }).click();
      await phase(app.page, "Light").getByRole("button", { name: "Disable" }).click();
      await app.page.getByRole("dialog").waitFor();
      await expectAxeClean(app.page, "disable dialog");
    });
    await withApp({ width: 960, height: 800 }, async (app) => {
      await open(app, "#/memories/dreams", (fx) => { fx.planWouldRun = false; });
      await phase(app.page, "Light").getByRole("button", { name: "Run now" }).click();
      await app.page.getByRole("dialog").getByText("The guards would skip this run").waitFor();
      await expectAxeClean(app.page, "run dialog would not run");
    });
  });

  test("German", async () => {
    await withApp({ locale: "de-DE", width: 1440, height: 900 }, async (app) => {
      installMemoryMocks(app.server);
      await openRoute(app.page, "#/memories/dreams/run_003", "de");
      await app.page.getByRole("region", { name: "Details des Laufs" }).getByLabel("Lauf-Log").waitFor();
      await settled(app.page);
      await expectAxeClean(app.page, "dreams de");
    });
  });
});

type Metrics = { scroll: boolean; minTarget: number; minFont: number; offenders: string[]; mainRight: number; maxRight: number };

async function metrics(page: Page): Promise<Metrics> {
  return page.evaluate(() => {
    const visible = (el: Element): DOMRect | null => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none" ? r : null;
    };
    const offenders: string[] = [];
    let minTarget = Infinity;
    let maxRight = 0;
    for (const el of Array.from(document.querySelectorAll("main a[href], main button, main select, main input, main [role=tab], main summary, dialog[open] button, dialog[open] a[href]"))) {
      const r = visible(el);
      if (!r) continue;
      const size = Math.min(r.width, r.height);
      if (size < minTarget) minTarget = size;
      offenders.push(`${size}:${el.tagName}.${el.className}:${(el.textContent ?? "").trim().slice(0, 20)}`);
    }
    for (const el of Array.from(document.querySelectorAll("main *"))) { const r = visible(el); if (r) maxRight = Math.max(maxRight, r.right); }
    let minFont = Infinity;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (el && (n.textContent ?? "").trim() && visible(el) && !el.closest(".sr-only")) minFont = Math.min(minFont, parseFloat(getComputedStyle(el).fontSize));
    }
    return {
      scroll: document.documentElement.scrollWidth > document.documentElement.clientWidth, minTarget: Math.floor(minTarget), minFont, offenders,
      mainRight: Math.round(document.querySelector("main")!.getBoundingClientRect().right), maxRight: Math.round(maxRight),
    };
  });
}

describe("layout at the reference widths (desktop spec §13.7)", opts, () => {
  const ROUTES = ["#/memories", "#/memories/mem_002", "#/memories/dreams", "#/memories/dreams/run_003"] as const;
  for (const width of [400, 960, 1024, 1440, 2560] as const) {
    test(`${width} px: no horizontal scroll, text >= 12 px, targets >= ${width < 1024 ? 44 : 24} px, nothing wider than the window`, async () => {
      await withApp({ width, height: 900 }, async (app) => {
        installMemoryMocks(app.server);
        await openRoute(app.page, "#/memories");
        for (const route of ROUTES) {
          await app.page.evaluate((h) => { location.hash = h; }, route);
          await settled(app.page);
          if (route === "#/memories") {
            await app.page.getByLabel("Search memories").fill("memory 00");
            await app.page.getByRole("button", { name: "Search", exact: true }).click();
            await app.page.getByRole("region", { name: "Search results" }).locator("details summary").click();
            await app.page.getByText("fusion").waitFor();
          }
          if (route === "#/memories/dreams") await phase(app.page, "Light").waitFor();
          await app.page.waitForTimeout(40);
          const m = await metrics(app.page);
          const need = width < 1024 ? 44 : 24;
          assert.equal(m.scroll, false, `${route}: horizontal scroll`);
          assert.ok(m.minFont >= 12, `${route}: text ${m.minFont}px`);
          assert.ok(m.minTarget >= need, `${route}: smallest target ${m.minTarget}px < ${need}\n${m.offenders.filter((o) => parseFloat(o) < need).join("\n")}`);
          assert.ok(m.mainRight <= width, `${route}: main reaches ${m.mainRight}`);
          assert.ok(m.maxRight <= width, `${route}: content reaches ${m.maxRight}`);
        }
      });
    });
  }

  for (const width of [400, 1024] as const) {
    test(`${width} px: long unbreakable texts (summary, text, run error, log line) wrap instead of overflowing`, async () => {
      await withApp({ width, height: 900 }, async (app) => {
        const long = "x".repeat(160);
        installMemoryMocks(app.server, defaultFixture({
          cards: [{ id: "mem_long", scope: "user", summary: long, text: long, createdAt: 1, origin: long, epistemicStatus: null }],
          runs: [{ ...defaultFixture().runs[0]!, error: { message: long }, reason: long }],
        }));
        await openRoute(app.page, "#/memories/mem_long");
        await app.page.getByRole("region", { name: "Memory details" }).getByRole("heading").waitFor();
        await settled(app.page);
        let m = await metrics(app.page);
        assert.equal(m.scroll, false, "memories");
        assert.ok(m.maxRight <= width, `memories reach ${m.maxRight}`);
        await app.page.evaluate(() => { location.hash = "#/memories/dreams/run_003"; });
        await app.page.getByRole("region", { name: "Run details" }).getByLabel("Run log").waitFor();
        await settled(app.page);
        m = await metrics(app.page);
        assert.equal(m.scroll, false, "dreams");
        assert.ok(m.maxRight <= width, `dreams reach ${m.maxRight}`);
      });
    });
  }

  test("compact shows the list or the detail (with Back); normal shows both columns", async () => {
    await withApp({ width: 400, height: 900 }, async (app) => {
      await open(app, "#/memories");
      const list = app.page.getByRole("region", { name: "Memory cards" });
      await list.getByRole("link").first().waitFor();
      assert.equal(await app.page.getByRole("region", { name: "Memory details" }).count(), 0, "the empty detail pane is out of the accessibility tree");
      await list.getByRole("link").first().click();
      await app.page.getByRole("region", { name: "Memory details" }).getByRole("heading", { name: "Summary of memory 001" }).waitFor();
      assert.equal(await list.count(), 0, "the list is hidden while the detail shows");
      await app.page.getByRole("button", { name: "Back to list" }).click();
      assert.equal(await app.page.evaluate(() => location.hash), "#/memories");
      await list.getByRole("link").first().waitFor();
    });
    await withApp({ width: 1440, height: 900 }, async (app) => {
      await open(app, "#/memories/mem_003");
      await app.page.getByRole("region", { name: "Memory details" }).getByRole("heading", { name: "Summary of memory 003" }).waitFor();
      await app.page.getByRole("region", { name: "Memory cards" }).getByRole("link").first().waitFor();
      const [listRight, detailLeft] = await app.page.evaluate(() => [
        Math.round(document.querySelector('[aria-label="Memory cards"]')!.getBoundingClientRect().right),
        Math.round(document.querySelector('[aria-label="Memory details"]')!.getBoundingClientRect().left),
      ] as const);
      assert.ok(listRight <= detailLeft, `columns side by side: ${listRight} vs ${detailLeft}`);
    });
  });

  test("200 % text zoom of a 1440 window is a 720 px viewport (compact): every route fits without horizontal scrolling", async () => {
    await withApp({ width: 720, height: 900 }, async (app) => {
      installMemoryMocks(app.server);
      await openRoute(app.page, "#/memories");
      for (const route of ["#/memories", "#/memories/mem_002", "#/memories/dreams", "#/memories/dreams/run_003"]) {
        await app.page.evaluate((h) => { location.hash = h; }, route);
        await settled(app.page);
        if (route === "#/memories/dreams") await phase(app.page, "Light").waitFor();
        await app.page.waitForTimeout(60);
        const m = await metrics(app.page);
        assert.equal(m.scroll, false, `${route}: horizontal scroll`);
        assert.ok(m.minTarget >= 44, `${route}: target ${m.minTarget}`);
        assert.ok(m.maxRight <= 720, `${route}: content reaches ${m.maxRight}`);
      }
    });
  });

  test("the page actions move into the More menu in compact and Refresh still works there", async () => {
    await withApp({ width: 400, height: 900 }, async (app) => {
      await open(app, "#/memories");
      await app.page.getByRole("button", { name: "More actions" }).click();
      await app.page.getByRole("button", { name: "Refresh" }).click();
    });
  });
});

describe("keyboard", opts, () => {
  test("tabs: Right/Left/Home/End move and select, the tab is in the URL, only the selected tab is in the Tab order", async () => {
    await withApp({}, async (app) => {
      await open(app, "#/memories");
      const tab = (n: string) => app.page.getByRole("tab", { name: n });
      await tab("Memories").focus();
      await app.page.keyboard.press("ArrowRight");
      await app.page.getByRole("group", { name: "Light", exact: true }).waitFor();
      assert.equal(await app.page.evaluate(() => location.hash), "#/memories/dreams");
      assert.equal(await tab("Dreams").getAttribute("aria-selected"), "true");
      assert.equal(await tab("Memories").getAttribute("tabindex"), "-1");
      await app.page.keyboard.press("Home");
      await app.page.getByRole("region", { name: "Memory cards" }).getByRole("link").first().waitFor();
      assert.equal(await app.page.evaluate(() => location.hash), "#/memories");
      await app.page.keyboard.press("End");
      await app.page.getByRole("group", { name: "Light", exact: true }).waitFor();
      await app.page.keyboard.press("ArrowLeft");
      await app.page.getByRole("region", { name: "Memory cards" }).getByRole("link").first().waitFor();
    });
  });

  test("list -> detail -> back with the keyboard only (compact): Enter opens, Back returns focus to the list", async () => {
    await withApp({ width: 400, height: 900 }, async (app) => {
      await open(app, "#/memories");
      const first = app.page.getByRole("region", { name: "Memory cards" }).getByRole("link").first();
      await first.focus();
      await app.page.keyboard.press("Enter");
      await app.page.getByRole("region", { name: "Memory details" }).getByRole("heading", { name: "Summary of memory 001" }).waitFor();
      assert.equal(await app.page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Memory details");
      await app.page.getByRole("button", { name: "Back to list" }).focus();
      await app.page.keyboard.press("Enter");
      await app.page.getByRole("region", { name: "Memory cards" }).getByRole("link").first().waitFor();
      assert.equal(await app.page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Memory cards");
    });
  });

  test("search: type and press Enter submits; the explanation toggles with Enter and Space", async () => {
    await withApp({}, async (app) => {
      await open(app, "#/memories");
      await app.page.getByLabel("Search memories").fill("memory 00");
      await app.page.keyboard.press("Enter");
      const res = app.page.getByRole("region", { name: "Search results" });
      await res.getByText("Summary of memory 001").waitFor();
      await res.locator("summary").focus();
      await app.page.keyboard.press("Enter");
      await res.getByText("fusion").waitFor();
      await app.page.keyboard.press("Space");
      await res.getByText("fusion").waitFor({ state: "hidden" });
    });
  });

  test("dialog: opens from the keyboard, focus stays inside (Tab and Shift+Tab wrap), Esc closes and returns focus to the opener", async () => {
    await withApp({}, async (app) => {
      await open(app, "#/memories/dreams");
      const opener = phase(app.page, "Light").getByRole("button", { name: "Run now" });
      await opener.focus();
      await app.page.keyboard.press("Enter");
      const dlg = app.page.getByRole("dialog");
      await dlg.getByText("The guards allow this run").waitFor();
      const inside = () => app.page.evaluate(() => !!document.activeElement?.closest("dialog"));
      for (let i = 0; i < 6; i++) { await app.page.keyboard.press("Tab"); assert.equal(await inside(), true, `Tab ${i}`); }
      for (let i = 0; i < 6; i++) { await app.page.keyboard.press("Shift+Tab"); assert.equal(await inside(), true, `Shift+Tab ${i}`); }
      await app.page.keyboard.press("Escape");
      await dlg.waitFor({ state: "detached" });
      assert.equal(await app.page.evaluate(() => document.activeElement?.textContent), "Run now");
    });
  });

  test("dialog confirm with the keyboard: Tab to Run now, Enter runs once", async () => {
    await withApp({}, async (app) => {
      await open(app, "#/memories/dreams");
      await phase(app.page, "Light").getByRole("button", { name: "Run now" }).focus();
      await app.page.keyboard.press("Enter");
      const dlg = app.page.getByRole("dialog");
      await dlg.getByText("The guards allow this run").waitFor();
      await dlg.getByRole("button", { name: "Run now" }).focus();
      await app.page.keyboard.press("Enter");
      await app.page.getByRole("status").filter({ hasText: "finished as run" }).waitFor();
      assert.equal(app.server.rpc.calls.filter((c) => c.method === "dreams.run" && !(c.params as { dryRun?: boolean }).dryRun).length, 1);
    });
  });

  test("run list -> run detail by keyboard in the Dreams tab, and the Back link of the pane", async () => {
    await withApp({ width: 400, height: 900 }, async (app) => {
      await open(app, "#/memories/dreams");
      const link = app.page.getByRole("region", { name: "Dream runs" }).getByRole("link").first();
      await link.focus();
      await app.page.keyboard.press("Enter");
      await app.page.getByRole("region", { name: "Run details" }).getByText("run_003").first().waitFor();
      await app.page.getByRole("button", { name: "Back to list" }).focus();
      await app.page.keyboard.press("Enter");
      assert.equal(await app.page.evaluate(() => location.hash), "#/memories/dreams");
    });
  });
});
