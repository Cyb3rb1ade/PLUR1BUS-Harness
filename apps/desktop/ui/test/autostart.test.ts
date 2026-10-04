import test from "node:test";
import assert from "node:assert/strict";
import { withShell } from "./browser-harness.ts";
test("runtime autostart toggle reflects launcher confirmation and preserves state on failure", async () => {
  await withShell(async page => {
    await page.evaluate(() => { location.hash = "#/settings/runtime"; });
    const toggle = page.getByRole("checkbox", {name:"Start PLUR1BUS at login"});
    await toggle.waitFor();
    assert.equal(await toggle.isChecked(), false);
    await toggle.check();
    await page.waitForFunction(() => (window as any).testShell.autostartCalls().length === 1);
    assert.deepEqual(await page.evaluate(() => (window as any).testShell.autostartCalls()), [true]);
    assert.equal(await toggle.isChecked(), true);
    await page.evaluate(() => (window as any).testShell.failAutostart());
    await toggle.click();
    await page.getByText("Could not change autostart. Please try again.").waitFor();
    assert.equal(await toggle.isChecked(), true);
    assert.deepEqual(await page.evaluate(() => (window as any).testShell.autostartCalls()), [true, false]);
  });
});

test("unconfirmed portal autostart remains indeterminate until an explicit grant", async () => {
  await withShell(async page => {
    await page.addInitScript(() => { (window as any).__fixtureBoot = {autostartUnknown:true}; });
    await page.reload();
    await page.getByRole("navigation").waitFor();
    await page.evaluate(() => { location.hash = "#/settings/runtime"; });
    const toggle = page.getByRole("checkbox", {name:"Start PLUR1BUS at login"});
    await toggle.waitFor();
    await page.getByText("Autostart has not been confirmed in this session. Changing it requests permission.").waitFor();
    assert.equal(await toggle.evaluate((input: HTMLInputElement) => input.indeterminate), true);
    assert.equal(await toggle.isEnabled(), true);
    assert.deepEqual(await page.evaluate(() => (window as any).testShell.autostartCalls()), []);
    await toggle.click();
    await page.waitForFunction(() => (window as any).testShell.autostartCalls().length === 1);
    assert.equal(await toggle.isChecked(), true);
    assert.equal(await toggle.evaluate((input: HTMLInputElement) => input.indeterminate), false);
  });
});
