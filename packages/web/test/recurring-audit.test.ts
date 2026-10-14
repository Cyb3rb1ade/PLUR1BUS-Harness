// Audit of #/recurring (agent c17): dates, localized run errors, personal tasks (paused state, runAs, schedule input, DST).
// Everything runs against the typed mock; the real transport is not wired yet.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { expectAxeClean } from "./axe.ts";
import { browserSkip, openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { rpcError } from "./mock-rpc.ts";
import { seedJobs } from "./surfaces-fixtures.ts";

before(setup);
after(teardown);
const opts = { skip: browserSkip };

const calls = (app: App, method: string): { params: unknown }[] => app.server.rpc.calls.filter((c) => c.method === method);
describe("Recurring: dates, run errors", opts, () => {
  test("next run and history show the date, not just the time of day", async () => {
    await withApp({}, async (app) => {
      seedJobs(app.server.rpc, [{ name: "consolidate", needsLlm: true, singleton: true, kind: "agent", schedule: { every: 86_400_000, jitter: 0 }, nextRunAt: 1_800_000_000_000 }],
        [{ runId: "r1", job: "consolidate", agentId: "main", trigger: "cron", outcome: "completed", attempt: 1, durationMs: 5, startedAt: 1_799_000_000_000, finishedAt: 1_799_000_000_005 }]);
      await openRoute(app.page, "#/recurring");
      const next = await app.page.locator(".recurring-table tbody tr td").nth(3).innerText();
      assert.match(next, /2027/);
      await app.page.getByRole("tab", { name: /Run History/ }).click();
      const when = await app.page.locator(".recurring-history-item .field-hint").first().innerText();
      assert.match(when, /2027/);
    });
  });

  test("a failed Run now shows a localized sentence, not the server text (German)", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      seedJobs(app.server.rpc);
      app.server.rpc.handle("jobs.run", () => { throw rpcError("E_INTERNAL", "ECONNREFUSED 10.0.0.5:5432 at pg.connect"); });
      await openRoute(app.page, "#/recurring", "de");
      await app.page.getByRole("button", { name: "Jetzt ausführen" }).first().click();
      await app.page.getByRole("dialog").getByRole("button", { name: "Jetzt ausführen" }).click();
      const alert = app.page.getByRole("dialog").locator("[role=alert]");
      await alert.waitFor();
      const text = await alert.innerText();
      assert.ok(!text.includes("ECONNREFUSED") && !/Failed to/.test(text), `got: ${text}`);
      assert.match(text, /gestartet/);
    });
  });
});

describe("Recurring: personal tasks", opts, () => {
  const base = { id: "user:fixture", name: "Daily", agentId: "main", prompt: "Summarize the day", schedule: { cron: "0 9 * * *", timezone: "Europe/Berlin" }, enabled: true, kind: "user", needsLlm: true, singleton: true, runAs: "alice", createdBy: "alice", createdAt: 0, updatedAt: 0, nextRunAt: 1_800_000_000_000 };
  function seedUser(app: App, job: Record<string, unknown> = {}, runs: unknown[] = []): void {
    const rpc = app.server.rpc;
    rpc.handle("jobs.list", () => ({ jobs: [{ ...base, ...job }], manageableAgents: ["main"] }), { write: false });
    rpc.handle("jobs.update", (p) => ({ job: { ...base, ...(p as object) } }));
    rpc.handle("jobs.create", (p) => ({ job: { ...base, ...(p as object) } }));
    rpc.handle("jobs.history", () => ({ runs }), { write: false });
  }

  test("a task the server paused shows that, and why", async () => {
    await withApp({}, async (app) => {
      seedUser(app, { enabled: false, disabledReason: "skipped_no_rights" });
      await openRoute(app.page, "#/recurring");
      const row = app.page.locator(".recurring-page li", { hasText: "Daily" });
      await row.getByText(/Paused/).waitFor();
      await row.getByText(/lost the right/).waitFor();
    });
  });

  test("editing someone else's task names who it ran as until now", async () => {
    await withApp({}, async (app) => {
      seedUser(app);
      await openRoute(app.page, "#/recurring");
      await app.page.getByRole("button", { name: "Edit recurring task", exact: true }).click();
      const dlg = app.page.getByRole("dialog");
      await dlg.getByText("This task will run under your name from now on.", { exact: true }).waitFor();
      await dlg.getByText(/alice/).waitFor();
    });
  });

  test("saving sends the trimmed cron and timezone", async () => {
    await withApp({}, async (app) => {
      seedUser(app);
      await openRoute(app.page, "#/recurring");
      await app.page.getByRole("button", { name: "Edit recurring task", exact: true }).click();
      const dlg = app.page.getByRole("dialog");
      await dlg.getByLabel("Cron expression", { exact: true }).fill("  0 7 * * *  ");
      await dlg.getByLabel("Timezone", { exact: true }).fill(" Europe/Berlin ");
      await dlg.getByRole("button", { name: "Save task", exact: true }).click();
      await dlg.waitFor({ state: "hidden" });
      assert.deepEqual((calls(app, "jobs.update")[0]!.params as { schedule: unknown }).schedule, { cron: "0 7 * * *", timezone: "Europe/Berlin" });
    });
  });

  test("a cron the schema would refuse (over 128 characters) cannot be saved; the field is marked invalid", async () => {
    await withApp({}, async (app) => {
      seedUser(app);
      await openRoute(app.page, "#/recurring");
      await app.page.getByRole("button", { name: "Edit recurring task", exact: true }).click();
      const dlg = app.page.getByRole("dialog");
      const longCron = Array.from({ length: 60 }, (_, i) => String(i)).join(",") + " * * * *";
      await dlg.getByLabel("Cron expression", { exact: true }).fill(longCron);
      assert.equal(await dlg.getByRole("button", { name: "Save task", exact: true }).isDisabled(), true);
      assert.equal(await dlg.getByLabel("Cron expression", { exact: true }).getAttribute("aria-invalid"), "true");
    });
  });

  test("the preview shows the date and offset of each run and warns when a DST change hits the schedule", async () => {
    await withApp({}, async (app) => {
      seedUser(app);
      await openRoute(app.page, "#/recurring");
      await app.page.getByRole("button", { name: "Edit recurring task", exact: true }).click();
      const dlg = app.page.getByRole("dialog");
      await dlg.getByLabel("Cron expression", { exact: true }).fill("30 2 * * *");
      const items = await dlg.getByRole("listitem").allInnerTexts();
      assert.equal(items.length, 3);
      assert.match(items[0]!, /20\d\d/);
      assert.match(items[0]!, /GMT[+-]\d/);
      await dlg.locator("[data-dst-note]").waitFor();
      await dlg.getByLabel("Cron expression", { exact: true }).fill("30 9 * * *");
      assert.equal(await dlg.locator("[data-dst-note]").count(), 0);
    });
  });

  test("a task without runs says so, and runs show their outcome in the UI language (German)", async () => {
    await withApp({ locale: "de-DE" }, async (app) => {
      seedUser(app);
      await openRoute(app.page, "#/recurring", "de");
      await app.page.getByRole("button", { name: "Aufgabenverlauf", exact: true }).click();
      await app.page.getByRole("dialog").getByText("Noch keine Läufe.", { exact: true }).waitFor();
    });
    await withApp({ locale: "de-DE" }, async (app) => {
      const run = { runId: "r", jobId: base.id, job: "Daily", kind: "user", agentId: "main", runAs: "alice", runAsDisplayName: "Alice", trigger: "recurring", startedAt: 1_800_000_000_000, finishedAt: 1_800_000_001_000, durationMs: 1000, outcome: "failed" };
      seedUser(app, {}, [run]);
      await openRoute(app.page, "#/recurring", "de");
      await app.page.getByRole("button", { name: "Aufgabenverlauf", exact: true }).click();
      await app.page.getByRole("dialog").getByText(/Fehlgeschlagen/).waitFor();
    });
  });

  test("two Save clicks and two Delete clicks in one task each send one request", async () => {
    await withApp({}, async (app) => {
      seedUser(app);
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      app.server.rpc.handle("jobs.update", async (p) => { await held; return { job: { ...base, ...(p as object) } }; });
      app.server.rpc.handle("jobs.delete", async () => { await held; return { id: base.id, deleted: true }; });
      await openRoute(app.page, "#/recurring");
      await app.page.getByRole("button", { name: "Edit recurring task", exact: true }).click();
      await app.page.getByRole("dialog").getByRole("button", { name: "Save task", exact: true }).waitFor();
      await app.page.evaluate(() => { const b = document.querySelector<HTMLButtonElement>("button[form=user-job-form]")!; b.click(); b.click(); });
      await app.page.waitForTimeout(150);
      assert.equal(calls(app, "jobs.update").length, 1);
      release();
      await app.page.getByRole("dialog").waitFor({ state: "hidden" });
      await app.page.getByRole("button", { name: "Delete recurring task", exact: true }).click();
      await app.page.getByRole("dialog").getByText("Delete task Daily?").waitFor();
      await app.page.evaluate(() => { const b = [...document.querySelectorAll<HTMLButtonElement>("dialog button.btn-primary")][0]!; b.click(); b.click(); });
      await app.page.waitForTimeout(150);
      assert.equal(calls(app, "jobs.delete").length, 1);
    });
  });

  test("the editor with a DST note and a paused task are axe clean, in English and German", async () => {
    for (const [locale, lng] of [["en-US", "en"], ["de-DE", "de"]] as const) {
      await withApp({ locale }, async (app) => {
        seedUser(app, { enabled: false, disabledReason: "skipped_agent_missing", schedule: { cron: "30 2 * * *", timezone: "Europe/Berlin" } });
        await openRoute(app.page, "#/recurring", lng);
        await expectAxeClean(app.page, "paused user job");
        await app.page.getByRole("button", { name: /Edit recurring task|Wiederkehrende Aufgabe bearbeiten/ }).click();
        await app.page.locator("[data-dst-note]").waitFor();
        await expectAxeClean(app.page, "user job editor with dst note");
      });
    }
  });
});
