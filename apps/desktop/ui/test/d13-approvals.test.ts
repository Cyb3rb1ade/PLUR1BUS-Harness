// Audit D13 (apps/desktop/ui): written red first; the fix is in the same commit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withShell } from "./browser-harness.ts";
const card = { id: "fixture", capability: "fs.read", effect: "read", targets: ["/synthetic"], risk: "low", reversible: true, grantOptions: ["once"], actionHash: "sha256:synthetic", reason: "synthetic" };

test("approval card: one pending decision disables every action of that card", async () => {
  await withShell(async page => {
    await page.evaluate(c => { const s = (window as any).testShell; s.hold("decide"); s.showPendingApprovals([c]); }, card);
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Deny", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Approve", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "Deny", exact: true }).click({ force: true });
    assert.equal(await page.evaluate(() => (window as any).testShell.calls.decide), 1);
    await page.evaluate(() => (window as any).testShell.release("decide"));
    await page.getByRole("button", { name: "Open in PLUR1BUS" }).waitFor();
    await page.waitForFunction(() => !(document.querySelector("article button") as HTMLButtonElement).disabled);
    // A decided card stays closed until the native change event replaces it.
    assert.equal(await page.getByRole("button", { name: "Deny", exact: true }).isDisabled(), true);
  });
});

test("approvals window: a failed read shows an alert, and a slow older read cannot overwrite a newer one", async () => {
  await withShell(async page => {
    await page.evaluate(() => (window as any).testShell.mountApprovalsWindow());
    await page.waitForFunction(() => (window as any).testShell.approvalsList.length === 1);
    await page.evaluate(() => (window as any).testShell.approvalsList[0].reject("boom"));
    await page.getByRole("alert").waitFor({ timeout: 3000 });
    // Two overlapping reads: the second (newer) one answers first, the stale first one afterwards.
    await page.evaluate(() => { const s = (window as any).testShell; s.approvalsChanged(); s.approvalsChanged(); });
    await page.waitForFunction(() => (window as any).testShell.approvalsList.length === 3);
    const cardOf = (id: string) => ({ ...card, id, capability: id, targets: [id] });
    await page.evaluate(c => (window as any).testShell.approvalsList[2].resolve({ cards: [c], decideEnabled: true }), cardOf("fresh.read"));
    await page.getByRole("heading", { name: "fresh.read" }).waitFor();
    await page.evaluate(c => (window as any).testShell.approvalsList[1].resolve({ cards: [c], decideEnabled: true }), cardOf("stale.read"));
    await page.waitForTimeout(200);
    assert.equal(await page.getByRole("heading", { name: "stale.read" }).count(), 0);
    assert.equal(await page.getByRole("heading", { name: "fresh.read" }).count(), 1);
  });
});
