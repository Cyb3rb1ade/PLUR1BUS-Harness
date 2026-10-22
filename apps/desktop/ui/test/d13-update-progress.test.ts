// D13 gap: update_install used to give the offer dialog nothing to show: the button stayed disabled with no feedback
// until the app restarted. The dialog now says that the install runs, shows the shell's download progress while
// it arrives, and reports a failure with a way to try again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withShell } from "./browser-harness.ts";
import { parseUpdateProgress, progressPercent } from "../src/models/update-model.ts";

test("update progress payloads are validated at the IPC boundary and turned into whole percent", () => {
  assert.deepEqual(parseUpdateProgress({ downloaded: 512, total: 1024 }), { downloaded: 512, total: 1024 });
  assert.deepEqual(parseUpdateProgress({ downloaded: 512, total: null }), { downloaded: 512, total: null });
  assert.deepEqual(parseUpdateProgress({ downloaded: 512, total: 0 }), { downloaded: 512, total: null }, "an empty length counts as unknown");
  for (const bad of [null, undefined, "50", 5, [], {}, { downloaded: "1" }, { downloaded: -1, total: 10 }, { downloaded: Number.NaN, total: 10 }, { downloaded: Infinity, total: 10 }]) assert.equal(parseUpdateProgress(bad), null, JSON.stringify(bad));
  assert.equal(progressPercent({ downloaded: 512, total: 1024 }), 50);
  assert.equal(progressPercent({ downloaded: 999, total: 1000 }), 99, "never rounds up to done before it is");
  assert.equal(progressPercent({ downloaded: 2000, total: 1000 }), 100, "capped at 100");
  assert.equal(progressPercent({ downloaded: 5, total: null }), null);
});

test("Update now shows an installing state with the download progress, and a failure re-enables the install", async () => {
  await withShell(async page => {
    await page.evaluate(() => (window as any).testShell.showUpdates());
    await page.getByRole("button", { name: "View 0.1.1" }).click();
    await page.evaluate(() => (window as any).testShell.hold("install"));
    const install = page.getByRole("button", { name: "Update now" });
    await install.click();
    await page.getByRole("status").getByText("Installing the update…", { exact: false }).waitFor();
    assert.equal(await install.isDisabled(), true, "no second install while one runs");
    for (const name of ["Hold this version", "Skip this version", "Later"]) assert.equal(await page.getByRole("button", { name, exact: true }).isDisabled(), true, `${name} waits for the install`);
    assert.equal(await page.getByRole("button", { name: "Close", exact: true }).isDisabled(), false, "the dialog can always be closed");
    await page.waitForFunction(() => (window as any).testShell.updateProgressListeners() === 1);
    const bar = page.getByRole("progressbar", { name: "Update download progress" });
    assert.equal(await bar.evaluate(node => (node as HTMLProgressElement).hasAttribute("value")), false, "indeterminate until the first event");
    await page.evaluate(() => (window as any).testShell.emitUpdateProgress(512, 1024));
    await page.getByText("Downloading: 50 %", { exact: true }).waitFor();
    assert.equal(await bar.evaluate(node => (node as HTMLProgressElement).value), 50);
    await page.evaluate(() => (window as any).testShell.emitUpdateProgress(1024, null));
    assert.equal(await bar.evaluate(node => (node as HTMLProgressElement).hasAttribute("value")), false, "an unknown length shows no made-up percent");
    assert.equal(await page.getByText("Downloading:", { exact: false }).count(), 0);
    await page.evaluate(() => (window as any).testShell.release("install"));
    await page.getByRole("alert").getByText("Update could not be installed.").waitFor();
    assert.equal(await page.getByRole("status").getByText("Installing the update…", { exact: false }).count(), 0, "the installing state ends with the failure");
    assert.equal(await page.getByRole("progressbar").count(), 0);
    assert.equal(await install.isDisabled(), false, "the person can try again");
    assert.equal(await page.getByRole("button", { name: "Later", exact: true }).isDisabled(), false);
    assert.equal(await page.evaluate(() => (window as any).testShell.updateProgressListeners()), 0, "the progress listener is released");
    // Retry: one alert at a time, not a growing stack.
    await install.click();
    await page.getByRole("alert").getByText("Update could not be installed.").waitFor();
    assert.equal(await page.getByRole("alert").filter({ hasText: "Update could not be installed." }).count(), 1);
    assert.equal(await page.evaluate(() => (window as any).testShell.calls.install), 2);
  });
});

test("closing the dialog during an install releases the progress listener", async () => {
  await withShell(async page => {
    await page.evaluate(() => (window as any).testShell.showUpdates());
    await page.getByRole("button", { name: "View 0.1.1" }).click();
    await page.evaluate(() => (window as any).testShell.hold("install"));
    await page.getByRole("button", { name: "Update now" }).click();
    await page.waitForFunction(() => (window as any).testShell.updateProgressListeners() === 1);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.locator("dialog").waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => (window as any).testShell.updateProgressListeners()), 0);
    await page.evaluate(() => (window as any).testShell.release("install"));
  });
});

test("the installing state with progress passes the accessibility check", async () => {
  await withShell(async page => {
    await page.evaluate(() => (window as any).testShell.showUpdates());
    await page.getByRole("button", { name: "View 0.1.1" }).click();
    await page.evaluate(() => (window as any).testShell.hold("install"));
    await page.getByRole("button", { name: "Update now" }).click();
    await page.evaluate(() => (window as any).testShell.emitUpdateProgress(1, 4));
    await page.getByText("Downloading: 25 %", { exact: true }).waitFor();
    await page.addScriptTag({ url: "/axe.js" });
    const violations = await page.evaluate(async () => { const result = await (window as any).axe.run(document.querySelector("dialog"), { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } }); return result.violations.map((v: any) => v.id); });
    assert.deepEqual(violations, []);
    await page.evaluate(() => (window as any).testShell.release("install"));
  });
});

test("the installing state and progress speak German with du", async () => {
  await withShell(async page => {
    await page.evaluate(() => { document.documentElement.lang = "de"; (window as any).testShell.showUpdates(); });
    await page.getByRole("button", { name: "0.1.1 ansehen" }).click();
    await page.evaluate(() => (window as any).testShell.hold("install"));
    await page.getByRole("button", { name: "Jetzt aktualisieren" }).click();
    await page.getByRole("status").getByText("Update wird installiert…", { exact: false }).waitFor();
    await page.evaluate(() => (window as any).testShell.emitUpdateProgress(1, 4));
    await page.getByText("Download: 25 %", { exact: true }).waitFor();
    assert.equal(await page.getByRole("progressbar", { name: "Fortschritt des Update-Downloads" }).count(), 1);
    await page.evaluate(() => (window as any).testShell.release("install"));
    await page.getByRole("alert").getByText("Update konnte nicht installiert werden.").waitFor();
  });
});
