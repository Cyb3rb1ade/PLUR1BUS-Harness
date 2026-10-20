// Settings > Users & roles > Rights per agent: the panel edits the rights of one person, loads what they hold (agent.rights.get) and
// sends only what changed to agent.rights.set, with the person's id and null for a right taken away.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { seed } from "./users-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const USERS = [
  { id: "local-owner", displayName: "Owner", role: "owner" },
  { id: "u-anna", displayName: "Anna", role: "member" },
  { id: "u-olaf", displayName: "Olaf", role: "operator" },
];
const HELD: Record<string, { userId: string; right: "use" | "manage" }[]> = {
  main: [{ userId: "u-anna", right: "use" }, { userId: "u-olaf", right: "use" }],
  research: [{ userId: "u-anna", right: "manage" }],
  ops: [],
};

async function open(app: App): Promise<void> {
  const { rpc } = app.server;
  seed(rpc);
  rpc.handle("user.list", () => ({ users: USERS }), { write: false });
  rpc.handle("agent.rights.get", (p) => { const agentId = (p as { agentId: string }).agentId; return { agentId, rights: HELD[agentId] ?? [] }; }, { write: false });
  rpc.handle("agent.rights.set", (p) => ({ ...(p as object) }));
  await openRoute(app.page, "#/settings/users");
  await app.page.getByRole("heading", { name: "Users & roles", level: 2 }).waitFor();
  await app.page.getByRole("checkbox", { name: "Simple mode" }).uncheck();
  await app.page.getByRole("checkbox", { name: "Use right on agent research" }).waitFor();
}
const sets = (app: App): unknown[] => app.server.rpc.calls.filter((c) => c.method === "agent.rights.set").map((c) => c.params);

describe("users: rights of one person", opts, () => {
  test("the panel shows what the person holds now; owners and admins are not listed", async () => {
    await withApp({}, async (app) => {
      await open(app);
      assert.deepEqual(await app.page.getByLabel("Rights for person").locator("option").allTextContents(), ["Anna", "Olaf"]);
      assert.equal(await app.page.getByRole("checkbox", { name: "Use right on agent main" }).isChecked(), true);
      assert.equal(await app.page.getByRole("checkbox", { name: "Manage right on agent research" }).isChecked(), true);
      assert.equal(await app.page.getByRole("checkbox", { name: "Use right on agent ops" }).isChecked(), false);
    });
  });
  test("the matrix is first drawn with what the person holds, never empty and then filled in", async () => {
    await withApp({}, async (app) => {
      // A click in an empty frame would be overwritten when the loaded rights arrive (an unchecked box that is then ticked by the load).
      await app.page.evaluate(() => {
        const frames: boolean[] = [];
        (window as unknown as { __mainFrames: boolean[] }).__mainFrames = frames;
        new MutationObserver(() => {
          const box = document.querySelector<HTMLInputElement>('input[aria-label="Use right on agent main"]');
          if (box && frames.length === 0) frames.push(box.checked);
        }).observe(document.body, { subtree: true, childList: true, attributes: true });
      });
      await open(app);
      assert.deepEqual(await app.page.evaluate(() => (window as unknown as { __mainFrames: boolean[] }).__mainFrames), [true]);
    });
  });
  test("saving sends the person's id, only the changes, and null for a right taken away", async () => {
    await withApp({}, async (app) => {
      await open(app);
      await app.page.getByRole("checkbox", { name: "Use right on agent main" }).uncheck();
      await app.page.getByRole("checkbox", { name: "Use right on agent ops" }).check();
      await app.page.getByRole("button", { name: "Save rights" }).click();
      await app.page.getByRole("status").filter({ hasText: "Rights saved." }).waitFor();
      assert.deepEqual(sets(app), [{ agentId: "main", userId: "u-anna", right: null }, { agentId: "ops", userId: "u-anna", right: "use" }]);
    });
  });
  test("an operator cannot hold Manage; switching the person loads that person's rights", async () => {
    await withApp({}, async (app) => {
      await open(app);
      await app.page.getByLabel("Rights for person").selectOption("u-olaf");
      await app.page.getByRole("checkbox", { name: "Use right on agent main" }).waitFor();
      assert.equal(await app.page.getByRole("columnheader", { name: "Manage" }).count(), 0);
      const research = app.page.getByRole("checkbox", { name: "Use right on agent research" });
      for (let i = 0; i < 50 && await research.isChecked(); i++) await new Promise((r) => setTimeout(r, 100)); // the previous person's matrix is replaced when the new rights arrive
      assert.equal(await research.isChecked(), false);
      assert.deepEqual(sets(app), []);
    });
  });
  test("a failed save says so", async () => {
    await withApp({}, async (app) => {
      await open(app);
      app.server.rpc.scenario("agent.rights.set", "error");
      await app.page.getByRole("checkbox", { name: "Use right on agent ops" }).check();
      await app.page.getByRole("button", { name: "Save rights" }).click();
      await app.page.getByRole("alert").filter({ hasText: "could not be saved" }).waitFor();
    });
  });
  test("a failing rights load offers Try again and shows no matrix", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc);
      app.server.rpc.handle("user.list", () => ({ users: USERS }), { write: false });
      app.server.rpc.handle("agent.rights.get", () => HELD, { write: false });
      app.server.rpc.scenario("agent.rights.get", "error");
      await openRoute(app.page, "#/settings/users");
      await app.page.getByRole("checkbox", { name: "Simple mode" }).uncheck();
      await app.page.locator("#users-rights-h").waitFor();
      await app.page.locator(".users-block").filter({ has: app.page.locator("#users-rights-h") }).getByRole("button", { name: "Try again" }).waitFor();
      assert.equal(await app.page.getByRole("button", { name: "Save rights" }).count(), 0);
    });
  });
});
