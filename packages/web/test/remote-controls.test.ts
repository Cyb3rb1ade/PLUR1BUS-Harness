import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";
import { remoteFixture } from "./remote-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };
const route = "#/settings/devices";

describe("remote controls: real REST contract", opts, () => {
  test("local hides pairing; network change needs explicit notice confirmation before PATCH", async () => {
    await withApp({}, async app => {
      const remote = remoteFixture(app);
      await openRoute(app.page, route);
      await app.page.getByLabel("Exposure", { exact: true }).selectOption("network");
      const save = app.page.getByRole("button", { name: "Apply remote settings" });
      assert.equal(await save.isDisabled(), true);
      assert.equal(await app.page.getByRole("group", { name: "Pair a device" }).count(), 0);
      assert.equal(remote.calls.filter(c => c.method === "PATCH").length, 0);
      await app.page.getByLabel("Allowed client subnets (CIDR, one per line)").fill("192.168.0.0/16\n10.0.0.0/8");
      await app.page.getByRole("checkbox", { name: "I understand and confirm the network security notice" }).click();
      await save.click();
      await app.page.getByText("Settings saved. Restart the harness to apply them.").waitFor();
      const writes = remote.calls.filter(c => c.method !== "GET");
      assert.deepEqual(writes.map(c => [c.method, c.path]), [["POST", "/api/v1/remote/confirm"], ["PATCH", "/api/v1/remote"]]);
      assert.deepEqual(writes[0]!.body, { confirmed: true, version: 1 });
      assert.deepEqual((writes[1]!.body as { allowSubnets: string[] }).allowSubnets, ["192.168.0.0/16", "10.0.0.0/8"]);
    });
  });
  test("a refused notice confirmation never applies network settings", async () => {
    await withApp({}, async app => {
      const remote = remoteFixture(app); remote.setConfirmStatus(403);
      await openRoute(app.page, route); await app.page.getByLabel("Exposure", { exact: true }).selectOption("network");
      await app.page.getByRole("checkbox", { name: "I understand and confirm the network security notice" }).click();
      await app.page.getByRole("button", { name: "Apply remote settings" }).click();
      await app.page.getByRole("alert").waitFor();
      assert.equal(remote.calls.filter(c => c.method === "PATCH").length, 0);
    });
  });
  test("trusted live announcements refresh the certificate card", async () => {
    await withApp({}, async app => {
      const remote = remoteFixture(app, { publish: "tailnet", status: { state: "ready" } });
      app.server.events.enable(); await openRoute(app.page, route);
      await app.page.getByRole("button", { name: "Announce next certificate" }).waitFor();
      await app.server.events.waitForConnections(1);
      const before = remote.calls.filter(c => c.path.endsWith("trust")).length;
      remote.setTrustStaged(); app.server.events.push({ event: "devices.trust.next", data: { type: "devices.trust.next" } });
      await app.page.getByText("A certificate change has been announced.").waitFor();
      assert.ok(remote.calls.filter(c => c.path.endsWith("trust")).length > before);
    });
  });
  test("confirmation is keyboard operable and all-interface bind needs its own explicit acknowledgment", async () => {
    await withApp({}, async app => {
      remoteFixture(app); await openRoute(app.page, route);
      await app.page.getByLabel("Exposure", { exact: true }).selectOption("network");
      await app.page.getByLabel("Listen address", { exact: true }).fill("0.0.0.0");
      const notice = app.page.getByRole("checkbox", { name: "I understand and confirm the network security notice" });
      await notice.focus(); await app.page.keyboard.press("Space");
      assert.equal(await notice.getAttribute("aria-checked"), "true");
      const save = app.page.getByRole("button", { name: "Apply remote settings" }); assert.equal(await save.isDisabled(), true);
      const bind = app.page.getByRole("checkbox", { name: "I explicitly allow listening on all interfaces" });
      await bind.focus(); await app.page.keyboard.press("Space"); assert.equal(await save.isDisabled(), false);
    });
  });
  test("company files are sent only by explicit upload; a staged replacement keeps its pending instruction", async () => {
    await withApp({}, async app => {
      const remote = remoteFixture(app); remote.setCertificateStaged(true);
      await openRoute(app.page, route); await app.page.getByLabel("Exposure", { exact: true }).selectOption("network");
      await app.page.getByLabel("TLS certificate", { exact: true }).selectOption("company-ca");
      const certPem = randomBytes(48).toString("base64"); const keyPem = randomBytes(64).toString("base64");
      await app.page.getByLabel("Certificate PEM file").setInputFiles({ name: "certificate.pem", mimeType: "application/x-pem-file", buffer: Buffer.from(certPem) });
      await app.page.getByLabel("Private key PEM file").setInputFiles({ name: "private.pem", mimeType: "application/x-pem-file", buffer: Buffer.from(keyPem) });
      assert.equal(remote.calls.filter(c => c.path.endsWith("certificate")).length, 0);
      await app.page.getByRole("button", { name: "Upload certificate and key" }).click();
      await app.page.getByText(/Certificate staged\./).waitFor();
      const request = remote.calls.find(c => c.path.endsWith("certificate"))!.body as { certPem: string; keyPem: string };
      assert.equal(request.certPem, certPem); assert.equal(request.keyPem, keyPem);
      assert.ok(!(await app.page.locator("body").innerText()).includes(keyPem));
      assert.equal(await app.page.getByLabel("Private key PEM file").inputValue(), "");
      assert.equal(remote.calls.filter(c => c.method === "PATCH").length, 0);
    });
  });
  test("pairing offers use POST and show QR, native deep link and certificate pin without storage", async () => {
    await withApp({ width: 400 }, async app => {
      const remote = remoteFixture(app, { publish: "tailnet", status: { state: "ready" } });
      await openRoute(app.page, route);
      await app.page.getByRole("button", { name: "Create pairing offer" }).click();
      const pair = app.page.getByRole("group", { name: "Pair a device" });
      await pair.locator(".pairing-qr svg").waitFor();
      const link = await pair.getByRole("link").getAttribute("href"); assert.ok(link?.startsWith("plur1bus://pair?"));
      assert.ok(new URL(link!).searchParams.get("pin")?.startsWith("sha256:"));
      assert.equal(remote.calls.filter(c => c.method === "POST" && c.path.endsWith("pairing")).length, 1);
      const code = new URL(link!).searchParams.get("code")!;
      const stores = await app.page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
      assert.ok(!stores.includes(code));
      assert.equal(await app.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
      await expectAxeClean(app.page, "remote-pairing-compact");
    });
  });
  test("trust announcements show missed devices; activate and cancel use CSRF REST actions", async () => {
    await withApp({}, async app => {
      const remote = remoteFixture(app, { publish: "network", status: { state: "ready" } }); remote.setTrustMissing([{ id: "device", name: "Offline phone" }]);
      app.server.events.enable(); await openRoute(app.page, route);
      await app.page.getByRole("button", { name: "Announce next certificate" }).click();
      await app.page.getByText("Offline phone").waitFor();
      await app.page.getByText("1 of 2 devices received the announcement.").waitFor();
      await app.page.getByRole("button", { name: "Activate announced certificate" }).click();
      await app.page.getByRole("button", { name: "Announce next certificate" }).waitFor();
      assert.deepEqual(remote.calls.filter(c => c.path.endsWith("rotate")).map(c => c.body), [{ operation: "stage" }, { operation: "activate" }]);
    });
  });
  for (const locale of ["en-US", "de-DE"]) for (const colorScheme of ["light", "dark"] as const) test(`network notice is accessible (${locale}/${colorScheme})`, async () => {
    await withApp({ locale, colorScheme, width: 400 }, async app => {
      remoteFixture(app); await openRoute(app.page, route, locale === "de-DE" ? "de" : "en");
      await app.page.getByLabel(locale === "de-DE" ? "Erreichbarkeit" : "Exposure", { exact: true }).selectOption("network");
      await expectAxeClean(app.page, `network-notice-${locale}-${colorScheme}`);
    });
  });
});
