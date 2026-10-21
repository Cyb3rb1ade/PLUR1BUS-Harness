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
  // The matrix is only drawn once the person's rights are loaded; wait for that state (Anna holds Manage on research) before a test acts on it.
  await app.page.waitForFunction(() => (document.querySelector('[aria-label="Manage right on agent research"]') as HTMLInputElement | null)?.checked === true);
}
/** Records the checked state of every matrix checkbox in a mutation callback (a microtask right after each draw), so a draw that
 *  shows a right as not held, even for one frame, is seen. Installed before the page loads; `switchPerson` starts a new window. */
async function watchMatrix(app: App): Promise<void> {
  await app.context.addInitScript(() => {
    const seen: Record<string, boolean[]> = {};
    (window as unknown as { __seen: typeof seen }).__seen = seen;
    const look = (): void => {
      for (const box of Array.from(document.querySelectorAll<HTMLInputElement>('.users-matrix input[type="checkbox"]'))) {
        const log = (seen[box.getAttribute("aria-label") ?? ""] ??= []);
        if (log[log.length - 1] !== box.checked) log.push(box.checked);
      }
    };
    // `checked` is a property, so a change of it raises no mutation: every frame is sampled as well as every DOM change.
    new MutationObserver(look).observe(document, { childList: true, subtree: true });
    const frame = (): void => { look(); requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  });
  await app.page.goto(app.baseUrl + "/");
}
const seen = (app: App, label: string): Promise<boolean[]> => app.page.evaluate((l) => (window as unknown as { __seen: Record<string, boolean[]> }).__seen[l] ?? [], label);
/** Picks the person and starts a new log in the same task, so no frame samples the old person's matrix into the new window. */
const switchPerson = (app: App, id: string): Promise<void> => app.page.evaluate((v) => {
  const w = window as unknown as { __seen: Record<string, unknown> };
  for (const k of Object.keys(w.__seen)) delete w.__seen[k];
  const select = document.getElementById("users-rights-person") as HTMLSelectElement;
  select.value = v; select.dispatchEvent(new Event("change", { bubbles: true }));
}, id);
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
  test("the matrix is drawn only with what the person holds: never as an empty matrix first, not even for one draw", async () => {
    await withApp({}, async (app) => {
      await watchMatrix(app);
      await open(app);
      const research = app.page.getByRole("checkbox", { name: "Manage right on agent research" });
      await research.waitFor();
      await app.page.waitForFunction(() => (document.querySelector('[aria-label="Use right on agent main"]') as HTMLInputElement | null)?.checked === true);
      assert.deepEqual(await seen(app, "Use right on agent main"), [true]);
      assert.deepEqual(await seen(app, "Manage right on agent research"), [true]);
      assert.deepEqual(await seen(app, "Use right on agent ops"), [false]);
    });
  });
  test("switching the person never draws the previous person's rights for the new one", async () => {
    await withApp({}, async (app) => {
      await watchMatrix(app);
      await open(app);
      await app.page.getByRole("checkbox", { name: "Manage right on agent research" }).waitFor();
      await switchPerson(app, "u-olaf");
      const research = app.page.getByRole("checkbox", { name: "Use right on agent research" });
      await research.waitFor();
      assert.equal(await app.page.getByRole("columnheader", { name: "Manage" }).count(), 0);
      assert.equal(await research.isChecked(), false);
      assert.deepEqual(await seen(app, "Use right on agent research"), [false]);
      assert.deepEqual(await seen(app, "Use right on agent main"), [true]);
      assert.deepEqual(sets(app), []);
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
