// ADR-009 acceptance tests A1-A8 ("demonstrably works"), on a virtual clock.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DAY, FakeEngine, HOUR, mkHarness, T0, writeDiary } from "./helpers/dreams.ts";

describe("ADR-009 acceptance", () => {
  it("A1 fresh install, 24 h: all three phases ran with an outcome, and the diary exists and is non-empty", async () => {
    const h = mkHarness();
    const diary = path.join(h.dir, "workspace", "bernd", "dreaming.md");
    // the engine owns the diary: the deep job writes it
    h.engine.behaviours.set("consolidate-daily", () => { writeDiary(h.dir, "bernd", "# Dream diary\n\n- consolidated 3 captures\n"); return { diary: { written: true } }; });
    h.sched = h.make({ diaryPath: () => diary, requireDiary: { deep: true } });
    await h.sched.start();
    // three short conversations
    for (let i = 0; i < 3; i++) { h.captures("bernd", 2); await h.advance(HOUR); }
    await h.advance(24 * HOUR);
    const st = h.sched.status("bernd").agents[0]!;
    for (const p of st.phases) {
      assert.ok(p.lastRun, `${p.phase} has a lastRun`);
      assert.notEqual(p.lastRun!.outcome, null, `${p.phase} outcome is non-null`);
      assert.ok(p.lastRun!.startedAt >= T0 && p.lastRun!.startedAt <= T0 + 27 * HOUR);
      assert.ok(p.nextRunAt !== null && p.nextRunAt > h.clock.now(), `${p.phase} is scheduled ahead`);
    }
    // each phase did real work once, and every later tick on the consumed corpus is a visible skip, not silence
    for (const phase of ["light", "rem", "deep"] as const) {
      const runs = h.store.listRuns({ phase, limit: 100 });
      assert.ok(runs.some((r) => r.outcome === "completed"), `${phase} completed at least once`);
      for (const r of runs.filter((x) => x.outcome === "skipped")) assert.equal(r.reason, "min_corpus", `${phase} skip reason`);
    }
    assert.equal(st.diary!.exists, true); assert.ok(st.diary!.bytes > 0);
    assert.match(readFileSync(diary, "utf8"), /Dream diary/);
    // no manual step, no repair script: everything above came from the scheduler's own timer
    assert.ok(h.store.listRuns({ limit: 100 }).every((r) => r.trigger === "cron" || r.trigger === "importance"));
    await h.sched.stop();
  });

  it("A2 a failing phase shows skipped/failed, never completed", async () => {
    const h = mkHarness();
    h.captures("bernd", 3);
    h.engine.behaviours.set("consolidate-daily", () => ({ outcome: "skipped", reason: "no_llm_config" }));
    const noRoute = await h.sched.runPhase("bernd", "deep", { trigger: "manual" });
    assert.equal(noRoute.outcome, "skipped"); assert.equal(noRoute.reason, "no_llm_route");
    assert.equal(h.sched.status("bernd").agents[0]!.phases[2]!.lastRun!.reason, "no_llm_route", "visible in status");

    // variant: the diary write fails => failed, error recorded, not swallowed
    h.engine.behaviours.set("consolidate-daily", () => ({ diary: { written: false, reason: "EACCES: permission denied" } }));
    h.captures("bernd", 1);
    const noDiary = await h.sched.runPhase("bernd", "deep", { trigger: "manual" });
    assert.equal(noDiary.outcome, "failed"); assert.equal(noDiary.reason, "diary_not_written");
    assert.match(noDiary.error!.message, /EACCES/);
  });

  it("A2 an explicit route pre-check skips before any engine call", async () => {
    const h = mkHarness({ over: { llmRoute: () => false } });
    h.captures("bernd", 3);
    const r = await h.sched.runPhase("bernd", "rem", { trigger: "manual" });
    assert.equal(r.outcome, "skipped"); assert.equal(r.reason, "no_llm_route");
    assert.equal(h.engine.calls.length, 0);
  });

  it("A3 the session breaker trips: cap 2, ten LLM sessions wanted => exactly 2 run, the run aborts, the breaker is open (the #65550 regression)", async () => {
    const engine = new FakeEngine();
    const ids = Array.from({ length: 10 }, (_, i) => `llm-${i}`);
    engine.extraJobs = ids.map((name) => ({ name, needsLlm: true, singleton: false }));
    const h = mkHarness({ engine, over: { breakerSessions: 2, phases: { rem: { jobs: ids, primary: "llm-0" } } } });
    h.captures("bernd", 3);
    const run = await h.sched.runPhase("bernd", "rem", { trigger: "manual" });
    assert.equal(run.outcome, "aborted"); assert.equal(run.reason, "breaker_sessions");
    assert.equal(engine.calls.length, 2, "spend is bounded by the cap");
    assert.equal(run.counts.llmSessions, 2);
    assert.equal(h.sched.status("bernd").agents[0]!.phases[1]!.breaker.state, "open");
    assert.equal(run.claimed, false, "an aborted run does not consume the corpus");
    // nothing was promoted from the aborted portion
    assert.equal(h.store.listCandidates("bernd", "promoted").length, 0);
    // and a loop of retries cannot get past the breaker
    for (let i = 0; i < 5; i++) { h.captures("bernd", 1); assert.equal((await h.sched.runPhase("bernd", "rem", { trigger: "manual" })).reason, "breaker_open"); }
    assert.equal(engine.calls.length, 2);
  });

  it("A4 the second deep run over the same corpus and window is idempotent: no LLM call, no second promotion, no second diary entry", async () => {
    const h = mkHarness();
    let diaryEntries = 0;
    h.engine.behaviours.set("consolidate-daily", () => { diaryEntries++; return { diary: { written: true } }; });
    h.captures("bernd", 3);
    await h.sched.runPhase("bernd", "deep", { trigger: "manual" });
    const second = await h.sched.runPhase("bernd", "deep", { trigger: "manual" });
    assert.equal(second.outcome, "skipped"); assert.equal(second.reason, "idempotent");
    assert.equal(h.engine.callsOf("consolidate-daily"), 1);
    assert.equal(diaryEntries, 1);
  });

  it("A7 20 agents, same phase, same window: start times spread across the stagger window, concurrency never exceeds 3", async () => {
    const agents = Array.from({ length: 20 }, (_, i) => `a${String(i).padStart(2, "0")}`);
    const h = mkHarness({ agents, over: { staggerWindowS: 1800 } });
    h.engine.behaviours.set("consolidate-daily", async () => { await new Promise((r) => setImmediate(r)); return {}; });
    h.sched = h.make({ staggerWindowS: 1800 });
    await h.sched.start();
    for (const a of agents) h.captures(a, 3);
    await h.advance(5 * HOUR, 60_000 * 5); // past 04:00 + the 30 min window, in 5-minute steps
    const deep = h.store.listRuns({ phase: "deep", limit: 100 }).filter((r) => r.trigger === "cron");
    assert.equal(deep.length, 20);
    const starts = deep.map((r) => r.startedAt - (T0 + 4 * HOUR));
    assert.ok(starts.every((s) => s >= 0 && s < 1800_000 + 5 * 60_000), "inside the window (+ step granularity)");
    assert.ok(new Set(starts).size >= 4, `spread over several ticks: ${new Set(starts).size}`);
    assert.ok(h.engine.peak <= 3 && h.sched.peakConcurrency <= 3);
    await h.sched.stop();
  });

  it("A8 downtime across scheduled windows: exactly one catch-up run per phase, not one per missed tick", async () => {
    const h = mkHarness();
    h.captures("bernd", 3);
    await h.sched.start();
    await h.sched.stop(); // the daemon stops at T0
    assert.equal(h.store.listRuns().length, 0);
    // it stays down for 2 days: light missed 12 ticks, rem 2, deep 2
    await h.clock.advance(2 * DAY + 2 * HOUR);
    const restarted = h.make();
    await restarted.start();
    const runs = h.store.listRuns({ limit: 100 });
    assert.equal(runs.length, 3, "one per phase");
    assert.ok(runs.every((r) => r.trigger === "catchup"));
    assert.deepEqual(runs.map((r) => r.phase).sort(), ["deep", "light", "rem"]);
    // and the next windows are in the future: no further catch-ups
    await h.advance(HOUR);
    assert.equal(h.store.listRuns({ limit: 100 }).filter((r) => r.trigger === "catchup").length, 3);
    await restarted.stop();
  });

  it("A8 a restart before the window is not a catch-up", async () => {
    const h = mkHarness();
    await h.sched.start(); await h.sched.stop();
    await h.clock.advance(HOUR / 2);
    const again = h.make(); await again.start(); await again.stop();
    assert.equal(h.store.listRuns().length, 0);
  });

  it("A6 the scheduler's only external effects are the ledger database and the per-run logs", async () => {
    const h = mkHarness();
    h.captures("bernd", 3);
    await h.sched.start();
    await h.advance(DAY);
    await h.sched.stop();
    const files: string[] = [];
    const walk = (d: string) => { for (const e of readdirSync(d)) { const p = path.join(d, e); statSync(p).isDirectory() ? walk(p) : files.push(path.relative(h.dir, p)); } };
    walk(h.dir);
    for (const f of files) assert.match(f, /^(dreams\.db(-wal|-shm)?|logs\/bernd\/(light|rem|deep)\/[0-9a-f-]{36}\.log)$/, `unexpected file ${f}`);
    assert.ok(files.some((f) => f === "dreams.db"));
  });
});
