// Settings > Users & roles > Identities (#387): the former `/identities` route is a tab; deep links land on it, the route's
// RBAC (everyone reads, a Viewer cannot write) is unchanged, and People stays Owner/Admin only.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { movedTo } from "../src/router.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { seed } from "./users-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const LINKS = { humanId: "owner", links: [{ id: "link1", channel: "telegram", accountId: "bot", userId: "42" }], pairings: [{ id: "pair1", channel: "matrix", state: "claimed", expiresAt: 1000 }] };
function play(app: App): void {
  seed(app.server.rpc);
  app.server.rpc.handle("identity.link.list", () => LINKS, { write: false });
  app.server.rpc.handle("identity.link.request", () => ({ id: "p9", code: "ABCDEFGH", expiresAt: 1000 }));
  app.server.rpc.handle("identity.link.approve", () => ({}));
  app.server.rpc.handle("identity.principals", () => ({ principals: ["owner", "42@telegram"] }), { write: false });
}
const hash = (app: App) => app.page.evaluate(() => location.hash);
const identitiesTab = (app: App) => app.page.getByRole("tab", { name: "Identities" });

describe("moved routes (no browser)", () => {
  test("/identities and anything below it go to the Identities tab; other routes stay", () => {
    assert.equal(movedTo("/identities"), "/settings/users?tab=identities");
    assert.equal(movedTo("/identities/anything"), "/settings/users?tab=identities");
    for (const p of ["/", "/chat", "/settings/users", "/identitiesx", "/agents/identities"]) assert.equal(movedTo(p), null, p);
  });
});

describe("users: identities tab", opts, () => {
  test("a deep link to #/identities lands on the tab and rewrites the address", async () => {
    await withApp({}, async (app) => {
      play(app);
      await openRoute(app.page, "#/identities");
      await app.page.getByRole("heading", { name: "My identities", level: 2 }).waitFor();
      assert.equal(await identitiesTab(app).getAttribute("aria-selected"), "true");
      assert.equal(await hash(app), "#/settings/users?tab=identities");
      await app.page.getByText("telegram · bot · 42").waitFor();
    });
  });
  test("the old route also redirects while the app is running, and Back does not trap the person", async () => {
    await withApp({}, async (app) => {
      play(app);
      await openRoute(app.page, "#/settings/users");
      await app.page.evaluate(() => { location.hash = "#/identities"; });
      await identitiesTab(app).waitFor();
      await app.page.getByRole("heading", { name: "My identities", level: 2 }).waitFor();
      assert.equal(await hash(app), "#/settings/users?tab=identities");
    });
  });
  test("switching tabs keeps the section and changes the address; keyboard works", async () => {
    await withApp({}, async (app) => {
      play(app);
      await openRoute(app.page, "#/settings/users");
      const people = app.page.getByRole("tab", { name: "People" });
      await people.waitFor();
      assert.equal(await people.getAttribute("aria-selected"), "true");
      await people.focus();
      await app.page.keyboard.press("ArrowRight");
      await app.page.getByText("telegram · bot · 42").waitFor();
      assert.equal(await hash(app), "#/settings/users?tab=identities");
      await app.page.keyboard.press("ArrowLeft");
      await app.page.getByRole("list", { name: "People with access" }).waitFor();
      assert.equal(await hash(app), "#/settings/users");
    });
  });
  test("the settings navigation link for identities opens the tab", async () => {
    await withApp({}, async (app) => {
      play(app);
      await openRoute(app.page, "#/settings/general");
      await app.page.getByRole("link", { name: "My identities" }).click();
      await app.page.getByText("telegram · bot · 42").waitFor();
      assert.equal(await hash(app), "#/settings/users?tab=identities");
    });
  });
  test("an Owner issues a code (shown once), approves a claimed pairing and lists principals; unlinking asks first", async () => {
    await withApp({}, async (app) => {
      play(app);
      await openRoute(app.page, "#/settings/users?tab=identities");
      await app.page.getByLabel("Channel", { exact: true }).fill("telegram");
      await app.page.getByRole("button", { name: "Issue pairing code" }).click();
      await app.page.getByText("One-time code: ABCDEFGH", { exact: false }).waitFor();
      assert.deepEqual(app.server.rpc.calls.find(c => c.method === "identity.link.request")!.params, { channel: "telegram" });
      await app.page.getByRole("button", { name: "Approve link" }).click();
      await app.page.getByRole("button", { name: "My principal union" }).click();
      await app.page.locator("pre", { hasText: "42@telegram" }).waitFor();
      await app.page.getByRole("button", { name: "Remove" }).first().click();
      await app.page.getByRole("dialog").waitFor();
      assert.equal(app.server.rpc.calls.filter((c) => c.method === "identity.link.remove").length, 0, "nothing removed before the confirmation");
      await app.page.getByRole("button", { name: "Cancel" }).click();
      const methods = app.server.rpc.calls.map((c) => c.method);
      assert.ok(methods.includes("identity.link.request") && methods.includes("identity.link.approve") && methods.includes("identity.principals"));
    });
  });
  test("a Viewer reads the identities but cannot write, and People stays forbidden", async () => {
    await withApp({ server: { role: "viewer" } }, async (app) => {
      play(app);
      await openRoute(app.page, "#/settings/users?tab=identities");
      await app.page.getByText("telegram · bot · 42").waitFor();
      for (const name of ["Issue pairing code", "Approve link", "Remove"]) assert.equal(await app.page.getByRole("button", { name }).count(), 0, name);
      await app.page.getByRole("tab", { name: "People" }).click();
      await app.page.locator('[data-state="forbidden"]').waitFor();
    });
  });
  test("the tab list is German in German", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      play(app);
      await openRoute(app.page, "#/identities", "de");
      await app.page.getByRole("tab", { name: "Identitäten" }).waitFor();
      await app.page.getByRole("tab", { name: "Personen" }).waitFor();
    });
  });
  test("the tab has no axe violations at 400 px", async () => {
    const { expectAxeClean } = await import("./axe.ts");
    await withApp({ width: 400, height: 900 }, async (app) => {
      play(app);
      await openRoute(app.page, "#/settings/users?tab=identities");
      await app.page.getByText("telegram · bot · 42").waitFor();
      await expectAxeClean(app.page, "identities tab 400");
      assert.equal(await app.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    });
  });
});
