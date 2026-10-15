// b20 audit: Agents lifecycle state after a delete.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { installAgents, world } from "./agents-fixtures.ts";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

describe("agents: after a delete", opts, () => {
  test("the deleted agent leaves the list and the detail, the person lands on the list and is told", async () => {
    await withApp({}, async (app) => {
      installAgents(app.server, world());
      await openRoute(app.page, "#/agents/scribe");
      await app.page.getByRole("heading", { name: "Scribe", level: 2 }).waitFor();
      await app.page.getByRole("button", { name: "Delete" }).click();
      const dlg = app.page.getByRole("dialog", { name: "Delete Scribe?" });
      await dlg.getByLabel("Type Scribe to confirm").fill("Scribe");
      await dlg.getByRole("button", { name: "Delete agent" }).click();
      await app.page.getByText("Agent Scribe was deleted.").waitFor();
      await app.page.locator("dialog[open]").waitFor({ state: "detached" });
      assert.equal(await app.page.locator("a.a-row", { hasText: "Scribe" }).count(), 0, "the deleted agent is still listed");
      assert.equal(await app.page.evaluate(() => location.hash), "#/agents", "the detail of a deleted agent is still open");
      assert.equal(await app.page.locator("a.a-row", { hasText: "Main" }).count(), 1);
      assert.deepEqual(app.problems, []);
    });
  });
});
