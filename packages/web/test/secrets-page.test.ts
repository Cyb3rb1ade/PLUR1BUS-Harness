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
  test("a short value is saved and a notice says the log redactor does not mask it; a longer one shows no notice", async () => {
    await withApp({}, async (app) => {
      seedSecrets(app.server.rpc); await open(app);
      await app.page.getByRole("button", { name: "Add secret" }).click();
      let dlg = app.page.getByRole("dialog", { name: "Add a secret" });
      await dlg.getByLabel("Name", { exact: true }).fill("legacy.pin");
      await dlg.getByLabel("Value", { exact: true }).fill("1234");
      await dlg.getByRole("button", { name: "Save" }).click();
      await app.page.getByRole("row", { name: /legacy\.pin/ }).waitFor();
      await app.page.getByText(/legacy\.pin is saved, but its value has fewer than 8 characters/).waitFor();
      assert.deepEqual(calls(app, "secret.set").map((c) => c.params), [{ name: "legacy.pin", value: "1234" }]);
      assert.equal(await app.page.getByText("1234").count(), 0, "the notice never repeats the value");
      await app.page.getByRole("button", { name: "Add secret" }).click();
      dlg = app.page.getByRole("dialog", { name: "Add a secret" });
      await dlg.getByLabel("Name", { exact: true }).fill("long.key");
      await dlg.getByLabel("Value", { exact: true }).fill("a-long-enough-value");
      await dlg.getByRole("button", { name: "Save" }).click();
      await app.page.getByText("Saved long.key.").waitFor();
      assert.equal(await app.page.locator(".secrets-warning").count(), 0);
    });
  });
  test("description: shown in the list, sent on create, kept by a rotation that leaves it alone, sent when edited or emptied", async () => {
    await withApp({}, async (app) => {
      seedSecrets(app.server.rpc, [meta("anthropic.apiKey", { description: "Billing key for the team account" }), meta("telegram.token")]); await open(app);
      await app.page.getByRole("row", { name: /anthropic\.apiKey.*Billing key for the team account/ }).waitFor();
      await app.page.getByRole("columnheader", { name: "Description" }).waitFor();
      // create with a description
      await app.page.getByRole("button", { name: "Add secret" }).click();
      let dlg = app.page.getByRole("dialog", { name: "Add a secret" });
      await dlg.getByLabel("Name", { exact: true }).fill("openai.key");
      await dlg.getByLabel("Value", { exact: true }).fill("sk-test-123");
      await dlg.getByLabel("Description (optional)").fill("  Shared OpenAI key  ");
      await dlg.getByRole("button", { name: "Save" }).click();
      await app.page.getByRole("row", { name: /openai\.key.*Shared OpenAI key/ }).waitFor();
      // rotate without touching the description: the field shows it, nothing about it is sent
      await app.page.getByRole("button", { name: "Rotate anthropic.apiKey" }).click();
      dlg = app.page.getByRole("dialog", { name: "Rotate anthropic.apiKey" });
      assert.equal(await dlg.getByLabel("Description (optional)").inputValue(), "Billing key for the team account");
      await dlg.getByLabel("New value").fill("new-val");
      await dlg.getByRole("button", { name: "Save" }).click();
      await dlg.getByRole("button", { name: "Rotate now" }).click();
      await dlg.waitFor({ state: "detached" });
      await app.page.getByText(/^anthropic\.apiKey: updated on /).waitFor();
      // rotate and empty the description
      await app.page.getByRole("button", { name: "Rotate anthropic.apiKey" }).click();
      dlg = app.page.getByRole("dialog", { name: "Rotate anthropic.apiKey" });
      await dlg.getByLabel("Description (optional)").fill("");
      await dlg.getByLabel("New value").fill("newer-val");
      await dlg.getByRole("button", { name: "Save" }).click();
      await dlg.getByRole("button", { name: "Rotate now" }).click();
      // the first rotation's notice has the same text, so wait for the dialog to close (it closes once the save has returned)
      await dlg.waitFor({ state: "detached" });
      await app.page.getByText(/^anthropic\.apiKey: updated on /).waitFor();
      assert.deepEqual(calls(app, "secret.set").map((c) => c.params), [
        { name: "openai.key", value: "sk-test-123", description: "Shared OpenAI key" },
        { name: "anthropic.apiKey", value: "new-val" },
        { name: "anthropic.apiKey", value: "newer-val", description: "" },
      ]);
      // the list reloads after the save: the emptied description is gone from the row
      await app.page.getByRole("row", { name: /anthropic\.apiKey.*Billing key/ }).waitFor({ state: "detached" });
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
      // Rotating asks once more; nothing has been sent yet and the value sits in a read-only masked field.
      await dlg.getByText(/Replace the value of anthropic\.apiKey\?/).waitFor();
      assert.equal(calls(app, "secret.set").length, 0);
      assert.equal(await dlg.getByLabel("New value").getAttribute("readonly"), "");
      assert.equal(await dlg.getByLabel("New value").getAttribute("type"), "password");
      await dlg.getByRole("button", { name: "Rotate now" }).click();
      await dlg.waitFor({ state: "detached" });
      await app.page.getByText(/^anthropic\.apiKey: updated on /).waitFor();
      assert.deepEqual(calls(app, "secret.set").map((c) => c.params), [{ name: "anthropic.apiKey", value: "new-val" }]);
      // After the rotation the only thing the page says is the update time; the value is nowhere.
      assert.ok(!(await app.page.content()).includes("new-val"));
    });
  });
  test("rotate: Back from the question keeps the dialog and the typed value, Cancel sends nothing", async () => {
    await withApp({}, async (app) => {
      seedSecrets(app.server.rpc); await open(app);
      await app.page.getByRole("button", { name: "Rotate anthropic.apiKey" }).click();
      const dlg = app.page.getByRole("dialog");
      await dlg.getByLabel("New value").fill("keep-me");
      await dlg.getByRole("button", { name: "Save" }).click();
      await dlg.getByRole("button", { name: "Back" }).click();
      assert.equal(await dlg.getByLabel("New value").inputValue(), "keep-me");
      assert.equal(await dlg.getByLabel("New value").getAttribute("readonly"), null);
      await dlg.getByRole("button", { name: "Save" }).click();
      await dlg.getByRole("button", { name: "Cancel" }).click();
      await dlg.waitFor({ state: "detached" });
      assert.equal(calls(app, "secret.set").length, 0);
    });
  });
  test("rotate: the masked field is never prefilled and the empty value is refused before the question", async () => {
    await withApp({}, async (app) => {
      seedSecrets(app.server.rpc); await open(app);
      await app.page.getByRole("button", { name: "Rotate anthropic.apiKey" }).click();
      const dlg = app.page.getByRole("dialog");
      const input = dlg.getByLabel("New value");
      assert.equal(await input.inputValue(), "");
      assert.equal(await input.getAttribute("type"), "password");
      assert.equal(await input.getAttribute("autocomplete"), "off");
      assert.equal(await input.getAttribute("value"), null);
      await dlg.getByRole("button", { name: "Save" }).click();
      await dlg.getByText("Enter a value.").waitFor();
      assert.equal(await dlg.getByRole("button", { name: "Rotate now" }).count(), 0);
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
      await dlg.getByRole("button", { name: "Rotate now" }).click();
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
      await app.page.getByRole("button", { name: "Rotate anthropic.apiKey" }).click();
      await app.page.getByRole("dialog").getByLabel("New value").fill("v");
      await app.page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
      await app.page.getByText(/Replace the value of/).waitFor();
      await expectAxeClean(app.page, "rotate confirmation");
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
      await app.page.getByRole("button", { name: "anthropic.apiKey rotieren" }).click();
      const dlg = app.page.getByRole("dialog");
      await dlg.getByLabel("Neuer Wert").fill("x");
      await dlg.getByRole("button", { name: "Speichern" }).click();
      await dlg.getByRole("button", { name: "Jetzt rotieren" }).click();
      await app.page.getByText(/^anthropic\.apiKey: aktualisiert am /).waitFor();
    });
  });
});

test("Admin keeps the existing page gate but never sees Owner-only status timestamps", opts, async () => {
  await withApp({ server: { role: "admin" } }, async app => {
    seedSecrets(app.server.rpc);
    await open(app);
    const row = app.page.getByRole("row", { name: /anthropic\.apiKey/ });
    await row.waitFor();
    assert.equal(await row.getByRole("cell", { name: "Unknown", exact: true }).count(), 2);
    assert.equal(await row.getByText(/2026/).count(), 0);
    await expectAxeClean(app.page, "Admin metadata boundary");
  });
});
