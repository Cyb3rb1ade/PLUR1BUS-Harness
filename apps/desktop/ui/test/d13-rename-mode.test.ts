// D13 gap: the rename form (and the remove confirmation) is a view mode of the connections view, so a shell re-render
// keeps it together with the typed name instead of dropping the person back to the list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withShell } from "./browser-harness.ts";

const row = { id: "fixture-row", name: "Saved desk", kind: "remote", origin: "https://harness.test", installationId: "synthetic", deviceId: "synthetic", tokenHint: "hint", certPin: null, caPin: null, nextCertPin: null, nextCaPin: null, observedCertPin: null, pairingNeeded: false };

async function openRename(page: import("playwright").Page) {
  await page.addInitScript(row => { (window as any).__fixtureBoot = { rows: [row] }; }, row);
  await page.reload();
  await page.getByRole("button", { name: "View connections" }).click();
  await page.getByRole("heading", { name: "Saved desk" }).waitFor();
  await page.getByRole("button", { name: "Rename", exact: true }).click();
}

test("a shell re-render keeps the rename form and the typed name", async () => {
  await withShell(async page => {
    await openRename(page);
    const name = page.getByLabel("Name", { exact: true });
    assert.equal(await name.inputValue(), "Saved desk");
    await name.fill("Typed name");
    await page.evaluate(() => (window as any).testShell.refreshConnections());
    await page.evaluate(() => (window as any).testShell.setPlatform("mac"));
    assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "Typed name", "the draft survives the re-render");
    assert.equal(await page.getByRole("button", { name: "Save", exact: true }).isDisabled(), false);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("heading", { name: "Typed name" }).waitFor();
    assert.equal(await page.getByLabel("Name", { exact: true }).count(), 0, "saving leaves the form");
  });
});

test("cancel leaves the rename form without saving, and a later rename starts from the saved name", async () => {
  await withShell(async page => {
    await openRename(page);
    await page.getByLabel("Name", { exact: true }).fill("Never saved");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("heading", { name: "Saved desk" }).waitFor();
    assert.deepEqual(await page.evaluate(() => (window as any).testShell.storedConnections().map((c: { name: string }) => c.name)), ["Saved desk"]);
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "Saved desk");
  });
});

test("a failed rename keeps the form and the typed name and says why", async () => {
  await withShell(async page => {
    await openRename(page);
    await page.evaluate(() => (window as any).testShell.setRenameError("storage"));
    await page.getByLabel("Name", { exact: true }).fill("Typed name");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("alert").getByText("Connection details could not be saved.").waitFor();
    assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "Typed name");
    assert.equal(await page.getByRole("button", { name: "Save", exact: true }).isDisabled(), false, "the person can retry");
    await page.evaluate(() => (window as any).testShell.setRenameError(null));
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("heading", { name: "Typed name" }).waitFor();
  });
});

test("a shell re-render keeps the remove confirmation instead of dropping the pending decision", async () => {
  await withShell(async page => {
    await page.addInitScript(row => { (window as any).__fixtureBoot = { rows: [row] }; }, row);
    await page.reload();
    await page.getByRole("button", { name: "View connections" }).click();
    await page.getByRole("heading", { name: "Saved desk" }).waitFor();
    await page.getByRole("button", { name: "Remove connection", exact: true }).click();
    await page.getByText("Remove Saved desk and delete its sign-in from this device?").waitFor();
    await page.evaluate(() => (window as any).testShell.refreshConnections());
    await page.getByText("Remove Saved desk and delete its sign-in from this device?").waitFor();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("heading", { name: "Saved desk" }).waitFor();
    assert.equal(await page.evaluate(() => (window as any).testShell.calls.remove), 0, "cancel removes nothing");
  });
});

test("a connection that disappears under an open rename form returns to the list instead of renaming nothing", async () => {
  await withShell(async page => {
    await openRename(page);
    await page.evaluate(() => (window as any).testShell.setConnections([]));
    await page.getByRole("heading", { name: "No connections yet" }).waitFor();
    assert.equal(await page.getByLabel("Name", { exact: true }).count(), 0);
  });
});
