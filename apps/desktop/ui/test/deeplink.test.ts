import { test } from "node:test";
import assert from "node:assert/strict";
import { withShell } from "./browser-harness.ts";

test("pair_link_prefills_and_never_pairs: origin and pin visible, existing rows preserved", async () => {
  await withShell(async page => {
    await page.evaluate(() => (window as any).testShell.offerLink({ id: 1, intent: { kind: "pair", origin: "https://harness.test", code: "ABCD-1234", pin: "sha256:" + "A".repeat(43), ca: null } }));
    await page.getByText("https://harness.test", { exact: true }).waitFor();
    assert.equal(await page.locator("#pair-origin").inputValue(), "https://harness.test");
    assert.equal(await page.locator("#pair-code-first").inputValue(), "ABCD");
    assert.equal(await page.locator("#pair-code-second").inputValue(), "1234");
    assert.equal(await page.evaluate(() => (window as any).testShell.calls.pair), 0);
    await page.locator("#pair-name").fill("Work harness");
    await page.getByRole("radio", { name: "Direct" }).check();
    await page.locator('form button[type="submit"]').click();
    await page.waitForFunction(() => (window as any).testShell.calls.pair === 1);
  });
});
test("external hooks are unavailable and code is absent from browser URL", async () => {
  await withShell(async page => {
    for (const kind of ["chat", "install", "p1x"]) {
      await page.evaluate(kind => (window as any).testShell.offerLink({ id: 2, intent: { kind, rest: "session-1", catalogue_id: "skill.example" } }), kind);
      await page.getByText("Not available in this version", { exact: true }).waitFor();
      assert.ok(!page.url().includes("ABCD"));
      await page.getByRole("button", { name: "Close details", exact: true }).click();
    }
    assert.equal(await page.evaluate(() => (window as any).testShell.calls.pair), 0);
  });
});

test("link confirmations pass WCAG, reflow and keyboard focus in DE/EN and both themes", async () => {
  await withShell(async page => {
    await page.addScriptTag({url: "/axe.js"});
    for (const locale of ["en", "de"]) for (const theme of ["light", "dark"]) {
      await page.evaluate(async prefs => { await (window as any).testShell.setPreferences(prefs); }, {locale, theme});
      for (const kind of ["pair", "p1x", "install", "chat"]) {
        await page.evaluate(kind => (window as any).testShell.offerLink({id: 3, intent:{kind, origin:"https://harness.test", code:"ABCD-1234", pin:"sha256:" + "A".repeat(43), ca:null}}), kind);
        for (const width of [400, 960, 1440, 2560]) {
          await page.setViewportSize({width, height:900});
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${kind}/${width}`);
        }
        const violations = await page.evaluate(async () => (await (window as any).axe.run(document, {runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa"]}})).violations.map((v:any) => ({id:v.id, nodes:v.nodes.map((n:any)=>n.target)})));
        assert.deepEqual(violations, [], `${kind}/${locale}/${theme}`);
        await page.keyboard.press("Tab");
        assert.ok(await page.locator(":focus-visible").count());
        if (kind === "pair") await page.getByRole("button", {name:locale === "en" ? "Cancel" : "Abbrechen",exact:true}).click();
        else await page.getByRole("button", {name:locale === "en" ? "Close details" : "Details schließen",exact:true}).click();
      }
    }
  });
});

test("failed confirmed pairing keeps readonly code for an explicit retry", async () => {
  await withShell(async page => {
    await page.evaluate(() => { (window as any).testShell.setPairingError("network"); (window as any).testShell.offerLink({ id: 4, intent: {kind:"pair", origin:"https://harness.test", code:"ABCD-1234",pin:null,ca:null} }); });
    await page.locator("#pair-name").fill("Desk");
    await page.getByRole("radio", { name: "Direct" }).check();
    await page.locator('form button[type="submit"]').click();
    await page.waitForFunction(() => (window as any).testShell.calls.pair === 1);
    assert.equal(await page.locator("#pair-code-first").inputValue(), "ABCD");
    assert.equal(await page.locator("#pair-code-second").inputValue(), "1234");
    await page.evaluate(() => (window as any).testShell.setPairingError(null));
    await page.locator('form button[type="submit"]').click();
    await page.waitForFunction(() => (window as any).testShell.calls.pair === 2);
  });
});
