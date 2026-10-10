// Switchboard channel management: list, host status, channel detail, enable/disable,
// field edit with schema validation & secret rejection, health test & send-owner,
// link-help, role visibility, axe, German.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { rpcError } from "./mock-rpc.ts";
import { sampleChannel, seedSwitchboard } from "./switchboard-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const open = async (app: App, lang: "en" | "de" = "en"): Promise<void> => {
  await openRoute(app.page, "#/switchboard", lang);
};
const calls = (app: App, method: string): { params: unknown; csrf: string | null }[] =>
  app.server.rpc.calls.filter((c) => c.method === method);

describe("switchboard: states", opts, () => {
  test("loading, then lists channels with state, health and configuration", async () => {
    await withApp({}, async (app) => {
      seedSwitchboard(app.server.rpc);
      app.server.rpc.setDelay("channel.list", 200);
      await open(app);
      await app.page.locator(".page-state[data-state=loading]").waitFor();
      await app.page.getByRole("button", { name: /Discord/i }).waitFor();
      await app.page.getByRole("button", { name: /Telegram/i }).waitFor();
      assert.equal(app.problems.length, 0, app.problems.join("\n"));
    });
  });

  test("host: false is shown as not started (host missing), not as an error", async () => {
    await withApp({}, async (app) => {
      seedSwitchboard(app.server.rpc, [sampleChannel()], false);
      await open(app);
      // State badge or notice mentions host not registered / not started
      await app.page.getByText(/Host fehlt|Host missing|Not started \(no host\)/i).first().waitFor();
      assert.equal(await app.page.locator(".page-state[data-state=error]").count(), 0);
    });
  });

  test("empty state", async () => {
    await withApp({}, async (app) => {
      seedSwitchboard(app.server.rpc, []);
      await open(app);
      await app.page.getByRole("heading", { name: /No channels/i }).waitFor();
    });
  });

  test("error offers Try again, which reloads", async () => {
    await withApp({}, async (app) => {
      seedSwitchboard(app.server.rpc);
      app.server.rpc.scenario("channel.list", "error", { code: "E_INTERNAL" });
      await open(app);
      await app.page.getByRole("alert").waitFor();
      app.server.rpc.scenario("channel.list", "success");
      await app.page.getByRole("button", { name: "Try again" }).click();
      await app.page.getByRole("button", { name: /Discord/i }).waitFor();
    });
  });

  test("unavailable when channel.list is not served", async () => {
    await withApp({}, async (app) => {
      seedSwitchboard(app.server.rpc);
      app.server.rpc.scenario("channel.list", "unavailable");
      await open(app);
      await app.page.locator(".page-state[data-state=unavailable]").waitFor();
    });
  });

  test("forbidden for operator and viewer: nothing is requested from channel.*", async () => {
    for (const role of ["operator", "viewer"]) {
      await withApp({ server: { role } }, async (app) => {
        seedSwitchboard(app.server.rpc);
        await open(app);
        await app.page.locator(".page-state[data-state=forbidden]").waitFor();
        assert.equal(calls(app, "channel.list").length, 0);
      });
    }
  });

  test("a server refusal shows forbidden", async () => {
    await withApp({}, async (app) => {
      seedSwitchboard(app.server.rpc);
      app.server.rpc.scenario("channel.list", "forbidden");
      await open(app);
      await app.page.locator(".page-state[data-state=forbidden]").waitFor();
    });
  });
});

describe("switchboard: channel details and actions", opts, () => {
  test("selecting channel displays detail, secrets as names only, and linkHelp", async () => {
    await withApp({}, async (app) => {
      seedSwitchboard(app.server.rpc);
      await open(app);

      await app.page.getByRole("button", { name: /Discord/i }).click();
      await app.page.getByRole("heading", { name: "Discord", level: 2 }).waitFor();
      await app.page.getByText("channels.discord.token").waitFor();
      await app.page.getByText(/type \/link <code> to pair/i).waitFor();

      // Secrets are never values
      const content = await app.page.content();
      assert.ok(!content.includes("secret-value"));
    });
  });

  test("channel toggle: enable / disable", async () => {
    await withApp({}, async (app) => {
      seedSwitchboard(app.server.rpc);
      await open(app);

      await app.page.getByRole("button", { name: /Discord/i }).click();
      const disableBtn = app.page.getByRole("button", { name: /Disable channel|Deaktivieren/i });
      await disableBtn.click();

      const enableBtn = app.page.getByRole("button", { name: /Enable channel|Aktivieren/i });
      await enableBtn.waitFor();

      const disableCalls = calls(app, "channel.disable");
      assert.equal(disableCalls.length, 1);
      assert.deepEqual(disableCalls[0]!.params, { id: "discord" });

      await enableBtn.click();
      await app.page.getByRole("button", { name: /Disable channel|Deaktivieren/i }).waitFor();

      const enableCalls = calls(app, "channel.enable");
      assert.equal(enableCalls.length, 1);
      assert.deepEqual(enableCalls[0]!.params, { id: "discord" });
    });
  });

  test("field edit sends channel.set, and secret values are rejected with link to secrets", async () => {
    await withApp({}, async (app) => {
      seedSwitchboard(app.server.rpc);
      await open(app);

      await app.page.getByRole("button", { name: /Discord/i }).click();
      await app.page.getByRole("row", { name: /replyPolicy/i }).getByRole("button", { name: /Edit setting|Edit key/i }).click();

      const dlg = app.page.getByRole("dialog");
      const input = dlg.getByLabel(/Value/i);
      await input.fill("always");
      await dlg.getByRole("button", { name: /Save/i }).click();
      await dlg.waitFor({ state: "detached" });

      const setCalls = calls(app, "channel.set");
      assert.equal(setCalls.length, 1);
      assert.equal((setCalls[0]!.params as { key: string }).key, "replyPolicy");

      // Try setting a secret value on a secret key
      await app.page.getByRole("row", { name: /tokenSecret/i }).getByRole("button", { name: /Edit setting|Edit key/i }).click();
      const dlgSecret = app.page.getByRole("dialog");
      const secretInput = dlgSecret.getByLabel(/Value/i);
      await secretInput.fill("sk-live-raw-token-value");
      await dlgSecret.getByRole("button", { name: /Save/i }).click();

      // Check rejection message with link to secrets page
      await dlgSecret.getByText(/Secret values cannot be set here|Secret-Werte/i).waitFor();
      const link = dlgSecret.getByRole("link", { name: /Store secret|Secret setzen/i });
      assert.ok(link);
      assert.match((await link.getAttribute("href")) ?? "", /#\/settings\/secrets/);
    });
  });

  test("test buttons call channel.test without and with sendOwner", async () => {
    await withApp({}, async (app) => {
      seedSwitchboard(app.server.rpc);
      await open(app);

      await app.page.getByRole("button", { name: /Discord/i }).click();

      // Test health probe
      await app.page.getByRole("button", { name: /^Test channel$|^Kanal testen$/i }).click();
      await app.page.getByText(/Test succeeded/i).waitFor();
      const testCalls = calls(app, "channel.test");
      assert.equal(testCalls.length, 1);
      assert.deepEqual(testCalls[0]!.params, { id: "discord" });

      // Test message to owner
      await app.page.getByRole("button", { name: /Test message to me|Testnachricht an mich/i }).click();
      await app.page.getByText(/sent to/i).waitFor();
      const testCalls2 = calls(app, "channel.test");
      assert.equal(testCalls2.length, 2);
      assert.deepEqual(testCalls2[1]!.params, { id: "discord", sendOwner: true });
    });
  });
});

describe("switchboard: a11y, layout, German", opts, () => {
  test("axe clean", async () => {
    await withApp({}, async (app) => {
      seedSwitchboard(app.server.rpc);
      await open(app);
      await expectAxeClean(app.page, "switchboard");
    });
  });

  test("German translation rendered correctly", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      seedSwitchboard(app.server.rpc);
      await open(app, "de");
      await app.page.getByRole("heading", { name: /Vermittlung/i }).waitFor();
      await app.page.getByRole("button", { name: /Discord/i }).click();
      await app.page.getByRole("button", { name: /Testnachricht an mich/i }).waitFor();
    });
  });
});
