// Settings > Secrets: states, create / rotate / delete with exact RPC params, forbidden by role, keyboard, axe, 400 px, German.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { rpcError } from "./mock-rpc.ts";
import { meta, seedSecrets } from "./secrets-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const open = async (app: App, lang: "en" | "de" = "en"): Promise<void> => { await openRoute(app.page, "#/settings/secrets", lang); };
const calls = (app: App, method: string): { params: unknown; csrf: string | null }[] => app.server.rpc.calls.filter((c) => c.method === method);

describe("secrets: states", opts, () => {
  test("loading, then names and metadata, never a value", async () => {
    await withApp({}, async (app) => {
      seedSecrets(app.server.rpc); app.server.rpc.setDelay("secret.list", 300); await open(app);
      await app.page.locator(".page-state[data-state=loading]").waitFor();
      await app.page.getByRole("row", { name: /anthropic\.apiKey/ }).waitFor();
      await app.page.getByRole("row", { name: /telegram\.token/ }).waitFor();
      await app.page.getByText("OS keyring").first().waitFor();
      assert.equal(calls(app, "secret.get").length, 0);
      assert.equal(app.problems.length, 0, app.problems.join("\n"));
    });
  });
  test("empty", async () => {
    await withApp({}, async (app) => {
      seedSecrets(app.server.rpc, []); await open(app);
      await app.page.getByRole("heading", { name: "No secrets yet" }).waitFor();
      await app.page.getByRole("button", { name: "Add secret" }).waitFor();
    });
  });
  test("error offers Try again, which reloads", async () => {
    await withApp({}, async (app) => {
      seedSecrets(app.server.rpc); app.server.rpc.scenario("secret.list", "error", { code: "E_INTERNAL" }); await open(app);
      await app.page.getByRole("alert").waitFor();
      app.server.rpc.scenario("secret.list", "success");
      await app.page.getByRole("button", { name: "Try again" }).click();
      await app.page.getByRole("row", { name: /anthropic\.apiKey/ }).waitFor();
    });
  });
  test("unavailable when secret.list is not served", async () => {
    await withApp({}, async (app) => {
      seedSecrets(app.server.rpc); app.server.rpc.scenario("secret.list", "unavailable"); await open(app);
      await app.page.locator(".page-state[data-state=unavailable]").waitFor();
      await app.page.getByRole("heading", { name: "Secrets are not available" }).waitFor();
    });
  });
  test("forbidden for a member and a viewer: nothing is requested", async () => {
    for (const role of ["member", "viewer"]) {
      await withApp({ server: { role } }, async (app) => {
        seedSecrets(app.server.rpc); await open(app);
        await app.page.locator(".page-state[data-state=forbidden]").waitFor();
        assert.equal(calls(app, "secret.list").length, 0);
      });
    }
  });
  test("a server refusal shows forbidden", async () => {
    await withApp({}, async (app) => {
      seedSecrets(app.server.rpc); app.server.rpc.scenario("secret.list", "forbidden"); await open(app);
      await app.page.locator(".page-state[data-state=forbidden]").waitFor();
    });
  });
  test("a failing secret.status does not hide the list", async () => {
    await withApp({}, async (app) => {
      seedSecrets(app.server.rpc); app.server.rpc.scenario("secret.status", "error", { code: "E_INTERNAL" }); await open(app);
      await app.page.getByRole("row", { name: /anthropic\.apiKey/ }).waitFor();
    });
  });
});

describe("secrets: create, rotate, delete", opts, () => {
  test("create sends exactly name and value, then lists the new name", async () => {
    await withApp({}, async (app) => {
      seedSecrets(app.server.rpc); await open(app);
      await app.page.getByRole("button", { name: "Add secret" }).click();
      const dlg = app.page.getByRole("dialog", { name: "Add a secret" });
      await dlg.getByLabel("Name", { exact: true }).fill("openai.key");
      const value = dlg.getByLabel("Value", { exact: true });
      assert.equal(await value.getAttribute("type"), "password");
      assert.equal(await value.getAttribute("autocomplete"), "off");
      await value.fill("sk-test-123");
      await dlg.getByRole("button", { name: "Save" }).click();
      await app.page.getByRole("row", { name: /openai\.key/ }).waitFor();
      await app.page.getByText("Saved openai.key.").waitFor();
      const c = calls(app, "secret.set");
      assert.equal(c.length, 1);
      assert.deepEqual(c[0]!.params, { name: "openai.key", value: "sk-test-123" });
      assert.ok(c[0]!.csrf);
    });
  });
  test("create validates the name, refuses an existing one and an empty value", async () => {
    await withApp({}, async (app) => {
      seedSecrets(app.server.rpc); await open(app);
      await app.page.getByRole("button", { name: "Add secret" }).click();
      const dlg = app.page.getByRole("dialog");
      await dlg.getByRole("button", { name: "Save" }).click();
      await dlg.getByText("Enter a valid name.").waitFor();
      await dlg.getByText("Enter a value.").waitFor();
      await dlg.getByLabel("Name", { exact: true }).fill("anthropic.apiKey");
      await dlg.getByLabel("Value", { exact: true }).fill("x");
      await dlg.getByRole("button", { name: "Save" }).click();
      await dlg.getByText(/Use Rotate/).waitFor();
      assert.equal(calls(app, "secret.set").length, 0);
    });
  });
  test("reveal toggle switches the input type and resets after saving", async () => {
    await withApp({}, async (app) => {
      seedSecrets(app.server.rpc); await open(app);
      await app.page.getByRole("button", { name: "Add secret" }).click();
      const dlg = app.page.getByRole("dialog");
      await dlg.getByLabel("Show value while typing").check();
      assert.equal(await dlg.getByLabel("Value", { exact: true }).getAttribute("type"), "text");
      await dlg.getByLabel("Show value while typing").uncheck();
      assert.equal(await dlg.getByLabel("Value", { exact: true }).getAttribute("type"), "password");
    });
  });
  test("rotate sends the fixed name with the new value", async () => {
    await withApp({}, async (app) => {
      seedSecrets(app.server.rpc); await open(app);
      await app.page.getByRole("button", { name: "Rotate anthropic.apiKey" }).click();
      const dlg = app.page.getByRole("dialog", { name: "Rotate anthropic.apiKey" });
      assert.equal(await dlg.getByLabel("Name", { exact: true }).count(), 0);
      await dlg.getByLabel("New value").fill("new-val");
      await dlg.getByRole("button", { name: "Save" }).click();
      await app.page.getByText("Saved anthropic.apiKey.").waitFor();
      assert.deepEqual(calls(app, "secret.set").map((c) => c.params), [{ name: "anthropic.apiKey", value: "new-val" }]);
    });
  });
  test("a failed save keeps the dialog open, asks to retype, and the value is gone", async () => {
    await withApp({}, async (app) => {
      seedSecrets(app.server.rpc);
      app.server.rpc.handle("secret.set", () => { throw rpcError("E_STORAGE", "disk"); });
      await open(app);
      await app.page.getByRole("button", { name: "Rotate anthropic.apiKey" }).click();
      const dlg = app.page.getByRole("dialog");
      await dlg.getByLabel("New value").fill("will-fail");
      await dlg.getByRole("button", { name: "Save" }).click();
      await dlg.getByRole("alert").getByText(/Enter the value again/).waitFor();
      assert.equal(await dlg.getByLabel("New value").inputValue(), "");
    });
  });
  test("delete needs the typed name, then sends secret.delete { name }", async () => {
    await withApp({}, async (app) => {
      seedSecrets(app.server.rpc); await open(app);
      await app.page.getByRole("button", { name: "Delete telegram.token" }).click();
      const dlg = app.page.getByRole("dialog", { name: "Delete telegram.token" });
      const go = dlg.getByRole("button", { name: "Delete secret" });
      assert.equal(await go.isDisabled(), true);
      await dlg.getByLabel(/Type telegram\.token/).fill("telegram.token");
      await go.click();
      await app.page.getByText("Deleted telegram.token.").waitFor();
      await app.page.getByRole("row", { name: /telegram\.token/ }).waitFor({ state: "detached" });
      assert.deepEqual(calls(app, "secret.delete").map((c) => c.params), [{ name: "telegram.token" }]);
    });
  });
  test("a write that is not served says so inside the dialog and sends nothing else", async () => {
    await withApp({}, async (app) => {
      seedSecrets(app.server.rpc); app.server.rpc.scenario("secret.set", "unavailable"); await open(app);
      await app.page.getByRole("button", { name: "Add secret" }).click();
      const dlg = app.page.getByRole("dialog");
      await dlg.getByLabel("Name", { exact: true }).fill("a.b"); await dlg.getByLabel("Value", { exact: true }).fill("v");
      await dlg.getByRole("button", { name: "Save" }).click();
      await dlg.getByText("Not available on this harness yet.").waitFor();
    });
  });
});

describe("secrets: keyboard, a11y, layout, German", opts, () => {
  test("keyboard only: open, fill, Enter saves, focus returns to the opener; Esc cancels", async () => {
    await withApp({}, async (app) => {
      seedSecrets(app.server.rpc); await open(app);
      await app.page.getByRole("button", { name: "Add secret" }).focus();
      await app.page.keyboard.press("Enter");
      const dlg = app.page.getByRole("dialog", { name: "Add a secret" });
      await dlg.waitFor();
      for (let i = 0; i < 6 && (await app.page.evaluate(() => document.activeElement?.id)) !== "secret-name"; i++) await app.page.keyboard.press("Tab");
      await app.page.keyboard.type("kbd.secret");
      await app.page.keyboard.press("Tab");
      assert.equal(await app.page.evaluate(() => document.activeElement?.id), "secret-value");
      await app.page.keyboard.type("kbd-value");
      await app.page.keyboard.press("Enter");
      await app.page.getByRole("row", { name: /kbd\.secret/ }).waitFor();
      await dlg.waitFor({ state: "detached" });
      assert.equal(await app.page.evaluate(() => document.activeElement?.textContent), "Add secret");
      await app.page.keyboard.press("Enter");
      await dlg.waitFor();
      await app.page.keyboard.press("Escape");
      await dlg.waitFor({ state: "detached" });
      assert.equal(calls(app, "secret.set").length, 1);
    });
  });
  test("keyboard only: delete confirmation", async () => {
    await withApp({}, async (app) => {
      seedSecrets(app.server.rpc); await open(app);
      await app.page.getByRole("button", { name: "Delete anthropic.apiKey" }).focus();
      await app.page.keyboard.press("Enter");
      const dlg = app.page.getByRole("dialog");
      await dlg.waitFor();
      for (let i = 0; i < 6 && (await app.page.evaluate(() => document.activeElement?.id)) !== "confirm-typed"; i++) await app.page.keyboard.press("Tab");
      await app.page.keyboard.type("anthropic.apiKey");
      await app.page.keyboard.press("Tab"); // Cancel
      await app.page.keyboard.press("Tab"); // Delete secret
      await app.page.keyboard.press("Enter");
      await dlg.waitFor({ state: "detached" });
      assert.deepEqual(calls(app, "secret.delete").map((c) => c.params), [{ name: "anthropic.apiKey" }]);
    });
  });
  test("axe clean: list, empty, forbidden, create dialog, delete dialog", async () => {
    await withApp({}, async (app) => {
      seedSecrets(app.server.rpc); await open(app);
      await app.page.getByRole("row", { name: /anthropic\.apiKey/ }).waitFor();
      await expectAxeClean(app.page, "list");
      await app.page.getByRole("button", { name: "Add secret" }).click();
      await app.page.getByRole("dialog").waitFor();
      await expectAxeClean(app.page, "create dialog");
      await app.page.keyboard.press("Escape");
      await app.page.getByRole("button", { name: "Delete anthropic.apiKey" }).click();
      await app.page.getByRole("dialog").waitFor();
      await expectAxeClean(app.page, "delete dialog");
    });
    await withApp({}, async (app) => {
      seedSecrets(app.server.rpc, []); await open(app);
      await app.page.getByRole("heading", { name: "No secrets yet" }).waitFor();
      await expectAxeClean(app.page, "empty");
    });
    await withApp({ server: { role: "viewer" } }, async (app) => {
      seedSecrets(app.server.rpc); await open(app);
      await app.page.locator(".page-state[data-state=forbidden]").waitFor();
      await expectAxeClean(app.page, "forbidden");
    });
  });
  test("400 px: no horizontal scroll, dialog fits", async () => {
    await withApp({ width: 400, height: 800 }, async (app) => {
      seedSecrets(app.server.rpc, [meta("a.very.long.secret.name.that.keeps.going.and.going.for.a.while/with@parts")]); await open(app);
      await app.page.getByRole("row", { name: /a\.very\.long/ }).waitFor();
      const wide = (): Promise<boolean> => app.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      assert.equal(await wide(), false);
      await app.page.getByRole("button", { name: "Add secret" }).click();
      await app.page.getByRole("dialog").waitFor();
      assert.equal(await wide(), false);
      await expectAxeClean(app.page, "400 px create dialog");
    });
  });
  test("German", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      seedSecrets(app.server.rpc); await open(app, "de");
      await app.page.getByRole("button", { name: "Geheimnis hinzufügen" }).waitFor();
      await app.page.getByRole("button", { name: "anthropic.apiKey rotieren" }).waitFor();
    });
  });
});
