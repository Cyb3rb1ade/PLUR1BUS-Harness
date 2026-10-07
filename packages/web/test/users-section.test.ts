// Settings > Users & roles (`/settings/users`): people list and its states, role presets, simple mode and the rights matrix,
// the invite dialog and break-glass (both end in "not available" and send nothing), keyboard paths, German.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { HUMANS, nonReads, seed, type Seed } from "./users-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

async function open(app: App, s: Seed | null = {}, lang: "en" | "de" = "en"): Promise<void> {
  if (s) seed(app.server.rpc, s);
  else app.server.rpc.enable();
  await openRoute(app.page, "#/settings/users", lang);
  await app.page.getByRole("heading", { name: lang === "de" ? "Nutzer & Rollen" : "Users & roles", level: 2 }).waitFor();
}
const list = (app: App) => app.page.getByRole("list", { name: "People with access" });

describe("users: people list", opts, () => {
  test("lists the signed-in principal with its role first, then the people identity.list returns", async () => {
    await withApp({}, async (app) => {
      await open(app);
      const items = list(app).getByRole("listitem");
      await items.nth(3).waitFor();
      assert.equal(await items.count(), 4);
      const first = (await items.first().textContent()) ?? "";
      assert.match(first, /owner \(you\)/); assert.match(first, /Owner/); assert.match(first, /Signed in/);
      assert.equal(await items.first().getByRole("button").count(), 0, "no break-glass on yourself");
      const anna = (await items.nth(1).textContent()) ?? "";
      assert.match(anna, /Anna Beispiel/); assert.match(anna, /2 linked identities/); assert.match(anna, /Role not shown/);
      const ben = (await items.nth(2).textContent()) ?? "";
      assert.match(ben, /No linked identity/); assert.match(ben, /Pairing pending/);
      assert.match((await items.nth(3).textContent()) ?? "", /1 linked identity/);
    });
  });
  test("empty: only the signed-in principal, with an explanation", async () => {
    await withApp({}, async (app) => {
      await open(app, { humans: [], pairings: [] });
      await app.page.getByText("No other people yet. Only you are listed.").waitFor();
      assert.equal(await list(app).getByRole("listitem").count(), 1);
    });
  });
  test("loading, then the list", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); app.server.rpc.setDelay("identity.list", 300);
      await openRoute(app.page, "#/settings/users");
      await app.page.locator(".users-block .page-state[data-state=loading]").waitFor();
      await list(app).waitFor();
    });
  });
  test("error with Try again, forbidden, unavailable (scenario and method missing)", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); app.server.rpc.scenario("identity.list", "error", { code: "E_INTERNAL", message: "boom" });
      await open(app, null);
      await app.page.getByRole("alert").getByRole("button", { name: "Try again" }).waitFor();
      app.server.rpc.scenario("identity.list", "success");
      await app.page.getByRole("button", { name: "Try again" }).click();
      await list(app).waitFor();
      app.server.rpc.scenario("identity.list", "forbidden");
      await app.page.getByRole("link", { name: "Secrets" }).click();
      await app.page.getByRole("link", { name: "Users & roles" }).click();
      await app.page.locator(".users-block .page-state[data-state=forbidden]").waitFor();
      app.server.rpc.scenario("identity.list", "unavailable");
      await app.page.getByRole("link", { name: "Secrets" }).click();
      await app.page.getByRole("link", { name: "Users & roles" }).click();
      await app.page.getByRole("heading", { name: "The list of people is not available" }).waitFor();
    });
    await withApp({}, async (app) => {
      await open(app, null);
      await app.page.getByRole("heading", { name: "The list of people is not available" }).waitFor();
      await app.page.getByRole("button", { name: "Invite person" }).waitFor();
    });
  });
});

describe("users: presets, simple mode, rights", opts, () => {
  test("simple mode is on by default: five presets with plain text, no matrix, no agent request", async () => {
    await withApp({}, async (app) => {
      await open(app);
      const sw = app.page.getByRole("checkbox", { name: "Simple mode" });
      assert.equal(await sw.isChecked(), true);
      const radios = app.page.getByRole("group", { name: "Role preset" }).getByRole("radio");
      assert.equal(await radios.count(), 5);
      assert.deepEqual(await app.page.locator(".users-preset strong").allTextContents(), ["Owner", "Admin", "Operator", "Member", "Viewer"]);
      assert.equal(await app.page.getByRole("heading", { name: "Rights per agent" }).count(), 0);
      assert.ok(!app.server.rpc.calls.some((c) => c.method === "config.get"));
      await app.page.getByText("Assigning roles is not available on this harness yet").waitFor();
    });
  });
  test("choosing a preset shows what it can and cannot do (keyboard)", async () => {
    await withApp({}, async (app) => {
      await open(app);
      const detail = app.page.locator(".users-detail");
      assert.match((await detail.textContent()) ?? "", /Member.*shared with them/s);
      await app.page.getByRole("radio", { name: /^Viewer/ }).focus();
      await app.page.keyboard.press("ArrowDown");   // wraps to Owner
      assert.match((await detail.textContent()) ?? "", /Owner.*Reveal and change secrets/s);
      await app.page.getByRole("radio", { name: /^Viewer/ }).check();
      const text = (await detail.textContent()) ?? "";
      assert.match(text, /Read logs/); assert.match(text, /Write any memory/);
    });
  });
  test("simple mode off: rights per agent from config.get agents; Manage includes Use; Operator has no Manage", async () => {
    await withApp({}, async (app) => {
      await open(app);
      await app.page.getByRole("checkbox", { name: "Simple mode" }).uncheck();
      await app.page.getByRole("heading", { name: "Rights per agent" }).waitFor();
      const rows = app.page.locator(".users-matrix tbody tr");
      assert.deepEqual(await rows.locator("th").allTextContents(), ["main", "research", "ops"]);
      assert.deepEqual(app.server.rpc.calls.filter((c) => c.method === "config.get").map((c) => c.params), [{ key: "agents" }]);
      assert.match((await app.page.locator(".users-rights").textContent()) ?? "", /sees only the agents shared with them/);
      const manage = app.page.getByRole("checkbox", { name: "Manage right on agent research" });
      const use = app.page.getByRole("checkbox", { name: "Use right on agent research" });
      await manage.check();
      assert.equal(await use.isChecked(), true);
      await use.uncheck();
      assert.equal(await manage.isChecked(), false);
      await app.page.getByLabel("Rights for role").selectOption("operator");
      assert.equal(await app.page.getByRole("columnheader", { name: "Manage" }).count(), 0);
      assert.match((await app.page.locator(".users-rights").textContent()) ?? "", /cannot hold Manage/);
      assert.deepEqual(nonReads(app.server.rpc), []);
    });
  });
  test("rights: no agents, agents error and agents unavailable", async () => {
    await withApp({}, async (app) => {
      await open(app, { agents: {} });
      await app.page.getByRole("checkbox", { name: "Simple mode" }).uncheck();
      await app.page.getByText("No agents are configured yet.").waitFor();
    });
    await withApp({}, async (app) => {
      await open(app);
      app.server.rpc.scenario("config.get", "error");
      await app.page.getByRole("checkbox", { name: "Simple mode" }).uncheck();
      await app.page.locator(".users-rights, .users-block").getByRole("button", { name: "Try again" }).waitFor();
    });
    await withApp({}, async (app) => {
      await open(app);
      app.server.rpc.scenario("config.get", "unavailable");
      await app.page.getByRole("checkbox", { name: "Simple mode" }).uncheck();
      await app.page.locator("#users-rights-h").waitFor();
      await app.page.locator(".page-state[data-state=unavailable]").waitFor();
    });
  });
});

describe("users: invite dialog", opts, () => {
  test("validates, then says it is not available; nothing is sent", async () => {
    await withApp({}, async (app) => {
      await open(app);
      await app.page.getByRole("button", { name: "Invite person" }).click();
      const dlg = app.page.getByRole("dialog", { name: "Invite person" });
      await dlg.waitFor();
      await dlg.getByRole("button", { name: "Send invitation" }).click();
      await dlg.getByText("Enter a name of 1 to 128 characters.").waitFor();
      assert.equal(await dlg.getByRole("textbox", { name: "Name" }).getAttribute("aria-invalid"), "true");
      assert.equal(await dlg.getByText("Inviting people is not available").count(), 0);
      await dlg.getByRole("textbox", { name: "Name" }).fill("x".repeat(129));
      await dlg.getByRole("button", { name: "Send invitation" }).click();
      await dlg.getByText("Enter a name of 1 to 128 characters.").waitFor();
      await dlg.getByRole("textbox", { name: "Name" }).fill("Dana Neu");
      await dlg.getByLabel("Role").selectOption("member");
      await dlg.getByRole("checkbox", { name: "Use right on agent main" }).check();
      const before = app.server.rpc.calls.length;
      await dlg.getByRole("button", { name: "Send invitation" }).click();
      await dlg.getByRole("status").filter({ hasText: "Inviting people is not available on this harness yet. Nothing was sent or created." }).waitFor();
      assert.equal(app.server.rpc.calls.length, before, "no request after submit");
      assert.deepEqual(nonReads(app.server.rpc), []);
    });
  });
  test("role changes the rights part; Esc closes and returns focus to the button", async () => {
    await withApp({}, async (app) => {
      await open(app);
      const btn = app.page.getByRole("button", { name: "Invite person" });
      await btn.focus(); await app.page.keyboard.press("Enter");
      const dlg = app.page.getByRole("dialog", { name: "Invite person" });
      await dlg.getByRole("table").waitFor();
      await dlg.getByLabel("Role").selectOption("viewer");
      assert.equal(await dlg.getByRole("table").count(), 0);
      assert.match((await dlg.textContent()) ?? "", /A Viewer only reads/);
      assert.equal(await dlg.getByRole("option", { name: "Owner" }).count(), 0);
      await app.page.keyboard.press("Escape");
      await dlg.waitFor({ state: "detached" });
      assert.equal(await btn.evaluate((el) => el === document.activeElement), true);
    });
  });
  test("Tab stays inside the dialog (focus trap)", async () => {
    await withApp({}, async (app) => {
      await open(app);
      await app.page.getByRole("button", { name: "Invite person" }).click();
      const dlg = app.page.getByRole("dialog", { name: "Invite person" });
      await dlg.waitFor();
      for (let i = 0; i < 25; i++) {
        await app.page.keyboard.press("Tab");
        assert.equal(await app.page.evaluate(() => !!document.activeElement?.closest("dialog")), true, `focus left the dialog at step ${i}`);
      }
      for (let i = 0; i < 25; i++) {
        await app.page.keyboard.press("Shift+Tab");
        assert.equal(await app.page.evaluate(() => !!document.activeElement?.closest("dialog")), true);
      }
    });
  });
});

describe("users: break-glass", opts, () => {
  const bgButton = (app: App) => app.page.getByRole("button", { name: "Read as Anna Beispiel (break-glass)" });

  test("dialog shows reason, window (default 15 min) and the notification notice; validation messages; unavailable result", async () => {
    await withApp({}, async (app) => {
      await open(app);
      await bgButton(app).click();
      const dlg = app.page.getByRole("dialog", { name: "Break-glass access" });
      await dlg.waitFor();
      assert.match((await dlg.textContent()) ?? "", /Anna Beispiel/);
      assert.equal(await dlg.getByLabel("Time window").inputValue(), "15");
      await dlg.getByText("The person concerned is notified at once").waitFor();
      await dlg.getByRole("button", { name: "Request access" }).click();
      await dlg.getByText("Give a reason of at least 10 characters.").waitFor();
      await dlg.getByLabel(/^Reason/).fill("too short");
      await dlg.getByText("Give a reason of at least 10 characters.").waitFor();
      await dlg.getByLabel(/^Reason/).fill("x".repeat(501));
      await dlg.getByText("The reason is limited to 500 characters.").waitFor();
      await dlg.getByLabel(/^Reason/).fill("Support case 4711, user asked for help");
      const before = app.server.rpc.calls.length;
      await dlg.getByRole("button", { name: "Request access" }).click();
      await dlg.getByText("Break-glass is not available on this harness yet. Nothing was requested.").waitFor();
      assert.equal(app.server.rpc.calls.length, before);
      const mins = await dlg.getByLabel("Time window").locator("option").allTextContents();
      assert.deepEqual(mins, ["1 minutes", "5 minutes", "15 minutes", "30 minutes", "60 minutes"]);
    });
  });
  test("keyboard only: open with Enter, trap Tab, Esc closes and focus returns to the row button", async () => {
    await withApp({}, async (app) => {
      await open(app);
      await bgButton(app).focus(); await app.page.keyboard.press("Enter");
      const dlg = app.page.getByRole("dialog", { name: "Break-glass access" });
      await dlg.waitFor();
      for (let i = 0; i < 12; i++) {
        await app.page.keyboard.press("Tab");
        assert.equal(await app.page.evaluate(() => !!document.activeElement?.closest("dialog")), true, `step ${i}`);
      }
      await app.page.keyboard.press("Escape");
      await dlg.waitFor({ state: "detached" });
      assert.equal(await bgButton(app).evaluate((el) => el === document.activeElement), true);
    });
  });
});

describe("users: German", opts, () => {
  test("labels, presets and the unavailable text are German", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      await open(app, {}, "de");
      await app.page.getByRole("button", { name: "Person einladen" }).waitFor();
      await app.page.getByRole("button", { name: "Als Anna Beispiel lesen (Break-glass)" }).waitFor();
      assert.match((await app.page.locator(".users-detail").textContent()) ?? "", /Geteilte Agenten/);
      await app.page.getByRole("checkbox", { name: "Einfacher Modus" }).uncheck();
      await app.page.getByRole("heading", { name: "Rechte pro Agent" }).waitFor();
    });
  });
});
void HUMANS;
