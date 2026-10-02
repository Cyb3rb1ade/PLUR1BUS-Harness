import { test } from "node:test";
import assert from "node:assert/strict";
import { withShell } from "./browser-harness.ts";

test("sample shell and dialog pass axe WCAG 2.1 AA in both themes and locales", async () => {
  await withShell(async page => {
    await page.addScriptTag({ url: "/axe.js" });
    await page.getByRole("button", { name: "Settings" }).first().click();
    await page.getByRole("button", { name: "Advanced" }).first().click();
    for (const theme of ["light", "dark"]) for (const locale of ["en", "de"]) {
      await page.evaluate(({ theme, locale }) => (window as any).testShell.setPreferences({ theme, locale }), { theme, locale });
      const pageViolations = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } })).violations);
      assert.deepEqual(pageViolations.map((v: { id: string, nodes: unknown[] }) => `${v.id} (${v.nodes.length})`), [], `unoccluded ${theme}/${locale}`);
      await page.getByRole("button", { name: locale === "de" ? "So funktionieren Einstellungen" : "How preferences work" }).click();
      const violations = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } })).violations);
      assert.deepEqual(violations.map((v: { id: string, nodes: unknown[] }) => `${v.id} (${v.nodes.length})`), [], `${theme}/${locale}`);
      await page.keyboard.press("Escape");
    }
  });
});

test("settings read failure keeps independently loaded Windows and KDE chrome", async () => {
  await withShell(async page => {
    for (const platform of ["win", "kde"] as const) {
      await page.addInitScript(value => { (window as any).__fixtureBoot = { platform: value, failGet: true }; }, platform);
      await page.reload();
      await page.getByRole("alert").waitFor();
      assert.equal(await page.locator("html").getAttribute("data-platform"), platform);
      await page.getByRole("button", { name: "How preferences work" }).click();
      assert.equal((await page.getByRole("dialog").getByRole("button").allTextContents())[0], "Got it");
      await page.keyboard.press("Escape");
    }
  });
});

test("rapid theme and language choices serialize without losing either", async () => {
  await withShell(async page => {
    await page.getByRole("button", { name: "Settings" }).first().click();
    await page.getByRole("button", { name: "Advanced" }).first().click();
    await page.evaluate(() => (window as any).testShell.deferSaves());
    await page.getByRole("button", { name: "Light" }).click();
    await page.getByRole("button", { name: "Deutsch" }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).testShell.pendingSaves()), [{ theme: "light", locale: "system" }]);
    await page.evaluate(() => (window as any).testShell.completeNextSave());
    await page.waitForFunction(() => (window as any).testShell.pendingSaves().length === 1);
    assert.deepEqual(await page.evaluate(() => (window as any).testShell.pendingSaves()), [{ theme: "light", locale: "de" }]);
    await page.evaluate(() => (window as any).testShell.completeNextSave());
    await page.waitForFunction(() => (window as any).testShell.storedSettings().locale === "de");
    assert.deepEqual(await page.evaluate(() => (window as any).testShell.storedSettings()), { theme: "light", locale: "de" });
    assert.equal(await page.getByRole("button", { name: "Hell" }).getAttribute("aria-pressed"), "true");
    assert.equal(await page.getByRole("button", { name: "Deutsch" }).getAttribute("aria-pressed"), "true");
  });
});

test("a failed queued preference rolls back only that choice and reports failure", async () => {
  await withShell(async page => {
    await page.getByRole("button", { name: "Settings" }).first().click();
    await page.getByRole("button", { name: "Advanced" }).first().click();
    await page.evaluate(() => (window as any).testShell.deferSaves());
    await page.getByRole("button", { name: "Light" }).click();
    await page.getByRole("button", { name: "Deutsch" }).click();
    await page.evaluate(() => (window as any).testShell.rejectNextSave());
    await page.waitForFunction(() => (window as any).testShell.pendingSaves().length === 1);
    assert.deepEqual(await page.evaluate(() => (window as any).testShell.pendingSaves()), [{ theme: "system", locale: "de" }]);
    await page.evaluate(() => (window as any).testShell.completeNextSave());
    await page.getByRole("alert").waitFor();
    assert.deepEqual(await page.evaluate(() => (window as any).testShell.storedSettings()), { theme: "system", locale: "de" });
    assert.equal(await page.getByRole("alert").textContent(), "Die Einstellung konnte nicht gespeichert werden. Bitte erneut versuchen.");
  });
});

test("keyboard focus survives preference changes and returns from the dialog", async () => {
  await withShell(async page => {
    await page.getByRole("button", { name: "Settings" }).first().click();
    await page.getByRole("button", { name: "Advanced" }).first().click();
    const light = page.getByRole("button", { name: "Light" });
    await light.click();
    assert.equal(await light.evaluate(node => document.activeElement === node), true);
    const opener = page.getByRole("button", { name: "How preferences work" });
    await opener.click();
    assert.equal(await page.getByRole("dialog").count(), 1);
    await page.keyboard.press("Escape");
    assert.equal(await opener.evaluate(node => document.activeElement === node), true);
  });
});

test("failed native preference save keeps the old choice and keyboard focus", async () => {
  await withShell(async page => {
    await page.getByRole("button", { name: "Settings" }).first().click();
    await page.getByRole("button", { name: "Advanced" }).first().click();
    await page.evaluate(() => (window as any).testShell.failNextSave());
    await page.getByRole("button", { name: "Light" }).click();
    assert.equal(await page.getByRole("button", { name: "System" }).first().getAttribute("aria-pressed"), "true");
    assert.equal(await page.getByRole("alert").textContent(), "Could not save your preference. Try again.");
    assert.equal(await page.getByRole("button", { name: "System" }).first().evaluate(node => document.activeElement === node), true);
  });
});

test("system theme follows browser preference with dark fallback and reduced-motion wordmark", async () => {
  await withShell(async page => {
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
    await page.getByRole("button", { name: "Settings" }).first().click();
    assert.equal(await page.locator(".wordmark-letter.is-collapsed").count(), 0);
    assert.equal(await page.locator(".wordmark-letters").textContent(), "SETT1NGS");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    await page.addInitScript(() => {
      const native = window.matchMedia.bind(window);
      window.matchMedia = query => query.includes("prefers-color-scheme")
        ? { media: query, matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null } as MediaQueryList
        : native(query);
    });
    await page.reload();
    await page.getByRole("navigation").waitFor();
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  });
});
