// b18 audit of the Inbox page: a second click on a write that is still in flight must not send a second request, and a partly
// failed "mark shown" must leave the list as the server has it. Both run against the mock API in a real Chromium.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { entry, installInbox, sampleEntries } from "./inbox-fixtures.ts";
import { rpcError } from "./mock-rpc.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };
const calls = (app: App, method: string) => app.server.rpc.calls.filter((c) => c.method === method);
async function openInbox(app: App): Promise<void> {
  await openRoute(app.page, "#/inbox", "en"); await app.page.getByRole("heading", { name: "Inbox", level: 1 }).waitFor();
  await app.page.locator(".inbox-item").first().waitFor();
}
/** Two clicks in the same task, before the page could re-render: what a fast double click does. */
const clickTwice = (loc: ReturnType<App["page"]["locator"]>) => loc.evaluate((el) => { (el as HTMLElement).click(); (el as HTMLElement).click(); });

describe("inbox: a double click sends one request", opts, () => {
  test("Dismiss", async () => {
    await withApp({}, async (app) => {
      installInbox(app.server.rpc, sampleEntries()); await openInbox(app);
      app.server.rpc.setDelay("inbox.dismiss", 300);
      await clickTwice(app.page.locator(".inbox-item").first().getByRole("button", { name: "Dismiss" }));
      await app.page.waitForFunction(() => document.querySelectorAll(".inbox-item").length === 5);
      assert.equal(calls(app, "inbox.dismiss").length, 1);
    });
  });

  test("Mark read", async () => {
    await withApp({}, async (app) => {
      installInbox(app.server.rpc, sampleEntries()); await openInbox(app);
      app.server.rpc.setDelay("inbox.markRead", 300);
      await clickTwice(app.page.locator(".inbox-item").first().getByRole("button", { name: "Mark as read" }));
      await app.page.waitForFunction(() => document.querySelectorAll('.inbox-item[data-read="false"]').length === 4);
      assert.equal(calls(app, "inbox.markRead").length, 1);
    });
  });

  test("Mark all read", async () => {
    await withApp({}, async (app) => {
      installInbox(app.server.rpc, sampleEntries()); await openInbox(app);
      app.server.rpc.setDelay("inbox.markRead", 300);
      await clickTwice(app.page.getByRole("button", { name: "Mark all as read" }));
      await app.page.waitForFunction(() => document.querySelectorAll('.inbox-item[data-read="false"]').length === 0);
      assert.equal(calls(app, "inbox.markRead").length, 1);
    });
  });
});

describe("inbox: mark the shown entries, partly failing", opts, () => {
  test("entries the server already marked read are shown as read, and the failure is said", async () => {
    await withApp({}, async (app) => {
      const rows = Array.from({ length: 600 }, (_, i) => entry({ id: `s${String(i).padStart(3, "0")}`, kind: "system", titleKey: "inbox.jobFailed", params: { job: `j${i}` }, createdAt: 1_800_000_000_000 - i }));
      const store = installInbox(app.server.rpc, rows, { pageSize: 200 }); await openInbox(app);
      let n = 0;
      app.server.rpc.handle("inbox.markRead", (p: unknown) => {
        const ids = (p as { ids?: string[] }).ids ?? [];
        if (++n > 1) throw rpcError("E_INTERNAL", "boom");
        for (const e of store.entries) if (ids.includes(e.id)) e.readAt = Date.now();
        return { changed: ids.length };
      });
      await app.page.getByRole("button", { name: "System" }).click();
      await app.page.locator(".inbox-item").first().waitFor();
      for (let i = 1; i <= 10; i++) { await app.page.getByRole("button", { name: "Load more" }).click(); await app.page.waitForFunction((k) => document.querySelectorAll(".inbox-item").length >= k, 50 * (i + 1)); }
      await app.page.getByRole("button", { name: "Mark all as read" }).click();
      await app.page.getByRole("dialog").getByRole("button", { name: "Mark as read" }).click();
      await app.page.getByRole("dialog").getByRole("alert").waitFor();
      await app.page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
      const stillUnread = await app.page.locator('.inbox-item[data-read="false"]').count();
      const shown = await app.page.locator(".inbox-title").evaluateAll((els) => els.map((e) => e.id.replace("inbox-title-", "")));
      const serverUnread = store.entries.filter((e) => e.readAt === null && shown.includes(e.id)).length;
      assert.equal(stillUnread, serverUnread, `page shows ${stillUnread} unread, server has ${serverUnread}`);
    });
  });
});
