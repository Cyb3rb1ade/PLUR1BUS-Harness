// Agents lifecycle (K3): pause/archive/export are unavailable with a reason; the delete flow (archive first, export offer, typed
// name) is built but sends nothing. Verified against the RPC call log.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { installAgents, world } from "./agents-fixtures.ts";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

describe("agents lifecycle", opts, () => {
  test("pause, archive and export are aria-disabled with a visible reason; clicking sends nothing", async () => {
    await withApp({}, async (app) => {
      installAgents(app.server);
      await openRoute(app.page, "#/agents/main");
      const d = app.page.getByRole("region", { name: "Agent details" });
      await d.getByRole("button", { name: "Pause" }).waitFor();
      const before = app.server.rpc.calls.length;
      for (const [name, reason] of [["Pause", /cannot pause|no way to pause/], ["Archive", /no way to archive/], ["Export bundle", /without secrets/]] as const) {
        const b = d.getByRole("button", { name });
        await b.waitFor();
        assert.equal(await b.getAttribute("aria-disabled"), "true");
        const desc = await b.evaluate((e) => document.getElementById(e.getAttribute("aria-describedby") ?? "")?.textContent ?? "");
        assert.match(desc, reason);
        await b.click({ force: true });
      }
      assert.equal(app.server.rpc.calls.length, before, "no RPC for lifecycle clicks");
    });
  });
  test("delete is not offered for an active agent: archive first", async () => {
    await withApp({}, async (app) => {
      installAgents(app.server);
      await openRoute(app.page, "#/agents/main");
      const del = app.page.getByRole("button", { name: "Delete" });
      assert.equal(await del.getAttribute("aria-disabled"), "true");
      await app.page.getByText("Archive the agent first.").waitFor();
      await del.click({ force: true });
      assert.equal(await app.page.getByRole("dialog").count(), 0);
    });
  });
  test("archived agent: delete opens a confirmation with export offer, typed name, and confirming sends nothing", async () => {
    await withApp({}, async (app) => {
      installAgents(app.server, world());
      await openRoute(app.page, "#/agents/scribe");
      await app.page.getByRole("heading", { name: "Scribe", level: 2 }).waitFor();
      const del = app.page.getByRole("button", { name: "Delete" });
      assert.equal(await del.getAttribute("aria-disabled"), null);
      await del.click();
      const dlg = app.page.getByRole("dialog", { name: "Delete Scribe?" });
      await dlg.waitFor();
      assert.match((await dlg.textContent()) ?? "", /Export a bundle first.*without secrets/);
      const exp = dlg.getByRole("button", { name: "Export bundle" });
      assert.equal(await exp.getAttribute("aria-disabled"), "true");
      assert.equal(await app.page.evaluate(() => document.activeElement?.closest("dialog") !== null), true, "focus is inside the dialog");
      const go = dlg.getByRole("button", { name: "Delete agent" });
      assert.equal(await go.isDisabled(), true, "disabled until the name is typed");
      await dlg.getByLabel("Type Scribe to confirm").fill("scribe");
      assert.equal(await go.isDisabled(), true, "the match is exact");
      await expectAxeClean(app.page, "delete dialog");
      await dlg.getByLabel("Type Scribe to confirm").fill("Scribe");
      const calls = app.server.rpc.calls.length;
      await go.click();
      await dlg.getByText("Deleting an agent is not available on this harness yet. Nothing was deleted.").waitFor();
      assert.equal(app.server.rpc.calls.length, calls, "nothing was sent");
      assert.equal(app.server.rpc.calls.filter((c) => c.method !== "config.get" && c.method !== "ext.list").length, 0);
      await app.page.keyboard.press("Escape");
      await app.page.getByRole("heading", { name: "Scribe", level: 2 }).waitFor();
      assert.equal(await app.page.getByRole("dialog").count(), 0);
    });
  });
  test("an operator sees every lifecycle action blocked by the role, even for an archived agent", async () => {
    await withApp({ server: { role: "viewer" } }, async (app) => {
      installAgents(app.server);
      await openRoute(app.page, "#/agents/scribe");
      await app.page.getByRole("heading", { name: "Scribe", level: 2 }).waitFor();
      assert.equal(await app.page.getByRole("button", { name: "Delete" }).getAttribute("aria-disabled"), "true");
      assert.equal(await app.page.getByText("Only owners and admins can do this.").count(), 4);
    });
  });
});
