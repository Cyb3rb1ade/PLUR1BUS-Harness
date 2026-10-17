// Registry driven M3 criteria 7/9: a newly shipped page automatically inherits this browser gate.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { PAGES } from "../src/pages/registry.ts";
import { layout } from "./layout-contract.ts";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";

before(setup);
after(teardown);
const widths = [400, 960, 1440, 2560] as const;
const themes = ["light", "dark"] as const;


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
