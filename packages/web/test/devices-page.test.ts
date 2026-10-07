// Settings > Devices & remote: hidden at local / unknown key, remote mode shows the card with the parts that have no RPC as
// unavailable, states, forbidden by role, axe, 400 px.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { rpcError } from "./mock-rpc.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const open = async (app: App, lang: "en" | "de" = "en"): Promise<void> => { await openRoute(app.page, "#/settings/devices", lang); };
const publish = (app: App, value: unknown): void => {
  app.server.rpc.handle("config.get", () => ({ key: "remote.publish", tier: "advanced", value, restartClass: "core", restart: "core", revision: "r1" }), { write: false });
};
const configCalls = (app: App): unknown[] => app.server.rpc.calls.filter((c) => c.method === "config.get").map((c) => c.params);

describe("devices: gate", opts, () => {
  test("local: the card is hidden and a note says remote access is off", async () => {
    await withApp({}, async (app) => {
      publish(app, "local"); await open(app);
      await app.page.getByRole("heading", { name: "Remote access is off" }).waitFor();
      assert.equal(await app.page.getByRole("group", { name: "Paired devices" }).count(), 0);
      assert.deepEqual(configCalls(app), [{ key: "remote.publish" }]);
    });
  });
  test("unknown key (E_NOT_FOUND / E_CONFIG_INVALID) and no config.get at all count as off", async () => {
    for (const mk of [
      (app: App) => { app.server.rpc.handle("config.get", () => { throw rpcError("E_NOT_FOUND", "no key"); }, { write: false }); },
      (app: App) => { app.server.rpc.handle("config.get", () => { throw rpcError("E_CONFIG_INVALID", "unknown key"); }, { write: false }); },
      (app: App) => { app.server.rpc.scenario("config.get", "unavailable"); },
    ]) {
      await withApp({}, async (app) => {
        publish(app, "local"); mk(app);
        await open(app);
        await app.page.getByRole("heading", { name: "Remote access is off" }).waitFor();
      });
    }
  });
  test("remote: card with the three parts that have no API as unavailable", async () => {
    await withApp({}, async (app) => {
      publish(app, "tailnet"); await open(app);
      await app.page.getByText("Published as tailnet").waitFor();
      for (const g of ["Paired devices", "Pair a device", "Removing a device"]) await app.page.getByRole("group", { name: g }).getByRole("status").waitFor();
      assert.deepEqual([...new Set(app.server.rpc.calls.map((c) => c.method))].filter((m) => m !== "config.get" && m !== "session.list"), []); // the shell lists sessions itself
    });
  });
  test("loading, error with Try again", async () => {
    await withApp({}, async (app) => {
      publish(app, "tailnet"); app.server.rpc.setDelay("config.get", 300);
      app.server.rpc.scenario("config.get", "error", { code: "E_INTERNAL" });
      await open(app);
      await app.page.locator(".page-state[data-state=loading]").waitFor();
      await app.page.getByRole("alert").waitFor();
      app.server.rpc.scenario("config.get", "success");
      await app.page.getByRole("button", { name: "Try again" }).click();
      await app.page.getByText("Published as tailnet").waitFor();
    });
  });
  test("forbidden for member and viewer (nothing requested) and for a server refusal", async () => {
    for (const role of ["member", "viewer"]) {
      await withApp({ server: { role } }, async (app) => {
        publish(app, "tailnet"); await open(app);
        await app.page.locator(".page-state[data-state=forbidden]").waitFor();
        assert.equal(configCalls(app).length, 0);
      });
    }
    await withApp({}, async (app) => {
      publish(app, "tailnet"); app.server.rpc.scenario("config.get", "forbidden"); await open(app);
      await app.page.locator(".page-state[data-state=forbidden]").waitFor();
    });
  });
});

describe("devices: a11y, layout, German", opts, () => {
  test("axe clean: off, remote, forbidden", async () => {
    await withApp({}, async (app) => { publish(app, "local"); await open(app); await app.page.getByRole("heading", { name: "Remote access is off" }).waitFor(); await expectAxeClean(app.page, "off"); });
    await withApp({}, async (app) => { publish(app, "tailnet"); await open(app); await app.page.getByText("Published as tailnet").waitFor(); await expectAxeClean(app.page, "remote"); });
    await withApp({ server: { role: "viewer" } }, async (app) => { publish(app, "tailnet"); await open(app); await app.page.locator(".page-state[data-state=forbidden]").waitFor(); await expectAxeClean(app.page, "forbidden"); });
  });
  test("400 px has no horizontal scroll", async () => {
    await withApp({ width: 400, height: 800 }, async (app) => {
      publish(app, "tailnet"); await open(app); await app.page.getByText("Published as tailnet").waitFor();
      assert.equal(await app.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
    });
  });
  test("German", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      publish(app, "local"); await open(app, "de");
      await app.page.getByRole("heading", { name: "Fernzugriff ist aus" }).waitFor();
    });
  });
});
