import { test } from "node:test";
import assert from "node:assert/strict";
import { withShell } from "./browser-harness.ts";

test("sample shell and dialog pass axe WCAG 2.1 AA in both themes and locales", async () => {
  await withShell(async page => {
    await page.addScriptTag({ url: "/axe.js" });
    for (const theme of ["light", "dark"]) for (const locale of ["en", "de"]) {
      await page.evaluate(({ theme, locale }) => (window as any).testShell.setPreferences({ theme, locale }), { theme, locale });
      for (const section of ["home", "connections", "settings"]) {
        await page.evaluate(section => (window as any).testShell.navigate(section, "advanced"), section);
        if (section === "home") {
          const colors = await page.evaluate(() => {
            const tokens = getComputedStyle(document.documentElement);
            return [[".eyebrow", "--ink-3"], ["h1", "--ink"], [".lead", "--ink-2"], [".chip-ok", "--ok-ink"]].map(([selector, token]) => {
              const node = document.querySelector<HTMLElement>(`.home-hero ${selector}`)!;
              const expected = document.createElement("span");
              expected.style.color = tokens.getPropertyValue(token!);
              document.body.append(expected);
              const pair = [getComputedStyle(node).color, getComputedStyle(expected).color];
              expected.remove();
              return pair;
            });
          });
          for (const [actual, expected] of colors) assert.equal(actual, expected, "gradient allow-list must use the tested token pairs");
        }
        await page.locator(".toast").waitFor({ state: "detached", timeout: 4000 });
        const results = await page.evaluate(async () => await (window as any).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } }));
        assertAxe(results, `${section} ${theme}/${locale}`);
      }
      await page.getByRole("button", { name: locale === "de" ? "So funktionieren Einstellungen" : "How preferences work" }).click();
      const results = await page.evaluate(async () => await (window as any).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } }));
      assertAxe(results, `dialog ${theme}/${locale}`);
      await page.keyboard.press("Escape");
    }
  });
});

function assertAxe(results: { violations: Array<{ id: string; nodes: unknown[] }>; incomplete: Array<{ id: string; nodes: Array<{ target: string[] }> }> }, context: string) {
  assert.deepEqual(results.violations.map(v => `${v.id} (${v.nodes.length})`), [], context);
  const exceptions: Record<string, string> = {
    ".wordmark-one": "WCAG 1.4.3 logotype exception: red brand numeral, never functional text.",
    ...(context.startsWith("home ") ? {
      ".eyebrow": "Home hero only: gradient extrema and interpolation verified for tertiary ink by contrast.test.ts.",
      "h1": "Home hero only: gradient extrema and interpolation verified for ink by contrast.test.ts.",
      ".lead": "Home hero only: gradient extrema and interpolation verified for secondary ink by contrast.test.ts.",
      ".chip-ok": "Home hero only: ok ink/background pair is composited over every gradient interpolation in contrast.test.ts.",
    } : {}),
  };
  const unreviewed = results.incomplete.filter(result => result.id === "color-contrast").flatMap(result => result.nodes)
    .filter(node => node.target.length !== 1 || !exceptions[node.target[0]!]).map(node => node.target);
  assert.deepEqual(unreviewed, [], `${context}: unreviewed incomplete contrast`);
}

test("settings read failure keeps independently loaded Windows and KDE chrome", async () => {
  await withShell(async page => {
    for (const platform of ["win", "kde"] as const) {
      await page.addInitScript(value => { (window as any).__fixtureBoot = { platform: value, failGet: true }; }, platform);
      await page.reload();
      await page.getByRole("alert").waitFor();
      assert.equal(await page.locator("html").getAttribute("data-platform"), platform);
      await page.getByRole("button", { name: "Dismiss message" }).click();
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
    assert.match(await page.getByRole("alert").textContent() ?? "", /^Die Einstellung konnte nicht gespeichert werden\. Bitte erneut versuchen\./);
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
    assert.match(await page.getByRole("alert").textContent() ?? "", /^Could not save your preference\. Try again\./);
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
