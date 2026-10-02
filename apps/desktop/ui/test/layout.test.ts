import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withShell } from "./browser-harness.ts";

test("frame follows content-width boundaries without clipping text", async () => {
  await withShell(async page => {
    for (const [width, expectedSidebar] of [[400, 64], [720, 64], [960, 64], [1023, 64], [1024, 256], [1440, 256], [1600, 256], [1601, 256], [2560, 256]] as Array<[number, number]>) {
      await page.setViewportSize({ width, height: 900 });
      const measured = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        document: document.documentElement.scrollWidth,
        sidebar: document.querySelector(".sidebar")?.getBoundingClientRect().width,
      }));
      assert.equal(measured.sidebar, expectedSidebar, `sidebar at ${width}`);
      assert.ok(measured.document <= measured.viewport, `horizontal overflow at ${width}: ${JSON.stringify(measured)}`);
    }
    await page.evaluate(() => (window as any).testShell.navigate("settings", "advanced"));
    for (const width of [400, 720, 960, 1440, 2560]) {
      await page.setViewportSize({ width, height: 900 });
      const measured = await page.evaluate(() => {
        const smallText: string[] = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!node.textContent?.trim() || !(node.parentElement instanceof HTMLElement)) continue;
          const element = node.parentElement;
          const style = getComputedStyle(element);
          if (element.getBoundingClientRect().width > 0 && style.visibility !== "hidden" && style.display !== "none" && parseFloat(style.fontSize) < 12) smallText.push(`${element.tagName}:${node.textContent.trim()}:${style.fontSize}`);
        }
        return { width: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth, smallText };
      });
      assert.ok(measured.width <= measured.viewport, `advanced settings overflow at ${width}`);
      assert.deepEqual(measured.smallText, [], `text below 12 px at ${width}`);
    }
  });
});

test("capture representative responsive shell views", async context => {
  const directory = process.env.PLUR1BUS_SCREENSHOT_DIR ?? await mkdtemp(join(tmpdir(), "plur1bus-wp03-screenshots-"));
  if (!process.env.PLUR1BUS_SCREENSHOT_DIR) context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(directory, { recursive: true });
  await withShell(async page => {
    for (const sample of [
      { width: 400, theme: "dark", locale: "de", platform: "mac", route: "settings", page: "advanced" },
      { width: 960, theme: "dark", locale: "en", platform: "mac", route: "home", page: "runtime" },
      { width: 1440, theme: "light", locale: "en", platform: "gnome", route: "settings", page: "advanced" },
      { width: 2560, theme: "light", locale: "de", platform: "win", route: "connections", page: "runtime" },
    ]) {
      await page.setViewportSize({ width: sample.width, height: 900 });
      await page.evaluate(async sample => {
        await (window as any).testShell.setPreferences({ theme: sample.theme, locale: sample.locale });
        (window as any).testShell.setPlatform(sample.platform);
        (window as any).testShell.navigate(sample.route, sample.page);
      }, sample);
      await page.locator(".toast").waitFor({ state: "detached", timeout: 4000 });
      await page.locator(".wordmark-collapsed").waitFor({ state: "detached", timeout: 1000 });
      await page.screenshot({ path: `${directory}/${sample.width}-${sample.theme}-${sample.locale}-${sample.platform}-${sample.route}.png` });
    }
    await page.setViewportSize({ width: 400, height: 900 });
    await page.evaluate(async () => {
      await (window as any).testShell.setPreferences({ theme: "dark", locale: "de" });
      (window as any).testShell.setPlatform("mac");
      (window as any).testShell.navigate("settings", "advanced");
    });
    await page.getByRole("button", { name: "Bereiche" }).click();
    await page.locator(".toast").waitFor({ state: "detached", timeout: 4000 });
    await page.screenshot({ path: `${directory}/400-dark-de-mac-sections.png` });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "So funktionieren Einstellungen" }).click();
    await page.screenshot({ path: `${directory}/400-dark-de-mac-dialog.png` });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.locator(":focus-visible").count(), 1);
    await page.screenshot({ path: `${directory}/400-dark-de-mac-keyboard-focus.png` });
  });
});

test("all interactive shell targets are at least 44 px and compact navigation closes", async () => {
  await withShell(async page => {
    for (const width of [400, 960, 1440, 2560]) {
      await page.setViewportSize({ width, height: 900 });
      const small = await page.locator("a,button,input,select").evaluateAll(elements => elements.filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44);
      }).map(el => ({ text: el.textContent?.trim(), box: el.getBoundingClientRect().toJSON() })));
      assert.deepEqual(small, [], `targets at ${width}`);
    }
    await page.setViewportSize({ width: 400, height: 900 });
    await page.getByRole("button", { name: /Open navigation/ }).click();
    assert.equal(await page.locator(".sidebar-overlay").isVisible(), true);
    assert.equal(await page.locator(".shell-mount").evaluate(node => (node as HTMLElement).inert), true);
    assert.equal(await page.locator(".sheet-left").evaluate(node => node.getBoundingClientRect().width), 288);
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.locator(".sidebar-overlay button").last().evaluate(node => document.activeElement === node), true);
    await page.keyboard.press("Tab");
    assert.equal(await page.locator(".sidebar-overlay .sheet-close").evaluate(node => document.activeElement === node), true);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".sidebar-overlay").count(), 0);
    assert.equal(await page.locator(".shell-mount").evaluate(node => (node as HTMLElement).inert), false);
    await page.getByRole("button", { name: "Settings" }).first().click();
    await page.getByRole("button", { name: "Sections" }).click();
    assert.equal(await page.getByRole("dialog", { name: "Sections" }).isVisible(), true);
    assert.equal(await page.locator(".sheet").evaluate(node => node.getBoundingClientRect().width), 400);
    await page.getByRole("button", { name: "Advanced" }).last().click();
    assert.equal(await page.getByRole("heading", { name: "Appearance" }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Sections" }).evaluate(node => document.activeElement === node), true, await page.evaluate(() => document.activeElement?.outerHTML));
    const small = await page.locator("a,button,input,select").evaluateAll(elements => elements.filter(el => {
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && (box.width < 44 || box.height < 44);
    }).map(el => el.textContent?.trim()));
    assert.deepEqual(small, [], "advanced settings targets at 400");
    const languageRows = await page.locator('fieldset[data-preference="locale"] button').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
    assert.equal(new Set(languageRows).size, 1, `language options wrapped at 400: ${languageRows}`);
  });
});

test("dialog layout and DOM button order follow all four platforms", async () => {
  await withShell(async page => {
    for (const [platform, expectedFirst, radius] of [["mac", "Close", "999px"], ["win", "Got it", "6px"], ["gnome", "Close", "999px"], ["kde", "Got it", "6px"]] as const) {
      await page.evaluate(value => (window as any).testShell.setPlatform(value), platform);
      await page.getByRole("button", { name: "How preferences work" }).click();
      const dialog = page.getByRole("dialog", { name: "Preferences" });
      assert.equal((await dialog.getByRole("button").allTextContents())[0], expectedFirst, platform);
      assert.equal(await dialog.getByRole("button").first().evaluate(node => getComputedStyle(node).borderRadius), radius, platform);
      assert.equal(await dialog.evaluate(node => node.getBoundingClientRect().width), 680, platform);
      await page.keyboard.press("Shift+Tab");
      assert.equal(await dialog.getByRole("button").last().evaluate(node => document.activeElement === node), true, `${platform}: ${await page.evaluate(() => document.activeElement?.outerHTML)}`);
      await page.keyboard.press("Tab");
      assert.equal(await dialog.getByRole("button").first().evaluate(node => document.activeElement === node), true, platform);
      await page.keyboard.press("Escape");
      assert.equal(await dialog.count(), 0);
    }
    await page.setViewportSize({ width: 400, height: 600 });
    await page.evaluate(() => (window as any).testShell.setPlatform("gnome"));
    await page.getByRole("button", { name: "How preferences work" }).click();
    assert.equal(await page.getByRole("dialog").evaluate(node => node.getBoundingClientRect().width), 352);
    const widths = await page.getByRole("dialog").getByRole("button").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
    assert.ok(widths.every(width => width >= 290), `GNOME full-width buttons: ${widths}`);
  });
});

test("the wide related panel becomes a 360 px sheet and a full-width compact sheet", async () => {
  await withShell(async page => {
    await page.getByRole("button", { name: "Settings" }).first().click();
    await page.setViewportSize({ width: 960, height: 900 });
    await page.getByRole("button", { name: "About this page" }).click();
    assert.equal(await page.getByRole("dialog", { name: "About this page" }).evaluate(node => node.getBoundingClientRect().width), 360);
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 400, height: 900 });
    await page.getByRole("button", { name: "About this page" }).click();
    assert.equal(await page.getByRole("dialog", { name: "About this page" }).evaluate(node => node.getBoundingClientRect().width), 400);
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 2560, height: 900 });
    assert.equal(await page.locator(".related-panel").isVisible(), true);
    assert.equal(await page.getByRole("button", { name: "About this page" }).count(), 0);
  });
});

test("200% text-only enlargement retains the 1440 viewport without clipping", async () => {
  await withShell(async page => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Settings" }).first().click();
    await page.getByRole("button", { name: "Advanced" }).first().click();
    const before = await page.getByRole("heading", { name: "Settings" }).evaluate(node => node.getBoundingClientRect().height);
    await page.evaluate(() => {
      const originalSizes = Array.from(document.querySelectorAll<HTMLElement>(".shell-mount *")).map(element => [element, parseFloat(getComputedStyle(element).fontSize)] as const);
      for (const [element, size] of originalSizes) element.style.fontSize = `${size * 2}px`;
    });
    const measured = await page.evaluate(() => ({ viewport: window.innerWidth, scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    const after = await page.getByRole("heading", { name: "Settings" }).evaluate(node => node.getBoundingClientRect().height);
    assert.equal(measured.viewport, 1440);
    assert.ok(after >= before * 1.9, `text did not enlarge: ${before} -> ${after}`);
    assert.ok(measured.scroll <= measured.client, `enlarged text overflow: ${JSON.stringify(measured)}`);
    assert.equal(await page.getByRole("button", { name: "About this page" }).isVisible(), true);
  });
});

test("Chromium 2x display scale keeps 1440 physical pixels while all shell pages fit 720 CSS pixels", async () => {
  for (const scale of [1, 2]) {
    await withShell(async page => {
      const metrics = await page.evaluate(() => ({ cssWidth: innerWidth, cssHeight: innerHeight, dpr: devicePixelRatio }));
      const pixels = await page.screenshot({ scale: "device" });
      assert.deepEqual(metrics, { cssWidth: 1440 / scale, cssHeight: 900 / scale, dpr: scale });
      assert.deepEqual([pixels.readUInt32BE(16), pixels.readUInt32BE(20)], [1440, 900]);
      for (const [section, subpage] of [["home", "runtime"], ["connections", "runtime"], ["settings", "runtime"], ["settings", "updates"], ["settings", "version"], ["settings", "advanced"]] as const) {
        await page.evaluate(([section, subpage]) => (window as any).testShell.navigate(section, subpage), [section, subpage]);
        const layout = await page.evaluate(() => {
          const small = Array.from(document.querySelectorAll<HTMLElement>("button,a,input,select")).filter(element => {
            const box = element.getBoundingClientRect();
            return box.width > 0 && box.height > 0 && (box.width < 44 || box.height < 44);
          }).map(element => element.textContent?.trim());
          return { scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, sidebar: document.querySelector(".sidebar")?.getBoundingClientRect().width, small };
        });
        assert.ok(layout.scroll <= layout.client, `${scale}x ${section}/${subpage} overflow: ${JSON.stringify(layout)}`);
        assert.deepEqual(layout.small, [], `${scale}x ${section}/${subpage} targets`);
        assert.equal(layout.sidebar, scale === 2 ? 64 : 256);
      }
    }, { physicalWidth: 1440, physicalHeight: 900, scale });
  }
});

test("top-level wordmark collapses to a red pivot while route content changes immediately", async () => {
  await withShell(async page => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.getByRole("button", { name: "Settings" }).first().click();
    assert.equal(await page.getByRole("heading", { name: "Settings" }).count(), 1);
    assert.equal(await page.locator(".wordmark").getAttribute("aria-label"), "Home");
    assert.equal(await page.locator(".wordmark-one").textContent(), "1");
    assert.ok(await page.locator(".wordmark-one").evaluate(node => node.getBoundingClientRect().width > 0 && getComputedStyle(node).opacity === "1"));
    assert.ok(await page.locator(".wordmark-letter.is-collapsed").count() > 0);
    assert.equal(await page.locator(".wordmark-collapsed").count(), 0);
    await page.waitForFunction(() => document.querySelector(".wordmark")?.textContent?.includes("SETT1NGS"));
    await page.getByRole("button", { name: "Settings" }).first().click();
    await page.getByRole("button", { name: "Home" }).first().click();
    await page.waitForFunction(() => document.querySelector(".wordmark")?.textContent?.includes("PLUR1BUS"));
    assert.equal(await page.locator(".wordmark-subtitle").textContent(), "Harness");
  });
});
