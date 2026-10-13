// Settings > Security & Permissions: a read-only overview built from config.get. No form, no config.set, no invented keys,
// links to the pages that own the live data, forbidden for roles below admin, axe, 400 px, German.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { seedConfig } from "./settings-config-fixtures.ts";
import { RULES, stateOf } from "../src/pages/settings/security/rules.ts";
import { SECTIONS, sectionOf } from "../src/settings-sections.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const SECURITY = {
  remote: { publish: "tailnet" }, tools: { hostctl: { enabled: true, shell: { allowed: false } } },
  extensions: { allowUnsigned: true }, secrets: { fileFallback: { enabled: false } },
};
const open = async (app: App, lang: "en" | "de" = "en"): Promise<void> => { await openRoute(app.page, "#/settings/security", lang); };
const calls = (app: App, method: string): { params: unknown }[] => app.server.rpc.calls.filter((c) => c.method === method);
const rule = (app: App, key: string) => app.page.locator(`.sec-rule[data-key="${key}"]`);
const badge = (app: App, key: string, text: string) => rule(app, key).locator(".badge", { hasText: new RegExp(`^${text}$`) });

describe("security settings: model", () => {
  test("sits right after Network, owns no config key, and lists only keys of the schema", async () => {
    const ids = SECTIONS.map((s) => s.id);
    assert.equal(ids[ids.indexOf("network") + 1], "security");
    assert.equal(SECTIONS.find((s) => s.id === "security")?.keys, undefined);
    assert.equal(sectionOf("remote.publish"), undefined, "the read-only section must not claim keys (the palette would route edits to it)");
    const schema = (await import("../../config-schema/schema/config.schema.json", { with: { type: "json" } })).default as { properties: Record<string, unknown> };
    for (const r of RULES) {
      let node: any = { properties: schema.properties };
      for (const seg of r.key.split(".")) { node = node.properties?.[seg]; assert.ok(node, `${r.key}: no such key in config.schema.json`); }
    }
  });
  test("stateOf reads booleans and the three exposure words, nothing else", () => {
    const b = RULES.find((r) => r.key === "tools.hostctl.shell.allowed")!;
    const p = RULES.find((r) => r.kind === "publish")!;
    assert.equal(stateOf(b, {}), "unset");
    assert.equal(stateOf(b, { tools: { hostctl: { shell: { allowed: true } } } }), "on");
    assert.equal(stateOf(b, { tools: { hostctl: { shell: { allowed: false } } } }), "off");
    assert.equal(stateOf(b, { tools: { hostctl: { shell: { allowed: "yes" } } } }), "other");
    assert.equal(stateOf(p, { remote: { publish: "tailnet" } }), "tailnet");
    assert.equal(stateOf(p, { remote: { publish: "<script>" } }), "other");
  });
});

describe("security settings: page", opts, () => {
  test("shows the rules from config.get, read only, with one config.get call and no config.set", async () => {
    await withApp({}, async (app) => {
      seedConfig(app.server.rpc, SECURITY); await open(app);
      await app.page.getByRole("heading", { name: "Security & Permissions", level: 2 }).waitFor();
      await badge(app, "remote.publish", "Tailnet").waitFor();
      await badge(app, "tools.hostctl.shell.allowed", "Off").waitFor();
      await badge(app, "extensions.allowUnsigned", "On").waitFor();
      assert.equal(await app.page.locator(".sec input, .sec select, .sec textarea, .sec form").count(), 0);
      assert.equal(calls(app, "config.set").length, 0);
      assert.equal(calls(app, "config.get").length, 1);
      assert.equal(await app.page.getByText(/maximum|expires|OS confirm/i).count(), 0, "no rule is shown that has no config key");
      assert.equal(app.problems.length, 0, app.problems.join("\n"));
    });
  });
  test("a key the configuration does not carry reads 'Not set'; an odd value reads 'Unknown value' and is not echoed", async () => {
    await withApp({}, async (app) => {
      seedConfig(app.server.rpc, { remote: { publish: "<img src=x onerror=alert(1)>" }, tools: { hostctl: { enabled: true } } }); await open(app);
      await badge(app, "remote.publish", "Unknown value").waitFor();
      await badge(app, "tools.hostctl.shell.allowed", "Not set").waitFor();
      assert.ok(!(await app.page.content()).includes("onerror=alert"));
    });
  });
  test("links go to Approvals, Break-glass and Devices; only the extensions key offers a change link", async () => {
    await withApp({}, async (app) => {
      seedConfig(app.server.rpc, SECURITY); await open(app);
      const href = (name: string) => app.page.locator(".sec-links").getByRole("link", { name }).getAttribute("href");
      assert.equal(await href("Approvals"), "#/approvals");
      assert.equal(await href("Break-glass"), "#/breakglass");
      assert.equal(await href("Devices & remote"), "#/settings/devices");
      const change = app.page.locator(".sec-rules").getByRole("link");
      assert.equal(await change.count(), 1);
      assert.match((await change.getAttribute("href")) ?? "", /^#\/settings\/extensions\?focus=extensions\.allowUnsigned$/);
      assert.equal(await app.page.locator(".sec-rules").getByText("read only").count(), RULES.length - 1);
    });
  });
  test("the navigation lists the section after Network", async () => {
    await withApp({}, async (app) => {
      seedConfig(app.server.rpc, SECURITY); await open(app);
      await app.page.locator(".settings-nav").getByRole("link", { name: "Network" }).waitFor();
      const names = (await app.page.locator(".settings-nav li a").allInnerTexts()).map((x) => x.trim());
      assert.equal(names[names.indexOf("Network") + 1], "Security & Permissions");
    });
  });
  test("members and viewers get 'forbidden' and nothing is requested", async () => {
    for (const role of ["member", "viewer", "operator"]) {
      await withApp({ server: { role } }, async (app) => {
        seedConfig(app.server.rpc, SECURITY); await open(app);
        await app.page.locator(".page-state[data-state=forbidden]").waitFor();
        assert.equal(calls(app, "config.get").length, 0);
      });
    }
  });
  test("an unavailable or failing config.get shows the state, not an empty list", async () => {
    await withApp({}, async (app) => {
      seedConfig(app.server.rpc, SECURITY); app.server.rpc.scenario("config.get", "unavailable"); await open(app);
      await app.page.locator(".page-state[data-state=unavailable]").waitFor();
      assert.equal(await app.page.locator(".sec-rule").count(), 0);
    });
  });
  test("axe clean, 400 px without horizontal scroll", async () => {
    await withApp({}, async (app) => {
      seedConfig(app.server.rpc, SECURITY); await open(app);
      await rule(app, "remote.publish").waitFor();
      await expectAxeClean(app.page, "security overview");
    });
    await withApp({ width: 400, height: 800 }, async (app) => {
      seedConfig(app.server.rpc, SECURITY); await open(app);
      await rule(app, "remote.publish").waitFor();
      assert.equal(await app.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
    });
    await withApp({ server: { role: "viewer" } }, async (app) => {
      seedConfig(app.server.rpc, SECURITY); await open(app);
      await app.page.locator(".page-state[data-state=forbidden]").waitFor();
      await expectAxeClean(app.page, "security forbidden");
    });
  });
  test("German", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      seedConfig(app.server.rpc, SECURITY); await open(app, "de");
      await app.page.getByRole("heading", { name: "Sicherheit & Berechtigungen", level: 2 }).waitFor();
      await badge(app, "remote.publish", "Tailnet").waitFor();
      await app.page.locator(".sec-links").getByRole("link", { name: "Freigaben" }).waitFor();
    });
  });
});
