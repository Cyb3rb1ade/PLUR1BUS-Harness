// Desktop spec §13.7 / M3 acceptance 9, as far as this shell goes: modes, widths, targets, text size, no horizontal scroll.
// Snapshots are structural (numbers and booleans from the live layout) so they are the same on every OS; pixel screenshots
// vary with fonts and are written to PLUR1BUS_WEB_SHOTS_DIR when that is set, never committed.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Page } from "playwright";
import { withChat } from "./chat-fixtures.ts";
import { browserSkip, setup, signIn, teardown, withApp } from "./harness.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const FIXTURE = new URL("./fixtures/responsive.json", import.meta.url);
const UPDATE = process.env.UPDATE_SNAPSHOTS === "1";
const SHOTS = process.env.PLUR1BUS_WEB_SHOTS_DIR;

// 400 (minimum at 200 % zoom), 720 (a 1440 window at 200 %), 960 (compact example), 1024 (first normal), 1440 (reference),
// 1600 (last normal), 1601 (first wide), 2560 (wide example).
const WIDTHS = [400, 720, 960, 1023, 1024, 1440, 1600, 1601, 2560] as const;
const SNAPSHOT_WIDTHS = [400, 960, 1440, 2560] as const;

type Metrics = {
  mode: "rail" | "full";
  sidebarWidth: number;
  menuButton: boolean;
  navLabelsVisible: boolean;
  groupLabelsVisible: boolean;
  headerActions: "inline" | "more";
  mainWidth: number;
  horizontalScroll: boolean;
  minTarget: number;
  minFontPx: number;
};

async function measure(page: Page): Promise<Metrics> {
  return page.evaluate(() => {
    const vis = (el: Element): DOMRect | null => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none" ? r : null;
    };
    const sidebar = document.querySelector(".sidebar") as HTMLElement;
    const interactive = Array.from(document.querySelectorAll("a[href], button, select, input")).filter((e) => !e.classList.contains("skip-link"));
    const sizes = interactive.map(vis).filter((r): r is DOMRect => r !== null).map((r) => Math.min(r.width, r.height));
    let minFont = Infinity;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || !(n.textContent ?? "").trim() || !vis(el)) continue;
      minFont = Math.min(minFont, parseFloat(getComputedStyle(el).fontSize));
    }
    const width = (sel: string): number => Math.round(document.querySelector(sel)?.getBoundingClientRect().width ?? 0);
    return {
      mode: sidebar.getBoundingClientRect().width < 100 ? "rail" : "full",
      sidebarWidth: Math.round(sidebar.getBoundingClientRect().width),
      menuButton: !!vis(document.querySelector(".menu-btn")!),
      navLabelsVisible: !!document.querySelector(".nav-link .label") && (vis(document.querySelector(".nav-link .label")!) !== null),
      groupLabelsVisible: !!vis(document.querySelector(".group-label")!),
      headerActions: document.querySelector(".header-actions.more") ? "more" : "inline",
      mainWidth: width("main"),
      horizontalScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      minTarget: Math.floor(Math.min(...sizes)),
      minFontPx: minFont,
    } as Metrics;
  });
}

const results: Record<string, Metrics> = {};

describe("layout at the reference widths", opts, () => {
  for (const width of WIDTHS) {
    test(`${width} px`, async () => {
      await withApp({ width, height: 800 }, async ({ page }) => {
        await signIn(page);
        await page.getByRole("heading", { name: "Chat", level: 1 }).waitFor();
        const m = await measure(page);
        results[String(width)] = m;
        if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `shell-${width}.png`) }); }

        const compact = width < 1024;
        assert.equal(m.mode, compact ? "rail" : "full");
        assert.equal(m.sidebarWidth, compact ? 64 : 256);
        assert.equal(m.menuButton, compact);
        assert.equal(m.navLabelsVisible, !compact);
        assert.equal(m.groupLabelsVisible, !compact);
        assert.equal(m.headerActions, compact ? "more" : "inline");
        assert.equal(m.horizontalScroll, false, "text never scrolls horizontally");
        assert.ok(m.minFontPx >= 12, `text ${m.minFontPx}px < 12px`);
        assert.ok(m.minTarget >= (compact ? 44 : 24), `smallest target ${m.minTarget}px at ${width}px`);
        assert.ok(m.mainWidth <= width - m.sidebarWidth);
        // Forms and reading text never stretch: the project page is capped at 880 px. The landing
        // route is Chat, which is deliberately full width (its transcript is capped separately, see the test below).
        await page.evaluate(() => { location.hash = "#/projects"; });
        await page.getByRole("heading", { name: "Projects", level: 1 }).waitFor();
        // This fixture has no project RPC. Wait for the loaded page, rather than measuring the temporary lazy frame.
        await page.locator('main [data-state="unavailable"]').waitFor();
        const inner = await page.locator(".page-inner").boundingBox();
        assert.ok((inner?.width ?? 0) <= 880);
        if (width > 1600) assert.ok(Math.abs((inner!.x - 256) - (width - inner!.x - inner!.width)) <= 1, `capped content is centred: x=${inner!.x} w=${inner!.width} of ${width}`);
      });
    });
  }

  test("Chat is full width but its transcript stays at 820 px or less: no horizontal scroll at 2560 px", async () => {
    await withChat({ route: "#/chat/ses_1", width: 2560, height: 900, seed: (c) => { c.seed({ id: "ses_1", title: "Hello world", messages: [["user", "Question"], ["assistant", "Answer"]] }); } }, async ({ page }) => {
      await page.getByRole("log", { name: "Conversation with bernd" }).waitFor();
      const r = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        transcript: Math.round(document.querySelector(".chat-pane")!.getBoundingClientRect().width),
      }));
      assert.equal(r.scroll, false, "no horizontal scroll");
      assert.ok(r.transcript > 0 && r.transcript <= 820, `transcript ${r.transcript} px`);
    });
  });

  test("sign-in at every width: no horizontal scroll, targets and text sizes", async () => {
    for (const width of WIDTHS) {
      await withApp({ width, height: 800 }, async ({ page }) => {
        await page.getByRole("heading", { name: "Sign in", level: 1 }).waitFor();
        const s = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
        assert.equal(s, false, `${width}`);
        const sizes = await page.evaluate(() => Array.from(document.querySelectorAll("a, button, select, input")).map((e) => { const r = e.getBoundingClientRect(); return Math.min(r.width, r.height); }));
        assert.ok(Math.min(...sizes) >= (width < 1024 ? 44 : 24), `${width}: ${Math.min(...sizes)}`);
      });
    }
  });

  test("structural snapshots at 400, 960, 1440 and 2560 match test/fixtures/responsive.json", () => {
    const actual = Object.fromEntries(SNAPSHOT_WIDTHS.map((w) => [String(w), results[String(w)]]));
    if (UPDATE) { writeFileSync(FIXTURE, JSON.stringify(actual, null, 2) + "\n"); return; }
    assert.deepEqual(actual, JSON.parse(readFileSync(FIXTURE, "utf8")));
  });
});

describe("compact overlay and sheets", opts, () => {
  test("the menu button opens a 288 px overlay over a scrim; Esc, the scrim and a link close it; focus returns", async () => {
    await withApp({ width: 400, height: 800 }, async ({ page }) => {
      await signIn(page);
      await page.getByRole("heading", { name: "Chat", level: 1 }).waitFor();
      const menu = page.getByRole("button", { name: "Open menu" });
      await menu.click();
      const aside = page.locator(".sidebar");
      await page.locator(".sidebar[data-open=true]").waitFor();
      assert.equal(Math.round((await aside.boundingBox())!.width), 288);
      assert.equal(await page.locator(".scrim").isVisible(), true);
      assert.equal(await page.locator(".group-label").first().isVisible(), true);
      assert.equal(await page.locator(".content").getAttribute("inert"), "");
      assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("nav-link")), true);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, "overlay-400.png") });

      await page.keyboard.press("Escape");
      await page.locator(".sidebar[data-open=false]").waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("menu-btn")), true);

      await page.getByRole("button", { name: "Open menu" }).click();
      await page.mouse.click(380, 400); // on the scrim, right of the 288 px overlay
      await page.locator(".sidebar[data-open=false]").waitFor();

      await page.getByRole("button", { name: "Open menu" }).click();
      await page.getByRole("navigation").getByRole("link", { name: "Agents" }).click();
      await page.getByRole("heading", { name: "Agents", level: 1 }).waitFor();
      await page.locator(".sidebar[data-open=false]").waitFor();
    });
  });

  test("Tab stays inside the open overlay", async () => {
    await withApp({ width: 400, height: 800 }, async ({ page }) => {
      await signIn(page);
      await page.getByRole("button", { name: "Open menu" }).click();
      await page.locator(".sidebar[data-open=true]").waitFor();
      for (let i = 0; i < 25; i++) {
        await page.keyboard.press("Tab");
        assert.equal(await page.evaluate(() => !!document.activeElement?.closest(".sidebar")), true, `escaped after ${i + 1} tabs`);
      }
      for (let i = 0; i < 25; i++) {
        await page.keyboard.press("Shift+Tab");
        assert.equal(await page.evaluate(() => !!document.activeElement?.closest(".sidebar")), true, `escaped backwards after ${i + 1} tabs`);
      }
    });
  });

  test("growing the window closes the overlay", async () => {
    await withApp({ width: 400, height: 800 }, async ({ page }) => {
      await signIn(page);
      await page.getByRole("button", { name: "Open menu" }).click();
      await page.setViewportSize({ width: 1440, height: 800 });
      await page.locator(".sidebar[data-open=false]").waitFor();
      assert.equal(await page.locator(".scrim").isVisible(), false);
      assert.equal(await page.locator(".content").getAttribute("inert"), null);
    });
  });

  test("header actions move into a More menu: theme works from it, Esc closes it", async () => {
    await withApp({ width: 400, height: 800 }, async ({ page }) => {
      await signIn(page);
      await page.getByRole("button", { name: "More" }).click();
      const panel = page.locator("#more-panel");
      await panel.waitFor();
      assert.equal(await page.getByRole("button", { name: "More" }).getAttribute("aria-expanded"), "true");
      await panel.getByLabel("Theme").selectOption("light");
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
      await panel.getByRole("button", { name: "Sign out" }).waitFor();
      await page.keyboard.press("Escape");
      await panel.waitFor({ state: "detached" });
    });
  });
});

describe("motion", opts, () => {
  test("prefers-reduced-motion leaves no running animation or transition", async () => {
    await withApp({ reducedMotion: "reduce" }, async ({ page }) => {
      await signIn(page);
      await page.getByRole("heading", { name: "Chat", level: 1 }).waitFor();
      assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
      const d = await page.evaluate(() => { const s = getComputedStyle(document.querySelector(".nav-link")!); return { t: s.transitionDuration, a: s.animationName }; });
      assert.match(d.t, /^0(\.0+)?s$/);
      assert.equal(d.a, "none");
    });
  });
});
