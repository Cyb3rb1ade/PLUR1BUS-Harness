import { test } from "node:test";
import assert from "node:assert/strict";
import { withShell } from "./browser-harness.ts";

test("native file offers choose an origin before upload and open confirmation without installation", async () => {
    await withShell(async page => {
        await page.evaluate(async () => {
            await (window as any).testShell.setConnections(["one", "two"].map(id => ({ id, name:id, kind:"remote", origin:`https://${id}.example`, installationId:id, deviceId:id, tokenHint:"hint", pairingNeeded:false })));
            (window as any).testShell.offerLink({ id:31, intent:{kind:"p1x"} });
        });
        const review = page.getByRole("button", { name:"Upload and review", exact:true });
        await review.waitFor();
        assert.equal(await review.isDisabled(), true);
        assert.equal(await page.evaluate(() => (window as any).testShell.calls.extensionUploads.length), 0);
        await page.locator("#extension-connection").selectOption("two");
        await page.getByText("https://two.example", {exact:true}).last().waitFor();
        await review.click();
        await page.waitForFunction(() => (window as any).testShell.calls.extensionUploads.length === 1);
        assert.deepEqual(await page.evaluate(() => (window as any).testShell.calls.extensionUploads), [{ linkId:31, connectionId:"two" }]);
        assert.equal(await page.evaluate(() => (window as any).testShell.calls.install), 0);
    }, undefined, { extensionUpload:true });
});

test("native package review passes accessibility, keyboard and reflow checks in both languages and themes", async () => {
    await withShell(async page => {
        await page.addScriptTag({url:"/axe.js"});
        for (const locale of ["en", "de"]) for (const theme of ["light", "dark"]) {
            await page.evaluate(async prefs => {
                await (window as any).testShell.setPreferences(prefs);
                await (window as any).testShell.setConnections([{id:"one", name:"One", kind:"remote", origin:"https://one.example", installationId:"one",deviceId:"one",tokenHint:"hint",pairingNeeded:false}]);
                (window as any).testShell.offerLink({id:32,intent:{kind:"p1x"}});
            }, {locale,theme});
            for (const width of [400,960,1440,2560]) {
                await page.setViewportSize({width,height:900});
                assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            }
            assert.deepEqual(await page.evaluate(async () => (await (window as any).axe.run(document,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa"]}})).violations.map((v:any) => v.id)), []);
            await page.keyboard.press("Tab");
            assert.ok(await page.locator(":focus-visible").count());
            await page.getByRole("button", {name:locale === "en" ? "Close details" : "Details schließen",exact:true}).click();
        }
    }, undefined, {extensionUpload:true});
});
