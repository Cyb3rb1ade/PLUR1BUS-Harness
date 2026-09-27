import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { REAL, RERANK_FAILURE, cli, home, killCore, reapHome, startCore, stopCore, waitEngineReady, waitJournalDrained, type RunningCore } from "./helpers.ts";

/** Spec targets for a CLI recall: the soft budget on the engine's timed phases and the core's hard budget on wall time. */
const SOFT_TARGET_MS = 400;
const HARD_TARGET_MS = 600;
/**
 * Ruling H3-R26: CI runners are not reference hardware. PLUR1BUS_CI_RECALL_HARD_MS (set by the nightly) raises the
 * test home's core.recall.hardBudgetMs so a slow shared runner does not abort the recall, and turns the 400/600 ms
 * targets into diagnostics plus a GitHub Actions `::warning::`. Unset (reference hardware), the targets are asserted.
 */
const CI_RECALL_HARD_MS = ((raw) => {
  if (raw === undefined || raw === "") return null;
  if (!/^\d+$/.test(raw) || Number(raw) < 100) throw new Error(`PLUR1BUS_CI_RECALL_HARD_MS must be an integer >= 100, got ${JSON.stringify(raw)}`);
  return Number(raw);
})(process.env.PLUR1BUS_CI_RECALL_HARD_MS);

/** Real models: the recall's timing against the targets. Strict (reference hardware) asserts them; CI reports them. */
function checkRecallBudget(t: { diagnostic(m: string): void }, label: string, wallMs: number, timing: any): void {
  const totalMs = timing?.totalMs;
  const over: string[] = [];
  if (timing?.exceededBudget === true) over.push("exceededBudget");
  if (!(typeof totalMs === "number" && totalMs < SOFT_TARGET_MS)) over.push(`timing.totalMs ${totalMs} >= ${SOFT_TARGET_MS}`);
  // H3-R22: timing.totalMs counts only the engine's timed phases; the core aborts at the hard budget of wall time.
  if (!(wallMs < HARD_TARGET_MS)) over.push(`wall ${wallMs.toFixed(0)} ms >= ${HARD_TARGET_MS}`);
  t.diagnostic(`${label}: wall ${wallMs.toFixed(0)} ms (target < ${HARD_TARGET_MS}), timing.totalMs ${totalMs} (target < ${SOFT_TARGET_MS})${over.length ? ` — over target: ${over.join(", ")}` : ""}`);
  if (CI_RECALL_HARD_MS === null) {
    assert.deepEqual(over, [], `${label} over the recall targets: ${JSON.stringify(timing)}`);
  } else if (over.length > 0) {
    // A workflow command must start its own stdout line; the test runner passes stdout through verbatim.
    process.stdout.write(`::warning title=recall budget (CI runner)::${label}: ${over.join(", ")} (CI hard budget ${CI_RECALL_HARD_MS} ms; strict targets apply on reference hardware only)\n`);
  }
}

/** R20: a fully successful replay renames `<agent>.jsonl` away and appends nothing back — absent or empty. */
function journalDrained(path: string): boolean {
  return !existsSync(path) || readFileSync(path, "utf8").trim() === "";
}

describe("M1 acceptance 1 — two-session recall through the CLI", () => {
  it("captures in s1, recalls in s2 (reranker ran with real models); survives a core kill via the journal", async (t) => {
    const h = home();
    const journal = join(h, "state/journal/bernd.jsonl");
    let core: RunningCore | undefined;
    try {
      cli(h, ["agent", "create", "bernd"]);
      // The flat embedder gives every text the same vector, so the engine's duplicate check (0.95) would
      // skip every fact after the first; above 1 it never matches. Real models keep the default.
      if (!REAL) cli(h, ["config", "set", "engine.duplicateThreshold", "1.01", "--yes"]);
      if (CI_RECALL_HARD_MS !== null) {
        cli(h, ["config", "set", "core.recall.hardBudgetMs", String(CI_RECALL_HARD_MS), "--yes"]);
        t.diagnostic(`CI recall budget: core.recall.hardBudgetMs ${CI_RECALL_HARD_MS} (targets reported, not asserted; H3-R26)`);
      }

      core = await startCore(h);
      t.diagnostic(`core ready (1st start) ${core.readyMs.toFixed(0)} ms${REAL ? " [real models]" : " [flat embedder]"}`);
      // Spec §6.3: the core is ready before its models are; the background warm-up loads them (B8 readyMs, warmMs).
      const warmMs = await waitEngineReady(h, 60_000);
      t.diagnostic(`models warm ${warmMs.toFixed(0)} ms after ready`);

      const status = cli(h, ["dreams", "status"]);
      assert.equal(status.jobs.length, 18, JSON.stringify(status));

      let t0 = performance.now();
      const add = cli(h, ["memory", "add", "--agent", "bernd", "--session", "s1", "Please remember that the roadmap review is on Thursday at ten."]);
      t.diagnostic(`CLI memory add ${(performance.now() - t0).toFixed(0)} ms: ${JSON.stringify(add)}`);
      assert.ok(add.stored >= 1, JSON.stringify(add));
      // A second, unrelated fact: the engine only calls the reranker with more than one candidate.
      const other = cli(h, ["memory", "add", "--agent", "bernd", "--session", "s1", "Please remember that the quarterly budget draft is due in March."]);
      assert.ok(other.stored >= 1, JSON.stringify(other));

      // Scope the rerank-failure scan to the measured recall: remember where stderr and core.log end now.
      const logFile = join(h, "logs/core.log");
      const stderrMark = core.stderr().length;
      const logMark = existsSync(logFile) ? statSync(logFile).size : 0;

      t0 = performance.now();
      const r = cli(h, ["memory", "recall", "--agent", "bernd", "--session", "s2", "--joined", "when is the roadmap review"]);
      const ms = performance.now() - t0;
      t.diagnostic(`CLI memory recall wall ${ms.toFixed(0)} ms, engine timing.totalMs ${r.timing?.totalMs ?? "n/a"}; timing ${JSON.stringify(r.timing ?? null)}`);
      assert.equal(r.degraded, null, JSON.stringify(r.degraded));
      assert.match(r.joined.text, /roadmap review/i);
      if (REAL) {
        // The first measured recall after the warm-up is within the 400/600 ms targets (it failed on macOS at 582 ms
        // with `exceededBudget: true` while the models still lazy-loaded on the first recall).
        checkRecallBudget(t, "first recall", ms, r.timing);
        // timing.namespacePhases records a "rerank" phase on every recall, even with no reranker, and its timer
        // also wraps the failure/timeout fallback. So require real cross-encoder time AND no engine rerank-failure
        // warning. Engine warnings go to the core's log file (logs/core.log), not stderr; both are checked.
        const rerank = (r.timing?.namespacePhases ?? []).filter((p: any) => p.phase === "rerank");
        assert.ok(rerank.length > 0 && rerank.some((p: any) => p.ms >= 5), `reranker ran: ${JSON.stringify(r.timing)}`);
        const logs = `${core.stderr().slice(stderrMark)}\n${existsSync(logFile) ? readFileSync(logFile).subarray(logMark).toString("utf8") : ""}`;
        const failure = logs.split("\n").find((l) => RERANK_FAILURE.test(l));
        assert.equal(failure, undefined, `rerank failed or fell back: ${failure}`);
      }
      assert.ok(ms < 5000, `CLI recall took ${ms} ms`);

      // §8 "core killed mid-use": degraded fast, add journaled, replayed after restart.
      await killCore(core, "SIGKILL");
      const t1 = performance.now();
      const down = cli(h, ["memory", "recall", "--agent", "bernd", "anything"]);
      const downMs = performance.now() - t1;
      t.diagnostic(`CLI recall with the core down ${downMs.toFixed(0)} ms: ${JSON.stringify(down.degraded)}`);
      assert.equal(down.degraded?.reason, "core-unavailable", JSON.stringify(down));
      assert.ok(downMs < 1000, `degraded recall took ${downMs} ms`);

      const j = cli(h, ["memory", "add", "--agent", "bernd", "--session", "s3", "Also remember that Mira visits every spring."]);
      assert.equal(j.journaled, true, JSON.stringify(j));
      assert.ok(existsSync(journal), "journal written while the core is down");
      assert.match(readFileSync(journal, "utf8"), /Mira visits every spring/);

      core = await startCore(h); // B2: the replay runs in the background after the ready line
      const drainMs = await waitJournalDrained(h, 30_000);
      t.diagnostic(`core ready (restart with replay) ${core.readyMs.toFixed(0)} ms, journal drained ${drainMs.toFixed(0)} ms after ready; journal after replay: ${existsSync(journal) ? "present" : "absent"}`);
      assert.ok(journalDrained(journal), `journal drained: ${existsSync(journal) ? readFileSync(journal, "utf8") : "(absent)"}`);
      // The restarted core is a new process: its models warm again (spec §6.3, S7), and a recall before that may
      // degrade by design. Wait, as after the first start (H3-R22; PLUR1BUS_SYSTEM_INTERNALS=flat-embedder-cold in CI).
      const warmMs2 = await waitEngineReady(h, 60_000);
      t.diagnostic(`models warm after restart ${warmMs2.toFixed(0)} ms after ready`);

      t0 = performance.now();
      const after = cli(h, ["memory", "recall", "--agent", "bernd", "--session", "s4", "--joined", "when does Mira visit"]);
      const afterMs = performance.now() - t0;
      t.diagnostic(`CLI recall after restart wall ${afterMs.toFixed(0)} ms, engine timing.totalMs ${after.timing?.totalMs ?? "n/a"}`);
      assert.equal(after.degraded, null, JSON.stringify(after.degraded));
      // Reported against the targets on CI; asserted only for the first recall on reference hardware (as before).
      if (REAL && CI_RECALL_HARD_MS !== null) checkRecallBudget(t, "recall after restart", afterMs, after.timing);
      assert.match(after.joined.text, /Mira|spring/i);

      const run = cli(h, ["dreams", "run", "gc-run", "--agent", "bernd"]);
      assert.ok(["completed", "skipped"].includes(run.outcome), JSON.stringify(run));
    } finally {
      // `core` is the restarted core once the restart succeeded; a failed start kills its own child first.
      if (core) await stopCore(core);
      await reapHome(h);
      rmSync(h, { recursive: true, force: true }); // removes a models/ symlink, never the cache it points to
    }
  });
});
