// Settings > Users & roles: axe WCAG 2.1 AA on the list, the presets, the rights matrix, the dialogs and the states; layout at 400 px.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { seed } from "./users-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

async function open(app: App, tweak?: () => void): Promise<void> {
  seed(app.server.rpc); tweak?.();
  await openRoute(app.page, "#/settings/users");
  await app.page.getByRole("heading", { name: "Users & roles", level: 2 }).waitFor();
  await app.page.waitForFunction(() => document.querySelectorAll('[data-state="loading"]').length === 0);
}
const noHScroll = (app: App) => app.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

for (const [scheme, width] of [["light", 1440], ["dark", 960], ["light", 400], ["dark", 400]] as const) {
  describe(`users axe: ${scheme}, ${width} px`, opts, () => {
    test("list and presets (simple mode)", async () => {
      await withApp({ colorScheme: scheme, width, height: 900 }, async (app) => {
        await open(app);
        await expectAxeClean(app.page, `users ${scheme} ${width}`);
        if (width === 400) assert.equal(await noHScroll(app), true, "no horizontal scroll at 400 px");
      });
    });
    test("rights matrix (simple mode off)", async () => {
      await withApp({ colorScheme: scheme, width, height: 900 }, async (app) => {
        await open(app);
        await app.page.getByRole("checkbox", { name: "Simple mode" }).uncheck();
        await app.page.locator(".users-matrix").waitFor();
        await expectAxeClean(app.page, `rights ${scheme} ${width}`);
        if (width === 400) assert.equal(await noHScroll(app), true);
      });
    });
    test("invite dialog open (with error, then result)", async () => {
      await withApp({ colorScheme: scheme, width, height: 900 }, async (app) => {
        await open(app);
        await app.page.getByRole("button", { name: "Invite person" }).click();
        const dlg = app.page.getByRole("dialog", { name: "Invite person" });
        await dlg.locator(".users-matrix").waitFor();
        await dlg.getByRole("button", { name: "Send invitation" }).click();
        await dlg.getByText("Enter a name of 1 to 128 characters.").waitFor();
        await expectAxeClean(app.page, `invite error ${scheme} ${width}`);
        await dlg.getByRole("textbox", { name: "Name" }).fill("Dana");
        await dlg.getByRole("button", { name: "Send invitation" }).click();
        await dlg.getByRole("status").filter({ hasText: "not available" }).waitFor();
        await expectAxeClean(app.page, `invite result ${scheme} ${width}`);
        if (width === 400) assert.equal(await noHScroll(app), true);
      });
    });
    test("break-glass dialog open (with error, then result)", async () => {
      await withApp({ colorScheme: scheme, width, height: 900 }, async (app) => {
        await open(app);
        await app.page.getByRole("button", { name: "Read as Anna Beispiel (break-glass)" }).click();
        const dlg = app.page.getByRole("dialog", { name: "Break-glass access" });
        await dlg.getByRole("button", { name: "Request access" }).click();
        await dlg.getByText("Give a reason of at least 10 characters.").waitFor();
        await expectAxeClean(app.page, `bg error ${scheme} ${width}`);
        await dlg.getByLabel(/^Reason/).fill("Support case 4711, user asked");
        await dlg.getByRole("button", { name: "Request access" }).click();
        await dlg.getByText("Break-glass is not available").waitFor();
        await expectAxeClean(app.page, `bg result ${scheme} ${width}`);
      });
    });
  });
}

describe("users axe: states", opts, () => {
  for (const state of ["empty", "error", "forbidden", "unavailable", "role-forbidden"] as const) {
    test(state, async () => {
      await withApp({ width: 400, height: 900, ...(state === "role-forbidden" ? { server: { role: "viewer" } } : {}) }, async (app) => {
        await open(app, () => {
          if (state === "empty") app.server.rpc.handle("identity.list", () => ({ humans: [], pairings: [] }), { write: false });
          else if (state === "error" || state === "forbidden" || state === "unavailable") app.server.rpc.scenario("identity.list", state);
        });
        await expectAxeClean(app.page, `users state ${state}`);
        assert.equal(await noHScroll(app), true);
      });
    });
  }
});
