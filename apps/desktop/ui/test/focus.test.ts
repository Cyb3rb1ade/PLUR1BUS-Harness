import { test } from "node:test";
import assert from "node:assert/strict";
import { withShell } from "./browser-harness.ts";

for (const overlay of ["dialog", "sheet"] as const) {
  for (const update of ["OS theme", "late native load"] as const) {
    test(`${overlay} returns focus to its opener after ${update} rerenders the shell`, async () => {
      await withShell(async page => {
        if (update === "late native load") {
          await page.addInitScript(() => { (window as any).__fixtureBoot = { deferLoad: true, locale: "de-DE" }; });
          await page.reload();
        }
        await page.emulateMedia({ colorScheme: "light" });
        await page.evaluate(() => (window as any).testShell.navigate("settings"));
        const opener = page.locator(`[data-focus-key="${overlay === "dialog" ? "preferences-help" : "related"}"]`);
        await opener.focus();
        await page.keyboard.press("Enter");
        assert.equal(await page.getByRole("dialog").count(), 1);
        if (update === "OS theme") {
          await page.emulateMedia({ colorScheme: "dark" });
          await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
        } else {
          await page.evaluate(() => (window as any).testShell.completeLoads());
          await page.waitForFunction(() => document.documentElement.lang === "de");
        }
        await page.keyboard.press("Escape");
        // Native dialog close events are queued after its open flag is cleared.
        await page.locator(overlay === "dialog" ? ".app-dialog" : ".sheet").waitFor({ state: "detached" });
        assert.equal(await page.getByRole("dialog").count(), 0);
        assert.equal(await opener.evaluate(node => node === document.activeElement), true);
      });
    });
  }
}

test("simultaneous overlays retain unique accessible title references", async () => {
  await withShell(async page => {
    await page.evaluate(() => (window as any).testShell.openRepeatedOverlays());
    const headings = await page.locator('[aria-labelledby]').evaluateAll(nodes => nodes.map(node => {
      const id = node.getAttribute("aria-labelledby")!;
      return { id, text: document.getElementById(id)?.textContent };
    }));
    assert.equal(new Set(headings.map(heading => heading.id)).size, 4);
    assert.deepEqual(headings.map(heading => heading.text), ["First sheet", "Second sheet", "First dialog", "Second dialog"]);
  });
});

test("Enter on every rail route focuses its page heading", async () => {
  await withShell(async page => {
    for (const name of ["Connections", "Settings", "Runtime", "Updates", "Version", "Advanced", "Home"]) {
      await page.locator(".sidebar").getByRole("button", { name, exact: true }).focus();
      await page.keyboard.press("Enter");
      assert.equal(await page.locator("h1").evaluate(node => node === document.activeElement), true, name);
    }
  });
});

test("OS theme changes retain the focused rail control", async () => {
  await withShell(async page => {
    for (const colorScheme of ["dark", "light"] as const) {
      const control = page.locator(".sidebar").getByRole("button", { name: "Settings", exact: true });
      await control.focus();
      await page.emulateMedia({ colorScheme });
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, colorScheme);
      assert.equal(await control.evaluate(node => node === document.activeElement), true);
    }
  });
});

test("Space activates navigation and preference controls", async () => {
  await withShell(async page => {
    await page.locator(".sidebar").getByRole("button", { name: "Settings", exact: true }).focus();
    await page.keyboard.press("Space");
    await page.locator(".sidebar").getByRole("button", { name: "Advanced", exact: true }).focus();
    await page.keyboard.press("Space");
    assert.equal(await page.locator("h1").evaluate(node => node === document.activeElement), true);
    await page.getByRole("button", { name: "Dark", exact: true }).focus();
    await page.keyboard.press("Space");
    await page.waitForFunction(() => (window as any).testShell.storedSettings().theme === "dark");
    assert.equal(await page.getByRole("button", { name: "Dark", exact: true }).getAttribute("aria-pressed"), "true");
  });
});

test("late native settings and app info preserve focus by stable key and use OS locale", async () => {
  await withShell(async page => {
    await page.addInitScript(() => { (window as any).__fixtureBoot = { deferLoad: true, locale: "de-DE" }; });
    await page.reload();
    await page.locator(".sidebar").getByRole("button", { name: "Settings", exact: true }).focus();
    await page.evaluate(() => (window as any).testShell.completeLoads());
    await page.waitForFunction(() => document.documentElement.lang === "de");
    assert.equal(await page.locator('.sidebar [data-focus-key="route-settings"]').evaluate(node => node === document.activeElement), true);
  });
});

test("error toasts remain actionable until explicitly dismissed", async () => {
  await withShell(async page => {
    await page.clock.install();
    await page.evaluate(async () => { (window as any).testShell.failNextSave(); await (window as any).testShell.setPreferences({ theme: "light" }); });
    await page.clock.fastForward(4000);
    assert.equal(await page.getByRole("alert").isVisible(), true);
    await page.getByRole("button", { name: "Dismiss message" }).click();
    assert.equal(await page.getByRole("alert").count(), 0);
  });
});
