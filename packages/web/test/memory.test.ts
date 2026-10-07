// Memories page (M3 E7): health, search with explanation, card list + detail, states per area, live updates. Mock /rpc and /events.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Page } from "playwright";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { defaultFixture, installMemoryMocks, type Fixture } from "./memory-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

/** Installs the mocks (optionally tweaked) before the page is opened, then opens the route. */
async function open(app: App, hash = "#/memories", tweak?: (fx: Fixture, app: App) => void, lang: "en" | "de" = "en"): Promise<Fixture> {
  const fx = installMemoryMocks(app.server, defaultFixture());
  tweak?.(fx, app);
  await openRoute(app.page, hash, lang);
  return fx;
}

const list = (page: Page) => page.getByRole("region", { name: "Memory cards" });
const detail = (page: Page) => page.getByRole("region", { name: "Memory details" });
const health = (page: Page) => page.getByRole("group", { name: "Health" });

describe("memories: health", opts, () => {
  test("shows engine, models, store schema, shared memory and card counts from core.status and memory.state", async () => {
    await withApp({}, async (app) => {
      await open(app);
      const h = health(app.page);
      await h.waitFor();
      await h.getByText("Ready", { exact: true }).first().waitFor();
      await h.getByText("Archived (forgotten)").waitFor();
      const text = (await h.textContent()) ?? "";
      for (const part of ["e5-small", "disabled", "7", "verified-path", "Agent-private", "Workspace", "User", "Archived"]) assert.ok(text.includes(part), `health lacks ${part}: ${text}`);
      assert.equal(app.problems.length, 0, app.problems.join("\n"));
    });
  });

  test("a store schema behind the expected one is flagged as a migration", async () => {
    await withApp({}, async (app) => {
      await open(app, "#/memories", (_fx, a) => {
        a.server.rpc.handle("core.status", () => ({
          process: { state: "degraded", reason: "migrating" }, contract: "1", rpc: "1", instanceId: "i", pid: 1, uptimeMs: 1000,
          engine: { ready: false, degraded: { reason: "store-behind", capability: "store" }, storeSchema: { current: "6", expected: "7" } }, agents: [{ agentId: "main", activity: { state: "idle", since: 1 } }],
        }), { write: false });
      });
      const h = health(app.page);
      await h.getByText("Migration needed").waitFor();
      await h.getByText("Not ready").waitFor();
      assert.ok(((await h.textContent()) ?? "").includes("store-behind"));
    });
  });

  test("memory.state failing does not hide the rest: the health card says so, search and list still work", async () => {
    await withApp({}, async (app) => {
      await open(app, "#/memories", (_fx, a) => { a.server.rpc.scenario("memory.state", "unavailable"); });
      await health(app.page).getByText("Card counts are not available").waitFor();
      await list(app.page).getByRole("link").first().waitFor();
    });
  });

  test("core.status and the REST agent list both missing: one page-level unavailable state", async () => {
    await withApp({}, async (app) => {
      await open(app, "#/memories", (_fx, a) => { a.server.rpc.scenario("core.status", "unavailable"); });
      await app.page.getByRole("heading", { name: "Memory is not available" }).waitFor();
    });
  });
});

describe("memories: list, pagination, detail", opts, () => {
  test("lists 20 cards, loads more until the end, and asks memory.list with caller and agent", async () => {
    await withApp({}, async (app) => {
      await open(app);
      const l = list(app.page);
      await l.getByRole("link").first().waitFor();
      assert.equal(await l.getByRole("link").count(), 20);
      await l.getByRole("button", { name: "Load more" }).click();
      await app.page.waitForFunction(() => document.querySelectorAll('[aria-label="Memory cards"] a').length === 40);
      await l.getByRole("button", { name: "Load more" }).click();
      await app.page.waitForFunction(() => document.querySelectorAll('[aria-label="Memory cards"] a').length === 45);
      assert.equal(await l.getByRole("button", { name: "Load more" }).count(), 0);
      const calls = app.server.rpc.calls.filter((c) => c.method === "memory.list").map((c) => c.params as { caller: { channel: string; userId: string }; agentId: string; limit: number });
      assert.deepEqual(calls.map((c) => c.limit), [20, 40, 60]);
      assert.equal(calls[0]!.agentId, "main");
      assert.equal(calls[0]!.caller.channel, "cli");
      assert.equal(calls[0]!.caller.userId, "owner");
    });
  });

  test("the topic filter narrows the list", async () => {
    await withApp({}, async (app) => {
      await open(app);
      await list(app.page).getByRole("link").first().waitFor();
      await app.page.getByLabel("Filter by topic").fill("memory 01");
      await app.page.getByRole("button", { name: "Apply filter" }).click();
      await app.page.waitForFunction(() => document.querySelectorAll('[aria-label="Memory cards"] a').length === 10);
      assert.equal((app.server.rpc.calls.filter((c) => c.method === "memory.list").at(-1)!.params as { topic: string }).topic, "memory 01");
    });
  });

  test("empty: no memories shows the empty state, not a blank list", async () => {
    await withApp({}, async (app) => {
      await open(app, "#/memories", (fx) => { fx.cards = []; });
      await list(app.page).getByRole("heading", { name: "No memories yet" }).waitFor();
    });
  });

  test("error: an RPC failure shows an alert, Try again recovers", async () => {
    await withApp({}, async (app) => {
      await open(app, "#/memories", (_fx, a) => { a.server.rpc.scenario("memory.list", "error", { code: "E_INTERNAL", message: "boom" }); });
      const alert = list(app.page).getByRole("alert");
      await alert.getByRole("heading", { name: "Something went wrong" }).waitFor();
      app.server.rpc.scenario("memory.list", "success");
      await alert.getByRole("button", { name: "Try again" }).click();
      await list(app.page).getByRole("link").first().waitFor();
    });
  });

  test("forbidden: the list says the role does not allow it", async () => {
    await withApp({}, async (app) => {
      await open(app, "#/memories", (_fx, a) => { a.server.rpc.scenario("memory.list", "forbidden"); });
      await list(app.page).getByRole("heading", { name: "Not allowed" }).waitFor();
      await health(app.page).waitFor();
    });
  });

  test("unavailable list: only the list is unavailable, health and the Dreams tab still work", async () => {
    await withApp({}, async (app) => {
      await open(app, "#/memories", (_fx, a) => { a.server.rpc.scenario("memory.list", "unavailable"); });
      await list(app.page).getByRole("heading", { name: "Memory cards are not available" }).waitFor();
      await health(app.page).getByText("verified-path").waitFor();
      await app.page.getByRole("tab", { name: "Dreams" }).click();
      await app.page.getByRole("group", { name: "Light" }).first().waitFor();
    });
  });

  test("whole backend missing (404 on /rpc): one clear page-level unavailable state, Dreams says its own", async () => {
    await withApp({}, async (app) => {
      await openRoute(app.page, "#/memories");
      await app.page.getByRole("heading", { name: "Memory is not available" }).waitFor();
      await app.page.getByRole("tab", { name: "Dreams" }).click();
      await app.page.getByRole("heading", { name: "Dreams are not available" }).waitFor();
      assert.equal(app.problems.length, 0, app.problems.join("\n"));
    });
  });

  test("selecting a card puts its id in the URL and shows memory.show; deep links work; unknown ids say not found", async () => {
    await withApp({}, async (app) => {
      await open(app);
      await list(app.page).getByRole("link", { name: /Summary of memory 002/ }).click();
      assert.equal(await app.page.evaluate(() => location.hash), "#/memories/mem_002");
      const d = detail(app.page);
      await d.getByRole("heading", { name: "Summary of memory 002" }).waitFor();
      const text = (await d.textContent()) ?? "";
      for (const part of ["Full text of memory 002.", "Second line 002.", "Workspace", "import", "ops", "src_002"]) assert.ok(text.includes(part), `detail lacks ${part}`);
      assert.equal(await list(app.page).locator("[aria-current=true]").count(), 1);
      await app.page.evaluate(() => { location.hash = "#/memories/mem_999"; });
      await detail(app.page).getByRole("heading", { name: "Memory not found" }).waitFor();
      await app.page.evaluate(() => { location.hash = "#/memories/mem_004"; });
      await detail(app.page).getByRole("heading", { name: "Summary of memory 004" }).waitFor();
      assert.equal(await app.page.evaluate(() => document.querySelector("[role=tab][aria-selected=true]")?.textContent), "Memories");
    });
  });

  test("a deep link to a card survives sign-in", async () => {
    await withApp({ hash: "#/memories/mem_003" }, async (app) => {
      installMemoryMocks(app.server);
      await app.page.getByRole("heading", { name: "Sign in", level: 1 }).waitFor();
      const { signIn } = await import("./harness.ts");
      await signIn(app.page);
      await detail(app.page).getByRole("heading", { name: "Summary of memory 003" }).waitFor();
    });
  });

  test("switching the agent reloads for that agent", async () => {
    await withApp({}, async (app) => {
      await open(app);
      await list(app.page).getByRole("link").first().waitFor();
      await app.page.getByLabel("Agent").selectOption("ops");
      await app.page.waitForTimeout(150);
      assert.equal((app.server.rpc.calls.filter((c) => c.method === "memory.list").at(-1)!.params as { agentId: string }).agentId, "ops");
      assert.equal((app.server.rpc.calls.filter((c) => c.method === "memory.state").at(-1)!.params as { agentId: string }).agentId, "ops");
    });
  });
});

describe("memories: search with explanation", opts, () => {
  const search = (page: Page) => page.getByRole("search");

  test("memory.recall: blocks, timing, deferrals and the trace are shown, and the page says what it can and cannot explain", async () => {
    await withApp({}, async (app) => {
      await open(app);
      await app.page.getByLabel("Search memories").fill("memory 00");
      await app.page.getByRole("button", { name: "Search", exact: true }).click();
      const res = app.page.getByRole("region", { name: "Search results" });
      await res.getByText("Summary of memory 001").waitFor();
      const call = app.server.rpc.calls.find((c) => c.method === "memory.recall")!.params as { query: string; agentId: string; caller: { channel: string } };
      assert.equal(call.query, "memory 00");
      assert.equal(call.agentId, "main");
      assert.equal(call.caller.channel, "cli");
      const why = res.locator("details");
      await why.locator("summary").click();
      await res.getByText("18 ms").waitFor();
      await res.getByText("memories-cap").waitFor();
      await why.getByText("fusion").waitFor();
      assert.ok(((await res.textContent()) ?? "").includes("no explain switch"), "honest note about the missing explain parameter");
      await search(app.page).waitFor();
    });
  });

  test("no hits says so; a failing search shows its own alert and leaves the list alone", async () => {
    await withApp({}, async (app) => {
      await open(app);
      await app.page.getByLabel("Search memories").fill("zzz-nothing");
      await app.page.getByRole("button", { name: "Search", exact: true }).click();
      const res = app.page.getByRole("region", { name: "Search results" });
      await res.getByText("No memory matched this query").waitFor();
      app.server.rpc.scenario("memory.recall", "error", { code: "E_INTERNAL", message: "recall exploded" });
      await app.page.getByRole("button", { name: "Search", exact: true }).click();
      await res.getByRole("alert").getByText("Something went wrong").waitFor();
      await list(app.page).getByRole("link").first().waitFor();
    });
  });

  test("search unavailable or forbidden: its own state, honestly worded", async () => {
    await withApp({}, async (app) => {
      await open(app, "#/memories", (_fx, a) => { a.server.rpc.scenario("memory.recall", "unavailable"); });
      await app.page.getByLabel("Search memories").fill("x");
      await app.page.getByRole("button", { name: "Search", exact: true }).click();
      await app.page.getByRole("region", { name: "Search results" }).getByRole("heading", { name: "Search is not available" }).waitFor();
      app.server.rpc.scenario("memory.recall", "forbidden");
      await app.page.getByRole("button", { name: "Search", exact: true }).click();
      await app.page.getByRole("region", { name: "Search results" }).getByRole("heading", { name: "Not allowed" }).waitFor();
    });
  });

  test("an empty query is not sent", async () => {
    await withApp({}, async (app) => {
      await open(app);
      await app.page.getByRole("button", { name: "Search", exact: true }).click();
      await app.page.waitForTimeout(100);
      assert.equal(app.server.rpc.calls.filter((c) => c.method === "memory.recall").length, 0);
    });
  });
});

describe("memories: reviews and live updates", opts, () => {
  test("pending change proposals are listed read-only (memory.proposals.list)", async () => {
    await withApp({}, async (app) => {
      await open(app);
      const rev = app.page.getByRole("group", { name: "Reviews" });
      await rev.getByText("old wording").waitFor();
      await rev.getByText("new wording").waitFor();
      assert.equal(await rev.getByRole("button").count(), 0);
    });
  });

  test("with the event channel up, a memory.proposal event refreshes the reviews; the page says live updates are on", async () => {
    await withApp({}, async (app) => {
      const fx = await open(app, "#/memories", (_f, a) => { a.server.events.enable(); });
      const rev = app.page.getByRole("group", { name: "Reviews" });
      await rev.getByText("old wording").waitFor();
      await app.page.getByText("Live updates on").waitFor();
      fx.proposals.push({ ...fx.proposals[0]!, id: "prop_2", oldText: "second old", newText: "second new" });
      app.server.events.push({ event: "memory.proposal", data: { agentId: "main", proposalId: "prop_2", status: "pending", sharerAgentId: "main", proposerAgentId: "ops", sharedId: "mem_002" } });
      await rev.getByText("second new").waitFor();
    });
  });

  test("without the event channel, manual Refresh reloads and the page says live updates are off", async () => {
    await withApp({}, async (app) => {
      await open(app);
      await app.page.getByText(/Live updates off/).waitFor();
      const before = app.server.rpc.calls.filter((c) => c.method === "memory.list").length;
      await app.page.getByRole("button", { name: "Refresh" }).click();
      await app.page.waitForTimeout(150);
      assert.ok(app.server.rpc.calls.filter((c) => c.method === "memory.list").length > before);
    });
  });
});

describe("memories: German", opts, () => {
  test("de catalogue: heading, tabs, list and states", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      installMemoryMocks(app.server);
      await openRoute(app.page, "#/memories", "de");
      await app.page.getByRole("tab", { name: "Erinnerungen" }).waitFor();
      await app.page.getByRole("tab", { name: "Träume" }).waitFor();
      await app.page.getByRole("region", { name: "Erinnerungskarten" }).getByRole("link").first().waitFor();
      await app.page.getByRole("group", { name: "Zustand" }).waitFor();
    });
  });
});

