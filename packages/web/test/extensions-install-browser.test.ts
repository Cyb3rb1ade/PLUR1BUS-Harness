import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";
import { expectAxeClean } from "./axe.ts";
import { seedExtensions } from "./surfaces-fixtures.ts";
import type { ExtInspection } from "../src/pages/common/surfaces-rpc.ts";
import type { MockHarnessServer } from "./mock-server.ts";

before(setup);
after(teardown);
const inspection = (tier: ExtInspection["trust"]["tier"] = "unsigned"): ExtInspection => ({
  inspectionId: "inspection-owned",
  expiresAt: "2099-01-01T00:00:00Z",
  sha256: "a".repeat(64),
  manifest: {
    id: "fixture/uploaded",
    version: "1.0.0",
    kind: "skill",
    publisher: "Claimed publisher",
    licence: "MIT",
    summary: { en: "Fixture package", de: "Testpaket" },
  },
  trust: { tier, keyId: "test-key-id", subject: "Fixture signer" },
  checks: [{ id: "signature", status: "pass", detail: "checked" }],
  capabilities: { network: "none", processes: { spawn: true, commands: ["sh"] } },
  scripts: [{ path: "scripts/run.sh", size: 20, firstLine: "#!/bin/sh", license: "MIT" }],
  requires: { runtime: "node" },
});
function seed(server: MockHarnessServer, inspected = inspection()): void {
  seedExtensions(server.rpc);
  server.rpc.handle("agent.list", () => ({ agents: [{ agentId: "main" }, { agentId: "other" }] }), { write: false });
  server.rpc.handle("ext.inspection.get", () => inspected, { write: false });
  server.rpc.handle("ext.inspect", (params) => {
    assert.deepEqual(params, { source: { upload: "U".repeat(43) } });
    return inspected;
  });
  server.rpc.handle("ext.install", () => ({
    name: "uploaded",
    version: "1.0.0",
    kind: "skill",
    replaced: false,
    state: "installed",
  }));
  server.extensions.push((req, res, path, body) => {
    if (path !== "/api/v1/extensions/upload") return false;
    const session = server.sessionOf(req),
      token = req.headers["x-csrf-token"];
    assert.ok(session && typeof token === "string" && session.csrf.delete(token));
    assert.match(String(req.headers["content-type"]), /^multipart\/form-data; boundary=/);
    assert.match(body, /real browser file bytes/);
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ uploadId: "U".repeat(43), expiresAt: 600000, sha256: "a".repeat(64) }));
    return true;
  });
}

describe("extension installation through real browser HTTP", { skip: browserSkip }, () => {
  test("bundle confirmation discloses each child, fixes required selection and resets consent when an optional child is included", async () => {
    await withApp({}, async (app) => {
      const inspected = inspection("release");
      inspected.manifest = { id: "fixture/bundle", kind: "bundle", version: "1.0.0", licence: "MIT" };
      const child = (
        name: string,
        optional: boolean,
        tier: ExtInspection["trust"]["tier"],
      ): NonNullable<ExtInspection["members"]>[number] => {
        const { inspectionId: _id, expiresAt: _expiry, ...disclosure } = inspection(tier);
        return {
          ...disclosure,
          name,
          kind: "skill",
          version: "1.0.0",
          optional,
          trust: { tier, keyId: `key-${name}` },
          scripts: [{ path: `scripts/${name}.sh`, size: 10, firstLine: "#!/bin/sh", license: "MIT" }],
        };
      };
      inspected.members = [child("core-child", false, "release"), child("extra-child", true, "unsigned")];
      seed(app.server, inspected);
      await openRoute(app.page, "#/extensions/confirm?inspection=inspection-owned");
      const required = app.page.getByLabel("Include core-child"),
        optional = app.page.getByLabel("Include extra-child");
      await required.waitFor();
      assert.equal(await required.isChecked(), true);
      assert.equal(await required.isDisabled(), true);
      assert.equal(await optional.isChecked(), false);
      for (const value of ["key-core-child", "key-extra-child", "scripts/core-child.sh", "scripts/extra-child.sh"])
        assert.ok((await app.page.locator("main").innerText()).includes(value));
      const rights = app.page.getByLabel(
        "I accept every capability requested by this bundle and the selected members.",
      );
      await rights.check();
      await optional.check();
      assert.equal(await rights.isChecked(), false);
      await rights.check();
      await app.page
        .getByLabel(
          "I accept the unsigned or unknown-signer warnings shown for this bundle and its selected members; those publishers are unverified.",
        )
        .check();
      await expectAxeClean(app.page, "bundle member disclosures and exact optional selection");
      await app.page.getByRole("button", { name: "Install", exact: true }).click();
      await app.page.waitForTimeout(100);
      assert.deepEqual(app.server.rpc.calls.find((call) => call.method === "ext.install")?.params, {
        inspectionId: "inspection-owned",
        acknowledge: ["capabilities", "unsigned"],
        members: ["core-child", "extra-child"],
      });
    });
  });
  test("upload sends bytes, confirmation reloads the owned inspection and activation selects agents", async () => {
    await withApp({}, async (app) => {
      seed(app.server);
      await openRoute(app.page, "#/skills");
      await app.page.getByRole("button", { name: "Install from file", exact: true }).first().click();
      await app.page.locator("#ext-file-input").setInputFiles({
        name: "local.p1x",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("real browser file bytes"),
      });
      await app.page.getByRole("heading", { name: "Confirm extension installation" }).waitFor();
      assert.ok(app.server.requests.some((request) => request.url === "/api/v1/extensions/upload"));
      assert.ok(app.server.rpc.calls.some((call) => call.method === "ext.inspection.get"));
      const text = await app.page.locator("main").innerText();
      for (const disclosure of ["Claimed publisher", "unverified", "test-key-id", "MIT", "#!/bin/sh", "scripts/run.sh"])
        assert.ok(text.includes(disclosure), disclosure);
      await app.page.getByLabel("I accept every requested capability shown above.").check();
      await app.page.getByLabel("I understand that this package is unsigned and its publisher is unverified.").check();
      await app.page.getByLabel("All agents", { exact: true }).uncheck();
      await app.page.getByLabel("main", { exact: true }).check();
      await app.page.getByRole("button", { name: "Install and activate", exact: true }).dblclick();
      await app.page.waitForTimeout(250);
      const installed = app.server.rpc.calls.filter((call) => call.method === "ext.install");
      assert.equal(installed.length, 1);
      assert.deepEqual(installed[0]!.params, {
        inspectionId: "inspection-owned",
        acknowledge: ["capabilities", "unsigned"],
        enable: { agents: ["main"] },
      });
      assert.deepEqual(app.problems, []);
    });
  });
  test("first-party confirmation announces automatic activation and has only Install", async () => {
    await withApp({}, async (app) => {
      seed(app.server, inspection("first-party"));
      await openRoute(app.page, "#/extensions/confirm?inspection=inspection-owned");
      await app.page
        .getByText("This first-party package is active for all agents immediately after installation.", { exact: true })
        .waitFor();
      assert.equal(await app.page.getByRole("button", { name: "Install and activate", exact: true }).count(), 0);
      await app.page.getByLabel("I accept every requested capability shown above.").check();
      await app.page.getByRole("button", { name: "Install", exact: true }).click();
      await app.page.waitForTimeout(100);
      assert.deepEqual(app.server.rpc.calls.find((call) => call.method === "ext.install")?.params, {
        inspectionId: "inspection-owned",
        acknowledge: ["capabilities"],
      });
    });
  });
  test("Member sees forbidden without invoking any extension method", async () => {
    await withApp({ server: { role: "member" } }, async (app) => {
      seed(app.server);
      await openRoute(app.page, "#/plugins");
      await app.page.locator('[data-state="forbidden"]').waitFor();
      assert.equal(app.server.rpc.calls.filter((call) => call.method.startsWith("ext.")).length, 0);
    });
  });
  test("MCP setup keeps secret values write-only and starts OAuth only after the person's action", async () => {
    await withApp({}, async (app) => {
      seed(app.server);
      const item = {
        name: "remote",
        id: "fixture/remote",
        kind: "mcp-server",
        version: "1.0.0",
        source: "file",
        trust: "unsigned",
        state: "installed",
        enabled: false,
        overlays: ["needs-setup"],
        agents: [],
      };
      app.server.rpc.handle("ext.list", () => ({ items: [item] }), { write: false });
      app.server.rpc.handle(
        "ext.show",
        () => ({
          item,
          manifest: { remote: { auth: "oauth" } },
          capabilities: {},
          scripts: [],
          trust: { tier: "unsigned" },
          files: { count: 1, bytes: 10 },
          dependents: [],
        }),
        { write: false },
      );
      app.server.rpc.handle(
        "admin.extensions.setup.get",
        () => ({
          name: "remote",
          available: true,
          slots: [{ slot: "access", secret: "ext:remote:access", required: true, present: false }],
        }),
        { write: false },
      );
      app.server.rpc.handle("admin.extensions.setup.set", () => ({ name: "remote", slot: "access", stored: true }));
      const attempt = {
        name: "remote",
        attemptId: "attempt",
        expiresAt: Date.now() + 600000,
        status: "awaiting-callback",
        method: "paste_callback",
        authorizationUrl: "https://issuer.example/authorize",
      };
      app.server.rpc.handle("admin.extensions.auth.start", () => attempt);
      app.server.rpc.handle("admin.extensions.auth.status", () => attempt, { write: false });
      app.server.rpc.handle("admin.extensions.auth.cancel", () => ({ ...attempt, status: "cancelled" }));
      await openRoute(app.page, "#/plugins/remote");
      await app.page.getByRole("heading", { name: "Extension setup" }).waitFor();
      assert.equal(app.server.rpc.calls.filter((call) => call.method === "admin.extensions.auth.start").length, 0);
      const value = app.page.locator('[id="secret-remote-access"]');
      await value.fill("fixture-private-value");
      await app.page.getByRole("button", { name: "Store secret", exact: true }).click();
      await app.page.waitForFunction(
        () => (document.getElementById("secret-remote-access") as HTMLInputElement | null)?.value === "",
      );
      assert.ok(!(await app.page.locator("main").innerText()).includes("fixture-private-value"));
      await app.page.getByLabel("Registered client ID or client metadata URL").fill("registered-client");
      await app.page.getByLabel("Registered loopback redirect URI").fill("http://127.0.0.1:8372/callback");
      await app.page.getByRole("button", { name: "Start sign-in", exact: true }).click();
      await app.page.getByLabel("Paste the complete callback URL").waitFor();
      assert.deepEqual(app.server.rpc.calls.find((call) => call.method === "admin.extensions.auth.start")?.params, {
        name: "remote",
        clientId: "registered-client",
        redirectUri: "http://127.0.0.1:8372/callback",
        pasteCallback: true,
      });
      await app.page.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
      await app.page.getByText("Sign-in cancelled.", { exact: true }).waitFor();
      await expectAxeClean(app.page, "MCP secret setup and cancelled OAuth");
      assert.deepEqual(app.problems, []);
    });
  });
});

for (const lang of ["en", "de"] as const)
  for (const state of ["loading", "empty", "error", "forbidden", "unavailable"] as const) {
    test(`extensions axe: ${state}, ${lang}`, { skip: browserSkip }, async () => {
      await withApp({ locale: lang === "de" ? "de-DE" : "en-US" }, async (app) => {
        seed(app.server);
        let release: (() => void) | undefined;
        if (state === "loading")
          app.server.rpc.handle(
            "ext.list",
            () =>
              new Promise((resolve) => {
                release = () => resolve({ items: [] });
              }),
            { write: false },
          );
        else if (state === "empty") app.server.rpc.handle("ext.list", () => ({ items: [] }), { write: false });
        else app.server.rpc.scenario("ext.list", state);
        try {
          await openRoute(app.page, "#/plugins", lang);
          await app.page.locator(`[data-state="${state}"]`).first().waitFor();
          await expectAxeClean(app.page, `extensions ${state} ${lang}`);
          assert.deepEqual(app.problems, []);
        } finally {
          release?.();
        }
      });
    });
  }
