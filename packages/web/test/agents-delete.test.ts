// Agents lifecycle: pause/resume, archive/unarchive, export and delete wired to RPC backends.
// Error handling for engine erasure limitations and role enforcement tested against mock RPC.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { installAgents, world } from "./agents-fixtures.ts";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";
import { rpcError } from "./mock-rpc.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

describe("agents lifecycle", opts, () => {
  test("pause, resume, archive, unarchive and export call the lifecycle RPCs", async () => {
    await withApp({}, async (app) => {
      installAgents(app.server);
      await openRoute(app.page, "#/agents/main");
      const d = app.page.getByRole("region", { name: "Agent details" });

      // 1. Pause
      const pauseBtn = d.getByRole("button", { name: "Pause" });
      await pauseBtn.waitFor();
      await pauseBtn.click();
      await app.page.getByText("Agent Main was paused.").waitFor();
      assert.ok(app.server.rpc.calls.some((c) => c.method === "agent.pause" && (c.params as any).agentId === "main"));

      // 2. Resume
      const resumeBtn = d.getByRole("button", { name: "Resume" });
      await resumeBtn.waitFor();
      await resumeBtn.click();
      await app.page.getByText("Agent Main was resumed.").waitFor();
      assert.ok(app.server.rpc.calls.some((c) => c.method === "agent.resume" && (c.params as any).agentId === "main"));

      // 3. Archive
      const archiveBtn = d.getByRole("button", { name: "Archive" });
      await archiveBtn.waitFor();
      await archiveBtn.click();
      await app.page.getByText("Agent Main was archived.").waitFor();
      assert.ok(app.server.rpc.calls.some((c) => c.method === "agent.archive" && (c.params as any).agentId === "main"));

      // 4. Unarchive
      const unarchiveBtn = d.getByRole("button", { name: "Unarchive" });
      await unarchiveBtn.waitFor();
      await unarchiveBtn.click();
      await app.page.getByText("Agent Main was unarchived.").waitFor();
      assert.ok(app.server.rpc.calls.some((c) => c.method === "agent.unarchive" && (c.params as any).agentId === "main"));

      // 5. Export bundle
      const exportBtn = d.getByRole("button", { name: "Export bundle" });
      await exportBtn.waitFor();
      await exportBtn.click();
      await app.page.getByText("Export bundle downloaded.").waitFor();
      assert.ok(app.server.rpc.calls.some((c) => c.method === "agent.export" && (c.params as any).agentId === "main"));
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

  test("archived agent: delete opens a confirmation with export offer, typed name, engine erasure notice, and successful delete", async () => {
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
      assert.equal(await exp.getAttribute("aria-disabled"), null);

      assert.equal(await app.page.evaluate(() => document.activeElement?.closest("dialog") !== null), true, "focus is inside the dialog");
      const go = dlg.getByRole("button", { name: "Delete agent" });
      assert.equal(await go.isDisabled(), true, "disabled until the name is typed");
      await dlg.getByLabel("Type Scribe to confirm").fill("scribe");
      assert.equal(await go.isDisabled(), true, "the match is exact");
      await expectAxeClean(app.page, "delete dialog");
      await dlg.getByLabel("Type Scribe to confirm").fill("Scribe");
      assert.equal(await go.isDisabled(), false);

      // Simulate engine-erasure error
      app.server.rpc.handle("agent.delete", () => {
        throw rpcError("E_ENGINE_ERASURE_UNAVAILABLE", "engine erasure unavailable", "engine-erasure-unavailable");
      });
      await go.click();
      await dlg.getByText("Engine erasure is unavailable on this harness.").waitFor();

      // Now simulate successful delete
      app.server.rpc.handle("agent.delete", (p) => {
        const id = (p as any).agentId;
        return { agentId: id, deleted: true };
      });
      await go.click();
      await app.page.getByText("Agent Scribe was deleted.").waitFor();
      assert.ok(app.server.rpc.calls.some((c) => c.method === "agent.delete" && (c.params as any).agentId === "scribe"));
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
