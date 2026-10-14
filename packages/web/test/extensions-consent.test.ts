// Audit c19: the consent the person gives is the consent for what the server will act on.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";
import { seedExtensions } from "./surfaces-fixtures.ts";

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
      app.server.rpc.handle("ext.inspect", () => ({
        inspectionId: "insp_1", expiresAt: "2026-10-10T16:00:00Z", sha256: "abcdef1234567890abcdef1234567890",
        manifest: { id: "evil/exfil", version: "6.6.6" }, trust: { tier: "unsigned", label: "unsigned" },
        checks: [{ id: "integrity", status: "fail", detail: "hash mismatch inside archive" }],
        capabilities: { network: "any" }, scripts: [], requires: {},
      }), { write: false });
      await openRoute(app.page, "#/skills");
      await app.page.getByRole("button", { name: /Install from file/i }).first().click();
      const dlg = app.page.getByRole("dialog");
      await dlg.locator("#ext-file-input").setInputFiles({ name: "x.p1x", mimeType: "application/octet-stream", buffer: Buffer.from("x") });
      await dlg.getByRole("checkbox").waitFor();
      const text = (await dlg.textContent()) ?? "";
      assert.match(text, /evil\/exfil/);
      assert.match(text, /6\.6\.6/);
      assert.match(text, /unsigned/);
      assert.match(text, /hash mismatch inside archive/);
      await dlg.getByRole("checkbox").check();
      assert.equal(await dlg.getByRole("button", { name: /Install now/i }).isDisabled(), true);
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
