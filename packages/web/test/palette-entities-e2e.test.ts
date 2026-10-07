// The palette's entity groups in a real browser: fan-out (groups appear as they arrive, caps, abort, time limit, dropped sources),
// role filtering, keyboard flow, axe and 400 px. The backend is the mock RPC server.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Page } from "playwright";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, setup, signIn, teardown, withApp, type App } from "./harness.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

type Sess = { id: string; title: string; agentId?: string };
type Fx = { agents?: Record<string, { displayName?: string }>; sessions?: Sess[]; sessionDelay?: (search: string) => Promise<void> };
const record = (s: Sess) => ({ id: s.id, kind: "direct", agentId: s.agentId ?? "bernd", scope: "user:t", chatKey: null, title: s.title, pinned: false, memoryMode: "remember", createdAt: 1, updatedAt: 1, lastTurnAt: 1, archivedAt: null, turnCount: 1 });

async function shell(app: App, fx: Fx = {}): Promise<Page> {
  const agents = fx.agents ?? { alpha: { displayName: "Alpha" }, bernd: { displayName: "Bernd das Bot" } };
  const sessions = fx.sessions ?? [{ id: "ses_1", title: "Alpha planning" }, { id: "ses_2", title: "Dinner ideas" }];
  app.server.rpc.handle("config.get", (p) => {
    const key = (p as { key?: string } | undefined)?.key;
    return key === "agents" ? { key, tier: null, value: agents, restartClass: null, restart: null, revision: "r1" } : { key: null, tier: null, value: { metrics: { port: 9464 }, agents }, restartClass: null, restart: null, revision: "r1" };
  }, { write: false });
  app.server.rpc.handle("session.list", async (p) => {
    const search = String((p as { search?: string }).search ?? "").toLowerCase();
    await fx.sessionDelay?.(search);
    return { sessions: sessions.filter((s) => s.title.toLowerCase().includes(search)).map(record), truncated: false };
  }, { write: false });
  await signIn(app.page);
  await app.page.getByRole("heading", { name: "Chat", level: 1 }).waitFor();
  await app.page.keyboard.press(`${(await app.page.evaluate(() => (/mac|iphone|ipad/i.test(navigator.platform) ? "Meta" : "Control")))}+K`);
  await combo(app.page).waitFor();
  return app.page;
}
const dlg = (page: Page) => page.locator("dialog.palette");
const combo = (page: Page) => page.locator("dialog.palette [role=combobox]");
const opt = (page: Page, name: string | RegExp) => dlg(page).getByRole("option", { name });
const groups = (page: Page) => page.locator("dialog.palette [role=group]").evaluateAll((els) => els.map((e) => document.getElementById(e.getAttribute("aria-labelledby") ?? "")?.textContent));
const hash = (page: Page) => page.evaluate(() => location.hash);
const calls = (app: App, method: string) => app.server.rpc.calls.filter((c) => c.method === method);

describe("palette entities: groups", opts, () => {
  test("agents and chats appear for a query, between actions and settings; Enter opens /agents/<id> and /chat/<id>", async () => {
    await withApp({}, async (app) => {
      const page = await shell(app);
      await combo(page).fill("alpha");
      await opt(page, /^Alpha/).first().waitFor();
      await dlg(page).getByRole("group", { name: "Chats" }).waitFor();
      const g = await groups(page);
      assert.ok(g.indexOf("Agents") >= 0 && g.indexOf("Chats") > g.indexOf("Agents"), String(g));
      assert.equal(await dlg(page).getByRole("group", { name: "Agents" }).getByRole("option").count(), 1);
      await dlg(page).getByRole("group", { name: "Agents" }).getByRole("option").click();
      assert.equal(await hash(page), "#/agents/alpha");
      await page.getByRole("heading", { name: "Agents", level: 1 }).waitFor();

      await page.keyboard.press("/");
      await combo(page).fill("alpha planning");
      await dlg(page).getByRole("group", { name: "Chats" }).getByRole("option").waitFor();
      await opt(page, /Alpha planning/).click();
      assert.equal(await hash(page), "#/chat/ses_1");
      assert.deepEqual(app.problems, []);
    });
  });

  test("an agent is found by id as well; a session by a word of its messages (server-side search, shown in the server's order)", async () => {
    await withApp({}, async (app) => {
      const page = await shell(app);
      await combo(page).fill("bernd");
      await dlg(page).getByRole("group", { name: "Agents" }).getByText("Bernd das Bot").waitFor();
      assert.deepEqual(calls(app, "session.list").at(-1)?.params, { kind: "direct", archived: "exclude", search: "bernd", limit: 5 });
    });
  });

  test("each fan-out group is capped at 5, whatever the backend returns", async () => {
    await withApp({}, async (app) => {
      const agents = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`ag${i}`, { displayName: `Agent ${i}` }]));
      const sessions = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, title: `Agent chat ${i}` }));
      const page = await shell(app, { agents, sessions });
      await combo(page).fill("agent");
      await dlg(page).getByRole("group", { name: "Chats" }).waitFor();
      assert.equal(await dlg(page).getByRole("group", { name: "Agents" }).getByRole("option").count(), 5);
      assert.equal(await dlg(page).getByRole("group", { name: "Chats" }).getByRole("option").count(), 5);
    });
  });

  test("nothing is asked for an empty query; the blank list is pages and actions only", async () => {
    await withApp({}, async (app) => {
      const page = await shell(app);
      assert.deepEqual(await groups(page), ["Navigation", "Actions"]);
      const searches = (): number => calls(app, "session.list").filter((c) => "search" in (c.params as object)).length; // the chat page behind the dialog lists too, without a search
      const before = searches();
      await combo(page).fill("  ");
      await new Promise((r) => setTimeout(r, 300)); // longer than the debounce
      assert.equal(searches(), before);
    });
  });

  test("German: group headings and action labels are German", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      app.server.rpc.handle("config.get", () => ({ key: "agents", tier: null, value: { alpha: { displayName: "Alpha" } }, restartClass: null, restart: null, revision: "r1" }), { write: false });
      app.server.rpc.handle("session.list", () => ({ sessions: [record({ id: "s1", title: "Alpha Chat" })], truncated: false }), { write: false });
      await signIn(app.page, undefined, "de");
      await app.page.getByRole("heading", { name: "Chat", level: 1 }).waitFor();
      await app.page.keyboard.press(`${(await app.page.evaluate(() => (/mac|iphone|ipad/i.test(navigator.platform) ? "Meta" : "Control")))}+K`);
      await combo(app.page).fill("alpha");
      await dlg(app.page).getByRole("group", { name: "Agenten" }).waitFor();
      await dlg(app.page).getByRole("group", { name: "Chats" }).waitFor();
      await combo(app.page).fill("agent anlegen");
      await opt(app.page, /Agent anlegen/).waitFor();
    });
  });
});

describe("palette entities: actions and log search", opts, () => {
  test("actions open their routes", async () => {
    await withApp({}, async (app) => {
      const page = await shell(app);
      for (const [q, target] of [["create agent", "#/agents/new"], ["run setup", "#/setup"], ["new chat", "#/chat/new"], ["open logs", "#/logs"], ["verify audit", "#/logs/activity"]] as const) {
        if (!(await combo(page).count())) await page.keyboard.press("/");
        await combo(page).fill(q);
        await dlg(page).getByRole("group", { name: "Actions" }).getByRole("option").first().waitFor();
        await dlg(page).getByRole("group", { name: "Actions" }).getByRole("option").first().click();
        assert.equal(await hash(page), target, q);
        await page.locator("main h1").first().waitFor();
      }
    });
  });

  test("'Search logs for ...' is the last entry, opens /logs?q=<text>; a trace-shaped query also offers /logs?trace=", async () => {
    await withApp({}, async (app) => {
      const page = await shell(app);
      await combo(page).fill("disk full");
      const last = dlg(page).getByRole("option").last();
      await last.waitFor();
      assert.equal(await last.textContent(), "Search logs for “disk full”");
      await page.keyboard.press("End"); // caret at the end of the text: End jumps to the last option
      await page.keyboard.press("Enter");
      assert.equal(await hash(page), "#/logs?q=disk%20full");
      await page.keyboard.press("/");
      await combo(page).fill("0af7651916cd43dd8448eb211c80319c");
      await opt(page, /Find trace/).click();
      assert.equal(await hash(page), "#/logs?trace=0af7651916cd43dd8448eb211c80319c");
      await page.getByRole("heading", { name: "Logs", level: 1 }).waitFor();
    });
  });
});

describe("palette entities: fan-out behaviour", opts, () => {
  test("fast typing: the older generation is aborted and its (late) answer never shows", async () => {
    await withApp({}, async (app) => {
      let releaseOld!: () => void;
      const oldGate = new Promise<void>((r) => { releaseOld = r; });
      const page = await shell(app, {
        sessions: [{ id: "old", title: "Al OLD answer" }, { id: "new", title: "Alp NEW answer" }],
        // "al" matches both titles on the server; the stale answer is held back until the newer one has been shown.
        sessionDelay: async (search) => { if (search === "al") await oldGate; },
      });
      await page.evaluate(() => {
        (window as unknown as { seen: string[] }).seen = [];
        new MutationObserver(() => { for (const o of Array.from(document.querySelectorAll("dialog.palette [role=option]"))) (window as unknown as { seen: string[] }).seen.push(o.textContent ?? ""); }).observe(document.body, { childList: true, subtree: true, characterData: true });
      });
      await combo(page).fill("al");
      while (!calls(app, "session.list").some((c) => (c.params as { search: string }).search === "al")) await new Promise((r) => setTimeout(r, 10));
      await combo(page).fill("alp");
      await opt(page, /Alp NEW answer/).waitFor();
      releaseOld();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(await opt(page, /OLD/).count(), 0);
      assert.equal((await page.evaluate(() => (window as unknown as { seen: string[] }).seen)).some((s) => s.includes("OLD")), false);
    });
  });

  test("a slow source is dropped after 1.5 s: the fast group stays, no error is shown", async () => {
    await withApp({}, async (app) => {
      let finished!: () => void;
      const done = new Promise<void>((r) => { finished = r; });
      const page = await shell(app, { sessionDelay: async () => { await new Promise((r) => setTimeout(r, 2000)); finished(); } });
      await combo(page).fill("alpha");
      await dlg(page).getByRole("group", { name: "Agents" }).waitFor(); // arrived first, while the sessions are still pending
      assert.equal(await dlg(page).getByRole("group", { name: "Chats" }).count(), 0);
      await done; // the slow answer has now been sent (after the client gave up)
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(await dlg(page).getByRole("group", { name: "Chats" }).count(), 0);
      assert.equal(await page.locator("dialog.palette [role=alert]").count(), 0);
      assert.deepEqual(app.problems, []);
    });
  });

  test("a forbidden, an unavailable or a failing source drops only its group, silently", async () => {
    for (const [method, scenario, other] of [["session.list", "forbidden", "Agents"], ["session.list", "unavailable", "Agents"], ["session.list", "error", "Agents"], ["config.get", "forbidden", "Chats"], ["config.get", "error", "Chats"]] as const) {
      await withApp({}, async (app) => {
        const page = await shell(app);
        app.server.rpc.scenario(method, scenario);
        await combo(page).fill("alpha");
        await dlg(page).getByRole("group", { name: other }).waitFor();
        await new Promise((r) => setTimeout(r, 150));
        const g = await groups(page);
        assert.equal(g.includes(method === "session.list" ? "Chats" : "Agents"), false, `${method} ${scenario}`);
        assert.equal(await page.locator("dialog.palette [role=alert]").count(), 0);
        assert.deepEqual(app.problems, []);
      });
    }
  });
});

const ROLES = {
  owner: { logs: true, admin: true }, admin: { logs: true, admin: true }, operator: { logs: true, admin: false }, member: { logs: false, admin: false }, viewer: { logs: true, admin: false },
} as const;
describe("palette entities: roles (docs/rbac.md)", opts, () => {
  for (const [role, may] of Object.entries(ROLES)) {
    test(`${role}: ${may.logs ? "Logs entries" : "no Logs entries"}, ${may.admin ? "admin entries" : "no Users, Secrets or agent-admin entries"}`, async () => {
      await withApp({ server: { role } }, async (app) => {
        const page = await shell(app);
        const labels = async (q: string): Promise<string[]> => { await combo(page).fill(q); await new Promise((r) => setTimeout(r, 30)); return dlg(page).getByRole("option").allTextContents(); };
        const has = async (q: string, re: RegExp): Promise<boolean> => (await labels(q)).some((l) => re.test(l));
        assert.equal(await has("logs", /^Logs/), may.logs, "nav logs");
        assert.equal(await has("open logs", /Open logs/), may.logs, "action open logs");
        assert.equal(await has("log", /Search logs for/), may.admin, "log search");
        assert.equal(await has("audit", /Verify audit trail/), may.admin, "verify audit");
        assert.equal(await has("users", /^Users/), may.admin, "users");
        assert.equal(await has("secrets", /^Secrets/), may.admin, "secrets");
        assert.equal(await has("fileFallback", /secrets\.fileFallback/), may.admin, "secrets setting");
        assert.equal(await has("create agent", /Create agent/), may.admin, "create agent");
        assert.equal(await has("run setup", /Run setup/), may.admin, "run setup");
        assert.equal(await has("new chat", /New chat/), true, "new chat");
        assert.equal(await has("loopback", /Allow loopback/), true, "network setting stays visible");
        await combo(page).fill("alpha"); // agents and chats are per caller and open to every role
        await dlg(page).getByRole("group", { name: "Agents" }).waitFor();
      });
    });
  }
});

describe("palette entities: keyboard", opts, () => {
  test("arrows, Ctrl+Home/End, Home/End at the text ends; the focus never leaves the input; Enter opens the active entity", async () => {
    await withApp({}, async (app) => {
      const page = await shell(app);
      await combo(page).fill("alpha");
      await dlg(page).getByRole("group", { name: "Chats" }).waitFor();
      const c = combo(page);
      const options = dlg(page).getByRole("option");
      const n = await options.count();
      const activeIs = async (i: number) => assert.equal(await c.getAttribute("aria-activedescendant"), await options.nth(i).getAttribute("id"));
      await activeIs(0);
      await page.keyboard.press("ArrowDown");
      await activeIs(1);
      await page.keyboard.press("Control+End");
      await activeIs(n - 1);
      await page.keyboard.press("Control+Home");
      await activeIs(0);
      // Plain Home/End move the caret while it is inside the text ...
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("Home");
      await activeIs(0);
      assert.equal(await page.evaluate(() => (document.activeElement as HTMLInputElement).selectionStart), 0);
      await page.keyboard.press("Home"); // ... and jump in the list once the caret is at the start
      await activeIs(0);
      await page.keyboard.press("End");
      await page.keyboard.press("End");
      await activeIs(n - 1);
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("role")), "combobox");
      await page.keyboard.type("x"); // type-ahead stays in the field
      assert.equal(await c.inputValue(), "alphax");
      await c.fill("alpha");
      await dlg(page).getByRole("group", { name: "Agents" }).waitFor();
      await opt(page, /^Alpha/).first().hover();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("Enter");
      assert.equal((await hash(page)).startsWith("#/agents/alpha"), true);
    });
  });

  test("a group arriving above the active option does not move the selection; aria-activedescendant always names an existing option", async () => {
    await withApp({}, async (app) => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const page = await shell(app, { sessionDelay: async () => { await gate; } });
      await combo(page).fill("e");
      await dlg(page).getByRole("group", { name: "Agents" }).waitFor();
      await page.keyboard.press("End");
      const before = await dlg(page).getByRole("option", { selected: true }).textContent();
      release();
      await dlg(page).getByRole("group", { name: "Chats" }).waitFor();
      assert.equal(await dlg(page).getByRole("option", { selected: true }).textContent(), before);
      const ad = await combo(page).getAttribute("aria-activedescendant");
      assert.equal(await page.locator(`[id="${ad}"]`).count(), 1);
    });
  });

  test("the result count is announced politely and only once the list has settled", async () => {
    await withApp({}, async (app) => {
      const page = await shell(app);
      const status = page.locator("dialog.palette [role=status]");
      assert.equal(await status.getAttribute("aria-live"), "polite");
      await combo(page).fill("alpha");
      await dlg(page).getByRole("group", { name: "Chats" }).waitFor();
      const n = await dlg(page).getByRole("option").count();
      await page.waitForFunction((x) => document.querySelector("dialog.palette [role=status]")?.textContent === `${x} results`, n);
    });
  });
});

describe("palette entities: axe and 400 px", opts, () => {
  for (const [scheme, width] of [["light", 1440], ["dark", 1440], ["light", 400], ["dark", 400]] as const) {
    test(`${scheme}, ${width} px: all groups`, async () => {
      await withApp({ colorScheme: scheme, width, height: 800 }, async (app) => {
        const page = await shell(app);
        await combo(page).fill("alpha");
        await dlg(page).getByRole("group", { name: "Chats" }).waitFor();
        await page.keyboard.press("ArrowDown");
        await expectAxeClean(page, "entity groups");
        await combo(page).fill("");
        await expectAxeClean(page, "blank list with actions");
        if (width === 400) {
          await combo(page).fill("alpha");
          await dlg(page).getByRole("group", { name: "Chats" }).waitFor();
          const m = await page.evaluate(() => ({
            page: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            list: document.querySelector<HTMLElement>("dialog.palette [role=listbox]")!.scrollWidth > document.querySelector<HTMLElement>("dialog.palette [role=listbox]")!.clientWidth,
            minTarget: Math.floor(Math.min(...Array.from(document.querySelectorAll("dialog.palette [role=option]")).map((o) => o.getBoundingClientRect().height))),
          }));
          assert.equal(m.page, false);
          assert.equal(m.list, false);
          assert.ok(m.minTarget >= 44, `target ${m.minTarget}`);
        }
      });
    });
  }
});
