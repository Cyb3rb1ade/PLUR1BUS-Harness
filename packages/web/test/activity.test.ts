// Activity tab of /logs (K9): grouped feed from logs.query, audit.verify card, states, paging, roles, German. Mock /rpc.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { rpcError } from "./mock-rpc.ts";
import { at, defaultActivity, diag, installActivity, NOW, type ActivityFx } from "./activity-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

/** Mocks, fixed browser clock (Wed 7 Oct 2026, 12:00 local), sign in, open the Activity tab. */
async function open(app: App, tweak?: (fx: ActivityFx, app: App) => void, lang: "en" | "de" = "en"): Promise<ActivityFx> {
  const fx = installActivity(app.server);
  tweak?.(fx, app);
  await app.page.clock.setFixedTime(NOW);
  await openRoute(app.page, "#/logs/activity", lang);
  return fx;
}
const feed = (app: App) => app.page.getByRole("region", { name: "Recent activity" });
const verifyCard = (app: App) => app.page.getByRole("group", { name: "Audit trail" });
const calls = (app: App, method: string) => app.server.rpc.calls.filter((c) => c.method === method);

describe("activity: feed", opts, () => {
  test("groups by Today, Yesterday, Earlier this week and Older under real headings, with plain sentences", async () => {
    await withApp({}, async (app) => {
      await open(app);
      const f = feed(app);
      await f.getByRole("heading", { level: 3, name: "Today", exact: true }).waitFor();
      const headings = await f.getByRole("heading", { level: 3 }).allTextContents();
      assert.deepEqual(headings, ["Today", "Yesterday", "Earlier this week", "Older"]);
      const text = (await f.textContent()) ?? "";
      for (const s of [
        "Signed in with the profile default.", "Dreaming (dreams.light) finished for agent main.", "The model scan finished.", "A backup failed.",
        "Break-glass access to usr_anna.", "Agent bernd skipped the job cron.report.", "Agent main finished the job cron.report.",
      ]) assert.ok(text.includes(s), `lacks "${s}"`);
      assert.ok(!text.includes("core.logLevel"), "config changes are not part of the feed");
      assert.ok(!text.includes("started"), "start records are not part of the feed");
    });
  });

  test("entries sit in the right group, newest first, with actor, time and an outcome word", async () => {
    await withApp({}, async (app) => {
      await open(app);
      await feed(app).getByRole("heading", { level: 3, name: "Older" }).waitFor();
      const today = app.page.locator('[aria-labelledby="activity-g-today"] li');
      assert.equal(await today.count(), 3);
      assert.ok(((await today.nth(0).textContent()) ?? "").startsWith("Signed in"), "09:30 login is the newest today");
      assert.ok(((await today.nth(0).textContent()) ?? "").includes("By usr_owner"));
      const scan = today.filter({ hasText: "model scan" });
      assert.ok(((await scan.textContent()) ?? "").includes("By the system"));
      assert.ok(((await scan.textContent()) ?? "").includes("Done"), "outcome as a word, not only colour");
      assert.ok(((await scan.locator("time").getAttribute("datetime")) ?? "").startsWith("2026-10-07"));
      const yesterday = app.page.locator('[aria-labelledby="activity-g-yesterday"] li');
      assert.ok(((await yesterday.filter({ hasText: "backup" }).textContent()) ?? "").includes("Failed"));
      assert.equal(await app.page.locator('[aria-labelledby="activity-g-older"] li').count(), 1);
    });
  });

  test("Open in log links to the viewer with q = trace id (or job / target) and the stream", async () => {
    await withApp({}, async (app) => {
      await open(app);
      const link = feed(app).getByRole("link", { name: "Open in log: Dreaming (dreams.light) finished for agent main." });
      assert.equal(await link.getAttribute("href"), "#/logs?q=t-dream&stream=diagnostic");
      assert.equal(await feed(app).getByRole("link", { name: /Break-glass access/ }).getAttribute("href"), "#/logs?q=t-bg&stream=audit");
      await link.click();
      await app.page.waitForFunction(() => location.hash.startsWith("#/logs?q=t-dream"));
    });
  });

  test("Show more loads the next page of each stream and goes away when everything is loaded", async () => {
    await withApp({}, async (app) => {
      await open(app, (fx) => { fx.pageSize = 2; });
      const items = feed(app).locator("li.activity-entry");
      await items.first().waitFor();
      const first = await items.count();
      assert.ok(first < 7);
      const more = feed(app).getByRole("button", { name: "Show more" });
      await more.click();
      await app.page.waitForFunction((n) => document.querySelectorAll("li.activity-entry").length > n, first);
      for (let i = 0; i < 10 && await more.count() > 0; i++) {
        await more.click();
        await app.page.waitForFunction(() => document.querySelector(".activity-more button[aria-disabled='true']") === null);
      }
      assert.equal(await items.count(), 7, "2 audit entries (login, break-glass) + 5 scheduler runs, each once");
      assert.equal(await feed(app).getByRole("button", { name: "Show more" }).count(), 0);
      assert.ok(calls(app, "logs.query").some((c) => (c.params as { cursor?: string }).cursor !== undefined));
    });
  });

  test("the queries are reads with the right filters", async () => {
    await withApp({}, async (app) => {
      await open(app);
      await feed(app).getByRole("heading", { level: 3, name: "Today" }).waitFor();
      const qs = calls(app, "logs.query").map((c) => c.params as Record<string, unknown>);
      assert.deepEqual(qs.map((q) => q.stream).sort(), ["audit", "diagnostic"]);
      assert.equal(qs.find((q) => q.stream === "diagnostic")!.text, "scheduler.run.");
      assert.ok(qs.every((q) => q.order === "desc" && typeof q.limit === "number"));
    });
  });
});

describe("activity: audit trail card", opts, () => {
  test("verified: status word, counts, last check time, and Verify again runs the check again", async () => {
    await withApp({}, async (app) => {
      await open(app);
      const c = verifyCard(app);
      await c.getByText("Verified", { exact: true }).waitFor();
      const text = (await c.textContent()) ?? "";
      assert.ok(text.includes("1,204 records in 3 files"));
      assert.ok(/Last checked .*2026/.test(text), "check time shown (the fixed browser clock is Oct 2026)");
      assert.equal(calls(app, "audit.verify").length, 1);
      await c.getByRole("button", { name: "Verify the audit trail again" }).click();
      await app.page.waitForFunction(() => document.querySelector('[data-verify="verified"]') !== null);
      assert.equal(calls(app, "audit.verify").length, 2);
    });
  });

  test("failed: says so, counts the findings, lists them with file and line, and mentions the unlisted ones", async () => {
    await withApp({}, async (app) => {
      await open(app, (fx) => {
        fx.verify = { ...fx.verify, ok: false, findingsTotal: 9, findings: [{ code: "hash-mismatch", file: "audit-chain.jsonl", line: 12, seq: 12 }, { code: "anchor-missing", file: "audit-chain.anchor", line: null, seq: null }] };
      });
      const c = verifyCard(app);
      await c.getByText("Failed", { exact: true }).waitFor();
      const text = (await c.textContent()) ?? "";
      assert.ok(text.includes("9 findings"));
      assert.ok(text.includes("hash-mismatch in audit-chain.jsonl, line 12"));
      assert.ok(text.includes("anchor-missing in audit-chain.anchor") && !text.includes("anchor.anchor, line"));
      assert.ok(text.includes("7 more findings are not listed."));
    });
  });

  test("unavailable (RPC missing): the card says so, the feed still works", async () => {
    await withApp({}, async (app) => {
      await open(app, (_fx, a) => { a.server.rpc.scenario("audit.verify", "unavailable"); });
      await verifyCard(app).getByText("Unavailable", { exact: true }).waitFor();
      await feed(app).getByRole("heading", { level: 3, name: "Today" }).waitFor();
    });
  });

  test("a failing check is 'Not checked' with a way to retry, and a retry can succeed", async () => {
    await withApp({}, async (app) => {
      await open(app, (_fx, a) => { a.server.rpc.scenario("audit.verify", "error"); });
      const c = verifyCard(app);
      await c.getByText("Not checked", { exact: true }).waitFor();
      app.server.rpc.scenario("audit.verify", "success");
      await c.getByRole("button", { name: "Verify the audit trail again" }).click();
      await c.getByText("Verified", { exact: true }).waitFor();
    });
  });

  test("the status is in a polite live region", async () => {
    await withApp({}, async (app) => {
      await open(app);
      const status = verifyCard(app).getByRole("status");
      await status.getByText("Verified", { exact: true }).waitFor();
    });
  });
});

describe("activity: states", opts, () => {
  test("loading", async () => {
    await withApp({}, async (app) => {
      installActivity(app.server);
      app.server.rpc.setDelay("logs.query", 1500);
      await app.page.clock.setFixedTime(NOW);
      await openRoute(app.page, "#/logs/activity");
      await app.page.locator('[data-state="loading"]').first().waitFor();
      await feed(app).getByRole("heading", { level: 3, name: "Today" }).waitFor();
    });
  });

  test("empty: nothing summarisable", async () => {
    await withApp({}, async (app) => {
      await open(app, (fx) => { fx.audit = []; fx.diagnostic = []; });
      await app.page.getByText("No activity yet", { exact: true }).waitFor();
      assert.equal(await feed(app).locator("li").count(), 0);
    });
  });

  test("error: Try again reloads and recovers", async () => {
    await withApp({}, async (app) => {
      await open(app, (_fx, a) => { a.server.rpc.scenario("logs.query", "error"); });
      await app.page.locator('[data-state="error"]').waitFor();
      app.server.rpc.scenario("logs.query", "success");
      await app.page.getByRole("button", { name: "Try again" }).first().click();
      await feed(app).getByRole("heading", { level: 3, name: "Today" }).waitFor();
    });
  });

  test("forbidden by the server", async () => {
    await withApp({}, async (app) => {
      await open(app, (_fx, a) => { a.server.rpc.scenario("logs.query", "forbidden"); });
      await app.page.locator('[data-state="forbidden"]').first().waitFor();
    });
  });

  test("unavailable (logs.query missing): the state names it and the audit card still answers", async () => {
    await withApp({}, async (app) => {
      await open(app, (_fx, a) => { a.server.rpc.scenario("logs.query", "unavailable"); });
      await app.page.getByText("Activity is not available", { exact: true }).waitFor();
      await verifyCard(app).getByText("Verified", { exact: true }).waitFor();
    });
  });

  test("one stream failing keeps the other's entries and says what is missing", async () => {
    await withApp({}, async (app) => {
      await open(app, (fx, a) => {
        a.server.rpc.handle("logs.query", (p) => {
          const q = p as { stream: string };
          if (q.stream === "audit") throw rpcError("E_INTERNAL", "boom");
          return { records: fx.diagnostic, nextCursor: null, corrupt: 0, scanned: { files: 1, bytes: 1 }, truncated: false };
        }, { write: false });
      });
      await feed(app).getByText("Some entries are missing: the audit log could not be read.").waitFor();
      await feed(app).getByText("The model scan finished.").waitFor();
    });
  });

  for (const role of ["admin"] as const) {
    test(`${role} may use the feed`, async () => {
      await withApp({ server: { role } }, async (app) => {
        await open(app);
        await feed(app).getByRole("heading", { level: 3, name: "Today" }).waitFor();
      });
    });
  }
  for (const role of ["operator", "member", "viewer"] as const) {
    test(`${role} gets the forbidden state and no log or audit call is made`, async () => {
      await withApp({ server: { role } }, async (app) => {
        await open(app);
        await app.page.locator('[data-state="forbidden"]').first().waitFor();
        assert.equal(calls(app, "logs.query").length + calls(app, "audit.verify").length, 0);
      });
    });
  }
});

describe("activity: German", opts, () => {
  test("headings, sentences, outcome words and buttons are German", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      await open(app, undefined, "de");
      const f = app.page.getByRole("region", { name: "Letzte Aktivität" });
      await f.getByRole("heading", { level: 3, name: "Heute" }).waitFor();
      const text = (await f.textContent()) ?? "";
      for (const s of ["Gestern", "Früher in dieser Woche", "Älter", "Mit dem Profil default angemeldet.", "Ein Backup ist fehlgeschlagen.", "Fehlgeschlagen", "Im Protokoll öffnen"]) assert.ok(text.includes(s), `lacks ${s}`);
      await app.page.getByRole("group", { name: "Audit-Kette" }).getByText("Geprüft", { exact: true }).waitFor();
      assert.ok(!/\{\w+\}/.test((await app.page.locator("main").textContent()) ?? ""), "no unfilled placeholder");
    });
  });
});
