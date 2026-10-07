import test from "node:test";
import assert from "node:assert/strict";
import { withShell } from "./browser-harness.ts";
test("dash hint remains single-use through repeated probes and shell rerender", async () => {
  await withShell(async page => {
    await page.evaluate(() => { (window as any).testShell.showBackgroundHint(); (window as any).testShell.showBackgroundHint(); });
    const hint = page.locator("[data-background-hint]");
    assert.equal(await hint.count(), 1);
    await page.evaluate(() => { location.hash = "#/settings/runtime"; });
    const dismiss = hint.getByRole("button", {name:"Dismiss"});
    const box = await dismiss.boundingBox();
    assert.ok(box && box.width >= 44 && box.height >= 44);
    await dismiss.click();
    await page.evaluate(() => (window as any).testShell.showBackgroundHint());
    assert.equal(await hint.count(), 0);
  });
});
