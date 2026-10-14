import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

type Grant = {
  id: string;
  holderUserId: string;
  targetUserId: string;
  reason: string;
  issuedAt: number;
  expiresAt: number;
};

type Notice = {
  kind: "granted";
  userId: string;
  grantId: string;
  holderUserId: string;
  reason: string;
  expiresAt: number;
};

const sampleGrants: Grant[] = [
  {
    id: "bg-grant-001",
    holderUserId: "usr_owner",
    targetUserId: "usr_target_1",
    reason: "Production incident debugging with database corruptions",
    issuedAt: Date.now() - 5 * 60 * 1000,
    expiresAt: Date.now() + 25 * 60 * 1000,
  },
  {
    id: "bg-grant-002",
    holderUserId: "usr_owner",
    targetUserId: "usr_target_2",
    reason: "Audit of security anomaly in authentication service",
    issuedAt: Date.now() - 120 * 60 * 1000,
    expiresAt: Date.now() - 60 * 60 * 1000,
  },
];

const sampleNotices: Notice[] = [
  {
    kind: "granted",
    userId: "usr_current",
    grantId: "bg-grant-099",
    holderUserId: "usr_admin_ops",
    reason: "Emergency certificate renewal verification",
    expiresAt: Date.now() + 10 * 60 * 1000,
  },
];

function seedBreakglass(
  app: App,
  grants: Grant[] = sampleGrants,
  notices: Notice[] = sampleNotices,
): void {
  app.server.rpc.handle("config.get", () => ({value:{}}), {write:false});
  app.server.rpc.handle("breakglass.list", () => ({ grants }), { write: false });
  app.server.rpc.handle("breakglass.notices", () => ({ notices }), { write: false });
  app.server.rpc.handle(
    "breakglass.request",
    (p) => {
      const params = p as { targetUserId: string; reason: string; windowMinutes?: number };
      const minutes = params.windowMinutes ?? 15;
      const newGrant: Grant = {
        id: `bg-grant-${Date.now()}`,
        holderUserId: "usr_owner",
        targetUserId: params.targetUserId,
        reason: params.reason,
        issuedAt: Date.now(),
        expiresAt: Date.now() + minutes * 60 * 1000,
      };
      return newGrant;
    },
    { write: true },
  );
  app.server.rpc.handle(
    "breakglass.revoke",
    (p) => {
      const params = p as { grantId: string };
      return { id: params.grantId, revoked: true };
    },
    { write: true },
  );
}

describe("Break-Glass page", opts, () => {
  test("role gating: forbidden for non-owner and non-admin", async () => {
    await withApp({ server: { role: "viewer" } }, async (app) => {
      seedBreakglass(app);
      await openRoute(app.page, "#/breakglass");
      await app.page.locator(".page-state[data-state=forbidden]").waitFor();
    });

    await withApp({ server: { role: "member" } }, async (app) => {
      seedBreakglass(app);
      await openRoute(app.page, "#/breakglass");
      await app.page.locator(".page-state[data-state=forbidden]").waitFor();
    });
  });

  test("navigation: sidebar contains Break-Glass under Control next to Approvals", async () => {
    await withApp({}, async (app) => {
      seedBreakglass(app);
      await openRoute(app.page, "#/chat");
      const navLink = app.page.locator("#sidebar-nav").getByRole("link", { name: "Break-Glass" });
      await navLink.waitFor();
      assert.equal(await navLink.getAttribute("href"), "#/breakglass");
      await navLink.click();
      await app.page.getByRole("heading", { name: "Break-Glass", level: 1 }).waitFor();
    });
  });

  test("renders active window with persistent warning banner, past windows and notices", async () => {
    await withApp({}, async (app) => {
      seedBreakglass(app);
      await openRoute(app.page, "#/breakglass");

      // Verify heading
      await app.page.getByRole("heading", { name: "Break-Glass", level: 1 }).waitFor();

      // Verify persistent warning banner for active window
      const banner = app.page.locator(".bg-banner[role=alert]");
      await banner.waitFor();
      await banner.getByText("usr_target_1").waitFor();
      await banner.getByRole("button", { name: /Revoke now/i }).waitFor();

      // Verify active table shows target and remaining time
      const activeTable = app.page.locator(".bg-table[aria-label='Active windows']");
      await activeTable.waitFor();
      await activeTable.getByText("usr_target_1").waitFor();
      await activeTable.getByText("Production incident debugging with database corruptions").waitFor();

      // Check past tab
      const pastTab = app.page.getByRole("tab", { name: /Past windows/i });
      await pastTab.click();
      const pastTable = app.page.locator(".bg-table[aria-label='Past windows']");
      await pastTable.waitFor();
      await pastTable.getByText("usr_target_2").waitFor();
      await pastTable.getByText("Audit of security anomaly in authentication service").waitFor();

      // Check notices tab
      const noticesTab = app.page.getByRole("tab", { name: /Received notices/i });
      await noticesTab.click();
      await app.page.getByText("usr_admin_ops").waitFor();
      await app.page.getByText("Emergency certificate renewal verification").waitFor();
    });
  });

  test("request dialog: requires reason (10-500 chars), duration, and explicit confirmation", async () => {
    await withApp({}, async (app) => {
      seedBreakglass(app, [], []);
      await openRoute(app.page, "#/breakglass");

      // Initially no banner
      assert.equal(await app.page.locator(".bg-banner").count(), 0);

      // Open dialog
      await app.page.getByRole("button", { name: "Request break-glass" }).click();
      const dialog = app.page.getByRole("dialog");
      await dialog.waitFor();

      const targetInput = dialog.locator("#bg-target-user");
      const reasonInput = dialog.locator("#bg-reason");
      const confirmCheck = dialog.locator("#bg-confirm-check");
      const submitBtn = dialog.getByRole("button", { name: "Request access" });

      // Fill short reason
      await targetInput.fill("usr_incident");
      await reasonInput.fill("too short");
      await confirmCheck.check();
      await submitBtn.click();

      // Validation error shown
      await dialog.getByText("The reason must be at least 10 characters long.").waitFor();

      // Fill valid reason
      await reasonInput.fill("Critical bug triage: investigating memory leak in worker processes");
      await submitBtn.click();

      // Dialog closes and RPC was called
      await dialog.waitFor({ state: "hidden" });

      const requestCalls = app.server.rpc.calls.filter((c) => c.method === "breakglass.request");
      assert.equal(requestCalls.length, 1);
      assert.equal((requestCalls[0]!.params as any).targetUserId, "usr_incident");
      assert.equal((requestCalls[0]!.params as any).reason, "Critical bug triage: investigating memory leak in worker processes");
      assert.equal((requestCalls[0]!.params as any).windowMinutes, 15);

      // Now warning banner is visible
      const banner = app.page.locator(".bg-banner[role=alert]");
      await banner.waitFor();
      await banner.getByText("usr_incident").waitFor();
    });
  });

  test("revoke with confirmation", async () => {
    await withApp({}, async (app) => {
      seedBreakglass(app);
      await openRoute(app.page, "#/breakglass");

      const banner = app.page.locator(".bg-banner[role=alert]");
      await banner.waitFor();

      // Click revoke in the table or banner
      await banner.getByRole("button", { name: "Revoke now" }).click();

      // Revoke confirmation dialog
      const dialog = app.page.getByRole("dialog");
      await dialog.waitFor();
      await dialog.getByText("Are you sure you want to revoke this break-glass window for usr_target_1?").waitFor();

      // Confirm revoke
      await dialog.getByRole("button", { name: "Revoke window" }).click();
      await dialog.waitFor({ state: "hidden" });

      // RPC called
      const revokeCalls = app.server.rpc.calls.filter((c) => c.method === "breakglass.revoke");
      assert.equal(revokeCalls.length, 1);
      assert.equal((revokeCalls[0]!.params as any).grantId, "bg-grant-001");

      // Banner should disappear as active grants are now 0
      assert.equal(await app.page.locator(".bg-banner").count(), 0);

      // Past tab shows it as revoked
      const pastTab = app.page.getByRole("tab", { name: /Past windows/i });
      await pastTab.click();
      await app.page.locator(".bg-table[aria-label='Past windows']").getByText("usr_target_1").waitFor();
      await app.page.getByText("Revoked").waitFor();
    });
  });

  test("security: reason text is not written to URL or localStorage", async () => {
    await withApp({}, async (app) => {
      seedBreakglass(app);
      await openRoute(app.page, "#/breakglass");
      await app.page.getByRole("heading", { name: "Break-Glass", level: 1 }).waitFor();

      // URL check
      const url = app.page.url();
      assert.ok(!url.includes("Production incident"), "URL contains reason text");
      assert.ok(!url.includes("usr_target"), "URL contains target user");

      // localStorage & sessionStorage check
      const storageState = await app.page.evaluate(() => {
        return {
          localKeys: Object.keys(localStorage),
          localValues: Object.values(localStorage),
          sessionKeys: Object.keys(sessionStorage),
          sessionValues: Object.values(sessionStorage),
        };
      });

      for (const val of [...storageState.localValues, ...storageState.sessionValues]) {
        assert.ok(!val.includes("Production incident"), "storage contains reason text");
      }
    });
  });

  test("accessibility (axe) and German translations", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      seedBreakglass(app);
      await openRoute(app.page, "#/breakglass", "de");

      // Heading in German
      await app.page.getByRole("heading", { name: "Break-Glass", level: 1 }).waitFor();
      await app.page.getByText("Aktiver Break-Glass-Zugriff").waitFor();

      // Check axe clean
      await expectAxeClean(app.page, "breakglass German");
    });

    await withApp({}, async (app) => {
      seedBreakglass(app);
      await openRoute(app.page, "#/breakglass");
      await expectAxeClean(app.page, "breakglass English");
    });
  });
});

test("configured emergency-access bounds replace the dialog constants", opts, async () => {
 await withApp({},async app=>{
  seedBreakglass(app);
  app.server.rpc.handle("config.get",()=>({value:{breakglass:{reasonMinChars:20,reasonMaxChars:80,maxWindowMinutes:2}}}),{write:false});
  await openRoute(app.page,"#/breakglass");
  await app.page.getByRole("button",{name:"Request break-glass",exact:true}).click();
  const dialog=app.page.getByRole("dialog");
  await dialog.getByText("Reason: 20 to 80 trimmed characters.",{exact:true}).waitFor();
  assert.equal(await dialog.locator("textarea").getAttribute("maxlength"),"130");
  assert.equal(await dialog.getByRole("option",{name:"60 minutes",exact:true}).count(),0);
  assert.equal(await dialog.getByRole("option",{name:"2 minutes",exact:true}).count(),1);
  await expectAxeClean(app.page,"configured breakglass bounds");
 });
});
