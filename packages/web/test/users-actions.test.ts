// Settings > Users & roles: what the person is told when a role change or a break-glass revoke is refused or fails.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { rpcError } from "./mock-rpc.ts";
import { seed } from "./users-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const USERS = [
  { id: "owner", displayName: "Olga Owner", role: "owner" },
  { id: "u-ben", displayName: "Ben Muster", role: "member" },
];
const seedUsers = (app: App): void => {
  seed(app.server.rpc);
  app.server.rpc.handle("user.list", () => ({ users: USERS }), { write: false });
};
const benRole = (app: App) => app.page.locator('[data-user="u-ben"] select');

describe("users: refused and failed actions", opts, () => {
  test("a role change the server refuses says so, not 'last owner', and the select goes back", async () => {
    await withApp({}, async (app) => {
      seedUsers(app);
      app.server.rpc.handle("user.role.set", () => { throw rpcError("E_DENIED", "not allowed for operator in tenant 7"); });
      await openRoute(app.page, "#/settings/users");
      await benRole(app).waitFor();
      await benRole(app).selectOption("admin");
      const note = app.page.getByRole("alert").filter({ hasText: /./ });
      await note.waitFor();
      const text = await note.innerText();
      assert.ok(!/last owner/i.test(text), text);
      assert.ok(!text.includes("tenant 7"), "server text shown");
      assert.match(text, /does not allow/);
      assert.equal(await benRole(app).inputValue(), "member");
    });
  });
  test("any other failure says nothing was changed and does not print the server text", async () => {
    await withApp({}, async (app) => {
      seedUsers(app);
      app.server.rpc.handle("user.role.set", () => { throw rpcError("E_INTERNAL", "ENOENT /var/lib/plur1bus/users.db"); });
      await openRoute(app.page, "#/settings/users");
      await benRole(app).selectOption("viewer");
      const note = app.page.getByRole("alert").filter({ hasText: /./ });
      await note.waitFor();
      const text = await note.innerText();
      assert.ok(!text.includes("ENOENT") && !/last owner/i.test(text), text);
      assert.match(text, /Nothing was changed/);
      assert.equal(await benRole(app).inputValue(), "member");
    });
  });
  test("the last-owner refusal keeps its own message", async () => {
    await withApp({}, async (app) => {
      seedUsers(app);
      app.server.rpc.handle("user.role.set", () => { throw rpcError("E_CONFLICT", "last owner", "last-owner"); });
      await openRoute(app.page, "#/settings/users");
      await benRole(app).selectOption("viewer");
      await app.page.getByText("The last owner cannot be demoted.").waitFor();
    });
  });
  test("a break-glass revoke that fails is reported and the window stays listed", async () => {
    await withApp({}, async (app) => {
      seedUsers(app);
      const now = Date.now();
      app.server.rpc.handle("breakglass.list", () => ({ grants: [{ id: "g1", holderUserId: "owner", targetUserId: "u-ben", reason: "Support case 4711", issuedAt: now, expiresAt: now + 600_000 }] }), { write: false });
      app.server.rpc.handle("breakglass.revoke", () => { throw rpcError("E_INTERNAL", "boom"); });
      await openRoute(app.page, "#/settings/users");
      const card = app.page.getByRole("group", { name: "Active break-glass windows" });
      await card.getByRole("button", { name: "Revoke" }).click();
      await card.getByText(/could not be revoked/).waitFor();
      assert.equal(await card.getByText("Target: u-ben").count(), 1);
    });
  });
});
