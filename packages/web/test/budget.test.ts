// Usage & Quota page (E8, route /usage): states, limit groups and boundary states, usage, set/edit/remove with confirmation,
// layout, a11y, keyboard, German. The backend does not serve /rpc yet; everything runs against test/mock-rpc.ts.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { rpcError, type MockRpc } from "./mock-rpc.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

type L = Record<string, unknown>;
const lim = (o: L): L => ({ period: "day", metric: "cost", soft: null, hard: null, used: 0, state: "ok", ...o });
const usage = (o: L = {}): L => ({ events: 4, inputTokens: 1200, outputTokens: 300, cacheReadTokens: 50, cacheWriteTokens: 10, costMicros: 1500, unpricedEvents: 1, ...o });

type Seeded = { limits: L[]; periods: L[] };
function seed(rpc: MockRpc, over: Partial<Seeded> = {}): Seeded {
  const s: Seeded = {
    limits: [
      lim({ scope: "global", period: "day", metric: "cost", soft: 5_000_000, hard: 10_000_000, used: 2_000_000, state: "ok" }),
      lim({ scope: "global", period: "month", metric: "tokens", soft: 1_000_000, hard: 2_000_000, used: 1_500_000, state: "soft" }),
      lim({ scope: "agent", agentId: "main", period: "day", metric: "cost", hard: 1_000_000, used: 1_200_000, state: "hard" }),
      lim({ scope: "agent", agentId: "dev", period: "month", metric: "tokens", soft: 500, used: 500, state: "soft" }),
    ],
    periods: [
      { period: "day", key: "2026-10-07", start: "2026-10-07T00:00:00+02:00", end: "2026-10-08T00:00:00+02:00", total: usage(), agents: [{ agentId: "main", total: usage(), models: [{ model: "claude-x", ...usage() }] }] },
      { period: "month", key: "2026-10", start: "2026-10-01T00:00:00+02:00", end: "2026-11-01T00:00:00+01:00", total: usage({ events: 40 }), agents: [] },
    ],
    ...over,
  };
  rpc.handle("budget.status", () => ({ timeZone: "Europe/Berlin", priceVersion: "2026-10-01", now: "2026-10-07T09:00:00+02:00", periods: s.periods, limits: s.limits }), { write: false });
  rpc.handle("budget.set", (p) => {
    const q = (p as { limit?: L }).limit ?? {};
    const same = (l: L): boolean => l.scope === q.scope && l.agentId === q.agentId && l.period === q.period && l.metric === q.metric;
    const found = s.limits.find(same);
    const next = lim({ ...(found ?? {}), ...q, used: found?.used ?? 0 });
    for (const b of ["soft", "hard"]) if (q[b] === undefined && found) next[b] = found[b];
    s.limits = s.limits.filter((l) => !same(l));
    if (next.soft !== null || next.hard !== null) s.limits.push(next);
    return { timeZone: "Europe/Berlin", limit: next, limits: s.limits };
  });
  return s;
}

const open = (app: App, hash = "#/usage"): Promise<void> => openRoute(app.page, hash);
const sets = (app: App): { params: { limit: L }; csrf: string | null }[] => app.server.rpc.calls.filter((c) => c.method === "budget.set") as never;

describe("usage: states", opts, () => {
  test("loading, then the page", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); app.server.rpc.setDelay("budget.status", 300); await open(app);
      await app.page.getByRole("heading", { name: "Usage & Quota", level: 1 }).waitFor();
      await app.page.locator(".page-state[data-state=loading]").waitFor();
      await app.page.getByRole("tab", { name: "Global" }).waitFor();
    });
  });
  test("empty budgets are explained, including what is not supported yet", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc, { limits: [], periods: [] }); await open(app);
      const empty = app.page.locator(".page-state[data-state=empty]");
      await empty.getByRole("heading", { name: "No limits set" }).waitFor();
      const text = (await empty.textContent()) ?? "";
      assert.match(text, /nothing is stopped/i); assert.match(text, /per project or per user are not available yet/i);
      await empty.getByRole("button", { name: "Set limit" }).waitFor();
    });
  });
  test("error with retry, forbidden, unavailable (scenario and /rpc missing)", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); app.server.rpc.scenario("budget.status", "error"); await open(app);
      await app.page.getByRole("alert").getByRole("heading", { name: "Something went wrong" }).waitFor();
      app.server.rpc.scenario("budget.status", "success");
      await app.page.getByRole("button", { name: "Try again" }).click();
      await app.page.getByRole("tab", { name: "Global" }).waitFor();
      app.server.rpc.scenario("budget.status", "forbidden");
      await app.page.getByRole("button", { name: "Refresh" }).click();
      await app.page.getByRole("heading", { name: "Not allowed" }).waitFor();
      app.server.rpc.scenario("budget.status", "unavailable");
      await app.page.evaluate(() => { location.hash = "#/doctor"; }); await app.page.evaluate(() => { location.hash = "#/usage"; });
      await app.page.getByRole("heading", { name: "Not available" }).waitFor();
    });
    await withApp({}, async (app) => {
      await open(app);
      await app.page.getByRole("heading", { name: "Not available" }).waitFor();
      assert.equal(await app.page.getByRole("button", { name: "Set limit" }).count(), 0);
    });
  });
});

describe("usage: limits", opts, () => {
  test("global tab: one card per limit with state text, bar with a text alternative, used of limit and percent", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      const daily = app.page.getByRole("group", { name: "Daily cost" });
      await daily.waitFor();
      assert.match((await daily.textContent()) ?? "", /Within limit/);
      assert.match((await daily.textContent()) ?? "", /\$2\.00 of \$10\.00 \(20%\)/);
      const meter = daily.getByRole("meter");
      assert.equal(await meter.getAttribute("aria-label"), "Daily cost: $2.00 of $10.00");
      assert.equal(await meter.getAttribute("max"), "10000000");
      const monthly = app.page.getByRole("group", { name: "Monthly tokens" });
      assert.match((await monthly.textContent()) ?? "", /Warning: soft limit reached/);
      assert.match((await monthly.textContent()) ?? "", /1,500,000 of 2,000,000 \(75%\)/);
      assert.equal(await app.page.getByRole("group", { name: "Daily cost" }).count(), 1);
    });
  });
  test("agents tab: grouped by agent; hard limit exceeded reads over 100 %; a bound reached exactly is a warning", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      await app.page.getByRole("tab", { name: "Agents" }).click();
      assert.equal(await app.page.evaluate(() => location.hash), "#/usage/agents");
      await app.page.getByRole("heading", { name: "main", level: 2, exact: true }).waitFor();
      await app.page.getByRole("heading", { name: "dev", level: 2, exact: true }).waitFor();
      const main = app.page.getByRole("group", { name: "Daily cost" });
      assert.match((await main.textContent()) ?? "", /Exceeded: hard limit reached/);
      assert.match((await main.textContent()) ?? "", /\$1\.20 of \$1\.00 \(120%\)/);
      assert.equal(await main.getByRole("meter").getAttribute("value"), "1000000", "bar capped at the limit");
      const dev = app.page.getByRole("group", { name: "Monthly tokens" });
      assert.match((await dev.textContent()) ?? "", /Warning: soft limit reached/);
      assert.match((await dev.textContent()) ?? "", /500 of 500 \(100%\)/);
      assert.match((await dev.textContent()) ?? "", /Hard limit\s*not set/);
    });
  });
  test("agents tab without agent limits explains that the global ones apply; unknown scopes get their own tab", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc, { limits: [lim({ scope: "global", period: "day", metric: "tokens", hard: 100, used: 1 }), lim({ scope: "project", agentId: "p1", period: "day", metric: "tokens", hard: 9, used: 1 })] }); await open(app, "#/usage/agents");
      await app.page.getByRole("heading", { name: "No agent limits" }).waitFor();
      await app.page.getByRole("tab", { name: "Other scopes" }).click();
      await app.page.getByText("project", { exact: false }).first().waitFor();
    });
  });
  test("usage tab: day and month totals, unpriced calls, per agent and model", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app, "#/usage/usage");
      const day = app.page.getByRole("group", { name: "Today · 2026-10-07" });
      await day.waitFor();
      const text = (await day.textContent()) ?? "";
      assert.match(text, /Model calls\s*4/); assert.match(text, /Input tokens\s*1,200/); assert.match(text, /Cost\s*\$0\.0015/);
      assert.match(text, /Calls without a price\s*1/); assert.match(text, /main/); assert.match(text, /claude-x/);
      await app.page.getByRole("group", { name: "This month · 2026-10" }).waitFor();
    });
  });
  test("the page header shows time zone, price table and refresh reloads", async () => {
    await withApp({}, async (app) => {
      const s = seed(app.server.rpc); await open(app);
      await app.page.getByText("Europe/Berlin", { exact: false }).first().waitFor();
      s.limits.push(lim({ scope: "global", period: "month", metric: "cost", hard: 3_000_000, used: 0 }));
      await app.page.getByRole("button", { name: "Refresh" }).click();
      await app.page.getByRole("group", { name: "Monthly cost" }).waitFor();
    });
  });
});

describe("usage: changing limits", opts, () => {
  test("set a new agent limit: validation, review step, confirmation, then the list reloads", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      await app.page.getByRole("button", { name: "Set limit" }).click();
      const dlg = app.page.getByRole("dialog", { name: "Set limit" });
      await dlg.getByLabel("Scope").selectOption("agent");
      await dlg.getByRole("button", { name: "Review" }).click();
      await dlg.getByText("Enter an agent id.").waitFor(); await dlg.getByText("Enter at least one limit.").waitFor();
      await dlg.getByLabel("Agent id").fill("qa");
      await dlg.getByLabel("Period").selectOption("month"); await dlg.getByLabel("Metric").selectOption("tokens");
      await dlg.getByLabel("Soft limit").fill("1.5"); await dlg.getByLabel("Hard limit").fill("50");
      await dlg.getByRole("button", { name: "Review" }).click();
      await dlg.getByText("Enter a whole number of tokens.").waitFor();
      await dlg.getByLabel("Soft limit").fill("100"); await dlg.getByLabel("Hard limit").fill("50");
      await dlg.getByRole("button", { name: "Review" }).click();
      await dlg.getByText("The soft limit must not be higher than the hard limit.").waitFor();
      assert.equal(sets(app).length, 0);
      await dlg.getByLabel("Hard limit").fill("200");
      await dlg.getByRole("button", { name: "Review" }).click();
      const review = app.page.getByRole("dialog", { name: "Confirm limit" });
      assert.match((await review.textContent()) ?? "", /qa/); assert.match((await review.textContent()) ?? "", /100/); assert.match((await review.textContent()) ?? "", /200/);
      assert.equal(sets(app).length, 0, "nothing is sent before the confirmation");
      await review.getByRole("button", { name: "Confirm and save" }).click();
      await review.waitFor({ state: "detached" });
      assert.deepEqual(sets(app)[0]!.params, { limit: { scope: "agent", agentId: "qa", period: "month", metric: "tokens", soft: 100, hard: 200 } });
      assert.ok(sets(app)[0]!.csrf);
      await app.page.getByRole("tab", { name: "Agents" }).click();
      await app.page.getByRole("heading", { name: "qa", level: 2, exact: true }).waitFor();
    });
  });
  test("cost limits are typed in dollars and sent as micro-USD", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc, { limits: [] , periods: [] }); await open(app);
      await app.page.locator(".page-state").getByRole("button", { name: "Set limit" }).click();
      const dlg = app.page.getByRole("dialog", { name: "Set limit" });
      await dlg.getByLabel("Hard limit").fill("0,25");
      await dlg.getByRole("button", { name: "Review" }).click();
      await app.page.getByRole("dialog", { name: "Confirm limit" }).getByRole("button", { name: "Confirm and save" }).click();
      await app.page.getByRole("dialog").waitFor({ state: "detached" });
      assert.deepEqual(sets(app)[0]!.params, { limit: { scope: "global", period: "day", metric: "cost", hard: 250_000 } });
    });
  });
  test("edit: prefilled, emptying a set bound clears it with null; Back returns to the form; Esc closes", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      const edit = app.page.getByRole("button", { name: "Edit limit: Daily cost" });
      await edit.focus(); await app.page.keyboard.press("Enter");
      const dlg = app.page.getByRole("dialog", { name: "Edit limit: Daily cost" });
      assert.equal(await dlg.getByLabel("Soft limit").inputValue(), "5"); assert.equal(await dlg.getByLabel("Hard limit").inputValue(), "10");
      await dlg.getByLabel("Soft limit").fill(""); await dlg.getByLabel("Hard limit").fill("8.5");
      await dlg.getByRole("button", { name: "Review" }).click();
      const review = app.page.getByRole("dialog", { name: "Confirm limit" });
      assert.match((await review.textContent()) ?? "", /cleared/i);
      await review.getByRole("button", { name: "Back" }).click();
      assert.equal(await app.page.getByRole("dialog", { name: "Edit limit: Daily cost" }).getByLabel("Hard limit").inputValue(), "8.5");
      await app.page.getByRole("button", { name: "Review" }).click();
      await app.page.getByRole("button", { name: "Confirm and save" }).click();
      await app.page.getByRole("dialog").waitFor({ state: "detached" });
      assert.deepEqual(sets(app)[0]!.params, { limit: { scope: "global", period: "day", metric: "cost", soft: null, hard: 8_500_000 } });
      assert.equal(await app.page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Edit limit: Daily cost");
      await app.page.keyboard.press("Enter"); await app.page.getByRole("dialog").waitFor();
      await app.page.keyboard.press("Escape"); await app.page.getByRole("dialog").waitFor({ state: "detached" });
    });
  });
  test("remove asks first, then clears both bounds; the card disappears", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      await app.page.getByRole("button", { name: "Remove limit: Monthly tokens" }).click();
      const dlg = app.page.getByRole("dialog", { name: "Remove limit" });
      await dlg.getByText("Nothing is stopped by this limit afterwards.").waitFor();
      assert.equal(sets(app).length, 0);
      await dlg.getByRole("button", { name: "Remove", exact: true }).click();
      await app.page.getByRole("group", { name: "Monthly tokens" }).waitFor({ state: "detached" });
      assert.deepEqual(sets(app)[0]!.params, { limit: { scope: "global", period: "month", metric: "tokens", soft: null, hard: null } });
    });
  });
  test("a refused write is explained in the dialog and nothing changes", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      app.server.rpc.handle("budget.set", () => { throw rpcError("E_DENIED", "no", "no-permission"); });
      await app.page.getByRole("button", { name: "Edit limit: Daily cost" }).click();
      await app.page.getByRole("button", { name: "Review" }).click();
      await app.page.getByRole("button", { name: "Confirm and save" }).click();
      await app.page.getByRole("dialog").getByRole("alert").getByText("You are not allowed to change budgets.").waitFor();
      app.server.rpc.handle("budget.set", () => { throw rpcError("E_INTERNAL", "boom"); });
      await app.page.getByRole("button", { name: "Confirm and save" }).click();
      await app.page.getByRole("dialog").getByRole("alert").getByText("The limit could not be saved. Try again.").waitFor();
    });
  });
});

describe("usage: layout, a11y, keyboard, language", opts, () => {
  for (const width of [400, 960, 1440, 2560] as const) {
    test(`no horizontal scroll on every tab (${width} px)`, async () => {
      await withApp({ width, height: 900 }, async (app) => {
        seed(app.server.rpc); await open(app);
        await app.page.getByRole("tab", { name: "Global" }).waitFor();
        for (const tab of ["Global", "Agents", "Usage"]) {
          await app.page.getByRole("tab", { name: tab }).click();
          assert.equal(await app.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, tab);
        }
      });
    });
  }
  test("keyboard: arrow keys move between tabs and select them", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      await app.page.getByRole("tab", { name: "Global" }).focus();
      await app.page.keyboard.press("ArrowRight");
      await app.page.getByRole("tab", { name: "Agents", selected: true }).waitFor();
      await app.page.keyboard.press("End");
      await app.page.getByRole("tab", { name: "Usage", selected: true }).waitFor();
      assert.equal(await app.page.evaluate(() => location.hash), "#/usage/usage");
    });
  });
  for (const [scheme, width] of [["light", 1440], ["dark", 400]] as const) {
    test(`axe: tabs, dialogs (${scheme}, ${width} px)`, async () => {
      await withApp({ colorScheme: scheme, width, height: 900 }, async (app) => {
        seed(app.server.rpc); await open(app);
        for (const tab of ["Global", "Agents", "Usage"]) {
          await app.page.getByRole("tab", { name: tab }).click();
          await app.page.getByRole("tabpanel").waitFor();
          await expectAxeClean(app.page, tab);
        }
        await app.page.getByRole("tab", { name: "Global" }).click();
        await app.page.getByRole("button", { name: "Edit limit: Daily cost" }).click();
        await app.page.getByRole("dialog").waitFor();
        await expectAxeClean(app.page, "edit dialog");
        await app.page.getByRole("button", { name: "Review" }).click();
        await app.page.getByRole("dialog", { name: "Confirm limit" }).waitFor();
        await expectAxeClean(app.page, "review dialog");
      });
    });
  }
  for (const state of ["empty", "error", "forbidden", "unavailable", "loading"] as const) {
    test(`axe: ${state} state`, async () => {
      await withApp({ width: 960, height: 800 }, async (app) => {
        seed(app.server.rpc, state === "empty" ? { limits: [], periods: [] } : {});
        if (state === "error" || state === "forbidden" || state === "unavailable") app.server.rpc.scenario("budget.status", state);
        if (state === "loading") app.server.rpc.setDelay("budget.status", 3000);
        await open(app);
        await app.page.locator(`.page-state[data-state=${state}]`).waitFor();
        await expectAxeClean(app.page, state);
      });
    });
  }
  test("agents tab empty explanation passes axe", async () => {
    await withApp({ width: 960, height: 800 }, async (app) => {
      seed(app.server.rpc, { limits: [lim({ scope: "global", period: "day", metric: "tokens", hard: 100, used: 1 })] }); await open(app, "#/usage/agents");
      await app.page.getByRole("heading", { name: "No agent limits" }).waitFor();
      await expectAxeClean(app.page, "agents empty");
    });
  });
  test("German texts and number formats", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      seed(app.server.rpc);
      await openRoute(app.page, "#/usage", "de");
      await app.page.getByRole("heading", { name: "Nutzung & Kontingent", level: 1 }).waitFor();
      await app.page.getByRole("tab", { name: "Global" }).waitFor();
      const g = app.page.getByRole("group", { name: "Tageskosten" });
      await g.waitFor();
      assert.match((await g.textContent()) ?? "", /Im Limit/);
      assert.match((await g.textContent()) ?? "", /2,00\s\$ von 10,00\s\$ \(20\s?%\)/);
      await app.page.getByRole("button", { name: "Limit setzen" }).click();
      await app.page.getByRole("dialog", { name: "Limit setzen" }).waitFor();
    });
  });
});
