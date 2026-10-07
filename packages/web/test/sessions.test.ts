// Sessions tab of /logs (K7): metadata-only overview of session.list, filter / search / sort / paging, break-glass path, states, roles.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { installSessions, makeSessions, NOW, type SessionRow } from "./activity-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

async function open(app: App, rows: SessionRow[] = makeSessions(30), lang: "en" | "de" = "en", truncated = false): Promise<SessionRow[]> {
  installSessions(app.server, rows, truncated);
  await app.page.clock.setFixedTime(NOW);
  await openRoute(app.page, "#/logs/sessions", lang);
  return rows;
}
const rowsOf = (app: App) => app.page.locator("li.session-row");
const calls = (app: App, m: string) => app.server.rpc.calls.filter((c) => c.method === m);
const titles = async (app: App): Promise<string[]> => (await app.page.locator(".session-title").allTextContents());

describe("sessions: overview", opts, () => {
  test("lists metadata of the caller's direct sessions: title, id, agent, created, last activity, turns", async () => {
    await withApp({}, async (app) => {
      await open(app);
      await rowsOf(app).first().waitFor();
      const first = rowsOf(app).first();
      const text = (await first.textContent()) ?? "";
      for (const s of ["Chat 0", "ses_0", "Agent", "Created", "Last activity", "Turns", "View transcript"]) assert.ok(text.includes(s), `lacks ${s}: ${text}`);
      assert.equal(calls(app, "session.list").length, 1);
      const p = calls(app, "session.list")[0]!.params as Record<string, unknown>;
      assert.deepEqual([p.kind, p.archived, p.limit], ["direct", "any", 200]);
    });
  });

  test("default sort is last activity, newest first; archived sessions are hidden until the status filter says otherwise", async () => {
    await withApp({}, async (app) => {
      await open(app);
      await rowsOf(app).first().waitFor();
      const active = makeSessions(30).filter((s) => s.archivedAt === null).length;
      assert.equal(await app.page.getByRole("status").filter({ hasText: "Showing" }).textContent(), `Showing 1 to 20 of ${active}`);
      assert.equal(await app.page.locator(".session-row .badge", { hasText: "Archived" }).count(), 0);
      await app.page.getByLabel("Status").selectOption("archived");
      await app.page.waitForFunction(() => document.querySelectorAll(".session-row .badge").length > 0);
      assert.equal(await rowsOf(app).count(), makeSessions(30).filter((s) => s.archivedAt !== null).length);
    });
  });

  test("text search matches title, id and agent; the agent and status filters narrow; Clear filters resets", async () => {
    await withApp({}, async (app) => {
      await open(app);
      await rowsOf(app).first().waitFor();
      await app.page.getByLabel("Search by title, ID or agent").fill("chat 003");
      await app.page.waitForFunction(() => document.querySelectorAll(".session-row").length === 1);
      assert.deepEqual(await titles(app), ["Chat 003"]);
      await app.page.getByLabel("Search by title, ID or agent").fill("ses_005");
      await app.page.waitForFunction(() => document.querySelector(".session-title")?.textContent === "Chat 005");
      await app.page.getByLabel("Search by title, ID or agent").fill("zzz");
      await app.page.getByText("No sessions match", { exact: true }).waitFor();
      await app.page.getByRole("button", { name: "Clear filters" }).click();
      await rowsOf(app).first().waitFor();
      assert.equal(await app.page.getByLabel("Search by title, ID or agent").inputValue(), "");
      await app.page.getByLabel("Agent", { exact: true }).selectOption("ops");
      await app.page.waitForFunction(() => Array.from(document.querySelectorAll(".session-row dl")).every((d) => d.textContent?.includes("ops")));
    });
  });

  test("date filter bounds the last activity", async () => {
    await withApp({}, async (app) => {
      await open(app);
      await rowsOf(app).first().waitFor();
      // fixtures: last turns fall on 2 Oct 2026 (+ i hours); created 1 Oct
      await app.page.getByLabel("Last activity from").fill("2026-10-04");
      await app.page.getByText("No sessions match", { exact: true }).waitFor();
      await app.page.getByLabel("Last activity from").fill("2026-10-02");
      await app.page.getByLabel("Last activity until").fill("2026-10-02");
      await rowsOf(app).first().waitFor();
    });
  });

  test("sort by title ascending and by turns descending", async () => {
    await withApp({}, async (app) => {
      await open(app);
      await rowsOf(app).first().waitFor();
      await app.page.getByLabel("Sort by").selectOption("title");
      await app.page.getByLabel("Order").selectOption("asc");
      await app.page.waitForFunction(() => document.querySelector(".session-title")?.textContent === "Chat 001");
      await app.page.getByLabel("Sort by").selectOption("turns");
      await app.page.getByLabel("Order").selectOption("desc");
      await app.page.waitForFunction(() => document.querySelector(".session-title")?.textContent === "Chat 029");
    });
  });

  test("pages of 20: next, previous, range text, disabled ends, and a filter change returns to page 1", async () => {
    await withApp({}, async (app) => {
      await open(app, makeSessions(60));
      const nav = app.page.getByRole("navigation", { name: "Session pages" });
      await nav.waitFor();
      assert.equal(await rowsOf(app).count(), 20);
      assert.equal(await nav.getByRole("button", { name: "Previous page" }).isDisabled(), true);
      assert.ok(((await nav.textContent()) ?? "").includes("Page 1 of 3"));
      await nav.getByRole("button", { name: "Next page" }).click();
      await app.page.waitForFunction(() => document.querySelector(".session-pager")?.textContent?.includes("Page 2 of 3"));
      await nav.getByRole("button", { name: "Next page" }).click();
      await app.page.waitForFunction(() => document.querySelector(".session-pager")?.textContent?.includes("Page 3 of 3"));
      assert.equal(await nav.getByRole("button", { name: "Next page" }).isDisabled(), true);
      assert.equal(await rowsOf(app).count(), 60 - makeSessions(60).filter((s) => s.archivedAt !== null).length - 40);
      await app.page.getByLabel("Agent", { exact: true }).selectOption("main");
      await app.page.waitForFunction(() => document.querySelector(".session-pager")?.textContent?.includes("Page 1 of 1") || document.querySelector(".session-pager") === null);
    });
  });

  test("a truncated answer is said so", async () => {
    await withApp({}, async (app) => {
      await open(app, makeSessions(3), "en", true);
      await app.page.getByText("Only the newest 3 sessions are loaded.", { exact: false }).waitFor();
    });
  });

  test("untitled sessions get a name; a session that never had a turn says so", async () => {
    await withApp({}, async (app) => {
      const rows = makeSessions(1);
      rows[0] = { ...rows[0]!, title: "", lastTurnAt: null, turnCount: 0, pinned: true };
      await open(app, rows);
      const row = rowsOf(app).first();
      await row.waitFor();
      const text = (await row.textContent()) ?? "";
      assert.ok(text.includes("Untitled chat") && text.includes("No messages yet") && text.includes("Pinned"));
    });
  });
});

describe("sessions: transcripts only through break-glass", opts, () => {
  test("View transcript opens the break-glass dialog; a valid form ends in 'not available' and nothing is sent", async () => {
    await withApp({}, async (app) => {
      await open(app);
      await rowsOf(app).first().waitFor();
      const before = app.server.rpc.calls.length;
      await app.page.getByRole("button", { name: "View transcript: Chat 029" }).click();
      const dlg = app.page.getByRole("dialog");
      await dlg.waitFor();
      assert.ok(((await dlg.textContent()) ?? "").includes("Chat 029 (ses_029)"));
      await dlg.getByLabel("Reason (10 to 500 characters)").fill("Investigating a support case");
      await dlg.getByRole("button", { name: "Request access" }).click();
      await dlg.getByText("Break-glass is not available on this harness yet. Nothing was requested.").waitFor();
      assert.deepEqual(app.server.rpc.calls.slice(before).map((c) => c.method), [], "no RPC at all was sent while the dialog was used");
      assert.equal(app.server.rpc.calls.some((c) => c.method.startsWith("breakglass") || c.method === "session.resume" || c.method === "session.events"), false);
      await dlg.getByRole("button", { name: "Cancel" }).click();
      await dlg.waitFor({ state: "detached" });
      await app.page.getByRole("button", { name: "View transcript: Chat 029" }).waitFor();
    });
  });

  test("the page never calls anything that reads messages", async () => {
    await withApp({}, async (app) => {
      await open(app);
      await rowsOf(app).first().waitFor();
      const methods = new Set(app.server.rpc.calls.map((c) => c.method));
      for (const m of ["session.resume", "session.events", "session.get", "breakglass.request"]) assert.equal(methods.has(m), false, m);
      const p = calls(app, "session.list")[0]!.params as Record<string, unknown>;
      assert.equal("search" in p, false, "no server-side full-text search over messages");
    });
  });

  test("no transcript text in the DOM: a stray preview or message field of the server never shows", async () => {
    await withApp({}, async (app) => {
      const rows = makeSessions(3).map((r) => ({ ...r, preview: "TOP-SECRET-PREVIEW", messages: [{ text: "TOP-SECRET-MESSAGE" }] })) as SessionRow[];
      await open(app, rows);
      await rowsOf(app).first().waitFor();
      const html = await app.page.content();
      assert.equal(html.includes("TOP-SECRET"), false);
    });
  });
});

describe("sessions: states and roles", opts, () => {
  test("loading", async () => {
    await withApp({}, async (app) => {
      installSessions(app.server, makeSessions(3));
      app.server.rpc.setDelay("session.list", 1500);
      await app.page.clock.setFixedTime(NOW);
      await openRoute(app.page, "#/logs/sessions");
      await app.page.locator('[data-state="loading"]').first().waitFor();
      await rowsOf(app).first().waitFor();
    });
  });
  test("empty", async () => {
    await withApp({}, async (app) => {
      await open(app, []);
      await app.page.getByText("No direct chats yet", { exact: true }).waitFor();
    });
  });
  test("error: Try again recovers", async () => {
    await withApp({}, async (app) => {
      installSessions(app.server, makeSessions(3));
      app.server.rpc.scenario("session.list", "error");
      await openRoute(app.page, "#/logs/sessions");
      await app.page.locator('[data-state="error"]').waitFor();
      app.server.rpc.scenario("session.list", "success");
      await app.page.getByRole("button", { name: "Try again" }).click();
      await rowsOf(app).first().waitFor();
    });
  });
  test("forbidden by the server", async () => {
    await withApp({}, async (app) => {
      installSessions(app.server, makeSessions(3));
      app.server.rpc.scenario("session.list", "forbidden");
      await openRoute(app.page, "#/logs/sessions");
      await app.page.locator('[data-state="forbidden"]').first().waitFor();
    });
  });
  test("unavailable (session.list missing)", async () => {
    await withApp({}, async (app) => {
      installSessions(app.server, makeSessions(3));
      app.server.rpc.scenario("session.list", "unavailable");
      await openRoute(app.page, "#/logs/sessions");
      await app.page.getByText("Sessions are not available", { exact: true }).waitFor();
    });
  });
  for (const role of ["admin", "operator", "viewer"] as const) {
    test(`${role} may use the overview`, async () => {
      await withApp({ server: { role } }, async (app) => {
        await open(app);
        await rowsOf(app).first().waitFor();
      });
    });
  }
  test("member is forbidden (sessions.read is not theirs) and no call is made", async () => {
    await withApp({ server: { role: "member" } }, async (app) => {
      await open(app);
      await app.page.locator('[data-state="forbidden"]').first().waitFor();
      assert.equal(calls(app, "session.list").length, 0);
    });
  });
});

describe("sessions: German", opts, () => {
  test("labels, filters and buttons are German", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      await open(app, makeSessions(5), "de");
      await rowsOf(app).first().waitFor();
      const text = (await app.page.locator("main").textContent()) ?? "";
      for (const s of ["Direkte Chats", "Letzte Aktivität", "Transkript ansehen", "Alle Agenten", "Zeige 1 bis"]) assert.ok(text.includes(s), `lacks ${s}`);
      assert.ok(!/\{\w+\}/.test(text));
    });
  });
});
