import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { REAL, cli, home, reapHome, startCore, stopCore, type RunningCore } from "./helpers.ts";

// M1b-3 (ADR-009): the dreaming scheduler through the real CLI, a real core and the real engine's job registry. The
// scheduler's own timers stay off under test internals (RULING), so every run here is a manual one; the virtual-clock
// acceptance tests (A1-A8) are in packages/core/test/dreams-*.test.ts.
describe("M1b-3 — dreaming scheduler through the CLI", () => {
  it("phase schedules, dry run, run now and the ledger end to end", { skip: REAL && "flat embedder only" }, async () => {
    const h = home();
    let core: RunningCore | undefined;
    try {
      cli(h, ["agent", "create", "bernd"]);
      cli(h, ["config", "set", "engine.duplicateThreshold", "1.01", "--yes"]);
      core = await startCore(h);

      const sched = cli(h, ["dreams", "schedule", "get", "--agent", "bernd"]);
      assert.equal(sched.schema, "dreams.schedule.get/1");
      assert.deepEqual(sched.schedules.map((s: any) => [s.phase, s.cron, s.enabled]), [["light", "0 */4 * * *", true], ["rem", "15 1 * * *", true], ["deep", "0 4 * * *", true]]);
      assert.ok(sched.schedules.every((s: any) => typeof s.timezone === "string" && s.timezone.length > 0 && Number.isInteger(s.nextRunAt)), "timezone is explicit, next run is planned");

      // an edit is validated, applied and reported; a bad one writes nothing
      const set = cli(h, ["dreams", "schedule", "set", "deep", "--agent", "bernd", "--cron", "30 5 * * *", "--timezone", "Europe/Berlin"]);
      assert.equal(set.schema, "dreams.schedule.set/1");
      assert.equal(set.schedule.timezone, "Europe/Berlin");
      const bad = cli(h, ["dreams", "schedule", "set", "deep", "--agent", "bernd", "--cron", "not a cron"], { allowFail: true });
      assert.equal(bad.exit, 1);
      assert.equal(JSON.parse(bad.stdout).error, "E_INVALID_PARAMS");
      assert.equal(cli(h, ["dreams", "schedule", "get", "--agent", "bernd"]).schedules[2].cron, "30 5 * * *");
      assert.equal(cli(h, ["dreams", "disable", "rem", "--agent", "bernd"]).schedule.enabled, false);
      assert.equal(cli(h, ["dreams", "enable", "rem", "--agent", "bernd"]).schedule.enabled, true);

      // no corpus yet: the dry run says so, and writes nothing
      const dry = cli(h, ["dreams", "run", "light", "--agent", "bernd", "--dry-run"]);
      assert.equal(dry.dryRun, true); assert.equal(dry.wouldRun, false); assert.equal(dry.reason, "min_corpus");
      assert.equal(cli(h, ["dreams", "log", "--agent", "bernd", "--phase", "light"]).runs.length, 0, "a dry run leaves no ledger row");

      for (const text of ["Please remember that the roadmap review is on Thursday at ten.", "Please remember that the budget draft is due in March.", "Please remember that the offsite is in June."]) {
        assert.equal(cli(h, ["memory", "add", "--agent", "bernd", "--session", "s1", text]).stored, 1);
      }
      const ready = cli(h, ["dreams", "run", "light", "--agent", "bernd", "--dry-run"]);
      assert.equal(ready.wouldRun, true, JSON.stringify(ready));
      assert.ok(ready.jobs.includes("light-dream"));

      // run now goes through the engine's job registry and always leaves an explained row; completed or skipped, never silent
      const run = cli(h, ["dreams", "run", "light", "--agent", "bernd"], { allowFail: true });
      const doc = typeof run.exit === "number" ? JSON.parse(run.stdout) : run;
      assert.equal(doc.schema, "dreams.run/1");
      assert.notEqual(doc.outcome, null);
      if (doc.outcome !== "completed") assert.ok(doc.reason, `a ${doc.outcome} run says why`);
      const again = cli(h, ["dreams", "run", "light", "--agent", "bernd"], { allowFail: true });
      const second = typeof again.exit === "number" ? JSON.parse(again.stdout) : again;
      if (doc.outcome === "completed") { assert.equal(second.outcome, "skipped"); assert.equal(second.reason, "idempotent"); }

      const log = cli(h, ["dreams", "log", "--agent", "bernd", "--phase", "light"]);
      assert.equal(log.runs.length, 2);
      const one = cli(h, ["dreams", "log", "--run", doc.runId]);
      assert.match(one.log, /start light trigger=manual/);
      assert.match(one.log, /finish outcome=/);

      const status = cli(h, ["dreams", "status", "--agent", "bernd"]);
      assert.equal(status.schema, "dreams.status/1");
      const phases = status.scheduler.agents[0].phases;
      assert.deepEqual(phases.map((p: any) => p.phase), ["light", "rem", "deep"]);
      assert.equal(phases[0].lastRun.runId, second.runId);
      assert.ok(Array.isArray(status.jobs), "the engine-job view is still there");
    } finally {
      if (core) await stopCore(core);
      await reapHome(h);
      rmSync(h, { recursive: true, force: true });
    }
  });
});
