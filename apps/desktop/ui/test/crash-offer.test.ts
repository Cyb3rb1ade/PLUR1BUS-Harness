import test from "node:test";
import assert from "node:assert/strict";
import {withShell} from "./browser-harness.ts";
test("crash offer renders plain text, copies locally and acknowledges only explicit dismissal", async () => {
  await withShell(async page => {
    await page.evaluate(() => (window as any).testShell.openCrash());
    const dialog = page.getByRole("dialog", {name:"Previous app crash"});
    assert.equal(await dialog.locator("img").count(), 0);
    await page.keyboard.press("Escape");
    assert.equal(await dialog.isVisible(), true);
    await dialog.getByRole("button", {name:"Copy details"}).click();
    await dialog.getByRole("alert").getByText("Details copied.").waitFor();
    assert.deepEqual(await page.evaluate(() => (window as any).testShell.crashHandled), []);
    assert.deepEqual(await page.evaluate(() => (window as any).testShell.crashCopied), ["<img src=x onerror=alert(1)> synthetic details"]);
    for (const button of await dialog.locator("button").all()) { const box = await button.boundingBox(); assert(box && box.width >=44 && box.height >=44); }
    await dialog.getByRole("button", {name:"Dismiss"}).click();
    await dialog.waitFor({state:"detached"});
    assert.deepEqual(await page.evaluate(() => (window as any).testShell.crashHandled), ["owned-crash"]);
  });
});
test("failed copy or acknowledgment preserves the crash offer", async () => {
  await withShell(async page => {
    await page.evaluate(() => (window as any).testShell.openCrash(true, true));
    const dialog = page.getByRole("dialog", {name:"Previous app crash"});
    await dialog.getByRole("button", {name:"Copy details"}).click();
    await dialog.getByRole("alert").getByText("Copy failed.").waitFor();
    await dialog.getByRole("button", {name:"Dismiss"}).click();
    await dialog.getByRole("alert").getByText("Acknowledgment failed.").waitFor();
    assert.equal(await dialog.isVisible(), true);
    assert.equal(await dialog.getByRole("button", {name:"Dismiss"}).isEnabled(), true);
    assert.deepEqual(await page.evaluate(() => (window as any).testShell.crashHandled), []);
  });
});
