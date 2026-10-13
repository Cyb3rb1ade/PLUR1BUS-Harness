// Recurring Tasks (#/recurring): the job list (jobs.list), the run history (jobs.history) and "Run now" (jobs.run) behind a
// confirmation dialog. Creating and editing jobs has no RPC; that stays a documented gap and is only checked to be absent.
//
// What the contract offers, and what these tests therefore cover:
//  - jobs.list items carry name, kind, schedule and nextRunAt, no outcome. The list shows no result column, so the different
//    results (completed, failed, skipped, incomplete, abandoned) are checked in the history. JobOutcome has no "running"
//    value, so a running job has no representation here.
//  - jobs.history has `limit` and `since`, no cursor and no offset: there is no paging to test, only the limit the page sends.
//  - jobs.run is a write (one-time CSRF token) and, per docs/rbac.md, allowed for Owner, Admin and Operator only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import type { Page } from "playwright";
import type { JobRun, JobsListResult, SystemJobRun } from "../src/pages/common/surfaces-rpc.ts";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import type { MockRpc } from "./mock-rpc.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

type JobEntry = JobsListResult["jobs"][number];
type Run = JobRun | SystemJobRun;

// ---- fixtures --------------------------------------------------------------------------------------------------------

const NOW = 1_800_000_000_000;

const JOBS: JobEntry[] = [
  { name: "consolidate", needsLlm: true, singleton: true, kind: "agent", phase: "light", schedule: { every: 3_600_000, jitter: 0.1 }, nextRunAt: NOW + 1_800_000 },
  { name: "models.scan", needsLlm: false, singleton: true, kind: "system", schedule: { every: 86_400_000, jitter: 0.05 }, nextRunAt: NOW + 72_000_000 },
  // Never scheduled and never run: no schedule, no next run.
  { name: "manual-only", needsLlm: false, singleton: false, kind: "system", nextRunAt: null },
];

const agentRun = (n: number, job: string, outcome: JobRun["outcome"], durationMs: number, reason?: string): JobRun => ({
  runId: `run_agent_${n}`, job, agentId: "main", trigger: "cron", outcome, attempt: 1, durationMs,
  startedAt: NOW - n * 60_000, finishedAt: NOW - n * 60_000 + durationMs, ...(reason ? { reason } : {}),
});
const systemRun = (n: number, job: string, outcome: SystemJobRun["outcome"], durationMs: number): SystemJobRun => ({
  runId: `run_system_${n}`, job, kind: "system", trigger: "manual", outcome, attempt: 1, durationMs,
  startedAt: NOW - n * 60_000, finishedAt: NOW - n * 60_000 + durationMs,
});

/** Newest first, one run per outcome the schema knows. */
const RUNS: Run[] = [
  systemRun(1, "models.scan", "completed", 5000),
  agentRun(2, "consolidate", "failed", 1200, "provider-error"),
  systemRun(3, "models.scan", "skipped", 3),
  agentRun(4, "consolidate", "incomplete", 800),
  agentRun(5, "consolidate", "abandoned", 150),
];
const TONE: Record<string, string> = { completed: "ok", failed: "err", skipped: "neutral", incomplete: "err", abandoned: "err" };

// ---- the mock backend ------------------------------------------------------------------------------------------------

/** Counts handler entries and lets a test wait for the n-th one without sleeping. */
class Hits {
  readonly #n = new Map<string, number>();
  readonly #waiters: { method: string; n: number; resolve: () => void }[] = [];
  hit(method: string): void {
    const n = (this.#n.get(method) ?? 0) + 1;
    this.#n.set(method, n);
    for (const w of this.#waiters) if (w.method === method && n >= w.n) w.resolve();
  }
  reached(method: string, n: number): Promise<void> {
    if ((this.#n.get(method) ?? 0) >= n) return Promise.resolve();
    return new Promise<void>((resolve) => { this.#waiters.push({ method, n, resolve }); });
  }
}

/** A promise a test settles by hand: holds a handler so that a loading or in-flight state can be observed. */
function gate(): { held: Promise<void>; release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  return { held, release };
}

type Seed = { jobs?: JobEntry[]; runs?: Run[]; holdList?: Promise<void>; holdHistory?: Promise<void>; holdRun?: Promise<void> };

/** jobs.list, jobs.history and jobs.run on the mock. Each handler registers its hit first and then waits on its gate. */
function seed(app: App, o: Seed = {}): Hits {
  const hits = new Hits();
  const rpc: MockRpc = app.server.rpc;
  rpc.handle("jobs.list", async () => { hits.hit("jobs.list"); await o.holdList; return { jobs: o.jobs ?? JOBS }; }, { write: false });
  rpc.handle("jobs.history", async () => { hits.hit("jobs.history"); await o.holdHistory; return { runs: o.runs ?? RUNS }; }, { write: false });
  rpc.handle("jobs.run", async (params) => {
    hits.hit("jobs.run");
    await o.holdRun;
    const { job, agentId } = params as { job: string; agentId?: string };
    const base = { runId: `run_manual_${job}`, job, trigger: "harness" as const, outcome: "completed" as const, attempt: 1, durationMs: 100, startedAt: NOW, finishedAt: NOW + 100 };
    return agentId ? { ...base, agentId } : { ...base, kind: "system" as const };
  });
  return hits;
}

const calls = (app: App, method: string): { params: unknown; csrf: string | null }[] => app.server.rpc.calls.filter((c) => c.method === method);

// ---- the contract: what the page sends must be what rpc.schema.json allows ---------------------------------------------

type Prop = { type?: string; enum?: unknown[]; pattern?: string; minimum?: number; maximum?: number; $ref?: string };
type MethodDef = { params: { properties?: Record<string, Prop>; required?: string[]; additionalProperties?: boolean } };
const SCHEMA = JSON.parse(readFileSync(new URL("../../rpc-schema/schema/rpc.schema.json", import.meta.url), "utf8")) as { $defs: Record<string, unknown> };
const METHODS = SCHEMA.$defs.methods as Record<string, MethodDef>;

/** The few keywords these three methods use: closed params, required, enum, integer range, the AgentId pattern. */
function assertParamsFit(method: string, params: unknown): void {
  const def = METHODS[method]?.params;
  assert.ok(def, `${method} is in the schema`);
  const given = (params ?? {}) as Record<string, unknown>;
  const props = def.properties ?? {};
  for (const k of Object.keys(given)) assert.ok(k in props, `${method}: "${k}" is not a parameter (params are closed)`);
  for (const k of def.required ?? []) assert.ok(k in given, `${method}: "${k}" is required`);
  for (const [k, v] of Object.entries(given)) {
    const raw = props[k]!;
    const p: Prop = raw.$ref ? ((SCHEMA.$defs[raw.$ref.split("/").pop()!] ?? {}) as Prop) : raw;
    if (p.enum) assert.ok(p.enum.includes(v), `${method}.${k}: ${String(v)} is not in the enum`);
    if (p.pattern) assert.match(String(v), new RegExp(p.pattern), `${method}.${k}`);
    if (p.type === "integer") assert.ok(Number.isInteger(v), `${method}.${k} is an integer`);
    if (p.minimum !== undefined) assert.ok((v as number) >= p.minimum, `${method}.${k} >= ${p.minimum}`);
    if (p.maximum !== undefined) assert.ok((v as number) <= p.maximum, `${method}.${k} <= ${p.maximum}`);
  }
}

// ---- page helpers ----------------------------------------------------------------------------------------------------

const rows = (page: Page) => page.locator(".recurring-table tbody tr");
/** The per-row "Run now" buttons (not the dialog's). */
const triggers = (page: Page) => page.locator(".recurring-table tbody button");
const dialog = (page: Page) => page.getByRole("dialog");
const confirmButton = (page: Page) => dialog(page).locator(".btn-primary");
const historyTab = (page: Page) => page.getByRole("tab", { name: /Run History|Ausführungsverlauf/ });

async function openList(app: App, hash = "#/recurring", lang: "en" | "de" = "en"): Promise<void> {
  await openRoute(app.page, hash, lang);
  await rows(app.page).first().waitFor();
}
async function openHistory(app: App): Promise<void> {
  await openRoute(app.page, "#/recurring");
  await historyTab(app.page).click();
  await app.page.locator(".recurring-history-item, .page-state:not([data-state=loading])").first().waitFor();
}
/** Opens the confirmation dialog of row `i` and waits for it. */
async function openDialog(app: App, i = 0): Promise<void> {
  await triggers(app.page).nth(i).click();
  await dialog(app.page).waitFor();
}
const isFocused = (loc: ReturnType<Page["locator"]>): Promise<boolean> => loc.evaluate((el) => el === document.activeElement);
/** Whether focus sits inside the open dialog. */
const focusInDialog = (page: Page): Promise<boolean> => page.evaluate(() => !!document.activeElement?.closest("dialog[open]"));
/** "Run now" buttons a user could use: present, not disabled, not aria-disabled. Works for hidden and for disabled controls. */
async function enabledRunButtons(page: Page): Promise<number> {
  return page.getByRole("button", { name: /Run now|Jetzt ausführen/ }).evaluateAll(
    (els) => els.filter((el) => !(el as HTMLButtonElement).disabled && el.getAttribute("aria-disabled") !== "true").length);
}

// ============================================================================================================================

describe("Recurring Tasks: job list", opts, () => {
  test("shows the loading state, then the table; the history is not asked for until its tab is opened", async () => {
    await withApp({}, async (app) => {
      const hold = gate();
      seed(app, { holdList: hold.held });
      await openRoute(app.page, "#/recurring");
      const loading = app.page.locator(".page-state[data-state=loading]");
      await loading.waitFor();
      assert.equal(await loading.getAttribute("aria-busy"), "true");
      assert.equal(await app.page.locator(".recurring-table").count(), 0);
      hold.release();
      await rows(app.page).first().waitFor();
      assert.equal(await loading.count(), 0);
      assert.equal(calls(app, "jobs.history").length, 0, "the History tab is not mounted yet");
      assert.deepEqual(app.problems, []);
    });
  });

  test("lists jobs of every kind with interval and next run; an unscheduled job shows dashes", async () => {
    await withApp({}, async (app) => {
      seed(app);
      await openList(app);
      assert.equal(await rows(app.page).count(), JOBS.length);
      const cells = async (i: number): Promise<string[]> => rows(app.page).nth(i).locator("td").allInnerTexts();
      const [consolidate, scan, manual] = [await cells(0), await cells(1), await cells(2)];
      assert.deepEqual([consolidate![0], consolidate![1], consolidate![2]], ["consolidate", "agent", "3600s"]);
      assert.deepEqual([scan![0], scan![1], scan![2]], ["models.scan", "system", "86400s"]);
      assert.notEqual(consolidate![3], "—", "a scheduled job shows its next run");
      assert.notEqual(scan![3], "—");
      assert.deepEqual([manual![0], manual![2], manual![3]], ["manual-only", "—", "—"], "never scheduled: no interval, no next run");
      // The page asks for agent and system jobs together, in the shape the schema allows.
      const list = calls(app, "jobs.list");
      assert.equal(list.length, 1);
      assert.deepEqual(list[0]!.params, { kind: "all" });
      assertParamsFit("jobs.list", list[0]!.params);
      assert.deepEqual(app.problems, []);
    });
  });

  test("an empty list shows the empty state; the gap note stays and nothing offers to create or edit a job", async () => {
    await withApp({}, async (app) => {
      seed(app, { jobs: [] });
      await openRoute(app.page, "#/recurring");
      const empty = app.page.locator(".page-state[data-state=empty]");
      await empty.getByRole("heading", { name: "No scheduled jobs configured." }).waitFor();
      assert.equal(await app.page.locator(".recurring-table").count(), 0);
      const note = app.page.getByRole("note");
      assert.match((await note.textContent()) ?? "", /docs\/web-ui\.md/);
      assert.equal(await app.page.getByRole("main").getByRole("button", { name: /create|new|add|edit|schedule|anlegen|neu|bearbeiten/i }).count(), 0);
      assert.equal(await triggers(app.page).count(), 0);
      assert.deepEqual(app.problems, []);
    });
  });

  test("a failed load shows an error with a retry that loads the list", async () => {
    await withApp({}, async (app) => {
      seed(app);
      app.server.rpc.scenario("jobs.list", "error", { code: "E_INTERNAL", message: "boom" });
      await openRoute(app.page, "#/recurring");
      const err = app.page.locator(".page-state[data-state=error]");
      await err.waitFor();
      assert.equal(await err.getAttribute("role"), "alert");
      assert.equal(await app.page.locator(".recurring-table").count(), 0);
      app.server.rpc.scenario("jobs.list", "success");
      await err.getByRole("button", { name: "Try again" }).click();
      await rows(app.page).first().waitFor();
      assert.equal(calls(app, "jobs.list").length, 2);
      assert.equal(await err.count(), 0);
    });
  });

  test("a backend without jobs.list shows the unavailable state, a refusal the forbidden state", async () => {
    await withApp({}, async (app) => {
      seed(app);
      app.server.rpc.scenario("jobs.list", "unavailable");
      await openRoute(app.page, "#/recurring");
      await app.page.locator(".page-state[data-state=unavailable]").waitFor();
      assert.equal(await app.page.locator(".recurring-table").count(), 0);
    });
    await withApp({}, async (app) => {
      seed(app);
      app.server.rpc.scenario("jobs.list", "forbidden");
      await openRoute(app.page, "#/recurring");
      await app.page.locator(".page-state[data-state=forbidden]").waitFor();
      assert.equal(await app.page.locator(".recurring-table").count(), 0);
    });
  });
});

describe("Recurring Tasks: run history", opts, () => {
  test("shows every outcome in the order the server sent (newest first), with trigger and duration", async () => {
    await withApp({}, async (app) => {
      seed(app);
      await openHistory(app);
      const items = app.page.locator(".recurring-history-item");
      assert.equal(await items.count(), RUNS.length);
      for (const [i, run] of RUNS.entries()) {
        const item = items.nth(i);
        const text = (await item.textContent()) ?? "";
        assert.ok(text.includes(run.job), `row ${i} is ${run.job}`);
        assert.ok(text.includes(`${run.durationMs}ms`), `row ${i} shows ${run.durationMs}ms`);
        assert.ok(text.includes(run.trigger), `row ${i} shows its trigger`);
        const badge = item.locator(".badge");
        assert.equal(await badge.getAttribute("data-tone"), TONE[run.outcome], `${run.outcome} tone`);
        assert.match((await badge.textContent()) ?? "", new RegExp(run.outcome, "i"));
      }
      assert.deepEqual(app.problems, []);
    });
  });

  test("asks for the newest 50 runs only; the schema has no cursor, so there is no paging to offer", async () => {
    await withApp({}, async (app) => {
      seed(app);
      await openHistory(app);
      const history = calls(app, "jobs.history");
      assert.equal(history.length, 1);
      assert.deepEqual(history[0]!.params, { limit: 50 });
      assertParamsFit("jobs.history", history[0]!.params);
      // jobs.history takes agentId, job, since and limit. If a cursor or offset appears, this test is the reminder to add paging.
      assert.deepEqual(Object.keys(METHODS["jobs.history"]!.params.properties ?? {}).sort(), ["agentId", "job", "limit", "since"]);
      assert.equal(await app.page.getByRole("button", { name: /more|older|next|page|weitere|ältere|nächste|seite/i }).count(), 0);
    });
  });

  test("shows the loading state while the history is on its way, then the runs", async () => {
    await withApp({}, async (app) => {
      const hold = gate();
      seed(app, { holdHistory: hold.held });
      await openRoute(app.page, "#/recurring");
      await historyTab(app.page).click();
      await app.page.locator(".page-state[data-state=loading]").waitFor();
      assert.equal(await app.page.locator(".recurring-history-item").count(), 0);
      hold.release();
      await app.page.locator(".recurring-history-item").first().waitFor();
      assert.equal(await app.page.locator(".page-state[data-state=loading]").count(), 0);
    });
  });

  test("an empty history shows the empty state", async () => {
    await withApp({}, async (app) => {
      seed(app, { runs: [] });
      await openHistory(app);
      await app.page.locator(".page-state[data-state=empty]").getByRole("heading", { name: "No task history recorded." }).waitFor();
      assert.equal(await app.page.locator(".recurring-history-item").count(), 0);
    });
  });

  test("a failed history load shows an error with a retry that loads the runs", async () => {
    await withApp({}, async (app) => {
      seed(app);
      app.server.rpc.scenario("jobs.history", "error", { code: "E_INTERNAL", message: "ledger broke" });
      await openHistory(app);
      const err = app.page.locator(".page-state[data-state=error]");
      assert.equal(await err.getAttribute("role"), "alert");
      app.server.rpc.scenario("jobs.history", "success");
      await err.getByRole("button", { name: "Try again" }).click();
      await app.page.locator(".recurring-history-item").first().waitFor();
      assert.equal(calls(app, "jobs.history").length, 2);
    });
  });

  test("outcomes are shown in the UI language", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      seed(app);
      await openRoute(app.page, "#/recurring", "de");
      await historyTab(app.page).click();
      await app.page.locator(".recurring-history-item").first().waitFor();
      const badges = await app.page.locator(".recurring-history-item .badge").allInnerTexts();
      assert.deepEqual(badges, ["Abgeschlossen", "Fehlgeschlagen", "Übersprungen", "Unvollständig", "Abgebrochen"]);
    });
  });

  // KNOWN GAP (page, not fixed: needs a decision which agents to ask): jobs.history without agentId answers the SYSTEM job
  // history only (rpc.schema.json, core methods.ts). The page lists agent jobs such as "consolidate" and can run them, but never
  // shows their runs, because it never passes an agentId.
  test("the history also shows runs of agent jobs", { todo: "KNOWN GAP web Recurring History: erwartet Läufe des Agenten-Jobs consolidate im Verlauf (jobs.history mit agentId), tatsächlich nur Systemjobs (jobs.history ohne agentId, packages/web/src/pages/recurring/page.ts HistoryTab)" }, async () => {
    await withApp({}, async (app) => {
      seed(app);
      // Like the real core: no agentId = system runs, an agentId = that agent's runs.
      app.server.rpc.handle("jobs.history", (params) => {
        const { agentId } = (params ?? {}) as { agentId?: string };
        return { runs: agentId ? [agentRun(1, "consolidate", "completed", 900)] : [systemRun(1, "models.scan", "completed", 5000)] };
      }, { write: false });
      await openHistory(app);
      assert.ok(calls(app, "jobs.history").some((c) => (c.params as { agentId?: string }).agentId !== undefined), "jobs.history is never asked with an agentId");
      await app.page.locator(".recurring-history-item", { hasText: "consolidate" }).waitFor();
    });
  });
});

describe("Recurring Tasks: Run now needs a confirmation", opts, () => {
  test("opening the dialog sends nothing; Cancel, the close button, Escape and a click on the backdrop each send nothing", async () => {
    for (const how of ["cancel", "close", "escape", "backdrop"] as const) {
      await withApp({}, async (app) => {
        seed(app);
        await openList(app);
        await openDialog(app);
        const dlg = dialog(app.page);
        assert.match((await dlg.textContent()) ?? "", /consolidate/, "the dialog names the job");
        assert.equal(calls(app, "jobs.run").length, 0, "nothing is sent by merely opening the dialog");
        if (how === "cancel") await dlg.getByRole("button", { name: "Cancel", exact: true }).click();
        else if (how === "close") await dlg.getByRole("button", { name: "Close", exact: true }).click();
        else if (how === "escape") await app.page.keyboard.press("Escape");
        else await app.page.mouse.click(4, 4);
        await dlg.waitFor({ state: "detached" });
        assert.equal(calls(app, "jobs.run").length, 0, `${how} sends no jobs.run`);
        assert.equal(await app.page.locator(".recurring-table").count(), 1, "the list is still there");
        assert.equal(calls(app, "jobs.list").length, 1, `${how} does not reload the list`);
        assert.deepEqual(app.problems, [], how);
      });
    }
  });

  test("confirming an agent job sends one jobs.run with its agent, a system job one without; the dialog closes and the list reloads", async () => {
    await withApp({}, async (app) => {
      const hits = seed(app);
      await openList(app);

      await openDialog(app, 0);
      await confirmButton(app.page).click();
      await dialog(app.page).waitFor({ state: "detached" });
      await hits.reached("jobs.list", 2);

      await openDialog(app, 1);
      await confirmButton(app.page).click();
      await dialog(app.page).waitFor({ state: "detached" });
      await hits.reached("jobs.list", 3);

      const runs = calls(app, "jobs.run");
      assert.equal(runs.length, 2);
      const [agent, system] = [runs[0]!, runs[1]!];
      assert.equal((agent.params as { job: string }).job, "consolidate");
      assert.equal((system.params as { job: string }).job, "models.scan");
      assertParamsFit("jobs.run", agent.params);
      assertParamsFit("jobs.run", system.params); // agentId is refused for system jobs; the params are closed
      assert.ok("agentId" in (agent.params as object), "an agent job needs an agentId");
      assert.ok(!("agentId" in (system.params as object)), "a system job must not carry an agentId");
      assert.ok(agent.csrf && system.csrf && agent.csrf !== system.csrf, "a write carries its own one-time CSRF token");
      assert.deepEqual(app.problems, []);
    });
  });

  test("a double click on the confirm button sends exactly one jobs.run (real double click)", async () => {
    await withApp({}, async (app) => {
      const hold = gate();
      const hits = seed(app, { holdRun: hold.held });
      await openList(app);
      await openDialog(app);
      await confirmButton(app.page).dblclick();
      await hits.reached("jobs.run", 1);
      assert.equal(await confirmButton(app.page).isDisabled(), true, "the confirm button is off while the run is in flight");
      hold.release();
      await dialog(app.page).waitFor({ state: "detached" });
      await hits.reached("jobs.list", 2);
      assert.equal(calls(app, "jobs.run").length, 1);
    });
  });

  test("two clicks in the same task (before the page can re-render) still send exactly one jobs.run", async () => {
    await withApp({}, async (app) => {
      const hold = gate();
      const hits = seed(app, { holdRun: hold.held });
      await openList(app);
      await openDialog(app);
      await confirmButton(app.page).evaluate((el) => { (el as HTMLButtonElement).click(); (el as HTMLButtonElement).click(); });
      await hits.reached("jobs.run", 1);
      hold.release();
      await dialog(app.page).waitFor({ state: "detached" });
      await hits.reached("jobs.list", 2);
      assert.equal(calls(app, "jobs.run").length, 1);
    });
  });

  test("a failed run keeps the dialog open with the error announced and focus inside; a retry then runs once more", async () => {
    await withApp({}, async (app) => {
      const hits = seed(app);
      app.server.rpc.scenario("jobs.run", "error", { code: "E_INTERNAL", message: "engine exploded" });
      await openList(app);
      await openDialog(app);
      await confirmButton(app.page).click();
      const alert = dialog(app.page).locator(".form-error[role=alert]");
      await alert.waitFor();
      assert.notEqual(((await alert.textContent()) ?? "").trim(), "");
      assert.equal(calls(app, "jobs.run").length, 1);
      assert.equal(await confirmButton(app.page).isDisabled(), false, "the user can try again");
      assert.equal(await focusInDialog(app.page), true, "focus did not fall out of the dialog while the button was busy");
      assert.equal(calls(app, "jobs.list").length, 1, "a failed run does not reload the list");

      app.server.rpc.scenario("jobs.run", "success");
      await confirmButton(app.page).click();
      await dialog(app.page).waitFor({ state: "detached" });
      await hits.reached("jobs.list", 2);
      assert.equal(calls(app, "jobs.run").length, 2);
      assert.deepEqual(app.problems, []);
    });
  });

  test("a refused run (the server says no) shows an error in the dialog instead of closing it", async () => {
    await withApp({}, async (app) => {
      seed(app);
      app.server.rpc.scenario("jobs.run", "forbidden");
      await openList(app);
      await openDialog(app);
      await confirmButton(app.page).click();
      await dialog(app.page).locator(".form-error[role=alert]").waitFor();
      assert.equal(await dialog(app.page).count(), 1);
      assert.equal(calls(app, "jobs.run").length, 1);
    });
  });

  // KNOWN GAP (page, not fixed: needs an agent choice): jobs.run for an agent job needs an existing agent. The page sends the
  // literal "default" and never asks agent.list, so on a harness whose agents are called otherwise the run is refused
  // (E_AGENT_UNKNOWN).
  test("an agent job runs on an agent that exists", { todo: "KNOWN GAP web Recurring Run now: erwartet agentId aus agent.list (hier main), tatsächlich fest \"default\" (packages/web/src/pages/recurring/page.ts RunConfirmDialog)" }, async () => {
    await withApp({}, async (app) => {
      seed(app);
      app.server.rpc.handle("agent.list", () => ({ agents: [{ agentId: "main", open: false, activity: { state: "idle" } }] }), { write: false });
      await openList(app);
      await openDialog(app, 0);
      await confirmButton(app.page).click();
      await dialog(app.page).waitFor({ state: "detached" });
      assert.equal((calls(app, "jobs.run")[0]!.params as { agentId?: string }).agentId, "main");
    });
  });
});

describe("Recurring Tasks: roles", opts, () => {
  for (const role of ["owner", "admin", "operator"] as const) {
    test(`${role} can run jobs: every row has a usable Run now`, async () => {
      await withApp({ server: { role } }, async (app) => {
        seed(app);
        await openList(app);
        assert.equal(await enabledRunButtons(app.page), JOBS.length);
      });
    });
  }
  for (const role of ["member", "viewer"] as const) {
    test(`${role} sees the jobs but no usable Run now, and nothing is sent to jobs.run`, async () => {
      await withApp({ server: { role } }, async (app) => {
        seed(app);
        await openList(app);
        assert.equal(await rows(app.page).count(), JOBS.length, "the list is a read, open to every role");
        assert.equal(await enabledRunButtons(app.page), 0, "docs/rbac.md: jobs.run is for Owner, Admin and Operator");
        assert.equal(await dialog(app.page).count(), 0);
        assert.equal(calls(app, "jobs.run").length, 0);
        // The history is a read too.
        await historyTab(app.page).click();
        await app.page.locator(".recurring-history-item").first().waitFor();
        assert.deepEqual(app.problems, []);
      });
    });
  }
});

describe("Recurring Tasks: the dialog by keyboard", opts, () => {
  test("Enter opens it, Tab and Shift+Tab stay inside, Escape closes it and focus returns to the same row's button", async () => {
    await withApp({}, async (app) => {
      seed(app);
      await openList(app);
      const trigger = triggers(app.page).nth(1);
      await trigger.focus();
      await app.page.keyboard.press("Enter");
      await dialog(app.page).waitFor();
      assert.equal(await focusInDialog(app.page), true, "focus moved into the dialog");

      // Close, Cancel and Run now are the three stops: a full lap and a bit more never leaves the dialog.
      const seen: string[] = [];
      for (let i = 0; i < 7; i++) {
        await app.page.keyboard.press("Tab");
        assert.equal(await focusInDialog(app.page), true, `Tab #${i + 1} stays in the dialog`);
        seen.push(await app.page.evaluate(() => (document.activeElement as HTMLElement).className + "|" + (document.activeElement as HTMLElement).textContent));
      }
      assert.ok(new Set(seen).size >= 3, `all three controls are reachable: ${JSON.stringify(seen)}`);
      for (let i = 0; i < 7; i++) {
        await app.page.keyboard.press("Shift+Tab");
        assert.equal(await focusInDialog(app.page), true, `Shift+Tab #${i + 1} stays in the dialog`);
      }

      await app.page.keyboard.press("Escape");
      await dialog(app.page).waitFor({ state: "detached" });
      assert.equal(await isFocused(trigger), true, "focus is back on the button that opened it");
      assert.equal(calls(app, "jobs.run").length, 0);
    });
  });

  test("Shift+Tab from the first control wraps to Run now, Tab from Run now wraps to the first", async () => {
    await withApp({}, async (app) => {
      seed(app);
      await openList(app);
      await openDialog(app);
      const dlg = dialog(app.page);
      const first = dlg.getByRole("button", { name: "Close", exact: true });
      const last = confirmButton(app.page);
      await first.focus();
      await app.page.keyboard.press("Shift+Tab");
      assert.equal(await isFocused(last), true, "Shift+Tab from Close lands on Run now");
      await app.page.keyboard.press("Tab");
      assert.equal(await isFocused(first), true, "Tab from Run now lands on Close");
    });
  });

  test("keyboard only: open, move to Run now, press Enter once; one jobs.run, dialog closed, focus back on the row's button", async () => {
    await withApp({}, async (app) => {
      const hits = seed(app);
      await openList(app);
      const trigger = triggers(app.page).first();
      await trigger.focus();
      await app.page.keyboard.press("Enter");
      await dialog(app.page).waitFor();
      await confirmButton(app.page).focus();
      await app.page.keyboard.press("Enter");
      await dialog(app.page).waitFor({ state: "detached" });
      await hits.reached("jobs.list", 2);
      assert.equal(calls(app, "jobs.run").length, 1);
      assert.equal(await isFocused(trigger), true, "focus is back on the button that opened it");
    });
  });
});

describe("Recurring Tasks: accessibility", opts, () => {
  test("the job list is axe clean", async () => {
    await withApp({}, async (app) => {
      seed(app);
      await openList(app);
      await expectAxeClean(app.page, "recurring list");
    });
  });

  test("the run history is axe clean", async () => {
    await withApp({}, async (app) => {
      seed(app);
      await openHistory(app);
      await expectAxeClean(app.page, "recurring history");
    });
  });

  test("the confirmation dialog is axe clean, in English and German", async () => {
    for (const [locale, lang] of [["en-US", "en"], ["de-DE", "de"]] as const) {
      await withApp({ locale }, async (app) => {
        seed(app);
        await openList(app, "#/recurring", lang);
        await openDialog(app);
        await expectAxeClean(app.page, `recurring dialog ${lang}`);
      });
    }
  });

  test("the empty list and an error with the dialog's alert are axe clean", async () => {
    await withApp({}, async (app) => {
      seed(app, { jobs: [] });
      await openRoute(app.page, "#/recurring");
      await app.page.locator(".page-state[data-state=empty]").waitFor();
      await expectAxeClean(app.page, "recurring empty");
    });
    await withApp({}, async (app) => {
      seed(app);
      app.server.rpc.scenario("jobs.run", "error", { code: "E_INTERNAL", message: "engine exploded" });
      await openList(app);
      await openDialog(app);
      await confirmButton(app.page).click();
      await dialog(app.page).locator(".form-error[role=alert]").waitFor();
      await expectAxeClean(app.page, "recurring dialog with error");
    });
  });
});
