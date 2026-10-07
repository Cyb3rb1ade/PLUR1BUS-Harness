// Theme persistence: in memory + cookie (plur1bus_theme), optional ?theme= parameter, localStorage never required.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, setup, teardown, withApp } from "./harness.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const bodyBg = (page: import("playwright").Page): Promise<string> => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const DARK = "rgb(11, 11, 14)";
const LIGHT = "rgb(245, 244, 241)";

describe("theme persistence", opts, () => {
  test("with localStorage blocked the choice survives a reload through the cookie", async () => {
    await withApp({ colorScheme: "light" }, async ({ page, context }) => {
      await page.addInitScript(() => {
        Object.defineProperty(window, "localStorage", { get() { throw new DOMException("blocked", "SecurityError"); } });
      });
      await page.reload();
      await page.getByRole("heading", { name: "Sign in", level: 1 }).waitFor();
      await page.getByLabel("Theme").selectOption("dark");
      assert.equal(await bodyBg(page), DARK);
      const cookie = (await context.cookies()).find((c) => c.name === "plur1bus_theme");
      assert.ok(cookie, "cookie written");
      assert.equal(cookie.value, "dark");
      assert.equal(cookie.sameSite, "Strict");
      assert.equal(cookie.path, "/");
      assert.equal(cookie.httpOnly, false);
      await page.reload();
      await page.getByRole("heading", { name: "Sign in", level: 1 }).waitFor();
      assert.equal(await page.getByLabel("Theme").inputValue(), "dark");
      assert.equal(await bodyBg(page), DARK);
    });
  });

  test("the cookie alone wins over a stale local cache", async () => {
    await withApp({ colorScheme: "dark" }, async ({ page, context }) => {
      await page.evaluate(() => localStorage.setItem("plur1bus.web.theme", "light"));
      await context.addCookies([{ name: "plur1bus_theme", value: "dark", url: page.url(), sameSite: "Strict" }]);
      await page.reload();
      await page.getByRole("heading", { name: "Sign in", level: 1 }).waitFor();
      assert.equal(await page.getByLabel("Theme").inputValue(), "dark");
    });
  });

  test("?theme=light overrides the OS, is persisted, and an invalid value is ignored", async () => {
    await withApp({ colorScheme: "dark", hash: "?theme=light" }, async ({ page, context }) => {
      await page.getByRole("heading", { name: "Sign in", level: 1 }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
      assert.equal(await bodyBg(page), LIGHT);
      assert.equal((await context.cookies()).find((c) => c.name === "plur1bus_theme")?.value, "light");
      await page.goto(page.url().split("?")[0] + "?theme=neon");
      await page.getByRole("heading", { name: "Sign in", level: 1 }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light", "falls back to the stored cookie");
    });
  });

  test("the root carries data-density=comfortable and a theme change keeps it", async () => {
    await withApp({}, async ({ page }) => {
      assert.equal(await page.evaluate(() => document.documentElement.dataset.density), "comfortable");
      await page.getByLabel("Theme").selectOption("light");
      assert.equal(await page.evaluate(() => document.documentElement.dataset.density), "comfortable");
    });
  });
});
