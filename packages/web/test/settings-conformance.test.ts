// Conditional M3 surfaces supplement the registry-root matrix with loaded controls and long public data.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { expectAxeClean } from "./axe.ts";
import { layout } from "./layout-contract.ts";
import { seedConfig } from "./settings-config-fixtures.ts";
import { remoteFixture } from "./remote-fixtures.ts";
import { seedDevices } from "./shots-m3b.ts";

before(setup); after(teardown);
async function load(app: App, section: "security" | "devices", lang: "en" | "de") {
  seedConfig(app.server.rpc, { remote: { publish: "network" }, tools: { hostctl: { enabled: true, shell: { allowed: false } } } });
  if (section === "security") {
    app.server.extensions.unshift((req, res, path) => {
      if (req.method !== "GET" || !["/api/v1/me/passkeys", "/api/v1/me/totp"].includes(path)) return false;
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(path.endsWith("passkeys") ? { keys: [{ id: "key1", name: "Workstation biometric security key" }] } : { enabled: true })); return true;
    });
  } else {
    const remote = remoteFixture(app, { publish: "network", tls: "company-ca", publicOrigin: "https://harness.example", bind: { address: "127.0.0.1", port: 8443 }, allowSubnets: ["192.168.0.0/16"], status: { state: "ready" } });
    remote.setTrustStaged(); remote.setTrustMissing([{ id: "tablet", name: "Work tablet awaiting certificate acknowledgment" }]);
    app.server.rpc.handle("device.list", () => ({ devices: [] }), { write: false });
  }
  await openRoute(app.page, `#/settings/${section}`, lang);
  await app.page.locator(`main[data-page="settings"] section[data-section="${section}"]`).waitFor();
  await app.page.waitForFunction(() => document.querySelectorAll('main [data-state="loading"]').length === 0);
  if (section === "security") await app.page.getByText("Workstation biometric security key", { exact: false }).waitFor();
  else {
    await app.page.getByText("Work tablet awaiting certificate acknowledgment", { exact: false }).waitFor();
    const create = app.page.getByRole("button", { name: lang === "en" ? "Create pairing offer" : "Kopplungsangebot erstellen", exact: true });
    await create.click(); await app.page.locator(".pairing-qr svg").waitFor();
  }
}
for (const section of ["security", "devices"] as const) describe(`loaded Settings ${section} conformance`, { skip: browserSkip }, () => {
  for (const lang of ["en", "de"] as const) for (const colorScheme of ["light", "dark"] as const) {
    for (const width of [400, 960, 1440, 2560]) test(`${lang}/${colorScheme}/${width}: axe, targets and overflow`, async () => {
      await withApp({ width, height: 900, colorScheme, locale: lang === "de" ? "de-DE" : "en-US", reducedMotion: "reduce" }, async app => {
        await load(app, section, lang); await expectAxeClean(app.page, `${section}/${lang}/${colorScheme}/${width}`);
        await layout(app.page, width < 1024, section); assert.deepEqual(app.problems, []);
      });
    });
    test(`${lang}/${colorScheme}/200%: reflow and enlarged text`, async () => {
      await withApp({ width: 720, height: 600, deviceScaleFactor: 2, colorScheme, locale: lang === "de" ? "de-DE" : "en-US", reducedMotion: "reduce" }, async app => {
        await load(app, section, lang); await expectAxeClean(app.page, `${section}/reflow`); await layout(app.page, true, section);
      });
      await withApp({ width: 1440, height: 1200, colorScheme, locale: lang === "de" ? "de-DE" : "en-US", reducedMotion: "reduce" }, async app => {
        await load(app, section, lang); await app.page.evaluate(() => { document.documentElement.style.zoom = "2"; });
        await expectAxeClean(app.page, `${section}/zoom`);
        const overflow = await app.page.evaluate(() => Array.from(document.querySelectorAll("main *")).filter(el => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1).map(el => `${el.tagName}.${el.className}: ${el.getBoundingClientRect().right}`));
        assert.deepEqual(overflow, [], "Enlarged text must fit");
      });
    });
  }
});
test("Devices screenshot seed follows the served REST status contract", { skip: browserSkip }, async () => {
  await withApp({}, async app => { seedDevices(app.server); await openRoute(app.page, "#/settings/devices"); await app.page.getByText("Published as tailnet").waitFor(); });
});
