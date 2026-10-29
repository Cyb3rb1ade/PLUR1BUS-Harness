// Audit c19: the consent the person gives is the consent for what the server will act on.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";
import { seedExtensions } from "./surfaces-fixtures.ts";
import type { ExtDetail } from "../src/pages/common/surfaces-rpc.ts";

before(setup);
after(teardown);

const detailFor = (rpc: Parameters<typeof seedExtensions>[0], capsOf: () => unknown): void => {
  rpc.handle("ext.show", (params) => {
    const { name } = params as { name: string };
    return {
      item: { name, id: `x/${name}`, kind: "module", version: "2.0.0", source: "file", trust: "release", state: "installed", overlays: [], enabled: false, agents: "all" },
      manifest: { name, version: "2.0.0" }, capabilities: capsOf(), scripts: [], trust: { tier: "release", label: "release" },
      files: { count: 1, bytes: 1 }, dependents: [], trash: [],
    };
  }, { write: false });
};

describe("extension consent", { skip: browserSkip }, () => {
  test("bundle enable shows installed child rights and requires fresh acknowledgement after a child changes", async () => {
    await withApp({}, async (app) => {
      const member = { name: "member", kind: "skill" as const, version: "1.0.0", sha256: "a".repeat(64), optional: false, enabled: false, agents: "all" as const };
      const detail: ExtDetail = {
        item: { name: "test-bundle", id: "test/bundle", kind: "bundle", version: "1.0.0", source: "file", trust: "release", state: "installed", overlays: [], enabled: false, agents: "all", members: [member] },
        manifest: { kind: "bundle" }, capabilities: {}, scripts: [], trust: { tier: "release" },
        files: { count: 1, bytes: 1 }, dependents: [], trash: [], members: [member], consentSha256: "c".repeat(64),
        memberInspections: [{ ...member, manifest: { id: "test/member", kind: "skill", version: "1.0.0", licence: "MIT" }, trust: { tier: "unsigned", keyId: "child-key" }, capabilities: { network: "none" }, scripts: [{ path: "run.sh", size: 1, firstLine: "#!/bin/sh" }], checks: [], requires: {} }],
      };
      seedExtensions(app.server.rpc, [detail.item]);
      app.server.rpc.handle("ext.show", () => detail, { write: false });
      await openRoute(app.page, "#/plugins");
      await app.page.getByRole("button", { name: /test-bundle/i }).click();
      await app.page.getByRole("button", { name: /^Enable$/ }).click();
      const dialog = app.page.getByRole("dialog");
      assert.equal(await dialog.getByText("Signing key ID", { exact: true }).locator("+ dd").innerText(), "child-key");
      assert.ok((await dialog.innerText()).includes("#!/bin/sh"));
      await dialog.getByRole("checkbox").check();
      detail.memberInspections![0]!.capabilities = { processes: { spawn: true, commands: ["danger"] } };
      await dialog.getByRole("button", { name: "Enable now" }).click();
      await dialog.locator('[data-right="processes"]').waitFor();
      assert.equal(await dialog.getByRole("checkbox").isChecked(), false);
      assert.equal(app.server.rpc.calls.filter(call => call.method === "ext.enable").length, 0);
      await dialog.getByRole("checkbox").check();
      await dialog.getByRole("button", { name: "Enable now" }).click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(app.server.rpc.calls.filter(call => call.method === "ext.enable").length, 1);
      assert.equal((app.server.rpc.calls.find(call => call.method === "ext.enable")?.params as { expectedConsentSha256: string }).expectedConsentSha256, detail.consentSha256);
    });
  });

  test("bundle enable cannot approve only an inert wrapper when child disclosures are absent", async () => {
    await withApp({}, async (app) => {
      const member = { name: "member", kind: "skill" as const, version: "1.0.0", sha256: "a".repeat(64), optional: false, enabled: false, agents: "all" as const };
      const item = { name: "test-bundle", id: "test/bundle", kind: "bundle" as const, version: "1.0.0", source: "file", trust: "release" as const, state: "installed" as const, overlays: [], enabled: false, agents: "all" as const, members: [member] };
      seedExtensions(app.server.rpc, [item]);
      await openRoute(app.page, "#/plugins");
      await app.page.getByRole("button", { name: /test-bundle/i }).click();
      await app.page.getByRole("button", { name: /^Enable$/ }).click();
      const dialog = app.page.getByRole("dialog");
      await dialog.getByRole("alert").waitFor();
      await dialog.getByRole("checkbox").check();
      assert.equal(await dialog.getByRole("button", { name: "Enable now" }).isDisabled(), true);
      assert.equal(app.server.rpc.calls.filter(call => call.method === "ext.enable").length, 0);
    });
  });

  test("enable: rights that changed after the dialog opened are shown again and nothing is enabled", async () => {
    await withApp({}, async (app) => {
      seedExtensions(app.server.rpc);
      let caps: unknown = { network: "none" };
      detailFor(app.server.rpc, () => caps);
      await openRoute(app.page, "#/plugins");
      await app.page.getByRole("button", { name: /auth-oauth/i }).click();
      await app.page.getByRole("button", { name: /^Enable$/i }).click();
      const dlg = app.page.getByRole("dialog");
      await dlg.waitFor();
      caps = { network: "none", processes: { spawn: true, commands: ["rm"] } };
      await dlg.getByRole("checkbox").check();
      await dlg.getByRole("button", { name: /Enable now/i }).click();
      await dlg.locator('[data-right="processes"]').waitFor({ state: "visible" });
      assert.equal(app.server.rpc.calls.filter((c) => c.method === "ext.enable").length, 0, "the changed rights were not accepted");
      assert.equal(await dlg.getByRole("checkbox").isChecked(), false, "acknowledgement starts over");
      assert.ok(await dlg.getByRole("alert").count() > 0, "the change is announced");
    });
  });

  test("enable: a double click on the confirm button enables once", async () => {
    await withApp({}, async (app) => {
      seedExtensions(app.server.rpc);
      detailFor(app.server.rpc, () => ({ network: "none" }));
      app.server.rpc.setDelay("ext.enable", 200);
      await openRoute(app.page, "#/plugins");
      await app.page.getByRole("button", { name: /auth-oauth/i }).click();
      await app.page.getByRole("button", { name: /^Enable$/i }).click();
      const dlg = app.page.getByRole("dialog");
      await dlg.getByRole("checkbox").check();
      await dlg.getByRole("button", { name: /Enable now/i }).dblclick();
      await app.page.waitForTimeout(500);
      assert.equal(app.server.rpc.calls.filter((c) => c.method === "ext.enable").length, 1);
    });
  });

  test("install: the dialog names the package and its trust tier, and a failed check blocks installing", async () => {
    await withApp({}, async (app) => {
      seedExtensions(app.server.rpc);
      const inspection = {
        inspectionId: "insp_1", expiresAt: "2099-01-01T00:00:00Z", sha256: "a".repeat(64),
        manifest: { id: "evil/exfil", kind: "skill", version: "6.6.6" }, trust: { tier: "unsigned", label: "unsigned" },
        checks: [{ id: "integrity", status: "fail", detail: "hash mismatch inside archive" }],
        capabilities: { network: "any" }, scripts: [], requires: {},
      };
      app.server.rpc.handle("ext.inspect", () => inspection);
      app.server.rpc.handle("ext.inspection.get", () => inspection, { write: false });
      app.server.extensions.push((_req, res, path) => {
        if (path !== "/api/v1/extensions/upload") return false;
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ uploadId: "U".repeat(43), expiresAt: 600000, sha256: "a".repeat(64) })); return true;
      });
      await openRoute(app.page, "#/skills");
      await app.page.getByRole("button", { name: /Install from file/i }).first().click();
      const dlg = app.page.getByRole("dialog");
      await dlg.locator("#ext-file-input").setInputFiles({ name: "x.p1x", mimeType: "application/octet-stream", buffer: Buffer.from("x") });
      await app.page.getByRole("heading", { name: "Confirm extension installation" }).waitFor();
      const confirmation = app.page.locator("main");
      // The heading renders before the inspection arrives ("Loading…"); read the page once the package is shown.
      await confirmation.getByText("evil/exfil").first().waitFor();
      const text = (await confirmation.textContent()) ?? "";
      assert.match(text, /evil\/exfil/);
      assert.match(text, /6\.6\.6/);
      assert.match(text, /unsigned/);
      assert.match(text, /hash mismatch inside archive/);
      await confirmation.getByLabel("I accept every requested capability shown above.").check();
      await confirmation.getByLabel("I understand that this package is unsigned and its publisher is unverified.").check();
      assert.equal(await confirmation.getByRole("button", { name: "Install unsigned package", exact: true }).isDisabled(), true);
      assert.equal(app.server.rpc.calls.filter(call => call.method === "ext.install").length, 0);
    });
  });

  test("detail: an ext.changed event refreshes the open detail (the rights the dialog will show)", async () => {
    await withApp({}, async (app) => {
      seedExtensions(app.server.rpc);
      let caps: unknown = { network: "none" };
      detailFor(app.server.rpc, () => caps);
      app.server.events.enable();
      await openRoute(app.page, "#/plugins");
      await app.page.getByRole("button", { name: /auth-oauth/i }).click();
      await app.page.locator('[data-right="network"]').first().waitFor();
      await app.server.events.waitForConnections(1);
      caps = { network: "none", hostBridge: ["keychain"] };
      app.server.events.push({ event: "ext.changed", data: {} });
      await app.page.locator('[data-right="hostBridge"]').first().waitFor({ timeout: 5000 });
    });
  });
});
