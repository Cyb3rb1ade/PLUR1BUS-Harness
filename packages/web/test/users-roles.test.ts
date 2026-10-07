// Role visibility of Settings > Users & roles: only Owner and Admin see the section (docs/rbac.md `users.read`); every other
// role gets the forbidden state and the page does not ask the backend for the list.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp } from "./harness.ts";
import { seed } from "./users-fixtures.ts";

before(setup);
after(teardown);

describe("users: role visibility", { skip: browserSkip }, () => {
  for (const [role, label] of [["owner", "Owner"], ["admin", "Admin"]] as const) {
    test(`${label} sees the list, presets and invite`, async () => {
      await withApp({ server: { role } }, async (app) => {
        seed(app.server.rpc);
        await openRoute(app.page, "#/settings/users");
        const items = app.page.getByRole("list", { name: "People with access" }).getByRole("listitem");
        await items.nth(3).waitFor();
        assert.match((await items.first().textContent()) ?? "", new RegExp(`${role} \\(you\\).*${label}`));
        await app.page.getByRole("button", { name: "Invite person" }).waitFor();
        await app.page.getByRole("group", { name: "Role preset" }).waitFor();
        assert.ok(app.server.rpc.calls.some((c) => c.method === "identity.list"));
      });
    });
  }
  for (const [role, label] of [["operator", "Operator"], ["member", "Member"], ["viewer", "Viewer"]] as const) {
    test(`${label} gets the forbidden state and no request`, async () => {
      await withApp({ server: { role } }, async (app) => {
        seed(app.server.rpc);
        await openRoute(app.page, "#/settings/users");
        const state = app.page.locator(".page-state[data-state=forbidden]");
        await state.getByRole("heading", { name: "Only Owner and Admin manage users" }).waitFor();
        assert.match((await state.textContent()) ?? "", new RegExp(`Your role is ${label}`));
        assert.equal(await app.page.getByRole("button", { name: "Invite person" }).count(), 0);
        assert.equal(await app.page.getByRole("list", { name: "People with access" }).count(), 0);
        // The shell itself may list sessions; the section must not ask for people or agents.
        assert.deepEqual(app.server.rpc.calls.map((c) => c.method).filter((m) => m !== "session.list"), []);
      });
    });
  }
});
