// Step 12 (Inbox) of the server hardening sweep, against the mock API in a real Chromium (skipped, with a reason, where none is
// found). Already pinned elsewhere (not repeated): list, titles and links, filters and chips, paging and the stale cursor, mark read,
// dismiss, the five states, the badge and its refresh, one hint reloading the list, German, one axe pass, the lazy chunk
// (inbox-page.test.ts); the pure model (inbox-model.test.ts). The audience of an entry is decided by the backend: the page shows
// what it is sent and filters nothing by role itself.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { entry, installInbox, sampleEntries, unreadTotal } from "./inbox-fixtures.ts";
import * as model from "../src/pages/inbox/model.ts";

// `isEntry` is what the page asks of every entry before it draws it; looked up by name so a missing export is a red test, not a load error.
const isEntry = (v: unknown): boolean => { const f = (model as unknown as { isEntry?: (x: unknown) => boolean }).isEntry; if (!f) throw new Error("model.isEntry does not exist"); return f(v); };

before(setup);
after(teardown);
const opts = { skip: browserSkip };
const rows = (app: App) => app.page.locator(".inbox-item");
const calls = (app: App, method: string) => app.server.rpc.calls.filter((c) => c.method === method);
async function openInbox(app: App, lang: "en" | "de" = "en"): Promise<void> {
  await openRoute(app.page, "#/inbox", lang); await app.page.getByRole("heading", { name: lang === "de" ? "Posteingang" : "Inbox", level: 1 }).waitFor();
}
const many = (n: number) => Array.from({ length: n }, (_, i) => entry({ id: `m${String(i).padStart(3, "0")}`, kind: "system", titleKey: "inbox.jobFailed", params: { job: `job-${i}` }, createdAt: 1_800_000_000_000 - i * 1000 }));

describe("inbox: live updates", opts, () => {
  test("a burst of hints leaves no entry twice and keeps the order the backend gave", async () => {
    await withApp({}, async (app) => {
      const store = installInbox(app.server.rpc, sampleEntries()); app.server.events.enable(); await openInbox(app); await rows(app).first().waitFor(); await app.server.events.waitForConnections(1);
      for (let i = 0; i < 6; i++) { store.entries.unshift(entry({ id: `n${i}`, kind: "system", titleKey: "inbox.jobFailed", params: { job: `fresh-${i}` }, createdAt: 1_800_000_000_000 + i })); app.server.events.push({ event: "inbox.changed", data: { change: "created", kinds: ["system"] } }); }
      await app.page.waitForFunction(() => document.querySelectorAll(".inbox-item").length === 12); await app.page.waitForTimeout(300);
      const ids = await rows(app).evaluateAll((els) => els.map((e) => e.querySelector(".inbox-title")?.id ?? "")); assert.equal(new Set(ids).size, ids.length, "an entry is on the page twice");
      assert.deepEqual(ids, [...store.entries].sort((a, b) => b.createdAt - a.createdAt).map((e) => `inbox-title-${e.id}`));
    });
  });

  test("a refresh after 'Load more' keeps the entries that were already shown instead of dropping back to the first page", async () => {
    await withApp({}, async (app) => {
      const store = installInbox(app.server.rpc, many(130), { pageSize: 200 }); app.server.events.enable(); await openInbox(app); await rows(app).first().waitFor(); await app.server.events.waitForConnections(1);
      await app.page.getByRole("button", { name: "Load more" }).click(); await app.page.waitForFunction(() => document.querySelectorAll(".inbox-item").length === 100);
      store.entries.unshift(entry({ id: "late", kind: "system", titleKey: "inbox.jobFailed", params: { job: "late" }, createdAt: 1_900_000_000_000 })); app.server.events.push({ event: "inbox.changed", data: { change: "created", kinds: ["system"] } });
      await app.page.waitForFunction(() => document.querySelector("#inbox-title-late") !== null); await app.page.waitForTimeout(300);
      assert.ok((await rows(app).count()) >= 100, `${await rows(app).count()} rows after the refresh; the page forgot what it had loaded`);
      const ids = await rows(app).evaluateAll((els) => els.map((e) => e.querySelector(".inbox-title")?.id ?? "")); assert.equal(new Set(ids).size, ids.length);
    });
  });

  test("a refresh that fails in the background keeps the list on screen and says so; it does not replace the list with an error page", async () => {
    await withApp({}, async (app) => {
      installInbox(app.server.rpc, sampleEntries()); app.server.events.enable(); await openInbox(app); await rows(app).first().waitFor(); await app.server.events.waitForConnections(1);
      app.server.rpc.scenario("inbox.list", "error"); app.server.events.push({ event: "inbox.changed", data: { change: "read", kinds: ["approval"] } }); await app.page.waitForTimeout(600);
      assert.equal(await rows(app).count(), 6, "the list vanished because a refresh failed"); assert.equal(await app.page.locator("[data-state=error]").count(), 0);
      await app.page.getByRole("status").filter({ hasText: /did not work|try again/i }).first().waitFor();
    });
  });

  test("after a reconnect the page shows what changed while it was offline, without duplicates", async () => {
    await withApp({}, async (app) => {
      const store = installInbox(app.server.rpc, sampleEntries()); app.server.events.enable(); await openInbox(app); await rows(app).first().waitFor(); await app.server.events.waitForConnections(1);
      app.server.events.dropConnections(); store.entries.unshift(entry({ id: "while-away", kind: "channel", titleKey: "inbox.channel.misconfigured", params: { channel: "matrix" }, createdAt: 1_900_000_000_000 }));
      await app.server.events.waitForConnections(2); await app.page.waitForFunction(() => document.querySelector("#inbox-title-while-away") !== null);
      const ids = await rows(app).evaluateAll((els) => els.map((e) => e.querySelector(".inbox-title")?.id ?? "")); assert.equal(new Set(ids).size, ids.length); assert.equal(ids.length, 7);
    });
  });
});

describe("inbox: what the backend sends is data, never markup, never a reason to crash", () => {
  test("isEntry accepts what the core sends and refuses everything else", () => {
    const good = entry({ id: "a", kind: "system" }); assert.equal(isEntry(good), true);
    for (const bad of [null, undefined, 0, "x", [], {}, { ...good, id: "" }, { ...good, id: 5 }, { ...good, kind: "nope" }, { ...good, severity: "fatal" }, { ...good, titleKey: 5 }, { ...good, params: null }, { ...good, params: [] }, { ...good, createdAt: NaN }, { ...good, createdAt: "1" }, { ...good, createdAt: Infinity }, { ...good, createdAt: 1e300 }, { ...good, readAt: "no" }, { ...good, readAt: NaN }, { ...good, ref: 5 }, { ...good, ref: { route: 5 } }]) assert.equal(isEntry(bad), false, JSON.stringify(bad));
    for (const ok of [{ ...good, ref: null }, { ...good, ref: {} }, { ...good, readAt: 1_700_000_000_000 }, { ...good, params: { a: "x", b: 2, c: true } }]) assert.equal(isEntry(ok), true, JSON.stringify(ok));
  });

  test("entries with a repeated id, a time that is not a time, missing parts or hostile text are skipped or shown as plain text, and the good ones stay", opts, async () => {
    await withApp({}, async (app) => {
      const good = (id: string, over: Record<string, unknown> = {}) => ({ ...entry({ id, kind: "system", titleKey: "inbox.jobFailed", params: { job: id } }), ...over });
      app.server.rpc.handle("inbox.count", () => ({ unread: { system: 3 }, total: 3 }), { write: false });
      app.server.rpc.handle("inbox.list", () => ({ entries: [good("g1"), good("g1"), { ...good("bad-time"), createdAt: "yesterday" }, { ...good("nan"), createdAt: null }, { ...good("no-params"), params: undefined }, null, 7, { id: "x" },
        good("html", { params: { job: "<img src=x onerror=window.__pwned=1>" } }), good("braces", { params: { job: "{job} {unknown} $& \\u0000" } }), good("proto", { titleKey: "__proto__" }), good("ctor", { titleKey: "constructor" }),
        good("route1", { ref: { route: "javascript:alert(1)" } }), good("route2", { ref: { route: "//evil.example/x" } }), good("route3", { ref: { route: "/approvals", objectId: "../../x?y=1#z" } }), good("g2")], nextCursor: null }), { write: false });
      await openInbox(app); await app.page.waitForTimeout(500);
      assert.equal(await app.page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned), undefined); assert.equal(await app.page.locator("main img").count(), 0);
      const ids = await rows(app).evaluateAll((els) => els.map((e) => e.querySelector(".inbox-title")?.id ?? "")); assert.equal(new Set(ids).size, ids.length, "a repeated id is on the page twice");
      assert.ok(ids.includes("inbox-title-g1") && ids.includes("inbox-title-g2"), "the good entries are there"); assert.ok(!ids.includes("inbox-title-bad-time") && !ids.includes("inbox-title-nan"), "an entry without a usable time is shown as if it had one");
      const text = await app.page.locator("main").innerText(); assert.ok(!text.includes("__proto__") && !text.includes("constructor"), "a raw title key reached the page");
      const hrefs = await app.page.locator(".inbox-item a").evaluateAll((els) => els.map((e) => e.getAttribute("href"))); for (const h of hrefs) assert.match(h ?? "", /^#\/[a-z-]+(\/[A-Za-z0-9%._~-]+)?$/, `a link that is not an app route: ${h}`);
      assert.deepEqual(app.problems.filter((p) => !/onerror/.test(p)), []);
    });
  });
});

describe("inbox: bulk actions say what they do", opts, () => {
  test("'Mark all as read' under a kind filter marks only the shown entries (and asks first); entries of other kinds stay unread", async () => {
    await withApp({}, async (app) => {
      const store = installInbox(app.server.rpc, sampleEntries()); await openInbox(app); await rows(app).first().waitFor();
      await app.page.getByRole("button", { name: "Approval", exact: true }).click(); await app.page.waitForFunction(() => document.querySelectorAll(".inbox-item").length === 1);
      const otherUnread = () => store.entries.filter((e) => e.kind !== "approval" && e.readAt === null).length; const before = otherUnread(); assert.ok(before >= 3);
      await app.page.getByRole("button", { name: "Mark all as read" }).click();
      const dialog = app.page.getByRole("dialog"); await dialog.waitFor(); assert.match(await dialog.innerText(), /1/, "the dialog names how many entries it is about"); assert.equal(calls(app, "inbox.markRead").length, 0, "nothing was sent before the confirmation");
      await dialog.getByRole("button", { name: /mark/i }).last().click(); await dialog.waitFor({ state: "detached" });
      assert.deepEqual(calls(app, "inbox.markRead").at(-1)?.params, { ids: ["e1"] }); assert.equal(otherUnread(), before, "entries of other kinds were marked read behind a filter that hid them");
      assert.equal(unreadTotal(store), before);
    });
  });

  test("cancelling the confirmation sends nothing and leaves the page as it was", async () => {
    await withApp({}, async (app) => {
      const store = installInbox(app.server.rpc, sampleEntries()); await openInbox(app); await rows(app).first().waitFor();
      await app.page.getByRole("button", { name: "Approval", exact: true }).click(); await app.page.waitForFunction(() => document.querySelectorAll(".inbox-item").length === 1);
      await app.page.getByRole("button", { name: "Mark all as read" }).click(); await app.page.getByRole("dialog").getByRole("button", { name: /cancel/i }).click(); await app.page.getByRole("dialog").waitFor({ state: "detached" });
      assert.equal(calls(app, "inbox.markRead").length, 0); assert.equal(unreadTotal(store), 5);
    });
  });
});

describe("inbox: the keyboard keeps its place", opts, () => {
  test("after 'Mark as read' the focus stays in that entry, on a control that still exists, never on the page body", async () => {
    await withApp({}, async (app) => {
      installInbox(app.server.rpc, sampleEntries()); await openInbox(app); await rows(app).first().waitFor();
      const btn = rows(app).first().getByRole("button", { name: "Mark as read" }); await btn.focus(); await app.page.keyboard.press("Enter");
      await app.page.waitForFunction(() => document.querySelector(".inbox-item")?.getAttribute("data-read") === "true");
      await app.page.waitForFunction(() => document.activeElement?.closest(".inbox-item") !== null && document.activeElement !== document.body, undefined, { timeout: 2000 }).catch(() => {});
      const where = await app.page.evaluate(() => { const a = document.activeElement; return { tag: a?.tagName, inRow: !!a?.closest(".inbox-item"), text: a?.textContent }; });
      assert.equal(where.inRow, true, `the focus fell to <${where.tag}> when the button it was on went away`);
    });
  });

  test("after marking read under 'Only unread' (the entry leaves the list) and after 'Load more' on the last page, the focus is on something on the page", async () => {
    await withApp({}, async (app) => {
      installInbox(app.server.rpc, many(60), { pageSize: 200 }); await openInbox(app); await rows(app).first().waitFor();
      await app.page.getByRole("button", { name: "Load more" }).focus(); await app.page.keyboard.press("Enter"); await app.page.waitForFunction(() => document.querySelectorAll(".inbox-item").length === 60);
      assert.notEqual(await app.page.evaluate(() => document.activeElement?.tagName), "BODY", "the focus was lost when the last 'Load more' button went away");
      await app.page.getByLabel("Only unread").check(); await app.page.waitForFunction(() => document.querySelectorAll(".inbox-item").length === 50); await app.page.waitForTimeout(200);
      await rows(app).first().getByRole("button", { name: "Mark as read" }).focus(); await app.page.keyboard.press("Enter"); await app.page.waitForFunction(() => document.querySelectorAll(".inbox-item").length === 49);
      assert.notEqual(await app.page.evaluate(() => document.activeElement?.tagName), "BODY", "the focus was lost when the entry left the list");
    });
  });

  test("the kind chips work by keyboard and say which are pressed", async () => {
    await withApp({}, async (app) => {
      installInbox(app.server.rpc, sampleEntries()); await openInbox(app); await rows(app).first().waitFor();
      const chip = app.page.getByRole("button", { name: "Approval", exact: true }); await chip.focus(); await app.page.keyboard.press("Space"); await app.page.waitForFunction(() => document.querySelectorAll(".inbox-item").length === 1);
      assert.equal(await chip.getAttribute("aria-pressed"), "true"); assert.equal(await app.page.getByRole("button", { name: "All kinds" }).getAttribute("aria-pressed"), "false");
      await app.page.keyboard.press("Enter"); await app.page.waitForFunction(() => document.querySelectorAll(".inbox-item").length === 6); assert.equal(await chip.getAttribute("aria-pressed"), "false");
    });
  });
});

describe("inbox: the backend decides who sees what", opts, () => {
  for (const role of ["owner", "admin", "operator", "member", "viewer"] as const) {
    test(`${role}: every entry the backend sends is shown and every action is offered; nothing is hidden by role on the page`, async () => {
      await withApp({ server: { role } }, async (app) => {
        installInbox(app.server.rpc, sampleEntries()); await openInbox(app); await rows(app).first().waitFor();
        assert.equal(await rows(app).count(), 6, `${role}: entries were filtered by the page`); assert.equal(await app.page.getByRole("button", { name: "Dismiss" }).count(), 6); assert.equal(await app.page.getByRole("button", { name: "Mark all as read" }).isDisabled(), false);
        assert.equal(calls(app, "inbox.list").every((c) => !JSON.stringify(c.params ?? {}).includes(role)), true, "the page sent the role or a person to the backend");
      });
    });
  }
});

describe("inbox: the badge only ever shows a count", opts, () => {
  test("counts that are not counts (text, negative, NaN-like, huge, missing) give no badge or a plain capped number, never 'NaN' or text", async () => {
    for (const unread of [{ system: "x", approval: 2 }, { system: -5 }, { system: -5, approval: 3 }, { system: 1e308, approval: 1e308 }, { system: null }, {}, "none", null]) {
      await withApp({}, async (app) => {
        app.server.rpc.handle("inbox.count", () => ({ unread, total: 0 }), { write: false }); app.server.rpc.handle("inbox.list", () => ({ entries: [], nextCursor: null }), { write: false });
        await openInbox(app); await app.page.waitForTimeout(250);
        const badge = await app.page.locator("nav .nav-badge").allInnerTexts(); for (const b of badge) assert.match(b, /^([1-9]\d?|99\+)$/, `the badge shows "${b}" for ${JSON.stringify(unread)}`);
      });
    }
  });
});

describe("inbox: accessible in every state", opts, () => {
  for (const [width, scheme, lang] of [[1440, "light", "en"], [360, "dark", "de"]] as const) {
    test(`axe finds nothing in the list, with an entry per kind and severity, the error and the forbidden state (${width} px, ${scheme}, ${lang})`, async () => {
      for (const state of ["list", "error", "forbidden"] as const) {
        await withApp({ width, colorScheme: scheme, locale: lang === "de" ? "de-DE" : "en-US" }, async (app) => {
          installInbox(app.server.rpc, sampleEntries()); if (state !== "list") app.server.rpc.scenario("inbox.list", state);
          await openInbox(app, lang); await app.page.waitForTimeout(500); await expectAxeClean(app.page, `inbox ${state} ${width}px ${scheme} ${lang}`);
          const overflow = await app.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); assert.ok(overflow <= 0, `${overflow}px of horizontal scrolling`);
        });
      }
    });
  }
});
