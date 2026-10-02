import { test } from "node:test";
import assert from "node:assert/strict";
import { withShell } from "./browser-harness.ts";
test("reachable remote form validates origin, pairs, selects, renames and removes", async () => {
    await withShell(async (page) => {
        await page.getByRole("button", { name: "View connections" }).click();
        await page.getByRole("button", { name: "Add remote", exact: true }).click();
        assert.equal(await page.getByLabel("Name", { exact: true }).evaluate(node => document.activeElement === node), true);
        await page.getByLabel("Name", { exact: true }).fill("Synthetic desk");
        await page.getByLabel("Harness origin").fill("http://harness.test");
        await page.getByLabel("First four characters").fill("ABCD");
        await page.getByLabel("Last four characters").fill("2345");
        await page.getByRole("button", { name: "Pair harness", exact: true }).click();
        assert.equal(await page.getByLabel("Harness origin").getAttribute("aria-invalid"), "true");
        await page.getByLabel("Harness origin").fill("https://harness.test");
        await page.getByRole("button", { name: "Pair harness", exact: true }).click();
        await page.getByRole("heading", { name: "Synthetic desk" }).waitFor();
        await page.getByRole("button", { name: "Open", exact: true }).click();
        await page.getByText("Connection verified and selected.", { exact: false }).waitFor();
        await page.evaluate(() => (window as any).testShell.setPairingError("network"));
        await page.getByRole("button", { name: "Open", exact: true }).click();
        await page.getByRole("alert").waitFor();
        assert.equal(await page.getByText("Connection verified and selected.", { exact: false }).count(), 0);
        await page.evaluate(() => (window as any).testShell.setPairingError(null));
        await page.getByRole("button", { name: "Rename", exact: true }).click();
        await page.getByLabel("Name", { exact: true }).fill("Renamed desk");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await page.getByRole("heading", { name: "Renamed desk" }).waitFor();
        await page.getByRole("button", { name: "Remove connection", exact: true }).click();
        await page.getByRole("button", { name: "Remove connection", exact: true }).click();
        await page.getByRole("heading", { name: "No connections yet" }).waitFor();
    });
});
test("native denial reaches code form; remote errors and repair retain accessible controls", async () => {
    await withShell(async (page) => {
        await page.getByRole("button", { name: "View connections" }).click();
        await page.getByRole("button", { name: "Attach native local", exact: true }).click();
        await page.getByLabel("Name", { exact: true }).fill("Desk");
        await page.getByRole("button", { name: "Attach native local", exact: true }).click();
        await page.getByRole("heading", { name: "Add remote" }).waitFor();
        await page.getByLabel("Name", { exact: true }).fill("Desk");
        await page.getByLabel("Harness origin").fill("https://harness.test");
        for (const error of ["revoked", "cert-changed", "ca-untrusted", "proof-mismatch"]) {
            await page.evaluate(error => (window as any).testShell.setPairingError(error), error);
            await page.getByLabel("First four characters").fill("ABCD");
            await page.getByLabel("Last four characters").fill("2345");
            await page.getByRole("button", { name: "Pair harness", exact: true }).click();
            await page.waitForFunction(() => document.querySelector<HTMLInputElement>(".code-fields input")?.value === "");
            assert.equal(await page.getByLabel("First four characters").evaluate(node => document.activeElement === node), true);
        }
    });
});
test("new connection states pass axe, keyboard and400px layout in DE/EN light/dark", async () => {
    await withShell(async (page) => {
        await page.addScriptTag({ url: "/axe.js" });
        await page.getByRole("button", { name: "View connections" }).click();
        for (const theme of ["light", "dark"])
            for (const locale of ["en", "de"]) {
                await page.evaluate(({ theme, locale }) => (window as any).testShell.setPreferences({ theme, locale }), { theme, locale });
                await page.setViewportSize({ width: 400, height: 900 });
                await page.getByRole("button", { name: locale === "de" ? "Remote hinzufügen" : "Add remote", exact: true }).click();
                const violations = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } })).violations);
                assert.deepEqual(violations.map((v: any) => v.id), []);
                const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, short: Array.from(document.querySelectorAll<HTMLElement>("input,button")).filter(e => e.getBoundingClientRect().width && e.getBoundingClientRect().height < 44).map(e => e.tagName) }));
                assert.ok(dimensions.scroll <= dimensions.width);
                assert.deepEqual(dimensions.short, []);
                await page.keyboard.press("Tab");
                assert.equal(await page.getByLabel(locale === "de" ? "Harness-Adresse" : "Harness origin").evaluate(node => document.activeElement === node), true);
                await page.getByRole("button", { name: locale === "de" ? "Abbrechen" : "Cancel", exact: true }).click();
            }
    });
});
test("CA received, trust next and changed certificate details remain reachable at compact width", async () => {
    await withShell(async (page) => {
        await page.evaluate(() => { (window as any).testShell.setConnections([{ id: "fixture-row", name: "Company desk", kind: "remote", origin: "https://harness.test", installationId: "fixture-installation", deviceId: "fixture-device", tokenHint: "hint", certPin: null, caPin: `sha256:${"A".repeat(43)}`, nextCertPin: `sha256:${"B".repeat(43)}`, nextCaPin: null, observedCertPin: `sha256:${"C".repeat(43)}`, pairingNeeded: true }]); });
        await page.setViewportSize({ width: 400, height: 900 });
        await page.getByRole("button", { name: "View connections" }).click();
        await page.getByText("Company CA received through pairing.", { exact: false }).waitFor();
        await page.getByText("New certificate announced.", { exact: false }).waitFor();
        await page.getByRole("button", { name: "Connection details", exact: true }).click();
        const dialog = page.getByRole("dialog");
        await dialog.getByText("Observed fingerprint", { exact: true }).waitFor();
        await page.addScriptTag({ url: "/axe.js" });
        assert.deepEqual(await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } })).violations.map((v: any) => v.id)), []);
        await page.keyboard.press("Escape");
        assert.equal(await page.getByRole("button", { name: "Connection details", exact: true }).evaluate(node => document.activeElement === node), true);
        await page.getByRole("button", { name: "Pair again", exact: true }).click();
        assert.equal(await page.getByLabel("Name", { exact: true }).getAttribute("readonly"), "");
        assert.equal(await page.getByLabel("Harness origin").getAttribute("readonly"), "");
    });
});

test("OS theme and late connection refresh preserve remote form focus and input", async () => {
    await withShell(async page => {
        await page.getByRole("button", { name: "View connections" }).click();
        await page.getByRole("button", { name: "Add remote", exact: true }).click();
        await page.getByLabel("Name", { exact: true }).fill("Scratch desk");
        await page.getByLabel("Harness origin").fill("https://harness.test");
        await page.getByLabel("Harness origin").focus();
        await page.emulateMedia({colorScheme:"dark"});
        await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
        assert.equal(await page.getByLabel("Harness origin").evaluate(node => node === document.activeElement), true);
        await page.evaluate(() => (window as any).testShell.refreshConnections());
        assert.equal(await page.getByLabel("Harness origin").evaluate(node => node === document.activeElement), true);
        assert.equal(await page.getByLabel("Name", { exact:true }).inputValue(), "Scratch desk");
        assert.equal(await page.getByLabel("Harness origin").inputValue(), "https://harness.test");
    });
});
