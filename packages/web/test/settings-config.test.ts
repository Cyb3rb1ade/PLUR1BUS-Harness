// Settings config sections (general, models, memory, extensions, network): states, edit -> diff -> save, conflict, restart badge,
// focus, secrets, role, a11y, 400 px. Runs against test/mock-rpc.ts; the backend serves no /rpc yet.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { rpcError } from "./mock-rpc.ts";
import { seedConfig } from "./settings-config-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };
const open = (app: App, hash: string): Promise<void> => openRoute(app.page, hash);
const sets = (app: App): { params: Record<string, unknown> }[] => app.server.rpc.calls.filter((c) => c.method === "config.set") as never;

describe("settings config: states", opts, () => {
  test("loading, then the fields of the section with label, key, default and restart badge", async () => {
    await withApp({}, async (app) => {
      seedConfig(app.server.rpc); app.server.rpc.setDelay("config.get", 250);
      await open(app, "#/settings/general");
      await app.page.locator(".page-state[data-state=loading]").waitFor();
      await app.page.getByRole("heading", { name: "General", level: 2 }).waitFor();
      const row = app.page.locator('.cfg-field[data-key="core.recall.softBudgetMs"]');
      await row.waitFor();
      assert.match(await row.innerText(), /Soft budget ms/);
      assert.match(await row.innerText(), /core\.recall\.softBudgetMs/);
      assert.match(await row.innerText(), /Default: 400/);
      assert.match(await row.innerText(), /Minimum: 50/);
      assert.match(await row.innerText(), /Restart required \(core\)/);
      assert.match(await app.page.locator('.cfg-field[data-key="core.logLevel"]').innerText(), /Applies live/);
      assert.equal(await app.page.locator("#cfg-core-logLevel").inputValue(), "warn");
    });
  });
  test("unavailable when the config RPC is missing", async () => {
    await withApp({}, async (app) => {
      await open(app, "#/settings/general");
      await app.page.locator('.page-state[data-state=unavailable]').waitFor();
    });
  });
  test("error offers Try again", async () => {
    await withApp({}, async (app) => {
      seedConfig(app.server.rpc); app.server.rpc.scenario("config.get", "error");
      await open(app, "#/settings/general");
      await app.page.locator('.page-state[data-state=error]').waitFor();
      app.server.rpc.scenario("config.get", "success");
      await app.page.getByRole("button", { name: "Try again" }).click();
      await app.page.getByRole("heading", { name: "General", level: 2 }).waitFor();
      await app.page.locator("#cfg-core-logLevel").waitFor();
    });
  });
  test("forbidden config.get", async () => {
    await withApp({}, async (app) => {
      seedConfig(app.server.rpc); app.server.rpc.scenario("config.get", "forbidden");
      await open(app, "#/settings/general");
      await app.page.locator('.page-state[data-state=forbidden]').waitFor();
    });
  });
  test("a role without config write sees read-only fields and a disabled Save with the reason", async () => {
    await withApp({ server: { role: "viewer" } }, async (app) => {
      seedConfig(app.server.rpc);
      await open(app, "#/settings/general");
      await app.page.locator("#cfg-core-logLevel").waitFor();
      assert.equal(await app.page.locator("#cfg-core-logLevel").isDisabled(), true);
      assert.equal(await app.page.locator("#cfg-core-recall-softBudgetMs").isDisabled(), true);
      const save = app.page.getByRole("button", { name: "Save changes" });
      assert.equal(await save.isDisabled(), true);
      assert.match(await app.page.locator("#cfg-ro").innerText(), /may read the configuration but not change it/);
      assert.equal(await save.getAttribute("aria-describedby"), "cfg-ro");
    });
  });
});

describe("settings config: sections and fields", opts, () => {
  test("each section shows only its own keys; secret-holding values are masked", async () => {
    await withApp({}, async (app) => {
      seedConfig(app.server.rpc);
      await open(app, "#/settings/network");
      await app.page.locator("#cfg-egress-allowHosts").waitFor();
      assert.equal(await app.page.locator("#cfg-egress-allowHosts").inputValue(), "api.example.com");
      assert.equal(await app.page.locator("#cfg-egress-allowPorts").inputValue(), "443");
      assert.equal(await app.page.locator("#cfg-core-logLevel").count(), 0);
      assert.equal(await app.page.locator("#cfg-egress-allowLoopback").getAttribute("role"), "switch");
      await app.page.evaluate(() => { location.hash = "#/settings/models"; });
      const roles = app.page.locator("#cfg-modelRoles");
      await roles.waitFor();
      const text = await app.page.locator("main").innerText();
      assert.ok(!text.includes("sk-secret-123") && !text.includes("sk-should-not-show"), "secret value shown");
      assert.match(await roles.innerText(), /chat/);
      assert.match(await app.page.locator(".cfg-field", { has: roles }).innerText(), /read-only/i);
      assert.equal(await app.page.locator("#cfg-models-scan-enabled").getAttribute("role"), "switch");
    });
  });
  test("a key unknown to the metadata gets a widget from its value type", async () => {
    await withApp({}, async (app) => {
      seedConfig(app.server.rpc, { logs: { keep: 5, futureFlag: true } });
      await open(app, "#/settings/general");
      await app.page.getByRole("button", { name: "Logs" }).click();
      const sw = app.page.locator("#cfg-logs-futureFlag");
      await sw.waitFor();
      assert.equal(await sw.getAttribute("role"), "switch");
    });
  });
});

describe("settings config: edit, review, save", opts, () => {
  test("edit several fields, review the diff, save sends exact config.set params with ifRevision", async () => {
    await withApp({}, async (app) => {
      const fake = seedConfig(app.server.rpc);
      await open(app, "#/settings/general");
      await app.page.locator("#cfg-core-logLevel").selectOption("debug");
      await app.page.locator("#cfg-core-recall-softBudgetMs").fill("500");
      await app.page.getByRole("button", { name: "Metrics" }).click();
      await app.page.locator("#cfg-metrics-enabled").check();
      await app.page.getByText("Unsaved changes: 3").waitFor();
      await app.page.getByRole("button", { name: "Review changes" }).click();
      const diff = app.page.locator(".cfg-diff");
      await diff.waitFor();
      const dry = sets(app);
      assert.equal(dry.length, 1);
      assert.deepEqual(dry[0]!.params, { changes: [{ key: "core.logLevel", value: "debug" }, { key: "core.recall.softBudgetMs", value: 500 }, { key: "metrics.enabled", value: true }], dryRun: true, ifRevision: "r1" });
      const text = await diff.innerText();
      assert.match(text, /core\.logLevel/); assert.match(text, /warn/); assert.match(text, /debug/);
      assert.match(text, /400/); assert.match(text, /500/);
      assert.match(text, /Restart required \(core\)/);
      assert.match(await app.page.locator(".cfg-review .form-notice").innerText(), /take effect only after a restart: core\.recall\.softBudgetMs, metrics\.enabled/);
      assert.equal(fake.sets.length, 0, "dry run must not apply");
      await app.page.getByRole("button", { name: "Save changes" }).click();
      await app.page.getByText(/Saved 3 changes/).waitFor();
      assert.deepEqual(fake.sets, [{ changes: [{ key: "core.logLevel", value: "debug" }, { key: "core.recall.softBudgetMs", value: 500 }, { key: "metrics.enabled", value: true }], ifRevision: "r1" }]);
      assert.match(await app.page.locator("[data-section=general] .form-notice").first().innerText(), /after a restart/);
      await app.page.waitForFunction(() => (document.getElementById("cfg-core-logLevel") as HTMLSelectElement | null)?.value === "debug");
    });
  });
  test("list fields send arrays", async () => {
    await withApp({}, async (app) => {
      const fake = seedConfig(app.server.rpc);
      await open(app, "#/settings/network");
      await app.page.locator("#cfg-egress-allowHosts").fill("api.example.com\n*.example.org\n");
      await app.page.locator("#cfg-egress-allowPorts").fill("443\n8443");
      await app.page.getByRole("button", { name: "Review changes" }).click();
      await app.page.getByRole("button", { name: "Save changes" }).click();
      await app.page.getByText(/Saved 2 changes/).waitFor();
      assert.deepEqual((fake.sets[0] as { changes: unknown }).changes, [{ key: "egress.allowHosts", value: ["api.example.com", "*.example.org"] }, { key: "egress.allowPorts", value: [443, 8443] }]);
    });
  });
  test("client validation blocks the review and names the field", async () => {
    await withApp({}, async (app) => {
      seedConfig(app.server.rpc);
      await open(app, "#/settings/general");
      const f = app.page.locator("#cfg-core-recall-softBudgetMs");
      await f.fill("10");
      await app.page.getByRole("button", { name: "Review changes" }).click();
      await app.page.getByText("Must be at least 50.").waitFor();
      assert.equal(await f.getAttribute("aria-invalid"), "true");
      assert.match((await f.getAttribute("aria-describedby")) ?? "", /cfg-core-recall-softBudgetMs-err/);
      assert.equal(sets(app).length, 0);
    });
  });
  test("a server validation error is shown next to its field", async () => {
    await withApp({}, async (app) => {
      const rpc = app.server.rpc; seedConfig(rpc);
      rpc.handle("config.set", () => { throw rpcError("E_CONFIG_INVALID", "/core/recall/hardBudgetMs must be >= 100", "invalid"); });
      await open(app, "#/settings/general");
      await app.page.locator("#cfg-core-recall-hardBudgetMs").fill("150");
      await app.page.getByRole("button", { name: "Review changes" }).click();
      const err = app.page.locator("#cfg-core-recall-hardBudgetMs-err");
      await err.waitFor();
      assert.match(await err.innerText(), /hardBudgetMs must be >= 100/);
      assert.equal(await app.page.locator("#cfg-core-recall-hardBudgetMs").getAttribute("aria-invalid"), "true");
    });
  });
  test("a revision conflict explains itself and reloads on request", async () => {
    await withApp({}, async (app) => {
      const fake = seedConfig(app.server.rpc);
      await open(app, "#/settings/general");
      await app.page.locator("#cfg-core-logLevel").selectOption("error");
      await app.page.getByRole("button", { name: "Review changes" }).click();
      await app.page.getByRole("button", { name: "Save changes" }).waitFor();
      fake.revision = 2; (fake.config.core as Record<string, unknown>).logLevel = "info";
      await app.page.getByRole("button", { name: "Save changes" }).click();
      const alert = app.page.getByRole("alert").filter({ hasText: "changed since you opened this page" });
      await alert.waitFor();
      assert.equal(fake.sets.length, 0);
      await alert.getByRole("button", { name: "Reload" }).click();
      await app.page.waitForFunction(() => (document.getElementById("cfg-core-logLevel") as HTMLSelectElement | null)?.value === "info");
      assert.equal(await app.page.getByRole("alert").count(), 0);
    });
  });
  test("when the dry run is not served, the diff is computed in the browser", async () => {
    await withApp({}, async (app) => {
      const rpc = app.server.rpc; seedConfig(rpc);
      rpc.scenario("config.set", "unavailable");
      await open(app, "#/settings/general");
      await app.page.locator("#cfg-core-logLevel").selectOption("error");
      await app.page.getByRole("button", { name: "Review changes" }).click();
      await app.page.getByText(/computed in your browser/).waitFor();
      assert.match(await app.page.locator(".cfg-diff").innerText(), /warn[\s\S]*error/);
    });
  });
  test("discard resets the form", async () => {
    await withApp({}, async (app) => {
      seedConfig(app.server.rpc);
      await open(app, "#/settings/general");
      await app.page.locator("#cfg-core-logLevel").selectOption("error");
      await app.page.getByRole("button", { name: "Discard changes" }).click();
      assert.equal(await app.page.locator("#cfg-core-logLevel").inputValue(), "warn");
      await app.page.getByText("No changes yet.").waitFor();
    });
  });
});

describe("settings config: ?focus", opts, () => {
  test("focuses and highlights the field, even inside a collapsed group", async () => {
    await withApp({}, async (app) => {
      seedConfig(app.server.rpc);
      await open(app, "#/settings/general?focus=logs.keep");
      const el = app.page.locator("#cfg-logs-keep");
      await el.waitFor();
      await app.page.waitForFunction(() => document.activeElement?.id === "cfg-logs-keep");
      assert.equal(await app.page.locator('.cfg-field[data-key="logs.keep"]').getAttribute("data-focus"), "true");
      assert.equal(await app.page.getByRole("button", { name: "Logs" }).getAttribute("aria-expanded"), "true");
    });
  });
  test("an unknown key gives a quiet notice", async () => {
    await withApp({}, async (app) => {
      seedConfig(app.server.rpc);
      await open(app, "#/settings/general?focus=nope.nothing");
      await app.page.getByText("This section has no setting named nope.nothing.").waitFor();
      assert.equal(await app.page.getByRole("alert").count(), 0);
    });
  });
});

describe("settings config: a11y and layout", opts, () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`axe clean in ${scheme}: form, review and states`, async () => {
      await withApp({ colorScheme: scheme }, async (app) => {
        seedConfig(app.server.rpc);
        await open(app, "#/settings/general");
        await app.page.locator("#cfg-core-logLevel").waitFor();
        await expectAxeClean(app.page, `general ${scheme}`);
        await app.page.locator("#cfg-core-logLevel").selectOption("debug");
        await app.page.locator("#cfg-core-recall-softBudgetMs").fill("1");
        await app.page.getByRole("button", { name: "Review changes" }).click();
        await app.page.getByText("Must be at least 50.").waitFor();
        await expectAxeClean(app.page, `invalid ${scheme}`);
        await app.page.locator("#cfg-core-recall-softBudgetMs").fill("500");
        await app.page.getByRole("button", { name: "Review changes" }).click();
        await app.page.locator(".cfg-diff").waitFor();
        await expectAxeClean(app.page, `review ${scheme}`);
        await app.page.evaluate(() => { location.hash = "#/settings/models"; });
        await app.page.locator("#cfg-modelRoles").waitFor();
        await expectAxeClean(app.page, `models ${scheme}`);
      });
    });
  }
  test("axe clean: unavailable and read-only role", async () => {
    await withApp({ server: { role: "viewer" } }, async (app) => {
      await open(app, "#/settings/network");
      await app.page.locator('.page-state[data-state=unavailable]').waitFor();
      await expectAxeClean(app.page, "unavailable");
    });
    await withApp({ server: { role: "viewer" } }, async (app) => {
      seedConfig(app.server.rpc);
      await open(app, "#/settings/network");
      await app.page.locator("#cfg-egress-allowHosts").waitFor();
      await expectAxeClean(app.page, "read-only");
    });
  });
  test("no horizontal scroll at 400 px, in the form and the review", async () => {
    await withApp({ width: 400, height: 800 }, async (app) => {
      seedConfig(app.server.rpc);
      await open(app, "#/settings/general");
      await app.page.locator("#cfg-core-logLevel").waitFor();
      const wide = (): Promise<boolean> => app.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      assert.equal(await wide(), false);
      await app.page.locator("#cfg-core-logLevel").selectOption("debug");
      await app.page.getByRole("button", { name: "Review changes" }).click();
      await app.page.locator(".cfg-diff").waitFor();
      assert.equal(await wide(), false);
      await app.page.evaluate(() => { location.hash = "#/settings/models"; });
      await app.page.locator("#cfg-modelRoles").waitFor();
      assert.equal(await wide(), false);
    });
  });
  test("German labels", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      seedConfig(app.server.rpc);
      await openRoute(app.page, "#/settings/general", "de");
      await app.page.getByText("Wirkt sofort").first().waitFor();
      await app.page.getByRole("button", { name: "Änderungen prüfen" }).waitFor();
    });
  });
});
