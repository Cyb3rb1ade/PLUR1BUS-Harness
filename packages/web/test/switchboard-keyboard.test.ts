// Switchboard by keyboard, and the health-test outcomes the page did not check before: a failed test shows its detail, a
// refused call shows the message, and German wording for both. Built on the same mock as switchboard-page.test.ts.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { rpcError } from "./mock-rpc.ts";
import { seedSwitchboard } from "./switchboard-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };
const open = (app: App, lang: "en" | "de" = "en"): Promise<void> => openRoute(app.page, "#/switchboard", lang);

describe("switchboard: keyboard", opts, () => {
  test("a channel is selected with Enter on its list button, and the detail follows", async () => {
    await withApp({}, async (app) => {
      seedSwitchboard(app.server.rpc);
      await open(app);
      const telegram = app.page.getByRole("button", { name: /Telegram/i });
      await telegram.waitFor();
      await telegram.focus();
      await app.page.keyboard.press("Enter");
      await app.page.waitForFunction(() => document.querySelector("[aria-current=true]")?.textContent?.includes("Telegram") === true);
      assert.equal(await telegram.getAttribute("aria-current"), "true");
    });
  });
});

describe("switchboard: health test outcomes", opts, () => {
  test("a failed health test shows Test failed with the server's detail", async () => {
    await withApp({}, async (app) => {
      seedSwitchboard(app.server.rpc);
      app.server.rpc.handle("channel.test", () => ({ id: "discord", ok: false, state: "error", detail: "gateway refused the token" }));
      await open(app);
      await app.page.getByRole("button", { name: /Discord/i }).click();
      await app.page.getByRole("button", { name: /^Test channel$|^Kanal testen$/i }).click();
      await app.page.getByText("Test failed: gateway refused the token").waitFor();
    });
  });

  test("a refused health test shows the refusal message instead of staying silent", async () => {
    await withApp({}, async (app) => {
      seedSwitchboard(app.server.rpc);
      app.server.rpc.handle("channel.test", () => { throw rpcError("E_INTERNAL", "channel offline", "offline"); });
      await open(app);
      await app.page.getByRole("button", { name: /Discord/i }).click();
      await app.page.getByRole("button", { name: /^Test channel$|^Kanal testen$/i }).click();
      await app.page.getByText(/channel offline/).waitFor();
    });
  });

  test("German: a failed health test is reported as Test fehlgeschlagen", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      seedSwitchboard(app.server.rpc);
      app.server.rpc.handle("channel.test", () => ({ id: "discord", ok: false, state: "error", detail: "Gateway lehnt ab" }));
      await open(app, "de");
      await app.page.getByRole("button", { name: /Discord/i }).click();
      await app.page.getByRole("button", { name: /^Kanal testen$/i }).click();
      await app.page.getByText("Test fehlgeschlagen: Gateway lehnt ab").waitFor();
    });
  });
});
