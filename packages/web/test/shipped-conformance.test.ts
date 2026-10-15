// Registry driven M3 criteria 7/9: a newly shipped page automatically inherits this browser gate.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Page } from "playwright";
import { PAGES } from "../src/pages/registry.ts";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";

before(setup);
after(teardown);
const widths = [400, 960, 1440, 2560] as const;
const themes = ["light", "dark"] as const;

async function layout(page: Page, compact: boolean, label: string): Promise<void> {
  const result = await page.evaluate(() => {
    const targets: string[] = []; const smallText: string[] = [];
    const min = innerWidth / Number(document.documentElement.style.zoom || 1) < 1024 ? 44 : 24;
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && s.display !== "none" && s.visibility !== "hidden" && !el.closest('[inert], .sr-only');
    };
    const zoom = Number(document.documentElement.style.zoom || 1);
    for (const el of Array.from(document.querySelectorAll('a[href], button, input, select, textarea, [role="tab"]'))) {
      if (!visible(el) || el.classList.contains("skip-link")) continue;
      // WCAG 2.5.5's Inline exception: a link embedded in prose cannot grow independently without overlapping text.
      // Standalone paragraph links and navigation links remain measured; this is semantic, not a page allowlist.
      const paragraph = el.closest("p");
      if (el.tagName === "A" && getComputedStyle(el).display === "inline" && paragraph && paragraph.textContent?.trim() !== el.textContent?.trim()) continue;
      const box = el.getBoundingClientRect();
      const cssSize = Math.min(box.width, box.height) / zoom;
      if (cssSize < min - 0.1) targets.push(`${el.tagName}.${el.className}: ${cssSize.toFixed(1)}px`);
    }
    const walker = document.createTreeWalker(document.querySelector("main")!, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el || !node.textContent?.trim() || !visible(el)) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < 12) smallText.push(`${el.tagName}: ${size}px`);
    }
    return { scroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, targets, smallText, min };
  });
  assert.equal(result.min, compact ? 44 : 24);
  assert.equal(result.scroll, false, `${label}: document text overflows horizontally`);
  assert.deepEqual(result.targets, [], `${label}: undersized interactive targets`);
  assert.deepEqual(result.smallText, [], `${label}: text below 12 CSS px`);
}

for (const id of Object.keys(PAGES)) describe(`shipped page ${id}`, { skip: browserSkip }, () => {
  for (const scheme of themes) for (const width of widths) test(`${scheme}, ${width}px: WCAG and responsive`, async () => {
    await withApp({ width, height: 900, colorScheme: scheme, reducedMotion: "reduce" }, async ({ page }) => {
      await openRoute(page, `#/${id}`);
      // The former identities route redirects to its Settings tab.
      await page.locator(`main[data-page="${id === "identities" ? "settings" : id}"]`).waitFor();
      await page.waitForFunction(() => document.querySelectorAll('main [data-state="loading"]').length === 0);
      await expectAxeClean(page, `${id}/${scheme}/${width}`);
      await layout(page, width < 1024, `${id}/${scheme}/${width}`);
    });
  });
  for (const scheme of themes) test(`${scheme}, 1440px at 200% zoom: WCAG and reflow`, async () => {
    await withApp({ width: 720, height: 600, deviceScaleFactor: 2, colorScheme: scheme, reducedMotion: "reduce" }, async ({ page }) => {
      await openRoute(page, `#/${id}`);
      await page.locator(`main[data-page="${id === "identities" ? "settings" : id}"]`).waitFor();
      await page.waitForFunction(() => document.querySelectorAll('main [data-state="loading"]').length === 0);
      // Browser zoom reduces the CSS viewport: 1440 physical px / 2 = 720 CSS px.
      // CSS `zoom` alone leaves media queries at 1440 and therefore cannot emulate browser reflow.
      await expectAxeClean(page, `${id}/${scheme}/zoom2`);
      await layout(page, true, `${id}/${scheme}/zoom2`);
    });
  });
  for (const scheme of themes) test(`${scheme}, 1440px with 200% CSS zoom: enlarged text fits`, async () => {
    await withApp({ width: 1440, height: 1200, colorScheme: scheme, reducedMotion: "reduce" }, async ({ page }) => {
      await openRoute(page, `#/${id}`);
      await page.locator(`main[data-page="${id === "identities" ? "settings" : id}"]`).waitFor();
      await page.waitForFunction(() => document.querySelectorAll('main [data-state="loading"]').length === 0);
      await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
      await expectAxeClean(page, `${id}/${scheme}/css-zoom2`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      assert.equal(overflow, false, `${id}/${scheme}: enlarged text must reflow without document scrolling`);
    });
  });
});
