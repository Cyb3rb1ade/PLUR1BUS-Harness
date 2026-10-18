// "No decision model set" hint: what is limited without `modelRoles.decision` and how to set it later. Shown in the setup
// wizard (model step and summary) and on the Models & providers settings section, hidden once the role is set; en and de;
// axe-clean. Pure rule first, then the browser against the mock RPC.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { DECISION_FEATURES, decisionRoleMissing } from "../src/pages/common/decision-hint.ts";
import { en, de } from "../src/i18n/shared.ts";
import { seedConfig } from "./settings-config-fixtures.ts";
import { next, open, seed, skip, stepHeading } from "./setup-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

describe("decision hint: the rule", () => {
  test("missing unless modelRoles.decision is a non-empty string", () => {
    for (const config of [undefined, null, 3, {}, { modelRoles: null }, { modelRoles: { chat: "p/m" } }, { modelRoles: { decision: "" } }, { modelRoles: { decision: "  " } }, { modelRoles: { decision: 7 } }, { modelRoles: { decision: { id: "p/m" } } }]) {
      assert.equal(decisionRoleMissing(config), true, JSON.stringify(config));
    }
    assert.equal(decisionRoleMissing({ modelRoles: { decision: "anthropic/claude-small" } }), false);
    assert.equal(decisionRoleMissing({ modelRoles: { decision: "fast-profile", chat: "p/m" } }), false);
  });

  test("three features, each with an English and a German text, and the way to set the role", () => {
    assert.deepEqual(DECISION_FEATURES.map((f) => f.id), ["triage", "tools", "classes"]);
    for (const f of DECISION_FEATURES) { assert.ok(en[f.text]); assert.ok(de[f.text]); assert.notEqual(en[f.text], de[f.text]); }
    for (const text of [en["shared.decisionHint.how"], en["shared.decisionHint.howHere"], de["shared.decisionHint.how"], de["shared.decisionHint.howHere"]]) assert.match(text, /plur1bus config set modelRoles\.decision/);
    assert.match(en["shared.decisionHint.how"], /Settings → Models & providers \(modelRoles\.decision\)/);
    assert.match(de["shared.decisionHint.how"], /Einstellungen → Modelle & Anbieter \(modelRoles\.decision\)/);
  });
});

const hint = (app: App) => app.page.locator("[data-decision-hint]");
const reads = (app: App): unknown[] => app.server.rpc.calls.filter((c) => c.method === "config.get").map((c) => c.params);

async function toModelStep(app: App): Promise<void> {
  const { page } = app;
  await stepHeading(page, "Your account").waitFor(); await next(page);
  await stepHeading(page, "Name & persona").waitFor(); await page.getByLabel("Display name").fill("Hal"); await next(page);
  await stepHeading(page, /Main model/).waitFor();
}

describe("decision hint: setup wizard", opts, () => {
  test("model step and summary name the limited features and the way to set the role; no config is written for it", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      const { page } = app;
      await toModelStep(app);
      await hint(app).waitFor();
      const text = (await hint(app).innerText()).replace(/\s+/g, " ");
      assert.match(text, /No decision model set/);
      for (const f of DECISION_FEATURES) assert.ok(text.includes(en[f.text]), f.id);
      assert.match(text, /Settings → Models & providers \(modelRoles\.decision\)/);
      assert.match(text, /plur1bus config set modelRoles\.decision <provider\/model>/);
      assert.equal(await hint(app).locator("li").count(), 3);
      assert.ok(reads(app).some((p) => (p as { key?: string })?.key === "modelRoles.decision"), "the role is read, not assumed");

      await page.getByLabel("Chat model").selectOption("anthropic/claude-x"); await next(page);
      await stepHeading(page, /Switchboard/).waitFor(); await skip(page);
      await stepHeading(page, /Memory/).waitFor(); await next(page);
      await stepHeading(page, /Language for voice features/).waitFor(); await skip(page);
      await stepHeading(page, /Backups/).waitFor();
      await page.getByRole("button", { name: "Create a backup now" }).click(); await page.getByText(/Backup created/).waitFor(); await next(page);
      await stepHeading(page, /Import/).waitFor(); await skip(page, "Skip and finish");
      await stepHeading(page, "Setup summary").waitFor();
      await hint(app).waitFor();
      assert.equal(await hint(app).count(), 1);

      const writes = app.server.rpc.calls.filter((c) => c.method === "config.set").flatMap((c) => (c.params as { changes: { key: string }[] }).changes.map((x) => x.key));
      assert.ok(!writes.includes("modelRoles.decision"), "the wizard never invents a decision model");
      assert.deepEqual(app.problems, []);
    });
  });

  test("no hint when a decision role is already set", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc);
      const base = app.server.rpc;
      base.handle("config.get", (p) => {
        const key = (p as { key?: string }).key;
        return { value: key === "modelRoles.decision" ? "anthropic/claude-small" : undefined, revision: "r1" };
      }, { write: false });
      await open(app); await toModelStep(app);
      await app.page.getByLabel("Chat model").waitFor();
      await app.page.waitForFunction(() => document.querySelectorAll("main [data-decision-hint]").length === 0);
      assert.equal(await hint(app).count(), 0);
    });
  });

  test("the hint still shows when the configuration cannot be read", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc);
      app.server.rpc.handle("config.get", (p) => {
        if ((p as { key?: string }).key === "modelRoles.decision") throw new Error("boom");
        return { value: undefined, revision: "r1" };
      }, { write: false });
      await open(app); await toModelStep(app);
      await hint(app).waitFor();
    });
  });

  test("German wording, and axe is clean with the hint (light and dark)", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      seed(app.server.rpc); await openRoute(app.page, "#/setup", "de");
      const { page } = app;
      await stepHeading(page, "Dein Konto").waitFor();
      await next(page);
      await stepHeading(page, "Name & Persona").waitFor();
      await page.getByLabel(/Anzeigename/).fill("Hal"); await next(page);
      await stepHeading(page, /Hauptmodell/).waitFor();
      await hint(app).waitFor();
      const text = (await hint(app).innerText()).replace(/\s+/g, " ");
      assert.match(text, /Kein Decision-Modell eingerichtet/);
      assert.match(text, /Einstellungen → Modelle & Anbieter \(modelRoles\.decision\)/);
      assert.match(text, /Werkzeug-Vorauswahl/);
      await expectAxeClean(page, "setup model step with decision hint de");
    });
    for (const colorScheme of ["light", "dark"] as const) {
      await withApp({ colorScheme }, async (app) => {
        seed(app.server.rpc); await open(app); await toModelStep(app);
        await hint(app).waitFor(); await app.page.getByLabel("Chat model").waitFor();
        await expectAxeClean(app.page, `setup model step with decision hint ${colorScheme}`);
      });
    }
  });
});

describe("decision hint: Models & providers settings", opts, () => {
  test("shown while modelRoles.decision is unset, on the models section only", async () => {
    await withApp({}, async (app) => {
      seedConfig(app.server.rpc);
      await openRoute(app.page, "#/settings/models");
      await app.page.getByRole("heading", { name: "Models & providers", level: 2 }).waitFor();
      await hint(app).waitFor();
      const text = (await hint(app).innerText()).replace(/\s+/g, " ");
      assert.match(text, /No decision model set/);
      assert.match(text, /plur1bus config set modelRoles\.decision <provider\/model>/);
      assert.equal(await hint(app).locator("li").count(), 3);
      await expectAxeClean(app.page, "settings models with decision hint");

      await app.page.evaluate(() => { location.hash = "#/settings/general"; });
      await app.page.getByRole("heading", { name: "General", level: 2 }).waitFor();
      assert.equal(await hint(app).count(), 0);
    });
  });

  test("hidden once the role is set, also with other roles set", async () => {
    await withApp({}, async (app) => {
      seedConfig(app.server.rpc, { modelRoles: { chat: "anthropic/claude-x", decision: "anthropic/claude-small" } });
      await openRoute(app.page, "#/settings/models");
      await app.page.getByRole("heading", { name: "Models & providers", level: 2 }).waitFor();
      await app.page.locator(".cfg-form").waitFor();
      assert.equal(await hint(app).count(), 0);
    });
  });

  test("German, dark, axe-clean", async () => {
    await withApp({ locale: "de-DE", colorScheme: "dark" }, async (app) => {
      seedConfig(app.server.rpc);
      await openRoute(app.page, "#/settings/models", "de");
      await hint(app).waitFor();
      assert.match(await hint(app).innerText(), /Kein Decision-Modell eingerichtet/);
      await expectAxeClean(app.page, "settings models with decision hint de dark");
    });
  });
});
