import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setup, teardown, withApp, openRoute, browserSkip } from "./harness.ts";
before(setup); after(teardown);
test("Join accepts an invite link, locks double submission, removes code and routes to login", { skip: browserSkip }, async () => {
  const code = randomBytes(32).toString("base64url"), password = randomBytes(24).toString("base64url");
  await withApp({ hash: `#/invite/${code}` }, async app => {
    let calls = 0; app.server.extensions.push(async (_req, res, path, body) => {
      if (path !== "/api/v1/invitations/redeem") return false;
      calls++; assert.equal(JSON.parse(body).code, code); await new Promise(r => setTimeout(r, 100));
      res.writeHead(201, { "content-type": "application/json" }); res.end(JSON.stringify({ schema: "invitation.redeem/1", created: true })); return true;
    });
    await app.page.getByLabel("Username", { exact: true }).fill("alice"); await app.page.getByLabel("Password (at least 12 characters)", { exact: true }).fill(password); await app.page.getByLabel("Repeat password", { exact: true }).fill(password);
    await app.page.getByRole("button", { name: "Create account" }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await app.page.getByRole("status").filter({ hasText: "Account created" }).waitFor(); assert.equal(calls, 1); assert.equal(app.page.url().includes(code), false);
    await app.page.getByRole("link", { name: "Sign in", exact: true }).click(); await app.page.getByLabel("Owner token", { exact: true }).waitFor(); assert.deepEqual(app.problems, []);
  });
});
test("Users status confirmation locks double clicks, updates disabled badge, and enables again", { skip: browserSkip }, async () => {
  await withApp({}, async app => {
    let disabled = false, writes = 0;
    app.server.rpc.handle("user.list", () => ({ users: [{ id: "owner", displayName: "Owner", role: "owner", disabled: false }, { id: "person-a", displayName: "Alice", role: "member", disabled }] }), { write: false });
    app.server.rpc.handle("user.disable", async () => { writes++; await new Promise(r => setTimeout(r, 100)); disabled = true; return { userId: "person-a", disabled }; });
    app.server.rpc.handle("user.enable", () => { writes++; disabled = false; return { userId: "person-a", disabled }; });
    await openRoute(app.page, "#/settings/users"); const row = app.page.locator('[data-user="person-a"]');
    await row.getByRole("button", { name: "Disable person" }).click(); const dialog = app.page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Disable person" }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await row.getByText("Disabled", { exact: true }).waitFor(); assert.equal(writes, 1);
    await row.getByRole("button", { name: "Enable person" }).click(); await app.page.getByRole("dialog").getByRole("button", { name: "Enable person" }).click(); await row.getByRole("button", { name: "Disable person" }).waitFor(); assert.equal(writes, 2); assert.deepEqual(app.problems, []);
  });
});

test("password login handles the existing TOTP challenge without storing credentials", { skip: browserSkip }, async () => {
  const password = randomBytes(24).toString("base64url"), challenge = randomBytes(24).toString("hex"), code = String(randomBytes(4).readUInt32BE() % 1_000_000).padStart(6, "0");
  await withApp({}, async app => {
    let attempts = 0;
    app.server.extensions.push((_req, res, path, raw) => {
      if (path !== "/api/v1/session" && path !== "/api/v1/session/totp") return false;
      const body = JSON.parse(raw);
      if (path === "/api/v1/session" && body.username !== "alice") return false;
      attempts++;
      if (path.endsWith("/totp")) { assert.deepEqual(body, { challenge, code }); const cookie = randomBytes(32).toString("hex"); app.server.sessions.set(cookie, { csrf: new Set() }); res.writeHead(200, { "content-type": "application/json", "set-cookie": `plur1bus_session=${cookie}; Path=/; HttpOnly; SameSite=Strict` }); res.end(JSON.stringify({ principal: { kind: "user", id: "alice", role: "member" } })); }
      else { assert.equal(body.password, password); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ mfa: "totp", challenge })); }
      return true;
    });
    await app.page.getByRole("button", { name: "Use username and password", exact: true }).click(); await app.page.getByLabel("Username", { exact: true }).fill("alice"); await app.page.getByLabel("Password", { exact: true }).fill(password); await app.page.getByRole("button", { name: "Sign in", exact: true }).click();
    await app.page.getByLabel("TOTP or backup code").fill(code); await app.page.getByRole("button", { name: "Sign in", exact: true }).click(); await app.page.locator(".sidebar").waitFor(); assert.equal(attempts, 2);
    const storage = await app.page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, href: location.href })); for (const marker of [password, challenge, code]) assert.equal(storage.includes(marker), false);
  });
});
