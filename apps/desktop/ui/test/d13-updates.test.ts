// Audit D13 (apps/desktop/ui): written red first; the fix is in the same commit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withShell } from "./browser-harness.ts";

test("quiet hours reject empty and out-of-range input instead of saving it", async () => {
  await withShell(async page => {
    await page.evaluate(() => (window as any).testShell.showUpdates());
    const from = page.getByLabel("From", { exact: false });
    await from.waitFor();
    assert.equal(await from.inputValue(), "3");
    await from.fill("");
    await from.press("Tab");
    await page.waitForTimeout(200);
    assert.equal(await page.getByLabel("From", { exact: false }).inputValue(), "3");
    await page.getByLabel("From", { exact: false }).fill("99");
    await page.getByLabel("From", { exact: false }).press("Tab");
    await page.waitForTimeout(200);
    assert.equal(await page.getByLabel("From", { exact: false }).inputValue(), "3");
    await page.getByLabel("From", { exact: false }).fill("7");
    await page.getByLabel("From", { exact: false }).press("Tab");
    await page.waitForFunction(() => (document.querySelector("[data-focus-key=update-hour-0]") as HTMLInputElement).value === "7");
  });
});
