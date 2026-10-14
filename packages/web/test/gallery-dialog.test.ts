import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";

before(setup);
after(teardown);

describe("Gallery fixture: dialog", { skip: browserSkip }, () => {
  test("focus is trapped, Escape closes, focus returns to the opener, axe is clean", async () => {
    await withApp({}, async ({ page }) => {
      await openRoute(page, "#/gallery/dialog");
      const opener = page.locator("#open-dialog");
      await opener.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("dialog").waitFor();
      await expectAxeClean(page, "gallery dialog");
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press("Tab");
        assert.ok(await page.evaluate(() => !!document.activeElement?.closest("dialog")));
      }
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "detached" });
      assert.equal(await opener.evaluate((e) => e === document.activeElement), true);
    });
  });
});
