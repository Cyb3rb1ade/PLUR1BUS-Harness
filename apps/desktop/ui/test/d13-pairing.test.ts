// Audit D13 (apps/desktop/ui): written red first; the fix is in the same commit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withShell } from "./browser-harness.ts";

async function openAddForm(page: import("playwright").Page) {
  await page.getByRole("button", { name: "View connections" }).click();
  await page.getByRole("button", { name: "Add remote", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Desk");
  await page.getByLabel("Harness origin").fill("https://harness.test");
  await page.getByLabel("First four characters").fill("ABCD");
  await page.getByLabel("Last four characters").fill("2345");
}

test("a shell re-render during pairing keeps the form locked: no second redemption of the one-time code", async () => {
  await withShell(async page => {
    await openAddForm(page);
    await page.evaluate(() => (window as any).testShell.hold("pair"));
    await page.getByRole("button", { name: "Pair harness", exact: true }).click();
    await page.waitForFunction(() => (window as any).testShell.calls.pair === 1);
    await page.evaluate(() => (window as any).testShell.refreshConnections());
    assert.equal(await page.getByRole("button", { name: "Pair harness", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "Pair harness", exact: true }).click({ force: true });
    assert.equal(await page.evaluate(() => (window as any).testShell.calls.pair), 1);
    await page.evaluate(() => (window as any).testShell.release("pair"));
    await page.getByRole("heading", { name: "Desk" }).waitFor();
  });
});

test("a failure that arrives after a re-render is shown on the live form", async () => {
  await withShell(async page => {
    await openAddForm(page);
    await page.evaluate(() => { const s = (window as any).testShell; s.hold("pair"); s.setPairingError("denied"); });
    await page.getByRole("button", { name: "Pair harness", exact: true }).click();
    await page.waitForFunction(() => (window as any).testShell.calls.pair === 1);
    await page.evaluate(() => (window as any).testShell.refreshConnections());
    await page.evaluate(() => (window as any).testShell.release("pair"));
    await page.getByRole("button", { name: "Pair harness", exact: true }).waitFor();
    await page.waitForFunction(() => !(document.querySelector("button[type=submit]") as HTMLButtonElement).disabled);
    assert.notEqual((await page.locator(".pair-status").textContent())?.trim(), "");
  });
});

test("a typed pairing code survives a late shell re-render", async () => {
  await withShell(async page => {
    await openAddForm(page);
    await page.evaluate(() => (window as any).testShell.refreshConnections());
    assert.equal(await page.getByLabel("First four characters").inputValue(), "ABCD");
    assert.equal(await page.getByLabel("Last four characters").inputValue(), "2345");
  });
});

test("double clicks reach the native side once: remove and open", async () => {
  await withShell(async page => {
    await openAddForm(page);
    await page.getByRole("button", { name: "Pair harness", exact: true }).click();
    await page.getByRole("heading", { name: "Desk" }).waitFor();
    await page.evaluate(() => (window as any).testShell.hold("open"));
    await page.getByRole("button", { name: "Open", exact: true }).dblclick();
    await page.waitForFunction(() => (window as any).testShell.calls.open >= 1);
    assert.equal(await page.evaluate(() => (window as any).testShell.calls.open), 1);
    await page.evaluate(() => (window as any).testShell.release("open"));
    await page.getByRole("button", { name: "Open", exact: true }).waitFor();
    await page.evaluate(() => (window as any).testShell.hold("remove"));
    await page.getByRole("button", { name: "Remove connection", exact: true }).click();
    await page.getByRole("button", { name: "Remove connection", exact: true }).last().dblclick();
    await page.waitForFunction(() => (window as any).testShell.calls.remove >= 1);
    assert.equal(await page.evaluate(() => (window as any).testShell.calls.remove), 1);
    await page.evaluate(() => (window as any).testShell.release("remove"));
    await page.getByRole("heading", { name: "No connections yet" }).waitFor();
    assert.equal(await page.getByRole("alert").count(), 0);
  });
});
