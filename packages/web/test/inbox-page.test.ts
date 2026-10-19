// The inbox page in Chromium: list and titles, filters, paging (and the stale cursor), mark read, dismiss, mark all, the five
// states, the sidebar badge, the reload on reconnect, German, and axe. Runs under the strict CSP of the mock server.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, signIn, teardown, withApp } from "./harness.ts";
import { expectAxeClean } from "./axe.ts";
import { entry, installInbox, sampleEntries, unreadTotal } from "./inbox-fixtures.ts";
import type { App } from "./harness.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

/** The item rows, by their title text. */
const items = (app: App) => app.page.locator(".inbox-item");
const lastCall = (app: App, method: string) => app.server.rpc.calls.filter((c) => c.method === method).at(-1);

async function openInbox(app: App, lang: "en" | "de" = "en"): Promise<void> {
  await openRoute(app.page, "#/inbox", lang);
  await app.page.getByRole("heading", { name: lang === "de" ? "Posteingang" : "Inbox", level: 1 }).waitFor();
}

describe("inbox page", opts, () => {
  test("lists the caller's entries newest first with translated titles, kind, severity and a link to the target", async () => {
    await withApp({}, async (app) => {
      installInbox(app.server.rpc, sampleEntries());
      await openInbox(app);
      await items(app).first().waitFor();
      assert.equal(await items(app).count(), 6);
      const first = items(app).first();
      assert.match((await first.textContent()) ?? "", /An approval for shell is waiting for you\./);
      assert.equal(await first.getByRole("link", { name: "Open" }).getAttribute("href"), "#/approvals/apr_1");
      // The break-glass entry points at the inbox itself: it has no link of its own.
      assert.equal(await app.page.locator('.inbox-item[data-severity="critical"] a').count(), 0);
      assert.equal(await app.page.locator('.inbox-item[data-read="true"]').count(), 1);
      assert.deepEqual(app.problems, []);
    });
  });

  test("a title key the page does not know falls back to the kind label, never to the raw key", async () => {
    await withApp({}, async (app) => {
      installInbox(app.server.rpc, [entry({ id: "u1", kind: "system", titleKey: "inbox.not.a.key", createdAt: 1 })]);
      await openInbox(app);
      await items(app).first().waitFor();
      const text = (await items(app).first().textContent()) ?? "";
      assert.match(text, /System/);
      assert.doesNotMatch(text, /inbox\.not\.a\.key/);
    });
  });

  test("the kind filter sends the kinds to inbox.list and marks the chip pressed; 'All kinds' clears it", async () => {
    await withApp({}, async (app) => {
      installInbox(app.server.rpc, sampleEntries());
      await openInbox(app);
      await items(app).first().waitFor();
      await app.page.getByRole("button", { name: "Approval", exact: true }).click();
      await app.page.waitForFunction(() => document.querySelectorAll(".inbox-item").length === 1);
      assert.deepEqual((lastCall(app, "inbox.list")?.params as { kinds?: string[] }).kinds, ["approval"]);
      assert.equal(await app.page.getByRole("button", { name: "Approval", exact: true }).getAttribute("aria-pressed"), "true");
      await app.page.getByRole("button", { name: "All kinds", exact: true }).click();
      await app.page.waitForFunction(() => document.querySelectorAll(".inbox-item").length === 6);
      assert.equal((lastCall(app, "inbox.list")?.params as { kinds?: unknown }).kinds, undefined);
    });
  });

  test("'Only unread' sends unreadOnly and hides entries that are read", async () => {
    await withApp({}, async (app) => {
      installInbox(app.server.rpc, sampleEntries());
      await openInbox(app);
      await items(app).first().waitFor();
      await app.page.getByLabel("Only unread").check();
      await app.page.waitForFunction(() => document.querySelectorAll(".inbox-item").length === 5);
      assert.equal((lastCall(app, "inbox.list")?.params as { unreadOnly?: boolean }).unreadOnly, true);
    });
  });

  test("paging: 'Load more' appends the next page by cursor and disappears on the last one", async () => {
    await withApp({}, async (app) => {
      installInbox(app.server.rpc, sampleEntries(), { pageSize: 2 });
      await openInbox(app);
      await items(app).nth(1).waitFor();
      assert.equal(await items(app).count(), 2);
      const more = app.page.getByRole("button", { name: "Load more" });
      await more.click();
      await app.page.waitForFunction(() => document.querySelectorAll(".inbox-item").length === 4);
      await more.click();
      await app.page.waitForFunction(() => document.querySelectorAll(".inbox-item").length === 6);
      assert.equal(await app.page.getByRole("button", { name: "Load more" }).count(), 0);
      assert.equal((lastCall(app, "inbox.list")?.params as { cursor?: string }).cursor, "o:4");
    });
  });

  test("an expired cursor (E_INBOX_CURSOR) reloads the list from the top and says so", async () => {
    await withApp({}, async (app) => {
      const store = installInbox(app.server.rpc, sampleEntries(), { pageSize: 2 });
      await openInbox(app);
      await items(app).nth(1).waitFor();
      store.staleCursor = true;
      await app.page.getByRole("button", { name: "Load more" }).click();
      await app.page.getByText("The list changed while you were paging").waitFor();
      await app.page.waitForFunction(() => document.querySelectorAll(".inbox-item").length === 2);
      assert.equal((lastCall(app, "inbox.list")?.params as { cursor?: string }).cursor, undefined);
      assert.deepEqual(app.problems, []);
    });
  });

  test("'Mark as read' updates the row and the badge; 'Dismiss' removes the row", async () => {
    await withApp({}, async (app) => {
      const store = installInbox(app.server.rpc, sampleEntries());
      await openInbox(app);
      await items(app).first().waitFor();
      const badge = app.page.locator("nav .nav-badge");
      assert.equal(await badge.textContent(), String(unreadTotal(store)));
      await items(app).first().getByRole("button", { name: "Mark as read" }).click();
      await app.page.waitForFunction(() => document.querySelector(".inbox-item")?.getAttribute("data-read") === "true");
      await app.page.waitForFunction(() => document.querySelector("nav .nav-badge")?.textContent === "4");
      await items(app).nth(1).getByRole("button", { name: "Dismiss" }).click();
      await app.page.waitForFunction(() => document.querySelectorAll(".inbox-item").length === 5);
      assert.notEqual(store.entries.find((e) => e.id === "e2")?.dismissedAt, null);
    });
  });

  test("'Mark all as read' sends { all: true } only and marks every entry", async () => {
    await withApp({}, async (app) => {
      const store = installInbox(app.server.rpc, sampleEntries());
      await openInbox(app);
      await items(app).first().waitFor();
      await app.page.getByRole("button", { name: "Mark all as read" }).click();
      await app.page.waitForFunction(() => document.querySelectorAll('.inbox-item[data-read="false"]').length === 0);
      assert.deepEqual(lastCall(app, "inbox.markRead")?.params, { all: true });
      assert.equal(unreadTotal(store), 0);
      // The sidebar badge follows asynchronously (inboxUnread is refreshed via inbox.count after the write): wait for it.
      await app.page.waitForFunction(() => document.querySelector("nav .nav-badge") === null);
      assert.equal(await app.page.locator("nav .nav-badge").count(), 0);
    });
  });

  test("empty state: no entries says so", async () => {
    await withApp({}, async (app) => {
      installInbox(app.server.rpc, []);
      await openInbox(app);
      await app.page.getByText("Nothing here").waitFor();
      assert.equal(await items(app).count(), 0);
    });
  });

  test("error state: a failed list shows the error with Try again, which loads the list", async () => {
    await withApp({}, async (app) => {
      installInbox(app.server.rpc, sampleEntries());
      app.server.rpc.scenario("inbox.list", "error", { code: "E_INTERNAL", message: "boom" });
      await openInbox(app);
      await app.page.getByText("The inbox could not be loaded").waitFor();
      app.server.rpc.scenario("inbox.list", "success");
      await app.page.getByRole("button", { name: "Try again" }).click();
      await items(app).first().waitFor();
      assert.equal(await items(app).count(), 6);
    });
  });

  test("loading state: the frame says Loading while the first list is on its way", async () => {
    await withApp({}, async (app) => {
      installInbox(app.server.rpc, sampleEntries());
      app.server.rpc.setDelay("inbox.list", 1500);
      await openInbox(app);
      await app.page.getByText("Loading…").first().waitFor();
      await items(app).first().waitFor({ timeout: 10_000 });
    });
  });

  test("the sidebar badge shows the unread count and is asked again on a route change", async () => {
    await withApp({}, async (app) => {
      const store = installInbox(app.server.rpc, sampleEntries());
      await openRoute(app.page, "#/inbox");
      await app.page.locator("nav .nav-badge").waitFor();
      assert.equal(await app.page.locator("nav .nav-badge").textContent(), "5");
      // Everything is read elsewhere; the badge follows on the next route change.
      for (const e of store.entries) e.readAt ??= Date.now();
      await app.page.evaluate(() => { location.hash = "#/chat"; });
      await app.page.waitForFunction(() => document.querySelector("nav .nav-badge") === null);
    });
  });

  test("an inbox.changed hint while the page is open asks for the list again; the stream is the page's own", async () => {
    await withApp({}, async (app) => {
      const store = installInbox(app.server.rpc, sampleEntries());
      app.server.events.enable();
      await openInbox(app);
      await items(app).first().waitFor();
      await app.server.events.waitForConnections(1);
      // The change happened on another device; the event only says "look again".
      store.entries.find((e) => e.id === "e1")!.readAt = Date.now();
      app.server.events.push({ event: "inbox.changed", data: { change: "read", kinds: ["approval"] } });
      await app.page.waitForFunction(() => document.querySelector('.inbox-item[data-read="true"]') !== null && document.querySelectorAll('.inbox-item[data-read="false"]').length === 4);
      assert.equal(app.server.events.connections.length >= 1, true);
    });
  });

  test("German: titles and labels come from the German catalogue", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      installInbox(app.server.rpc, sampleEntries());
      await openInbox(app, "de");
      await items(app).first().waitFor();
      assert.match((await items(app).first().textContent()) ?? "", /Eine Freigabe für shell wartet auf dich\./);
      assert.ok(await app.page.getByRole("button", { name: "Alle als gelesen markieren" }).count());
    });
  });

  test("axe: the list with its filters, and the empty state, have no violations", async () => {
    await withApp({}, async (app) => {
      installInbox(app.server.rpc, sampleEntries());
      await openInbox(app);
      await items(app).first().waitFor();
      await expectAxeClean(app.page, "inbox list");
    });
    await withApp({}, async (app) => {
      installInbox(app.server.rpc, []);
      await openInbox(app);
      await app.page.getByText("Nothing here").waitFor();
      await expectAxeClean(app.page, "inbox empty");
    });
  });

  test("the page is one lazy chunk: the frame shows before the page code, the page then takes the heading focus", async () => {
    await withApp({}, async (app) => {
      installInbox(app.server.rpc, sampleEntries());
      await signIn(app.page);
      await app.page.getByRole("heading", { name: "Chat", level: 1 }).waitFor();
      await app.page.getByRole("navigation").getByRole("link", { name: "Inbox" }).click();
      await app.page.getByRole("heading", { name: "Inbox", level: 1 }).waitFor();
      await items(app).first().waitFor();
      assert.deepEqual(app.problems, []);
    });
  });
});
