import { test } from "node:test";
import assert from "node:assert/strict";
import { withShell } from "./browser-harness.ts";

test("layout: wide edge at 1600/1601 switches panel and trigger on Settings and Connections", async () => {
  await withShell(async page => {
    for (const section of ["settings", "connections"]) {
      await page.evaluate(section => (window as any).testShell.navigate(section), section);
      for (const width of [1600, 1601]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.locator(section === "settings" ? ".related-panel" : ".connections-detail").isVisible(), width === 1601, `${section}/${width} panel`);
        assert.equal(await page.locator(".related-button").isVisible(), width === 1600, `${section}/${width} trigger`);
      }
    }
  });
});

test("layout: all six pages retain 12 px text and 44 px targets at every acceptance width", async () => {
  await withShell(async page => {
    for (const width of [400, 720, 960, 1440, 2560]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [section, subpage] of [["home", "runtime"], ["connections", "runtime"], ["settings", "runtime"], ["settings", "updates"], ["settings", "version"], ["settings", "advanced"]]) {
        await page.evaluate(([section, subpage]) => (window as any).testShell.navigate(section, subpage), [section, subpage]);
        const failures = await page.evaluate(() => {
          const failures: string[] = [];
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode, parent = node.parentElement;
            if (!parent || !node.textContent?.trim() || !parent.checkVisibility()) continue;
            if (parseFloat(getComputedStyle(parent).fontSize) < 12) failures.push(`text: ${node.textContent}`);
          }
          for (const control of Array.from(document.querySelectorAll<HTMLElement>("button,a,input,select"))) {
            if (!control.checkVisibility()) continue;
            const box = control.getBoundingClientRect();
            if (box.width < 44 || box.height < 44) failures.push(`target: ${control.textContent}`);
          }
          if (document.documentElement.scrollWidth > document.documentElement.clientWidth) failures.push("horizontal overflow");
          return failures;
        });
        assert.deepEqual(failures, [], `${section}/${subpage}/${width}`);
      }
    }
  });
});

test("full keyboard traversal: ordered accessible names, wrap and visible 3:1 focus on every page", async () => {
  await withShell(async page => {
    for (const theme of ["light", "dark"]) for (const width of [720, 1440, 1601]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(theme => (window as any).testShell.setPreferences({ theme }), theme);
      await page.locator(".toast").waitFor({ state: "detached", timeout: 4000 });
      for (const [section, subpage] of [["home", "runtime"], ["connections", "runtime"], ["settings", "runtime"], ["settings", "updates"], ["settings", "version"], ["settings", "advanced"]]) {
        await page.evaluate(([section, subpage]) => (window as any).testShell.navigate(section, subpage), [section, subpage]);
        const expected = [
          ...(width < 1024 ? ["Open navigation"] : []), "Home", "Connections", "Settings",
          ...(section === "settings" && width >= 1024 ? ["Runtime", "Updates", "Version", "Advanced"] : []), "Home",
          ...(section === "home" ? ["View connections", "Open settings"] : [
            ...(section === "settings" && width < 1024 ? ["Sections"] : []),
            ...(width <= 1600 ? [section === "settings" ? "About this page" : "Connection details"] : []),
            ...(section === "settings" && subpage === "advanced" ? ["System", "Light", "Dark", "System", "English", "Deutsch"] : []),
          ]), "How preferences work",
        ];
        await page.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute("tabindex"); });
        for (const name of [...expected, "Document", expected[0]!]) {
          await page.keyboard.press("Tab");
          const focused = await page.evaluate(() => {
            const node = document.activeElement as HTMLElement;
            if (node === document.body) return { name: "Document" };
            const style = getComputedStyle(node);
            const parse = (s: string) => s.match(/[\d.]+/g)!.map(Number);
            let bg = [0, 0, 0];
            const parents: HTMLElement[] = [];
            for (let parent = node.parentElement; parent; parent = parent.parentElement) parents.unshift(parent);
            for (const parent of parents) {
              const c = parse(getComputedStyle(parent).backgroundColor), a = c[3] ?? 1;
              bg = bg.map((v, i) => c[i]! * a + v * (1 - a));
            }
            const luminance = (rgb: number[]) => rgb.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i]!, 0);
            const a = luminance(parse(style.outlineColor)), b = luminance(bg);
            return { name: node.getAttribute("aria-label") ?? node.textContent?.trim(), style: style.outlineStyle, width: parseFloat(style.outlineWidth), contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
          });
          const context = `${theme}/${width}/${section}/${subpage}/${name}`;
          assert.equal(focused.name, name, context);
          if (name === "Document") continue;
          assert.notEqual(focused.style, "none", context);
          assert.ok(focused.width! >= 2, `${context} outline ${focused.width}`);
          assert.ok(focused.contrast! >= 3, `${context} outline contrast ${focused.contrast}`);
        }
      }
    }
  });
});

test("platform chrome: GNOME fills the 800 px footer row, Windows band and short dialog height", async () => {
  await withShell(async page => {
    await page.setViewportSize({ width: 800, height: 900 });
    const widths: number[] = [];
    for (const platform of ["mac", "gnome"]) {
      await page.evaluate(platform => (window as any).testShell.setPlatform(platform), platform);
      await page.getByRole("button", { name: "How preferences work" }).click();
      widths.push(await page.getByRole("dialog").getByRole("button").first().evaluate(node => node.getBoundingClientRect().width));
      await page.keyboard.press("Escape");
    }
    assert.ok(widths[1]! > widths[0]! * 2, `GNOME expands beyond intrinsic macOS widths: ${widths}`);
    await page.evaluate(() => (window as any).testShell.setPlatform("win"));
    await page.setViewportSize({ width: 800, height: 180 });
    await page.getByRole("button", { name: "How preferences work" }).click();
    const computed = await page.locator(".dialog-footer").evaluate(node => ({ background: getComputedStyle(node).backgroundColor, border: getComputedStyle(node).borderTopWidth }));
    assert.equal(computed.background, "rgb(240, 239, 236)");
    assert.equal(computed.border, "1px");
    assert.ok(await page.getByRole("dialog").evaluate(node => node.getBoundingClientRect().height) <= 132);
  });
});
