import { test } from "node:test";
import assert from "node:assert/strict";
import { withShell } from "./browser-harness.ts";
const row = { id: "fixture-row", name: "Saved desk", kind: "remote", origin: "https://harness.test", installationId: "synthetic", deviceId: "synthetic", tokenHint: "hint", certPin: null, caPin: null, nextCertPin: null, nextCaPin: null, observedCertPin: null, pairingNeeded: false };
test("startup Home and top read saved public metadata before visiting Connections", async () => {
    await withShell(async page => {
        await page.addInitScript(row => { (window as any).__fixtureBoot = { rows: [row] }; }, row);
        await page.reload();
        await page.waitForFunction(() => document.querySelector(".top-status")?.textContent === "Connections: 1", undefined, { timeout: 3000 });
        assert.ok(await page.locator(".home-cards").innerText().then(text => text.includes("Saved desk")));
        await page.getByRole("button", { name: "View connections" }).click();
        await page.getByRole("heading", { name: "Saved desk" }).waitFor();
    });
});
test("pair then Home then restart retains the shared connection summary", async () => {
    await withShell(async page => {
        await page.getByRole("button", { name: "View connections" }).click();
        await page.getByRole("button", { name: "Add remote", exact: true }).click();
        await page.getByLabel("Name", { exact: true }).fill("Paired desk");
        await page.getByLabel("Harness origin").fill("https://harness.test");
        await page.getByLabel("First four characters").fill("ABCD");
        await page.getByLabel("Last four characters").fill("2345");
        await page.getByRole("button", { name: "Pair harness", exact: true }).click();
        await page.getByRole("heading", { name: "Paired desk" }).waitFor();
        await page.evaluate(() => (window as any).testShell.navigate("home"));
        assert.ok((await page.locator(".home-cards").innerText()).includes("Paired desk"));
        const rows = await page.evaluate(() => (window as any).testShell.storedConnections());
        await page.addInitScript(rows => { (window as any).__fixtureBoot = { rows }; }, rows);
        await page.reload();
        await page.waitForFunction(() => document.querySelector(".home-cards")?.textContent?.includes("Paired desk"));
        assert.equal(await page.locator(".top-status").innerText(), "Connections: 1");
    });
});
test("loading and failed public metadata reads never claim an empty list", async () => {
    await withShell(async page => {
        await page.addInitScript(() => { (window as any).__fixtureBoot = { deferConnections: true, failConnections: true }; });
        await page.reload();
        await page.getByRole("button", { name: "View connections" }).waitFor();
        assert.equal(await page.locator(".top-status").innerText(), "Loading connections…");
        assert.ok(!(await page.locator(".home-cards").innerText()).includes("will appear"));
        await page.getByRole("button", { name: "View connections" }).click();
        assert.equal(await page.getByRole("heading", { name: "No connections yet" }).count(), 0);
        await page.evaluate(() => (window as any).testShell.releaseConnections());
        await page.waitForFunction(() => document.querySelector(".top-status")?.textContent === "Connections could not be loaded.");
        assert.equal(await page.getByRole("heading", { name: "No connections yet" }).count(), 0);
        await page.evaluate(() => (window as any).testShell.setConnectionsFailure(false));
        await page.getByRole("button", { name: "Refresh", exact: true }).click();
        await page.getByRole("heading", { name: "No connections yet" }).waitFor();
    });
});
