// Models page: which role sees which control. The matrix is docs/rbac.md (`models.read`: owner, admin, operator, viewer;
// `models.write`: owner, admin) and the server guard (packages/core/src/rbac/guard.ts), which wraps models.setOverride and
// models.removeManual only. models.list, models.scan and models.acknowledge have no policy action yet ("not yet secured"), so
// the page does not take a right away for them: a role that may read the catalogue keeps Refresh, Scan and "Mark as seen",
// and when the server does refuse one of them the page says so. The pattern for a control a role may not use is the one of the
// Agents and Approvals pages: the control is not offered (or is aria-disabled) and a note says why.
// The mock signs in as `server.role`; a role this UI does not know is allowed to try (roleIn in pages/common/load.ts).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Locator, Page } from "playwright";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { installCatalog, rpcError } from "./models-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const open = (app: App, hash = "#/models"): Promise<void> => openRoute(app.page, hash);
const link = (page: Page, name: string | RegExp) => page.getByRole("link", { name });
const detailOf = (page: Page) => page.getByRole("region", { name: "Model details" });
const calls = (app: App, method: string) => app.server.rpc.calls.filter((c) => c.method === method);
const hrefOf = (provider: string, id: string): string => `#/models/${encodeURIComponent(provider)}/${encodeURIComponent(id)}`;

/** The control is not there, or is there but disabled (`disabled` or `aria-disabled`). */
async function blocked(l: Locator): Promise<boolean> {
  if (await l.count() === 0) return true;
  return (await l.first().isDisabled()) || (await l.first().getAttribute("aria-disabled")) === "true";
}
async function usable(l: Locator): Promise<boolean> { return (await l.count()) === 1 && !(await blocked(l)); }

const NOTE = "You are not allowed to change the catalog.";

describe("models: roles that may change the catalog (owner, admin)", opts, () => {
  for (const role of ["owner", "admin"]) {
    test(`${role}: add, edit and remove are offered next to refresh, scan and 'mark as seen'`, async () => {
      await withApp({ server: { role } }, async (app) => {
        installCatalog(app.server.rpc); await open(app, hrefOf("beta", "beta-2"));
        await detailOf(app.page).getByRole("heading", { name: "Beta Manual", level: 2 }).waitFor();
        for (const name of ["Add manual model", "Refresh", "Scan providers", "Mark 2 new as seen"]) assert.ok(await usable(app.page.getByRole("button", { name })), `${role}: ${name}`);
        assert.ok(await usable(app.page.getByRole("button", { name: "Edit overrides" })));
        assert.ok(await usable(app.page.getByRole("button", { name: "Remove manual model" })));
        assert.equal(await app.page.getByText(NOTE).count(), 0, "no read-only note for a role that may write");
      });
    });
  }
});

describe("models: roles that may read but not change the catalog (operator, viewer)", opts, () => {
  for (const role of ["operator", "viewer"]) {
    test(`${role}: the catalog is shown; add, edit and remove are blocked and a note says why`, async () => {
      await withApp({ server: { role } }, async (app) => {
        installCatalog(app.server.rpc); await open(app);
        await link(app.page, /Gamma One/).waitFor();
        assert.ok(await blocked(app.page.getByRole("button", { name: "Add manual model" })), `${role}: Add manual model`);
        await app.page.getByText(NOTE).waitFor();

        await link(app.page, /Beta Manual/).click();
        await detailOf(app.page).getByRole("heading", { name: "Beta Manual", level: 2 }).waitFor();
        assert.ok(await blocked(app.page.getByRole("button", { name: "Edit overrides" })), `${role}: Edit overrides`);
        assert.ok(await blocked(app.page.getByRole("button", { name: "Remove manual model" })), `${role}: Remove manual model`);
        await link(app.page, /Alpha Two/).click();
        await detailOf(app.page).getByRole("heading", { name: "Alpha Two", level: 2 }).waitFor();
        assert.ok(await blocked(app.page.getByRole("button", { name: "Edit overrides" })), `${role}: Edit overrides on a scanned model`);

        // reading stays whole: the detail is complete and the read-side controls work
        assert.ok(await app.page.locator(".ld-detail dl.facts").count() === 1);
        assert.ok(await usable(app.page.getByRole("button", { name: "Refresh" })));
        assert.equal(calls(app, "models.setOverride").length + calls(app, "models.removeManual").length, 0, "no write is ever sent");
      });
    });

    test(`${role}: scan and 'mark as seen' stay available (the server has no policy for them yet) and a refusal is explained`, async () => {
      await withApp({ server: { role } }, async (app) => {
        installCatalog(app.server.rpc); await open(app);
        await link(app.page, /Gamma One/).waitFor();
        const ack = app.page.getByRole("button", { name: "Mark 2 new as seen" });
        const scan = app.page.getByRole("button", { name: "Scan providers" });
        assert.ok(await usable(ack)); assert.ok(await usable(scan));

        app.server.rpc.handle("models.scan", () => { throw rpcError("E_DENIED", "no", "no-permission"); });
        await scan.click();
        await app.page.getByRole("alert").getByText("You are not allowed to scan providers.").waitFor();
        assert.equal(await app.page.locator("[data-scan-result]").count(), 0);

        // the server refuses the acknowledgement: nothing is cleared on screen and the person is told
        app.server.rpc.handle("models.acknowledge", () => { throw rpcError("E_DENIED", "no", "no-permission"); });
        await ack.click();
        await app.page.getByRole("alert").getByText(NOTE).waitFor();
        assert.equal(await app.page.getByRole("button", { name: "Mark 2 new as seen" }).count(), 1, "the 'new' markers are still there");
        assert.equal(await app.page.locator(".model-list .badge", { hasText: /^new$/ }).count(), 2);
        assert.equal(calls(app, "models.acknowledge").length, 1);
      });
    });
  }

  test("viewer: a refused acknowledgement for another reason is reported too, and a later success clears the message", async () => {
    await withApp({ server: { role: "viewer" } }, async (app) => {
      const c = installCatalog(app.server.rpc); await open(app);
      await link(app.page, /Gamma One/).waitFor();
      app.server.rpc.handle("models.acknowledge", () => { throw rpcError("E_INTERNAL", "boom"); });
      await app.page.getByRole("button", { name: "Mark 2 new as seen" }).click();
      await app.page.getByRole("alert").getByText("The change could not be saved. Try again.").waitFor();
      app.server.rpc.handle("models.acknowledge", () => { c.newIds.clear(); return { acknowledgedAt: "2026-10-07T08:00:00Z" }; });
      await app.page.getByRole("button", { name: "Mark 2 new as seen" }).click();
      await app.page.getByRole("button", { name: /as seen/ }).waitFor({ state: "detached" });
      assert.equal(await app.page.getByText("The change could not be saved. Try again.").count(), 0);
    });
  });

  test("axe: the read-only view of the list and of a manual model's detail", async () => {
    await withApp({ server: { role: "viewer" }, width: 1440, height: 900 }, async (app) => {
      installCatalog(app.server.rpc); await open(app);
      await link(app.page, /Gamma One/).waitFor();
      await expectAxeClean(app.page, "viewer list");
      await link(app.page, /Beta Manual/).click();
      await detailOf(app.page).getByRole("heading", { name: "Beta Manual", level: 2 }).waitFor();
      await expectAxeClean(app.page, "viewer detail");
    });
    await withApp({ server: { role: "viewer" }, colorScheme: "dark", width: 400, height: 900 }, async (app) => {
      installCatalog(app.server.rpc); await open(app);
      await link(app.page, /Gamma One/).waitFor();
      await expectAxeClean(app.page, "viewer list, compact dark");
    });
  });
});

describe("models: a role without models.read", opts, () => {
  test("member: the forbidden state, no models call at all and nothing to act on", async () => {
    await withApp({ server: { role: "member" } }, async (app) => {
      installCatalog(app.server.rpc); app.server.events.enable(); await open(app);
      await app.page.locator(".page-state[data-state=forbidden]").waitFor();
      await app.page.getByRole("heading", { name: "Models", level: 1 }).waitFor();
      assert.equal(app.server.rpc.calls.filter((c) => c.method.startsWith("models.")).length, 0);
      for (const name of ["Add manual model", "Scan providers", "Refresh"]) assert.equal(await app.page.getByRole("button", { name }).count(), 0, name);
      assert.equal(await app.page.locator(".model-list").count(), 0);
      await expectAxeClean(app.page, "member forbidden");
    });
  });

  test("member: a direct link to a model is forbidden as well", async () => {
    await withApp({ server: { role: "member" } }, async (app) => {
      installCatalog(app.server.rpc); await open(app, hrefOf("alpha", "alpha-2"));
      await app.page.locator(".page-state[data-state=forbidden]").waitFor();
      assert.equal(await detailOf(app.page).count(), 0);
      assert.equal(app.server.rpc.calls.filter((c) => c.method.startsWith("models.")).length, 0);
    });
  });
});

describe("models: a role this UI does not know", opts, () => {
  test("is allowed to try: every control is offered and the server decides", async () => {
    await withApp({ server: { role: "auditor" } }, async (app) => {
      installCatalog(app.server.rpc); await open(app, hrefOf("beta", "beta-2"));
      await detailOf(app.page).getByRole("heading", { name: "Beta Manual", level: 2 }).waitFor();
      for (const name of ["Add manual model", "Edit overrides", "Remove manual model", "Scan providers"]) assert.ok(await usable(app.page.getByRole("button", { name })), name);
      assert.equal(await app.page.getByText(NOTE).count(), 0);
      app.server.rpc.handle("models.setOverride", () => { throw rpcError("E_DENIED", "no", "no-permission"); });
      await app.page.getByRole("button", { name: "Edit overrides" }).click();
      await app.page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
      await app.page.getByRole("dialog").getByRole("alert").getByText(NOTE).waitFor();
    });
  });
});

describe("models: the read-only note in German", opts, () => {
  test("viewer in German sees the German note and no English one", async () => {
    await withApp({ server: { role: "viewer" }, locale: "de-DE" }, async (app) => {
      installCatalog(app.server.rpc); await openRoute(app.page, "#/models", "de");
      await link(app.page, /Gamma One/).waitFor();
      await app.page.getByText("Du darfst den Katalog nicht ändern.").waitFor();
      assert.equal(await app.page.getByText(NOTE).count(), 0);
    });
  });
});
