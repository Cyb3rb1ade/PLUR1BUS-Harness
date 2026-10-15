// Switchboard robustness (audit b19): keyboard activation of Enable, results of one channel never shown on another, no double
// channel.set from a held Enter, and the compact Back button that really returns to the list.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { seedSwitchboard } from "./switchboard-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };
const calls = (app: App, method: string): { params: unknown }[] => app.server.rpc.calls.filter((c) => c.method === method);

describe("switchboard: robustness", opts, () => {
  test("Enable works from the keyboard (Enter on the focused button)", async () => {
    await withApp({}, async (app) => {
      seedSwitchboard(app.server.rpc);
      await openRoute(app.page, "#/switchboard");
      await app.page.getByRole("button", { name: /Telegram/i }).click();
      const enable = app.page.getByRole("button", { name: /Enable channel/i });
      await enable.waitFor();
      await enable.focus();
      await app.page.keyboard.press("Enter");
      await app.page.getByRole("button", { name: /Disable channel/i }).waitFor();
      assert.deepEqual(calls(app, "channel.enable").map((c) => c.params), [{ id: "telegram" }]);
    });
  });

  test("the result of a test started on one channel is not shown on the channel selected meanwhile", async () => {
    await withApp({}, async (app) => {
      seedSwitchboard(app.server.rpc);
      app.server.rpc.setDelay("channel.test", 600);
      await openRoute(app.page, "#/switchboard");
      await app.page.getByRole("button", { name: /Discord/i }).click();
      await app.page.getByRole("button", { name: /^Test channel$/ }).click();
      await app.page.getByRole("button", { name: /Telegram/i }).click();
      await app.page.getByRole("heading", { name: "Telegram", level: 2 }).waitFor();
      await app.page.waitForTimeout(1000);
      assert.equal(await app.page.getByText(/Test succeeded/).count(), 0);
    });
  });

  test("a held Enter in the edit dialog sends channel.set once", async () => {
    await withApp({}, async (app) => {
      seedSwitchboard(app.server.rpc);
      app.server.rpc.setDelay("channel.set", 500);
      await openRoute(app.page, "#/switchboard");
      await app.page.getByRole("button", { name: /Discord/i }).click();
      await app.page.getByRole("row", { name: /replyPolicy/i }).getByRole("button", { name: /Edit/i }).click();
      const input = app.page.getByRole("dialog").getByLabel(/Value/i);
      await input.fill("always");
      await input.press("Enter");
      await input.press("Enter");
      await input.press("Enter");
      await app.page.getByRole("dialog").waitFor({ state: "detached" });
      assert.equal(calls(app, "channel.set").length, 1);
    });
  });

  test("compact: the list is shown first and Back returns to it", async () => {
    await withApp({ width: 390, height: 800 }, async (app) => {
      seedSwitchboard(app.server.rpc);
      await openRoute(app.page, "#/switchboard");
      const list = app.page.locator(".ld-list");
      await list.getByRole("button", { name: /Telegram/i }).waitFor({ state: "visible" });
      await list.getByRole("button", { name: /Telegram/i }).click();
      await app.page.getByRole("heading", { name: "Telegram", level: 2 }).waitFor();
      await app.page.locator(".ld-back").click();
      await list.getByRole("button", { name: /Telegram/i }).waitFor({ state: "visible" });
      assert.equal(await app.page.locator(".list-detail").getAttribute("data-selected"), "false");
    });
  });
});
