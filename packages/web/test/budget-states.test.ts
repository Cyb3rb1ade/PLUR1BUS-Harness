// Usage & Quota page (`/usage`): the contract beyond test/budget.test.ts. A soft and a hard limit are told apart by words and numbers,
// not by colour; crossing a limit changes text; the states of budget.status and budget.set (loading, empty, failed, refused, in
// flight); who is offered the buttons that change a budget; axe on those views. Runs against test/mock-rpc.ts, no real sleep.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { rpcError, type MockRpc } from "./mock-rpc.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

type L = Record<string, unknown>;
const lim = (o: L): L => ({ period: "day", metric: "cost", soft: null, hard: null, used: 0, state: "ok", ...o });
const usage = (o: L = {}): L => ({ events: 4, inputTokens: 1200, outputTokens: 300, cacheReadTokens: 50, cacheWriteTokens: 10, costMicros: 1500, unpricedEvents: 0, ...o });
const periods = (): L[] => [
  { period: "day", key: "2026-10-07", start: "2026-10-07T00:00:00+02:00", end: "2026-10-08T00:00:00+02:00", total: usage(), agents: [{ agentId: "main", total: usage(), models: [{ model: "claude-x", ...usage() }] }] },
  { period: "month", key: "2026-10", start: "2026-10-01T00:00:00+02:00", end: "2026-11-01T00:00:00+01:00", total: usage({ events: 40 }), agents: [] },
];
/** One limit in each state: within, soft reached, hard exceeded. */
const threeStates = (): L[] => [
  lim({ scope: "global", period: "day", metric: "cost", soft: 5_000_000, hard: 10_000_000, used: 2_000_000, state: "ok" }),
  lim({ scope: "global", period: "month", metric: "tokens", soft: 1_000_000, hard: 2_000_000, used: 1_500_000, state: "soft" }),
  lim({ scope: "global", period: "day", metric: "tokens", soft: 100, hard: 200, used: 250, state: "hard" }),
];

/** A call that stays in flight until the test lets it go: no timer, so a slow machine cannot change what the test sees. */
function hold(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

type Seeded = { limits: L[]; periods: L[] };
function seed(rpc: MockRpc, over: Partial<Seeded> = {}, o: { set?: boolean; holdStatus?: Promise<void>; holdSet?: Promise<void> } = {}): Seeded {
  const s: Seeded = { limits: threeStates(), periods: periods(), ...over };
  rpc.handle("budget.status", async () => {
    if (o.holdStatus) await o.holdStatus;
    return { timeZone: "Europe/Berlin", priceVersion: "2026-10-01", now: "2026-10-07T09:00:00+02:00", periods: s.periods, limits: s.limits };
  }, { write: false });
  if (o.set !== false) {
    rpc.handle("budget.set", async (p) => {
      if (o.holdSet) await o.holdSet;
      const q = (p as { limit?: L }).limit ?? {};
      const same = (l: L): boolean => l.scope === q.scope && l.agentId === q.agentId && l.period === q.period && l.metric === q.metric;
      const found = s.limits.find(same);
      const next = lim({ ...(found ?? {}), ...q, used: found?.used ?? 0 });
      for (const b of ["soft", "hard"]) if (q[b] === undefined && found) next[b] = found[b];
      s.limits = s.limits.filter((l) => !same(l));
      if (next.soft !== null || next.hard !== null) s.limits.push(next);
      return { timeZone: "Europe/Berlin", limit: next, limits: s.limits };
    });
  }
  return s;
}

const open = (app: App, hash = "#/usage"): Promise<void> => openRoute(app.page, hash);
const sets = (app: App): { params: { limit: L }; csrf: string | null }[] => app.server.rpc.calls.filter((c) => c.method === "budget.set") as never;
const group = (app: App, name: string) => app.page.getByRole("group", { name, exact: true });
const badgeOf = async (app: App, name: string): Promise<string> => ((await group(app, name).locator(".badge").textContent()) ?? "").trim();

const OK = "Within limit";
const SOFT = "Warning: soft limit reached";
const HARD = "Exceeded: hard limit reached";

describe("usage: a soft limit and a hard limit are told apart without colour", opts, () => {
  test("within, soft and hard each carry their own words and numbers, visible next to the figures", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      await group(app, "Daily cost").waitFor();
      const states: [string, string, RegExp][] = [["Daily cost", OK, /\$2\.00 of \$10\.00 \(20%\)/], ["Monthly tokens", SOFT, /1,500,000 of 2,000,000 \(75%\)/], ["Daily tokens", HARD, /250 of 200 \(125%\)/]];
      const seen = new Set<string>();
      for (const [name, text, figures] of states) {
        const badge = group(app, name).locator(".badge");
        assert.equal(await badgeOf(app, name), text);
        assert.equal(await badge.isVisible(), true);
        const box = await badge.boundingBox();
        assert.ok(box && box.width > 8 && box.height > 8, `${name}: the state label takes room on the page`);
        const card = (await group(app, name).textContent()) ?? "";
        assert.ok(card.includes(text), `${name}: the state is part of the card's own text`);
        assert.match(card, figures);
        seen.add(text);
      }
      assert.equal(seen.size, 3, "three states, three different texts");
      assert.ok(!SOFT.includes("Exceeded") && !HARD.includes("Warning") && /soft/i.test(SOFT) && /hard/i.test(HARD), "the words themselves name the kind of limit");
      for (const name of ["Monthly tokens", "Daily tokens"]) {
        const card = (await group(app, name).textContent()) ?? "";
        assert.match(card, /Soft limit\s*[\d,.$]/);
        assert.match(card, /Hard limit\s*[\d,.$]/);
      }
    });
  });

  test("each bar has a text alternative and a text fallback with the same figures", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      await group(app, "Daily tokens").waitFor();
      const meter = group(app, "Daily tokens").getByRole("meter");
      assert.equal(await meter.getAttribute("aria-label"), "Daily tokens: 250 of 200");
      assert.equal(((await meter.textContent()) ?? "").trim(), "250 / 200");
      assert.equal(await meter.getAttribute("value"), "200", "the bar stops at the limit; the text says 125%");
    });
  });

  test("with colours taken away (forced colours) the three states are still three readable texts", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc);
      await app.page.emulateMedia({ forcedColors: "active" });
      await open(app);
      await group(app, "Daily cost").waitFor();
      assert.deepEqual([await badgeOf(app, "Daily cost"), await badgeOf(app, "Monthly tokens"), await badgeOf(app, "Daily tokens")], [OK, SOFT, HARD]);
      for (const name of ["Daily cost", "Monthly tokens", "Daily tokens"]) assert.equal(await group(app, name).locator(".badge").isVisible(), true);
    });
  });

  test("German: soft and hard read differently too", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      seed(app.server.rpc);
      await openRoute(app.page, "#/usage", "de");
      await app.page.getByRole("group", { name: "Tageskosten", exact: true }).waitFor();
      const de = async (name: string) => ((await app.page.getByRole("group", { name, exact: true }).locator(".badge").textContent()) ?? "").trim();
      assert.deepEqual([await de("Tageskosten"), await de("Monats-Tokens"), await de("Tages-Tokens")], ["Im Limit", "Warnung: weiches Limit erreicht", "Überschritten: hartes Limit erreicht"]);
    });
  });

  test("crossing a limit changes the words on the card: within, then warning, then exceeded", async () => {
    await withApp({}, async (app) => {
      const s = seed(app.server.rpc, { limits: [lim({ scope: "global", period: "day", metric: "tokens", soft: 100, hard: 200, used: 99, state: "ok" })] });
      await open(app);
      await group(app, "Daily tokens").waitFor();
      assert.equal(await badgeOf(app, "Daily tokens"), OK);
      assert.match((await group(app, "Daily tokens").textContent()) ?? "", /99 of 200 \(49%\)/);
      s.limits = [lim({ scope: "global", period: "day", metric: "tokens", soft: 100, hard: 200, used: 100, state: "soft" })];
      await app.page.getByRole("button", { name: "Refresh" }).click();
      await app.page.getByText(SOFT, { exact: true }).waitFor();
      assert.match((await group(app, "Daily tokens").textContent()) ?? "", /100 of 200 \(50%\)/);
      s.limits = [lim({ scope: "global", period: "day", metric: "tokens", soft: 100, hard: 200, used: 250, state: "hard" })];
      await app.page.getByRole("button", { name: "Refresh" }).click();
      await app.page.getByText(HARD, { exact: true }).waitFor();
      assert.match((await group(app, "Daily tokens").textContent()) ?? "", /250 of 200 \(125%\)/);
      assert.equal(await app.page.getByText(SOFT, { exact: true }).count(), 0, "the old words are gone");
    });
  });

  test("when the server sends no state, the page names it from the figures: at the soft bound a warning, at the hard bound exceeded", async () => {
    await withApp({}, async (app) => {
      const bare = (o: L): L => { const l = lim({ scope: "global", metric: "tokens", soft: 100, hard: 200, ...o }); delete l.state; return l; };
      seed(app.server.rpc, { limits: [bare({ period: "day", used: 99 }), bare({ period: "month", used: 100 }), bare({ scope: "agent", agentId: "a1", period: "day", used: 200 }), bare({ scope: "agent", agentId: "a2", period: "day", soft: null, hard: 0, used: 1 })] });
      await open(app);
      await group(app, "Daily tokens").waitFor();
      assert.equal(await badgeOf(app, "Daily tokens"), OK);
      assert.equal(await badgeOf(app, "Monthly tokens"), SOFT);
      await app.page.getByRole("tab", { name: "Agents" }).click();
      await app.page.getByRole("heading", { name: "a2", level: 2, exact: true }).waitFor();
      for (const agent of ["a1", "a2"]) {
        const card = app.page.locator("section", { has: app.page.getByRole("heading", { name: agent, level: 2, exact: true }) }).getByRole("group", { name: "Daily tokens", exact: true });
        assert.equal(((await card.locator(".badge").textContent()) ?? "").trim(), HARD, agent);
      }
    });
  });
});

describe("usage: budget.status loading, empty and failed", opts, () => {
  test("loading is a polite busy status and offers no way to change anything yet", async () => {
    await withApp({}, async (app) => {
      const gate = hold();
      seed(app.server.rpc, {}, { holdStatus: gate.promise }); await open(app);
      const loading = app.page.locator(".page-state[data-state=loading]");
      await loading.waitFor();
      assert.equal(await loading.getAttribute("role"), "status");
      assert.equal(await loading.getAttribute("aria-busy"), "true");
      for (const name of ["Set limit", "Edit limit: Daily cost", "Remove limit: Daily cost"]) assert.equal(await app.page.getByRole("button", { name }).count(), 0, name);
      gate.release();
      await group(app, "Daily cost").waitFor();
      assert.equal(await app.page.locator(".page-state[data-state=loading]").count(), 0);
    });
  });

  test("an empty answer, an empty object and a garbage answer all read as 'No limits set', without a page error", async () => {
    for (const answer of ["null", "{}", "[]", "text"]) {
      await withApp({}, async (app) => {
        const rpc = app.server.rpc;
        rpc.handle("budget.status", () => (answer === "null" ? null : answer === "{}" ? {} : answer === "[]" ? [] : "not a status"), { write: false });
        await open(app);
        const empty = app.page.locator(".page-state[data-state=empty]");
        await empty.getByRole("heading", { name: "No limits set" }).waitFor();
        await empty.getByRole("button", { name: "Set limit" }).waitFor();
        assert.deepEqual(app.problems, [], `answer ${answer}`);
      });
    }
  });

  test("the empty scenario of the mock is the same empty state", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); app.server.rpc.scenario("budget.status", "empty"); await open(app);
      await app.page.locator(".page-state[data-state=empty]").getByRole("heading", { name: "No limits set" }).waitFor();
    });
  });

  test("a core that does not serve the method (-32601) is a failed page: explained, nothing to change, a way to retry", async () => {
    await withApp({}, async (app) => {
      app.server.rpc.handle("budget.unrelated", () => null, { write: false }); await open(app);
      const state = app.page.locator(".page-state[data-state=error], .page-state[data-state=unavailable]");
      await state.first().waitFor();
      assert.equal(await app.page.getByRole("button", { name: "Set limit" }).count(), 0);
      assert.equal(await app.page.getByRole("group").count(), 0, "no figures from nowhere");
      seed(app.server.rpc);
      await app.page.getByRole("button", { name: "Try again" }).click();
      await group(app, "Daily cost").waitFor();
    });
  });

  test("a failing refresh replaces the figures with the error instead of leaving stale ones, and Try again brings them back", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      await group(app, "Daily cost").waitFor();
      app.server.rpc.scenario("budget.status", "error");
      await app.page.getByRole("button", { name: "Refresh" }).click();
      await app.page.getByRole("alert").getByRole("heading", { name: "Something went wrong" }).waitFor();
      assert.equal(await group(app, "Daily cost").count(), 0);
      assert.equal(await app.page.getByRole("button", { name: "Set limit" }).count(), 0);
      app.server.rpc.scenario("budget.status", "success");
      await app.page.getByRole("button", { name: "Try again" }).click();
      await group(app, "Daily cost").waitFor();
    });
  });
});

describe("usage: budget.set refused, failed and in flight", opts, () => {
  const saveEdit = async (app: App): Promise<void> => {
    await app.page.getByRole("button", { name: "Edit limit: Daily cost" }).click();
    await app.page.getByRole("button", { name: "Review" }).click();
    await app.page.getByRole("button", { name: "Confirm and save" }).click();
  };
  const cases: { name: string; fail: (rpc: MockRpc) => void; text: string }[] = [
    { name: "denied", fail: (rpc) => rpc.handle("budget.set", () => { throw rpcError("E_DENIED", "no", "no-permission"); }), text: "You are not allowed to change budgets." },
    { name: "internal error", fail: (rpc) => rpc.handle("budget.set", () => { throw rpcError("E_INTERNAL", "boom"); }), text: "The limit could not be saved. Try again." },
    { name: "invalid params", fail: (rpc) => rpc.handle("budget.set", () => { throw rpcError("E_INVALID_PARAMS", "bad", "x"); }), text: "The limit could not be saved. Try again." },
    { name: "service not available", fail: (rpc) => rpc.handle("budget.set", () => { throw rpcError("E_NOT_AVAILABLE", "off"); }), text: "The limit could not be saved. Try again." },
  ];
  for (const c of cases) {
    test(`${c.name}: said in the dialog, one call, the figures behind it are unchanged, the user can try again`, async () => {
      await withApp({}, async (app) => {
        seed(app.server.rpc); await open(app);
        await group(app, "Daily cost").waitFor();
        c.fail(app.server.rpc);
        await saveEdit(app);
        const dialog = app.page.getByRole("dialog", { name: "Confirm limit" });
        await dialog.getByRole("alert").getByText(c.text, { exact: true }).waitFor();
        assert.equal(sets(app).length, 1);
        assert.match((await group(app, "Daily cost").textContent()) ?? "", /\$2\.00 of \$10\.00 \(20%\)/);
        const confirm = dialog.getByRole("button", { name: "Confirm and save" });
        assert.equal(await confirm.isDisabled(), false);
        assert.notEqual(await confirm.getAttribute("aria-disabled"), "true");
      });
    });
  }

  test("a core without budget.set (-32601) says the same, and a refused remove keeps the limit", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc, {}, { set: false }); await open(app);
      await group(app, "Daily cost").waitFor();
      await saveEdit(app);
      await app.page.getByRole("dialog", { name: "Confirm limit" }).getByRole("alert").getByText("The limit could not be saved. Try again.", { exact: true }).waitFor();
      await app.page.keyboard.press("Escape");
      await app.page.getByRole("dialog").waitFor({ state: "detached" });
      await app.page.getByRole("button", { name: "Remove limit: Daily cost" }).click();
      const dialog = app.page.getByRole("dialog", { name: "Remove limit" });
      await dialog.getByRole("button", { name: "Remove", exact: true }).click();
      await dialog.getByRole("alert").getByText("The limit could not be saved. Try again.", { exact: true }).waitFor();
      assert.equal(await group(app, "Daily cost").count(), 1);
    });
  });

  test("while saving, Confirm and save is disabled; a double click sends one budget.set", async () => {
    await withApp({}, async (app) => {
      const gate = hold();
      seed(app.server.rpc, {}, { holdSet: gate.promise }); await open(app);
      await group(app, "Daily cost").waitFor();
      await app.page.getByRole("button", { name: "Edit limit: Daily cost" }).click();
      await app.page.getByRole("button", { name: "Review" }).click();
      const confirm = app.page.getByRole("button", { name: "Confirm and save" });
      await confirm.dblclick();
      assert.equal(await confirm.isDisabled(), true, "disabled while the write is in flight");
      gate.release();
      await app.page.getByRole("dialog").waitFor({ state: "detached" });
      assert.equal(sets(app).length, 1);
    });
  });

  test("a double click on Remove removes once, and nothing is sent before the question is answered", async () => {
    await withApp({}, async (app) => {
      const gate = hold();
      seed(app.server.rpc, {}, { holdSet: gate.promise }); await open(app);
      await group(app, "Daily cost").waitFor();
      await app.page.getByRole("button", { name: "Remove limit: Daily cost" }).click();
      const dialog = app.page.getByRole("dialog", { name: "Remove limit" });
      await dialog.waitFor();
      assert.equal(sets(app).length, 0);
      await dialog.getByRole("button", { name: "Remove", exact: true }).dblclick();
      gate.release();
      await dialog.waitFor({ state: "detached" });
      assert.equal(sets(app).length, 1);
      assert.deepEqual(sets(app)[0]!.params, { limit: { scope: "global", period: "day", metric: "cost", soft: null, hard: null } });
    });
  });

  test("Cancel, Back and Esc send nothing, at every step of the dialog", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      await group(app, "Daily cost").waitFor();
      await app.page.getByRole("button", { name: "Remove limit: Daily cost" }).click();
      await app.page.getByRole("dialog", { name: "Remove limit" }).getByRole("button", { name: "Cancel" }).click();
      await app.page.getByRole("dialog").waitFor({ state: "detached" });
      await app.page.getByRole("button", { name: "Edit limit: Daily cost" }).click();
      await app.page.getByRole("button", { name: "Review" }).click();
      await app.page.getByRole("dialog", { name: "Confirm limit" }).getByRole("button", { name: "Back" }).click();
      await app.page.getByRole("dialog", { name: "Edit limit: Daily cost" }).waitFor();
      await app.page.getByRole("button", { name: "Review" }).click();
      await app.page.getByRole("dialog", { name: "Confirm limit" }).waitFor();
      await app.page.keyboard.press("Escape");
      await app.page.getByRole("dialog").waitFor({ state: "detached" });
      assert.equal(sets(app).length, 0);
    });
  });
});

describe("usage: who is offered the buttons that change a budget", opts, () => {
  const changers = ["Set limit", "Edit limit: Daily cost", "Remove limit: Daily cost"];

  for (const role of ["owner", "admin"]) {
    test(`role ${role}: Set, Edit and Remove are offered`, async () => {
      await withApp({ server: { role } }, async (app) => {
        seed(app.server.rpc); await open(app);
        await group(app, "Daily cost").waitFor();
        for (const name of changers) assert.equal(await app.page.getByRole("button", { name }).count(), 1, name);
      });
    });
  }

  for (const role of ["operator", "member", "viewer"]) {
    test(`role ${role}: reads limits and usage, is offered nothing that changes them`, async () => {
      await withApp({ server: { role } }, async (app) => {
        seed(app.server.rpc); await open(app);
        await group(app, "Daily cost").waitFor();
        assert.equal(await badgeOf(app, "Daily tokens"), HARD, "the figures and states are there");
        for (const tab of ["Global", "Agents", "Usage"]) {
          await app.page.getByRole("tab", { name: tab }).click();
          await app.page.getByRole("tabpanel").waitFor();
          for (const name of ["Set limit", "Edit limit", "Remove limit"]) assert.equal(await app.page.getByRole("button", { name: new RegExp(`^${name}`) }).count(), 0, `${tab}: ${name}`);
        }
        await app.page.getByRole("button", { name: "Refresh" }).waitFor();
        assert.equal(sets(app).length, 0);
      });
    });
  }

  test("a read-only role gets no Set limit button in the empty states either", async () => {
    await withApp({ server: { role: "viewer" } }, async (app) => {
      seed(app.server.rpc, { limits: [], periods: [] }); await open(app);
      await app.page.locator(".page-state[data-state=empty]").getByRole("heading", { name: "No limits set" }).waitFor();
      assert.equal(await app.page.getByRole("button", { name: "Set limit" }).count(), 0);
    });
    await withApp({ server: { role: "member" } }, async (app) => {
      seed(app.server.rpc, { limits: [lim({ scope: "global", period: "day", metric: "tokens", hard: 100, used: 1 })] }); await open(app, "#/usage/agents");
      await app.page.getByRole("heading", { name: "No agent limits" }).waitFor();
      assert.equal(await app.page.getByRole("button", { name: "Set limit" }).count(), 0);
    });
  });

  test("an owner who loses the right while the page is open is told so by the server's refusal", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      await group(app, "Daily cost").waitFor();
      app.server.rpc.scenario("budget.set", "forbidden");
      await app.page.getByRole("button", { name: "Edit limit: Daily cost" }).click();
      await app.page.getByRole("button", { name: "Review" }).click();
      await app.page.getByRole("button", { name: "Confirm and save" }).click();
      await app.page.getByRole("dialog").getByRole("alert").getByText("You are not allowed to change budgets.").waitFor();
    });
  });
});

describe("usage: the core's own rule for budget.set", () => {
  // The page decides what to show; the additive Core rule and real HTTP authorization suite enforce the write policy.
  test("budget.set has an RBAC rule in the core", () => {
    const guard = readFileSync(new URL("../../core/src/rbac/guard.ts", import.meta.url), "utf8");
    assert.ok(/"budget\.set"\s*:/.test(guard), "RPC_RULES has no entry for budget.set");
  });
});

describe("usage: axe on these views", opts, () => {
  test("axe: a read-only role, every tab", async () => {
    await withApp({ server: { role: "viewer" }, width: 400, height: 900, colorScheme: "dark" }, async (app) => {
      seed(app.server.rpc); await open(app);
      for (const tab of ["Global", "Agents", "Usage"]) {
        await app.page.getByRole("tab", { name: tab }).click();
        await app.page.getByRole("tabpanel").waitFor();
        await expectAxeClean(app.page, `viewer ${tab}`);
      }
    });
  });

  test("axe: the three states side by side, light and dark", async () => {
    for (const scheme of ["light", "dark"] as const) {
      await withApp({ colorScheme: scheme }, async (app) => {
        seed(app.server.rpc); await open(app);
        await group(app, "Daily tokens").waitFor();
        await expectAxeClean(app.page, `three states ${scheme}`);
      });
    }
  });

  test("axe: a dialog showing a refused write, and the remove question", async () => {
    await withApp({}, async (app) => {
      seed(app.server.rpc); await open(app);
      await group(app, "Daily cost").waitFor();
      app.server.rpc.scenario("budget.set", "forbidden");
      await app.page.getByRole("button", { name: "Edit limit: Daily cost" }).click();
      await app.page.getByRole("button", { name: "Review" }).click();
      await app.page.getByRole("button", { name: "Confirm and save" }).click();
      await app.page.getByRole("dialog").getByRole("alert").getByText("You are not allowed to change budgets.").waitFor();
      await expectAxeClean(app.page, "refused write");
      await app.page.keyboard.press("Escape");
      await app.page.getByRole("button", { name: "Remove limit: Daily cost" }).click();
      await app.page.getByRole("dialog", { name: "Remove limit" }).waitFor();
      await expectAxeClean(app.page, "remove question");
    });
  });
});
