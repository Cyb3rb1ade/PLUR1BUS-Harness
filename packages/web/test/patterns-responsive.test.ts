// Desktop spec §13.7 for the shell and the shared patterns at 400, 960, 1440 and 2560 px, plus layout width tokens and 200 % zoom.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Page } from "playwright";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const WIDTHS = [400, 960, 1440, 2560] as const;
const ROUTES = ["#/chat", "#/models", "#/gallery/patterns", "#/gallery/actions", "#/gallery/list-detail/2", "#/gallery/list-detail", "#/gallery/error", "#/gallery/loading", "#/gallery/empty"] as const;

async function metrics(page: Page): Promise<{ scroll: boolean; minTarget: number; minFont: number; offenders: string[]; mainRight: number }> {
  return page.evaluate(() => {
    const visible = (el: Element): DOMRect | null => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none" ? r : null;
    };
    const offenders: string[] = [];
    let minTarget = Infinity;
    for (const el of Array.from(document.querySelectorAll("a[href], button, select, input, [role=tab]"))) {
      if (el.classList.contains("skip-link")) continue;
      const r = visible(el);
      if (!r) continue;
      const size = Math.min(r.width, r.height);
      if (size < minTarget) minTarget = size;
      offenders.push(`${size}:${el.tagName}.${el.className}:${(el.textContent ?? "").trim().slice(0, 20)}`);
    }
    let minFont = Infinity;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (el && (n.textContent ?? "").trim() && visible(el) && !el.closest(".sr-only")) minFont = Math.min(minFont, parseFloat(getComputedStyle(el).fontSize));
    }
    return {
      scroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      minTarget: Math.floor(minTarget), minFont, offenders, mainRight: Math.round(document.querySelector("main")!.getBoundingClientRect().right),
    };
  });
}

describe("shell and patterns at the reference widths", opts, () => {
  for (const width of WIDTHS) {
    test(`${width} px: no horizontal scroll, text >= 12 px, targets >= ${width < 1024 ? 44 : 24} px, content inside the window`, async () => {
      await withApp({ width, height: 800 }, async ({ page }) => {
        await openRoute(page, "#/chat");
        for (const route of ROUTES) {
          await page.evaluate((h) => { location.hash = h; }, route);
          await page.locator(route.startsWith("#/gallery") ? "main h1" : "main h1").first().waitFor();
          await page.waitForTimeout(30);
          const m = await metrics(page);
          assert.equal(m.scroll, false, `${route}: horizontal scroll`);
          assert.ok(m.minFont >= 12, `${route}: text ${m.minFont}px`);
          const need = width < 1024 ? 44 : 24;
          assert.ok(m.minTarget >= need, `${route}: smallest target ${m.minTarget}px < ${need}\n${m.offenders.filter((o) => parseFloat(o) < need).join("\n")}`);
          assert.ok(m.mainRight <= width, `${route}: main reaches ${m.mainRight}`);
        }
      });
    });
  }
});

describe("width tokens (rule 4)", opts, () => {
  test("tokens: reading 72ch, transcript 820, dialog 680, settings 880 with a 224 nav", async () => {
    await withApp({ width: 2560, height: 900 }, async ({ page }) => {
      const t = await page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        return ["--w-reading", "--w-transcript", "--w-dialog", "--w-settings", "--w-settings-nav"].map((k) => cs.getPropertyValue(k).trim());
      });
      assert.deepEqual(t, ["72ch", "820px", "680px", "880px", "224px"]);
      const classes = await page.evaluate(() => {
        const probe = (cls: string, prop: "maxWidth" | "gridTemplateColumns"): string => { const el = document.createElement("div"); el.className = cls; document.body.appendChild(el); const v = getComputedStyle(el)[prop]; el.remove(); return v; };
        return { reading: probe("reading", "maxWidth"), transcript: probe("transcript", "maxWidth"), cols: probe("settings-layout", "gridTemplateColumns") };
      });
      assert.notEqual(classes.reading, "none");
      assert.equal(classes.transcript, "820px");
      assert.match(classes.cols, /^224px \d/);
    });
  });

  test("at 2560 reading text stops at 72ch and the page content stops at 880 px, centred", async () => {
    await withApp({ width: 2560, height: 900 }, async ({ page }) => {
      await openRoute(page, "#/gallery/actions"); // a settings-width page with a lead (Models no longer has one)
      await page.locator(".lead").waitFor();
      const r = await page.evaluate(() => {
        const lead = document.querySelector(".lead") as HTMLElement;
        const probe = document.createElement("div");
        probe.style.width = "72ch";
        lead.parentElement!.appendChild(probe);
        const ch72 = probe.getBoundingClientRect().width;
        probe.remove();
        const inner = document.querySelector(".page-inner")!.getBoundingClientRect();
        return { maxWidth: parseFloat(getComputedStyle(lead).maxWidth), ch72, innerWidth: inner.width };
      });
      assert.ok(Math.abs(r.maxWidth - r.ch72) < 1, `${r.maxWidth} vs ${r.ch72}`);
      assert.ok(r.innerWidth <= 880);
    });
  });

  test("a full-width page (list-detail) is not capped, the list column is 240-340 px", async () => {
    await withApp({ width: 2560, height: 900 }, async ({ page }) => {
      await openRoute(page, "#/gallery/list-detail/1");
      await page.locator(".ld-list").waitFor(); // the gallery page is a lazy chunk: wait until it has rendered
      const w = await page.evaluate(() => ({ inner: document.querySelector(".page-inner")!.getBoundingClientRect().width, list: document.querySelector(".ld-list")!.getBoundingClientRect().width }));
      assert.ok(w.inner > 880);
      assert.ok(w.list >= 240 && w.list <= 340, `${w.list}`);
    });
  });
});

describe("200 % text zoom", opts, () => {
  for (const route of ["#/chat", "#/gallery/patterns", "#/gallery/list-detail/2"]) {
    test(`1440 window at zoom 2: ${route} still works without horizontal scrolling`, async () => {
      await withApp({ width: 1440, height: 900 }, async ({ page }) => {
        await openRoute(page, route);
        await page.locator("main h1").first().waitFor();
        await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
        await page.waitForTimeout(50);
        const r = await page.evaluate(() => {
          const h1 = document.querySelector("main h1")!.getBoundingClientRect();
          const nav = document.querySelector(".sidebar")!.getBoundingClientRect();
          return { scroll: document.documentElement.scrollWidth > document.documentElement.clientWidth, h1Right: h1.right, navWidth: nav.width, inner: window.innerWidth };
        });
        assert.equal(r.scroll, false);
        assert.ok(r.h1Right <= r.inner + 1, `heading clipped: ${r.h1Right} > ${r.inner}`);
      });
    });
  }

  test("400 px (a 800 px window at 200 %) keeps the dialog inside the window and reachable", async () => {
    await withApp({ width: 400, height: 450 }, async ({ page }) => {
      await openRoute(page, "#/gallery/dialog");
      await page.getByRole("button", { name: "Open dialog" }).click();
      const box = await page.getByRole("dialog").boundingBox();
      assert.ok(box!.x >= 0 && box!.x + box!.width <= 400 && box!.y >= 0 && box!.y + box!.height <= 450, JSON.stringify(box));
      await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
    });
  });
});
