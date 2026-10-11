// Settings > Users & roles: invitation links (#386). Validity choice, the link shown once and copied, the open-invitations list and its
// revoke confirmation. The rpc mock plays user.invite.*; the link it returns is a made-up path, never a token-shaped value.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { seed } from "./users-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

type Invite = { id: string; userId: string; role: string; channel: string; expiresAt: number; state: string; shareable: boolean; createdAt: number };
const LINK_PATH = "/#/invite/not-a-real-value";

async function open(app: App, invites: Invite[] = []): Promise<{ created: unknown[]; revoked: unknown[]; invites: Invite[] }> {
  seed(app.server.rpc);
  const seen = { created: [] as unknown[], revoked: [] as unknown[], invites };
  app.server.rpc.handle("user.invite.list", () => ({ invites: seen.invites }), { write: false });
  app.server.rpc.handle("user.invite.create", (p) => {
    seen.created.push(p);
    return { id: "inv-new", userId: "u-new", role: "member", channel: "web", expiresAt: Date.now() + 86_400_000, code: "ABCDEFGH", link: `${new URL(app.baseUrl).origin}${LINK_PATH}` };
  }, { write: true });
  app.server.rpc.handle("user.invite.revoke", (p) => {
    seen.revoked.push(p);
    seen.invites = seen.invites.filter((i) => i.id !== (p as { inviteId: string }).inviteId);
    return { id: (p as { inviteId: string }).inviteId, revoked: true };
  }, { write: true });
  await openRoute(app.page, "#/settings/users");
  await app.page.getByRole("heading", { name: "Users & roles", level: 2 }).waitFor();
  return seen;
}
const dialog = (app: App) => app.page.getByRole("dialog", { name: "Invite person" });
async function fill(app: App, name = "Dana Neu"): Promise<void> {
  await app.page.getByRole("button", { name: "Invite person" }).click();
  await dialog(app).waitFor();
  await dialog(app).getByRole("textbox", { name: "Name" }).fill(name);
}

describe("users: invitation validity", opts, () => {
  test("offers 1 hour, 24 hours, 7 days, 30 days and a custom value; 24 hours is the default and goes out as minutes", async () => {
    await withApp({}, async (app) => {
      const seen = await open(app);
      await fill(app);
      const select = dialog(app).getByLabel("Valid for");
      assert.deepEqual(await select.locator("option").allTextContents(), ["1 hour", "24 hours", "7 days", "30 days", "Custom…"]);
      assert.equal(await select.inputValue(), "24h");
      await dialog(app).getByRole("button", { name: "Send invitation" }).click();
      await app.page.getByRole("dialog", { name: "Invitation created." }).waitFor();
      const sent = seen.created[0] as Record<string, unknown>;
      assert.equal(sent.ttlMinutes, 1440);
      assert.equal(sent.origin, new URL(app.baseUrl).origin, "the link is built on this page's origin");
      assert.equal("expiresInMinutes" in sent, false);
    });
  });
  test("each preset sends its minutes", async () => {
    for (const [label, minutes] of [["1 hour", 60], ["7 days", 10080], ["30 days", 43200]] as const) {
      await withApp({}, async (app) => {
        const seen = await open(app);
        await fill(app);
        await dialog(app).getByLabel("Valid for").selectOption({ label });
        await dialog(app).getByRole("button", { name: "Send invitation" }).click();
        await app.page.getByRole("dialog", { name: "Invitation created." }).waitFor();
        assert.equal((seen.created[0] as { ttlMinutes: number }).ttlMinutes, minutes, label);
      });
    }
  });
  test("custom: whole hours from 1 to 720, anything else is refused before anything is sent", async () => {
    await withApp({}, async (app) => {
      const seen = await open(app);
      await fill(app);
      await dialog(app).getByLabel("Valid for").selectOption({ label: "Custom…" });
      const hours = dialog(app).getByRole("textbox", { name: "Hours (1 to 720)" });
      for (const bad of ["", "0", "721", "1.5", "abc", "-3"]) {
        await hours.fill(bad);
        await dialog(app).getByRole("button", { name: "Send invitation" }).click();
        await dialog(app).getByText("Enter a whole number of hours from 1 to 720.").waitFor();
        assert.equal(await hours.getAttribute("aria-invalid"), "true", bad);
      }
      assert.equal(seen.created.length, 0, "nothing sent for invalid values");
      await hours.fill("48");
      await dialog(app).getByRole("button", { name: "Send invitation" }).click();
      await app.page.getByRole("dialog", { name: "Invitation created." }).waitFor();
      assert.equal((seen.created[0] as { ttlMinutes: number }).ttlMinutes, 2880);
    });
  });
});

describe("users: invitation link", opts, () => {
  test("is shown once, can be copied, and is gone when the dialog is closed", async () => {
    await withApp({}, async (app) => {
      await app.context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
      await open(app);
      await fill(app);
      await dialog(app).getByRole("button", { name: "Send invitation" }).click();
      const done = app.page.getByRole("dialog", { name: "Invitation created." });
      await done.waitFor();
      await done.getByText("Copy this link now and send it to the person. It works once and will not be shown again.").waitFor();
      const link = done.getByRole("textbox", { name: "Invitation link" });
      const url = `${new URL(app.baseUrl).origin}${LINK_PATH}`;
      assert.equal(await link.inputValue(), url);
      assert.equal(await link.getAttribute("readonly"), "");
      assert.equal(await done.getByText("ABCDEFGH").count(), 0, "the pairing code is not shown next to the link");
      await app.page.evaluate(() => { (window as unknown as { __copied: string[] }).__copied = []; Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (v: string) => { (window as unknown as { __copied: string[] }).__copied.push(v); } } }); });
      await done.getByRole("button", { name: "Copy link" }).click();
      await done.locator("button", { hasText: "Copied!" }).waitFor();
      assert.deepEqual(await app.page.evaluate(() => (window as unknown as { __copied: string[] }).__copied), [url]);
      await done.locator("button.btn-primary", { hasText: "Close" }).click();
      await done.waitFor({ state: "detached" });
      assert.equal(await app.page.locator("input[readonly]").count(), 0);
      assert.equal(await app.page.getByText(url).count(), 0, "the link is nowhere on the page after closing");
      await app.page.getByRole("button", { name: "Invite person" }).click();
      assert.equal(await dialog(app).getByRole("textbox", { name: "Invitation link" }).count(), 0, "a new dialog starts empty");
    });
  });
});

describe("users: open invitations", opts, () => {
  const mine: Invite[] = [
    { id: "inv-1", userId: "Dana Neu", role: "member", channel: "web", expiresAt: Date.UTC(2031, 0, 5, 12), state: "pending", shareable: true, createdAt: 1 },
    { id: "inv-2", userId: "Old One", role: "viewer", channel: "web", expiresAt: 1, state: "expired", shareable: true, createdAt: 1 },
    { id: "inv-3", userId: "Used One", role: "viewer", channel: "web", expiresAt: Date.UTC(2031, 0, 5, 12), state: "redeemed", shareable: true, createdAt: 1 },
  ];
  test("lists only invitations that can still be used", async () => {
    await withApp({}, async (app) => {
      await open(app, [...mine]);
      const card = app.page.getByRole("heading", { name: "Open invitations" });
      await card.waitFor();
      const items = app.page.locator(".users-row", { hasText: "Channel: web" });
      assert.equal(await items.count(), 1);
      assert.match((await items.first().textContent()) ?? "", /Dana Neu/);
    });
  });
  test("revoking asks first; cancelling sends nothing, confirming revokes and removes the row", async () => {
    await withApp({}, async (app) => {
      const seen = await open(app, [...mine]);
      const row = app.page.locator(".users-row", { hasText: "Dana Neu" }).filter({ hasText: "Channel: web" });
      await row.getByRole("button", { name: "Revoke" }).click();
      const dlg = app.page.getByRole("dialog", { name: "Revoke invitation?" });
      await dlg.getByText("The link for Dana Neu stops working at once.", { exact: false }).waitFor();
      await dlg.getByRole("button", { name: "Cancel" }).click();
      await dlg.waitFor({ state: "detached" });
      assert.equal(seen.revoked.length, 0, "cancel revokes nothing");
      await row.getByRole("button", { name: "Revoke" }).click();
      await dlg.getByRole("button", { name: "Revoke" }).click();
      await app.page.getByText("Invitation revoked.").waitFor();
      assert.deepEqual(seen.revoked, [{ inviteId: "inv-1" }]);
      await app.page.locator(".users-row", { hasText: "Channel: web" }).waitFor({ state: "detached" });
    });
  });
  test("a failed revoke stays open and says so", async () => {
    await withApp({}, async (app) => {
      const seen = await open(app, [...mine]);
      app.server.rpc.scenario("user.invite.revoke", "error", { code: "E_INTERNAL", message: "boom" });
      await app.page.locator(".users-row", { hasText: "Channel: web" }).getByRole("button", { name: "Revoke" }).click();
      const dlg = app.page.getByRole("dialog", { name: "Revoke invitation?" });
      await dlg.getByRole("button", { name: "Revoke" }).click();
      await dlg.getByText("The invitation could not be revoked.").waitFor();
      assert.equal(seen.revoked.length, 0);
    });
  });
});

describe("users: invitations in German", opts, () => {
  test("validity, link and revoke texts", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      seed(app.server.rpc);
      app.server.rpc.handle("user.invite.list", () => ({ invites: [{ id: "inv-1", userId: "Dana", role: "member", channel: "web", expiresAt: Date.UTC(2031, 0, 5), state: "pending", shareable: true, createdAt: 1 }] }), { write: false });
      await openRoute(app.page, "#/settings/users", "de");
      await app.page.getByRole("button", { name: "Person einladen" }).click();
      const dlg = app.page.getByRole("dialog", { name: "Person einladen" });
      assert.deepEqual(await dlg.getByLabel("Gültig für").locator("option").allTextContents(), ["1 Stunde", "24 Stunden", "7 Tage", "30 Tage", "Eigener Wert …"]);
      await dlg.getByRole("button", { name: "Abbrechen" }).click();
      await app.page.locator(".users-row", { hasText: "Kanal: web" }).getByRole("button", { name: "Widerrufen" }).click();
      await app.page.getByRole("dialog", { name: "Einladung widerrufen?" }).waitFor();
    });
  });
});
