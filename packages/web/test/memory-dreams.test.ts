// Dreams tab (M3 E7): status, "did it ever run", schedule, run log with logs, confirmed actions, states per area, live updates.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Page } from "playwright";
import { roleAllows } from "../src/pages/memory/data.ts";
import { rpcError } from "./mock-rpc.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { defaultFixture, installMemoryMocks, makePhase, type Fixture } from "./memory-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

async function open(app: App, hash = "#/memories/dreams", tweak?: (fx: Fixture, app: App) => void): Promise<Fixture> {
  const fx = installMemoryMocks(app.server, defaultFixture());
  tweak?.(fx, app);
  await openRoute(app.page, hash);
  return fx;
}

const phase = (page: Page, name: "Light" | "REM" | "Deep") => page.getByRole("group", { name, exact: true });
const runs = (app: App, dry?: boolean) => app.server.rpc.calls.filter((c) => c.method === "dreams.run" && (dry === undefined || Boolean((c.params as { dryRun?: boolean }).dryRun) === dry));

describe("dreams: status and schedule", opts, () => {
  test("the Dreams tab is selected by the URL; phases show outcome, reason, error, schedule, next run, importance and breaker", async () => {
    await withApp({}, async (app) => {
      await open(app);
      assert.equal(await app.page.getByRole("tab", { selected: true }).textContent(), "Dreams");
      const light = phase(app.page, "Light");
      await light.waitFor();
      await light.getByText("Completed").first().waitFor();
      const lt = (await light.textContent()) ?? "";
      for (const part of ["0 */4 * * *", "Europe/Berlin", "40 of 150", "8 captures", "closed, 0 of 3", "Enabled"]) assert.ok(lt.includes(part), `light lacks ${part}: ${lt}`);
      const rem = (await phase(app.page, "REM").textContent()) ?? "";
      assert.ok(rem.includes("Skipped") && rem.includes("min_corpus"), rem);
      const deep = (await phase(app.page, "Deep").textContent()) ?? "";
      assert.ok(deep.includes("Failed") && deep.includes("store locked") && deep.includes("Disabled") && deep.includes("none while disabled"), deep);
      const top = (await app.page.getByRole("group", { name: "Has dreaming run?" }).textContent()) ?? "";
      assert.ok(top.includes("3 of 3") && top.includes("1") && top.includes("dreams.log"), top);
      const diary = (await app.page.getByRole("group", { name: "main", exact: true }).textContent()) ?? "";
      assert.ok(diary.includes("/home/x/diary/main.md") && diary.includes("2,048 bytes") || diary.includes("2.048 bytes"), diary);
      assert.ok(((await app.page.getByRole("group", { name: "Scheduler counters" }).textContent()) ?? "").includes("min_corpus 1"));
      for (let i = 0; i < 40 && !app.server.rpc.calls.some((c) => c.method === "dreams.schedule.get"); i++) await app.page.waitForTimeout(50);
      assert.deepEqual(app.server.rpc.calls.find((c) => c.method === "dreams.schedule.get")?.params, { agentId: "main" });
      assert.equal(app.problems.length, 0, app.problems.join("\n"));
    });
  });

  test("never ran is said plainly, with the empty ledger as evidence", async () => {
    await withApp({}, async (app) => {
      await open(app, "#/memories/dreams", (fx) => { fx.phases = fx.phases.map((p) => makePhase(p.phase)); fx.runs = []; });
      const top = app.page.getByRole("group", { name: "Has dreaming run?" });
      await top.getByText("Never ran").first().waitFor();
      await top.getByText(/No dream has run yet/).waitFor();
      await phase(app.page, "Light").getByText("Never ran").waitFor();
      await app.page.getByRole("heading", { name: "No dream run recorded" }).waitFor();
    });
  });

  test("the schedule falls back to the status when dreams.schedule.get is not served, and says so", async () => {
    await withApp({}, async (app) => {
      await open(app, "#/memories/dreams", (_fx, a) => { a.server.rpc.scenario("dreams.schedule.get", "unavailable"); });
      await app.page.getByText(/The schedule could not be read/).waitFor();
      await phase(app.page, "Light").getByText(/0 \*\/4 \* \* \*/).waitFor();
    });
  });

  test("an open circuit breaker and a running phase are visible", async () => {
    await withApp({}, async (app) => {
      await open(app, "#/memories/dreams", (fx) => {
        fx.phases[1] = makePhase("rem", { running: true, breaker: { state: "open", until: 1_790_000_000_000, reason: "breaker_sessions", sessionsUsed: 3, limit: 3 } });
      });
      const rem = phase(app.page, "REM");
      await rem.getByText("Breaker open").waitFor();
      await rem.getByText("Running", { exact: true }).waitFor();
      assert.ok(((await rem.textContent()) ?? "").includes("breaker_sessions"));
    });
  });
});

describe("dreams: states per area", opts, () => {
  test("status unavailable: the tab says Dreams are not available; the Memories tab is unaffected", async () => {
    await withApp({}, async (app) => {
      await open(app, "#/memories/dreams", (_fx, a) => { a.server.rpc.scenario("dreams.status", "unavailable"); });
      await app.page.getByRole("heading", { name: "Dreams are not available" }).waitFor();
      await app.page.getByRole("tab", { name: "Memories" }).click();
      await app.page.getByRole("group", { name: "Health" }).waitFor();
    });
  });

  test("status error: alert with Try again, which recovers", async () => {
    await withApp({}, async (app) => {
      await open(app, "#/memories/dreams", (_fx, a) => { a.server.rpc.scenario("dreams.status", "error", { code: "E_INTERNAL", message: "ledger broken" }); });
      const alert = app.page.getByRole("alert").first();
      await alert.getByRole("heading", { name: "Something went wrong" }).waitFor();
      app.server.rpc.scenario("dreams.status", "success");
      await alert.getByRole("button", { name: "Try again" }).click();
      await phase(app.page, "Light").waitFor();
    });
  });

  test("status forbidden: not allowed", async () => {
    await withApp({}, async (app) => {
      await open(app, "#/memories/dreams", (_fx, a) => { a.server.rpc.scenario("dreams.status", "forbidden"); });
      await app.page.getByRole("heading", { name: "Not allowed" }).first().waitFor();
    });
  });

  test("run log unavailable while the status works: only the run list is unavailable", async () => {
    await withApp({}, async (app) => {
      await open(app, "#/memories/dreams", (_fx, a) => { a.server.rpc.scenario("dreams.log", "unavailable"); });
      await phase(app.page, "Light").waitFor();
      await app.page.getByRole("region", { name: "Dream runs" }).getByRole("heading", { name: "The run log is not available" }).waitFor();
    });
  });
});

describe("dreams: run log", opts, () => {
  test("the ledger lists runs newest first; a run opens with its error and log text; the phase filter narrows", async () => {
    await withApp({}, async (app) => {
      await open(app);
      const list = app.page.getByRole("region", { name: "Dream runs" });
      await list.getByRole("link").first().waitFor();
      assert.equal(await list.getByRole("link").count(), 3);
      assert.ok(((await list.getByRole("link").first().textContent()) ?? "").includes("Failed"));
      await list.getByRole("link").first().click();
      assert.equal(await app.page.evaluate(() => location.hash), "#/memories/dreams/run_003");
      const d = app.page.getByRole("region", { name: "Run details" });
      await d.getByText("engine job consolidate-daily failed: store locked").first().waitFor();
      await d.getByLabel("Run log").waitFor();
      const text = (await d.textContent()) ?? "";
      for (const part of ["line 2 of the run log", "consolidate-daily", "engine_job_failed", "run_003"]) assert.ok(text.includes(part), `${part} missing: ${text}`);
      await app.page.getByLabel("Filter by phase").selectOption("rem");
      await app.page.waitForFunction(() => document.querySelectorAll('[aria-label="Dream runs"] li').length === 1);
    });
  });

  test("a deep link opens the run; an unknown run says so; the tab stays Dreams", async () => {
    await withApp({}, async (app) => {
      await open(app, "#/memories/dreams/run_002");
      await app.page.getByRole("region", { name: "Run details" }).getByText("min_corpus").first().waitFor();
      assert.equal(await app.page.getByRole("tab", { selected: true }).textContent(), "Dreams");
      await app.page.evaluate(() => { location.hash = "#/memories/dreams/run_999"; });
      await app.page.getByRole("region", { name: "Run details" }).getByRole("heading", { name: "Run not found" }).waitFor();
    });
  });

  test("a skipped run without a log says why there is none", async () => {
    await withApp({}, async (app) => {
      await open(app, "#/memories/dreams/run_002");
      await app.page.getByText(/No log text for this run/).waitFor();
    });
  });
});

describe("dreams: confirmed actions", opts, () => {
  test("Run now shows the dry-run plan in a dialog; Cancel runs nothing; Confirm runs once and shows the result", async () => {
    await withApp({}, async (app) => {
      await open(app);
      const light = phase(app.page, "Light");
      await light.getByRole("button", { name: "Run now" }).click();
      const dlg = app.page.getByRole("dialog", { name: "Run Light for main now?" });
      await dlg.getByText("The guards allow this run").waitFor();
      await dlg.getByText("light-dream, embedding-drain").waitFor();
      assert.equal(runs(app, true).length, 1);
      assert.equal(runs(app, false).length, 0, "nothing runs before the confirmation");
      await dlg.getByRole("button", { name: "Cancel" }).click();
      await dlg.waitFor({ state: "detached" });
      assert.equal(runs(app, false).length, 0);
      assert.equal(await app.page.evaluate(() => document.activeElement?.textContent), "Run now", "focus returns to the opener");

      await light.getByRole("button", { name: "Run now" }).click();
      await dlg.getByText("The guards allow this run").waitFor();
      await dlg.getByRole("button", { name: "Run now" }).click();
      await app.page.getByRole("status").filter({ hasText: "finished as run run_004: completed" }).waitFor();
      assert.equal(runs(app, false).length, 1);
      assert.deepEqual(runs(app, false)[0]!.params, { agentId: "main", phase: "light" });
      assert.ok(runs(app, false)[0]!.csrf, "a write carries a CSRF token");
      await app.page.getByRole("region", { name: "Dream runs" }).getByRole("link").first().waitFor();
      await app.page.waitForFunction(() => document.querySelectorAll('[aria-label="Dream runs"] li').length === 4);
    });
  });

  test("when the guards would skip the run, the dialog says why and cannot confirm", async () => {
    await withApp({}, async (app) => {
      await open(app, "#/memories/dreams", (fx) => { fx.planWouldRun = false; });
      await phase(app.page, "Light").getByRole("button", { name: "Run now" }).click();
      const dlg = app.page.getByRole("dialog");
      await dlg.getByText("The guards would skip this run").waitFor();
      await dlg.getByText("Reason: min_corpus").waitFor();
      assert.equal(await dlg.getByRole("button", { name: "Run now" }).getAttribute("aria-disabled"), "true");
      await dlg.getByRole("button", { name: "Run now" }).click({ force: true });
      await app.page.waitForTimeout(100);
      assert.equal(runs(app, false).length, 0);
    });
  });

  test("Esc closes the dialog without running", async () => {
    await withApp({}, async (app) => {
      await open(app);
      await phase(app.page, "Light").getByRole("button", { name: "Run now" }).click();
      const dlg = app.page.getByRole("dialog");
      await dlg.getByText("The guards allow this run").waitFor();
      await app.page.keyboard.press("Escape");
      await dlg.waitFor({ state: "detached" });
      assert.equal(runs(app, false).length, 0);
    });
  });

  test("Disable asks first (Cancel changes nothing); Confirm calls dreams.disable and the phase shows Disabled with an Enable button", async () => {
    await withApp({}, async (app) => {
      await open(app);
      const light = phase(app.page, "Light");
      await light.getByRole("button", { name: "Disable" }).click();
      const dlg = app.page.getByRole("dialog", { name: "Disable Light for main?" });
      await dlg.getByRole("button", { name: "Cancel" }).click();
      await dlg.waitFor({ state: "detached" });
      assert.equal(app.server.rpc.calls.filter((c) => c.method === "dreams.disable").length, 0);
      await light.getByRole("button", { name: "Disable" }).click();
      await dlg.getByRole("button", { name: "Disable" }).click();
      await app.page.getByRole("status").filter({ hasText: "Light for main is disabled." }).waitFor();
      await light.getByRole("button", { name: "Enable" }).waitFor();
      await light.getByText("Disabled").first().waitFor();
      assert.deepEqual(app.server.rpc.calls.find((c) => c.method === "dreams.disable")!.params, { agentId: "main", phase: "light" });
      await phase(app.page, "Deep").getByRole("button", { name: "Enable" }).click();
      await app.page.getByRole("dialog", { name: "Enable Deep for main?" }).getByRole("button", { name: "Enable" }).click();
      await app.page.getByRole("status").filter({ hasText: "Deep for main is enabled." }).waitFor();
      assert.equal(app.server.rpc.calls.filter((c) => c.method === "dreams.enable").length, 1);
    });
  });

  test("a refusal by the server (E_DENIED) is shown in the dialog and disables the action with the reason, it does not hide it", async () => {
    await withApp({}, async (app) => {
      await open(app, "#/memories/dreams", (_fx, a) => { a.server.rpc.scenario("dreams.run", "forbidden"); a.server.rpc.scenario("dreams.disable", "forbidden"); });
      const light = phase(app.page, "Light");
      await light.getByRole("button", { name: "Run now" }).click();
      const dlg = app.page.getByRole("dialog");
      await dlg.getByRole("alert").getByText(/does not allow running dreams/).waitFor();
      await dlg.getByRole("button", { name: "Cancel" }).click();
      await dlg.waitFor({ state: "detached" });
      const run = light.getByRole("button", { name: "Run now" });
      assert.equal(await run.getAttribute("aria-disabled"), "true");
      await light.getByText(/The server refused this: your role does not allow running dreams/).waitFor();
      const describedBy = await run.getAttribute("aria-describedby");
      assert.ok(describedBy && (await app.page.locator(`[id="${describedBy}"]`).count()) === 1);
      await run.click({ force: true });
      assert.equal(await app.page.getByRole("dialog").count(), 0, "a disabled action does not open the dialog");

      await light.getByRole("button", { name: "Disable" }).click();
      await app.page.getByRole("dialog").getByRole("button", { name: "Disable" }).click();
      await app.page.getByRole("dialog").getByRole("alert").getByText(/does not allow changing the schedule/).waitFor();
      await app.page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
      assert.equal(await light.getByRole("button", { name: "Disable" }).getAttribute("aria-disabled"), "true");
    });
  });

  test("a run that fails shows the failure in the dialog and keeps it open", async () => {
    await withApp({}, async (app) => {
      await open(app, "#/memories/dreams", (_fx, a) => {
        a.server.rpc.handle("dreams.run", (p) => {
          if ((p as { dryRun?: boolean }).dryRun) return { dryRun: true, wouldRun: true, reason: null, jobs: ["light-dream"], idempotencyKey: "k", counts: {} };
          throw rpcError("E_CONFLICT", "phase is already running", "already_running");
        });
      });
      await phase(app.page, "Light").getByRole("button", { name: "Run now" }).click();
      const dlg = app.page.getByRole("dialog");
      await dlg.getByText("The guards allow this run").waitFor();
      await dlg.getByRole("button", { name: "Run now" }).click();
      await dlg.getByRole("alert").getByText(/phase is already running/).waitFor();
      assert.equal(await app.page.getByRole("dialog").count(), 1);
      assert.notEqual(await dlg.getByRole("button", { name: "Run now" }).getAttribute("aria-disabled"), "true", "the user may try again");
    });
  });
});

describe("dreams: live updates", opts, () => {
  test("a job.run event reloads status and log when the event channel is up", async () => {
    await withApp({}, async (app) => {
      const fx = await open(app, "#/memories/dreams", (_f, a) => { a.server.events.enable(); });
      await phase(app.page, "Light").waitFor();
      await app.page.getByText("Live updates on").waitFor();
      fx.runs.unshift({ ...fx.runs[0]!, runId: "run_010", outcome: "completed", reason: null, error: null, startedAt: fx.runs[0]!.startedAt + 1000 });
      app.server.events.push({ event: "job.run", data: { agentId: "main", runId: "run_010", job: "light-dream", phase: "light", outcome: "completed" } });
      await app.page.waitForFunction(() => document.querySelectorAll('[aria-label="Dream runs"] li').length === 4);
    });
  });

  test("without the event channel the tab says so and Refresh reloads", async () => {
    await withApp({}, async (app) => {
      const fx = await open(app);
      await app.page.getByText(/Live updates off/).waitFor();
      fx.runs.unshift({ ...fx.runs[0]!, runId: "run_011" });
      await app.page.getByRole("button", { name: "Refresh" }).click();
      await app.page.waitForFunction(() => document.querySelectorAll('[aria-label="Dream runs"] li').length === 4);
    });
  });
});

describe("dreams: role gate", () => {
  test("owner, admin and operator may run; only owner and admin may change the schedule; an unknown role may try (the server decides)", () => {
    for (const r of ["owner", "admin", "operator"]) assert.equal(roleAllows(r, "dreams.run"), true, r);
    for (const r of ["member", "viewer"]) assert.equal(roleAllows(r, "dreams.run"), false, r);
    for (const r of ["owner", "admin"]) assert.equal(roleAllows(r, "dreams.schedule"), true, r);
    for (const r of ["operator", "member", "viewer"]) assert.equal(roleAllows(r, "dreams.schedule"), false, r);
    assert.equal(roleAllows("custom-role", "dreams.run"), true);
    assert.equal(roleAllows(undefined, "dreams.schedule"), true);
  });
});

describe("dreams: German", opts, () => {
  test("de texts for the tab, the dialog and the never-ran notice", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      installMemoryMocks(app.server, defaultFixture({ phases: defaultFixture().phases.map((p) => makePhase(p.phase)), runs: [] }));
      await openRoute(app.page, "#/memories/dreams", "de");
      await app.page.getByRole("group", { name: "Hat das Träumen je gelaufen?" }).getByText("Nie gelaufen").first().waitFor();
      await app.page.getByRole("group", { name: "Leicht", exact: true }).getByRole("button", { name: "Jetzt ausführen" }).click();
      await app.page.getByRole("dialog", { name: "Leicht für main jetzt ausführen?" }).getByRole("button", { name: "Abbrechen" }).click();
    });
  });
});
