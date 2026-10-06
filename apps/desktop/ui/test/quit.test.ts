import test from "node:test";
import assert from "node:assert/strict";
import { withShell } from "./browser-harness.ts";

test("quit modal defaults to keep running, cancels safely and submits the choice", async () => {
  await withShell(async page => {
    await page.evaluate(() => (window as any).testShell.openQuit());
    const dialog = page.getByRole("dialog", {name:"Quit PLUR1BUS"});
    assert.equal(await dialog.getByRole("radio", {name:"Keep PLUR1BUS running"}).isChecked(), true);
    assert.equal(await dialog.getByRole("radio", {name:"Stop harness"}).count(), 0);
    for (const target of await dialog.locator("button, label").all()) {
      const box = await target.boundingBox(); assert(box && box.width >= 44 && box.height >= 44);
    }
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => (window as any).testShell.quitDecisions.length === 1);
    assert.deepEqual(await page.evaluate(() => (window as any).testShell.quitDecisions), ["cancel"]);
    await page.evaluate(() => (window as any).testShell.openQuit());
    await page.getByRole("dialog").getByRole("button", {name:"Quit", exact:true}).click();
    await page.getByRole("dialog").waitFor({state:"detached"});
    assert.deepEqual(await page.evaluate(() => (window as any).testShell.quitDecisions), ["cancel", "keep-running"]);
  });
});

test("a rejected native quit keeps the modal open and permits cancellation", async () => {
  await withShell(async page => {
    await page.evaluate(() => { (window as any).testShell.setQuitFailure(true); (window as any).testShell.openQuit(); });
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", {name:"Quit", exact:true}).click();
    await dialog.getByRole("alert").getByText("Could not quit. Please try again.").waitFor();
    assert.deepEqual(await page.evaluate(() => (window as any).testShell.quitDecisions), []);
    assert.equal(await dialog.getByRole("button", {name:"Quit", exact:true}).isEnabled(), true);
    await dialog.getByRole("button", {name:"Cancel", exact:true}).click();
    await dialog.waitFor({state:"detached"});
    await page.waitForFunction(() => (window as any).testShell.quitDecisions.length === 1);
    assert.deepEqual(await page.evaluate(() => (window as any).testShell.quitDecisions), ["cancel"]);
  });
});
