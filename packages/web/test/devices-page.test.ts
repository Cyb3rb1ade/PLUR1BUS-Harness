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
const ID1 = "dev_00000000-0000-4000-8000-000000000001";
const ID2 = "dev_00000000-0000-4000-8000-000000000002";
type Dev = { id: string; name: string; platform: string; publicKey: string; fingerprint: string; pairedBy: string; pairedAt: number; lastSeenAt: number; scope: string[]; revoked: boolean; revokedAt?: number };
const dev = (o: Partial<Dev> = {}): Dev => ({ id: ID1, name: "Pixel", platform: "android-14", publicKey: "k", fingerprint: "fp", pairedBy: "owner", pairedAt: 1_700_000_000_000, lastSeenAt: 1_700_000_100_000, scope: [], revoked: false, ...o });
const listDevices = (app: App, v: Dev[] | (() => Dev[])): void => { app.server.rpc.handle("device.list", () => ({ devices: typeof v === "function" ? v() : v }), { write: false }); };
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
  test("remote: mode card, device list (empty) and the pairing card", async () => {
    await withApp({}, async (app) => {
      publish(app, "tailnet"); listDevices(app, []); await open(app);
      await app.page.getByText("Published as tailnet").waitFor();
      await app.page.getByRole("group", { name: "Paired devices" }).getByText("No paired devices").waitFor();
      await app.page.getByRole("group", { name: "Pair a device" }).getByRole("status").waitFor();
      assert.deepEqual([...new Set(app.server.rpc.calls.map((c) => c.method))].filter((m) => !["config.get", "session.list", "device.list"].includes(m)), []); // the shell lists sessions itself
    });
  });
  test("pairing.qr formats and renders a QR code with expiration", async () => {
    await withApp({}, async (app) => {
      publish(app, "tailnet");
      const sampleLink = "plur1bus://pair?origin=https%3A%2F%2Foffline.invalid&code=ABCD-EFGH&exp=2000&tag=offline-fixture";
      app.server.rpc.handle("pairing.qr", (p) => ({
        link: (p as any).link,
        qr: { text: (p as any).link, mode: "byte", errorCorrection: "M", length: 96, maxLength: 2331, fits: true },
        expiresAt: Date.now() + 3600000,
      }));
      await open(app);
      const pairGroup = app.page.getByRole("group", { name: "Pair a device" });
      await pairGroup.getByLabel("Pairing link").fill(sampleLink);
      await pairGroup.getByRole("button", { name: "Show QR code" }).click();
      await pairGroup.locator(".pairing-qr svg").waitFor();
      assert.ok(app.server.rpc.calls.some((c) => c.method === "pairing.qr" && (c.params as any).link === sampleLink));
      await expectAxeClean(app.page, "pairing-qr");
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
  test("a member skips the config gate and sees the device list; a server refusal is forbidden", async () => {
    await withApp({ server: { role: "member" } }, async (app) => {
      listDevices(app, [dev({ pairedBy: "member" })]); await open(app);
      await app.page.getByText("Pixel").waitFor();
      assert.equal(configCalls(app).length, 0);
      assert.equal(await app.page.getByText("Remote access").count(), 0);
    });
    await withApp({ server: { role: "viewer" } }, async (app) => {
      app.server.rpc.handle("device.list", () => { throw rpcError("E_DENIED", "no"); }, { write: false }); await open(app);
      await app.page.locator(".page-state[data-state=forbidden]").waitFor();
    });
    await withApp({}, async (app) => {
      publish(app, "tailnet"); app.server.rpc.scenario("config.get", "forbidden"); await open(app);
      await app.page.locator(".page-state[data-state=forbidden]").waitFor();
    });
  });
});

describe("devices: list, rename, revoke", opts, () => {
  test("shows name, platform, paired at/by, last seen and status; revoked ones have no actions", async () => {
    await withApp({}, async (app) => {
      publish(app, "tailnet");
      listDevices(app, [dev({ id: ID1, pairedBy: "owner" }), dev({ id: ID2, name: "Old tablet", platform: "android", pairedBy: "ann", revoked: true, revokedAt: 5 })]);
      await open(app);
      const row = app.page.locator(`[data-device="${ID1}"]`);
      const text = (await row.textContent()) ?? "";
      for (const x of ["Pixel", "android-14", "by owner", "Active"]) assert.ok(text.includes(x), x);
      const old = app.page.locator(`[data-device="${ID2}"]`);
      await old.getByText("Revoked").waitFor();
      assert.equal(await old.getByRole("button").count(), 0);
    });
  });
  test("owner sees every device but renames only their own; revoke is offered for all", async () => {
    await withApp({}, async (app) => {
      publish(app, "tailnet"); listDevices(app, [dev({ id: ID1, pairedBy: "owner" }), dev({ id: ID2, name: "Ann phone", pairedBy: "ann" })]);
      await open(app);
      await app.page.getByRole("button", { name: "Rename Pixel" }).waitFor();
      assert.equal(await app.page.getByRole("button", { name: "Rename Ann phone" }).count(), 0);
      await app.page.getByRole("button", { name: "Revoke Ann phone" }).waitFor();
    });
  });
  test("a member gets rename and revoke on their own device only", async () => {
    await withApp({ server: { role: "member" } }, async (app) => {
      listDevices(app, [dev({ id: ID1, pairedBy: "member" }), dev({ id: ID2, name: "Ann phone", pairedBy: "ann" })]); await open(app);
      await app.page.getByRole("button", { name: "Rename Pixel" }).waitFor();
      await app.page.getByRole("button", { name: "Revoke Pixel" }).waitFor();
      assert.equal(await app.page.getByRole("button", { name: /Ann phone/ }).count(), 0);
    });
  });
  test("rename sends id and trimmed name, then reloads", async () => {
    await withApp({}, async (app) => {
      publish(app, "tailnet"); const devices = [dev({ id: ID1, pairedBy: "owner" })]; listDevices(app, devices);
      app.server.rpc.handle("device.rename", (p) => { devices[0] = { ...devices[0]!, name: (p as { name: string }).name }; return devices[0]; });
      await open(app);
      await app.page.getByRole("button", { name: "Rename Pixel" }).click();
      const dlg = app.page.getByRole("dialog", { name: "Rename device" });
      await dlg.getByLabel("Name").fill("  Work phone  ");
      await dlg.getByRole("button", { name: "Save name" }).click();
      await app.page.getByText("Work phone").first().waitFor();
      await app.page.getByText("Device renamed.").waitFor();
      assert.deepEqual(app.server.rpc.calls.filter((c) => c.method === "device.rename").map((c) => c.params), [{ id: ID1, name: "Work phone" }]);
    });
  });
  test("rename error stays in the dialog with a readable text (not the raw server message)", async () => {
    await withApp({}, async (app) => {
      publish(app, "tailnet"); listDevices(app, [dev({ id: ID1, pairedBy: "owner" })]);
      app.server.rpc.handle("device.rename", () => { throw rpcError("E_DENIED", "SECRET internal text", "device-owner"); });
      await open(app);
      await app.page.getByRole("button", { name: "Rename Pixel" }).click();
      const dlg = app.page.getByRole("dialog", { name: "Rename device" });
      await dlg.getByRole("button", { name: "Save name" }).click();
      await dlg.getByRole("alert").getByText("Only the person who paired this device can do this.").waitFor();
      assert.equal(((await dlg.textContent()) ?? "").includes("SECRET"), false);
    });
  });
  test("revoke: the dialog warns that connections close at once, focus is inside, Escape cancels without a call", async () => {
    await withApp({}, async (app) => {
      publish(app, "tailnet"); listDevices(app, [dev({ id: ID1, pairedBy: "owner" })]); await open(app);
      await app.page.getByRole("button", { name: "Revoke Pixel" }).click();
      const dlg = app.page.getByRole("dialog", { name: "Revoke Pixel?" });
      await dlg.getByText(/any open connection from it is closed/).waitFor();
      assert.equal(await app.page.evaluate(() => document.activeElement?.closest("dialog") !== null), true);
      await expectAxeClean(app.page, "revoke dialog");
      await app.page.keyboard.press("Escape");
      await dlg.waitFor({ state: "detached" });
      assert.equal(app.server.rpc.calls.some((c) => c.method === "device.revoke"), false);
    });
  });
  test("revoke confirmed: sends the id, marks the device revoked", async () => {
    await withApp({}, async (app) => {
      publish(app, "tailnet"); let devices = [dev({ id: ID1, pairedBy: "owner" })]; listDevices(app, () => devices);
      app.server.rpc.handle("device.revoke", () => { devices = [dev({ id: ID1, pairedBy: "owner", revoked: true, revokedAt: 9 })]; return devices[0]; });
      await open(app);
      await app.page.getByRole("button", { name: "Revoke Pixel" }).click();
      await app.page.getByRole("dialog").getByRole("button", { name: "Revoke device" }).click();
      await app.page.getByText("Device Pixel was revoked.").waitFor();
      await app.page.locator(`[data-device="${ID1}"]`).getByText("Revoked").waitFor();
      assert.deepEqual(app.server.rpc.calls.filter((c) => c.method === "device.revoke").map((c) => c.params), [{ id: ID1 }]);
    });
  });
  test("revoke error keeps the dialog open with a readable text", async () => {
    await withApp({}, async (app) => {
      publish(app, "tailnet"); listDevices(app, [dev({ id: ID1, pairedBy: "owner" })]);
      app.server.rpc.handle("device.revoke", () => { throw rpcError("E_NOT_FOUND", "gone"); });
      await open(app);
      await app.page.getByRole("button", { name: "Revoke Pixel" }).click();
      const dlg = app.page.getByRole("dialog");
      await dlg.getByRole("button", { name: "Revoke device" }).click();
      await dlg.getByText("This device no longer exists.").waitFor();
    });
  });
  test("device.list unknown to the server: unavailable note; load error offers Try again", async () => {
    await withApp({}, async (app) => {
      publish(app, "tailnet"); listDevices(app, []); app.server.rpc.scenario("device.list", "unavailable"); await open(app);
      await app.page.getByRole("group", { name: "Paired devices" }).getByText("Paired devices are not available on this harness.").waitFor();
    });
    await withApp({}, async (app) => {
      publish(app, "tailnet"); listDevices(app, []); app.server.rpc.scenario("device.list", "error", { code: "E_INTERNAL" }); await open(app);
      await app.page.getByRole("button", { name: "Try again" }).waitFor();
    });
  });
  test("German list, axe clean with devices", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      publish(app, "tailnet"); listDevices(app, [dev({ id: ID1, pairedBy: "owner" })]); await open(app, "de");
      await app.page.getByRole("button", { name: "Pixel widerrufen" }).waitFor();
      await app.page.getByText("Zuletzt gesehen").waitFor();
      await expectAxeClean(app.page, "devices de");
    });
    await withApp({}, async (app) => { publish(app, "tailnet"); listDevices(app, [dev({ id: ID1, pairedBy: "owner" })]); await open(app); await app.page.getByText("Pixel").first().waitFor(); await expectAxeClean(app.page, "devices en"); });
  });
});

describe("devices: a11y, layout, German", opts, () => {
  test("axe clean: off, remote, forbidden", async () => {
    await withApp({}, async (app) => { publish(app, "local"); await open(app); await app.page.getByRole("heading", { name: "Remote access is off" }).waitFor(); await expectAxeClean(app.page, "off"); });
    await withApp({}, async (app) => { publish(app, "tailnet"); await open(app); await app.page.getByText("Published as tailnet").waitFor(); await expectAxeClean(app.page, "remote"); });
    await withApp({ server: { role: "viewer" } }, async (app) => { app.server.rpc.handle("device.list", () => { throw rpcError("E_DENIED", "no"); }, { write: false }); await open(app); await app.page.locator(".page-state[data-state=forbidden]").waitFor(); await expectAxeClean(app.page, "forbidden"); });
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
