import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { DreamStore, SCHEMA_VERSION } from "../src/dreams/store.ts";
import { DAY, HOUR, mkHarness, T0 } from "./helpers/dreams.ts";
import { tempDir } from "./helpers/temp-dir.ts";

describe("dreams scheduler: the ledger (L15, L16)", () => {
  it("writes the row before the body runs, and closes it with an outcome", async () => {
    const h = mkHarness();
    h.captures("bernd", 3);
    let openDuringBody = -1; let rowDuringBody: unknown;
    h.engine.onRun = () => { const open = h.store.openRuns(); openDuringBody = open.length; rowDuringBody = open[0]; };
    const run = await h.sched.runPhase("bernd", "rem", { trigger: "manual" });
    assert.equal(openDuringBody, 1, "an open (outcome NULL) row exists while the job body runs");
    assert.equal((rowDuringBody as { outcome: unknown }).outcome, null);
    assert.equal(run.outcome, "completed");
    assert.equal(run.finishedAt, T0);
    assert.equal(h.store.openRuns().length, 0);
  });

  it("a skip writes its row first, with a reason code, and never touches the engine", async () => {
    const h = mkHarness();
    // no captures: below the minimum corpus
    const run = await h.sched.runPhase("bernd", "deep", { trigger: "manual" });
    assert.equal(run.outcome, "skipped");
    assert.equal(run.reason, "min_corpus");
    assert.deepEqual(run.counts, { corpus: 0, minCorpus: 3 });
    assert.equal(h.engine.calls.length, 0);
    assert.equal(h.store.listRuns().length, 1);
  });

  it("L16: every row that is not completed carries a reason, across every skip path", async () => {
    const h = mkHarness();
    h.captures("bernd", 3);
    await h.sched.runPhase("bernd", "light", { trigger: "manual" });                    // completed
    await h.sched.runPhase("bernd", "light", { trigger: "manual" });                    // idempotent
    h.engine.behaviours.set("rem-dream", () => ({ outcome: "skipped", reason: "no_llm_config" }));
    await h.sched.runPhase("bernd", "rem", { trigger: "manual" });                      // no_llm_route
    h.engine.behaviours.set("consolidate-daily", () => ({ outcome: "failed", reason: "error:Boom" }));
    await h.sched.runPhase("bernd", "deep", { trigger: "manual" });                     // failed
    h.captures("bernd", 0);
    const rows = h.store.listRuns();
    assert.equal(rows.length, 4);
    for (const r of rows) {
      assert.notEqual(r.outcome, null, "closed");
      if (r.outcome !== "completed") assert.ok(r.reason, `${r.phase} ${r.outcome} has a reason`);
    }
    assert.deepEqual(rows.map((r) => [r.phase, r.outcome, r.reason]).sort(), [
      ["deep", "failed", "error:Boom"], ["light", "completed", null], ["light", "skipped", "idempotent"], ["rem", "skipped", "no_llm_route"],
    ]);
  });

  it("records tokens per run (cost is measured, not capped) and a per-run log", async () => {
    const h = mkHarness();
    h.captures("bernd", 3);
    const run = await h.sched.runPhase("bernd", "rem", { trigger: "manual" });
    assert.equal(run.tokensIn, 200); assert.equal(run.tokensOut, 100); // rem-dream + discover-semantic-links
    assert.equal(run.costMicros, null); // RULING: no price table yet
    assert.ok(run.logPath && existsSync(run.logPath));
    const text = readFileSync(run.logPath!, "utf8");
    assert.match(text, /start rem trigger=manual/);
    assert.match(text, /job rem-dream completed/);
    assert.match(text, /finish outcome=completed/);
    assert.equal(h.sched.log({ runId: run.runId }).log, text);
  });
});

describe("dreams scheduler: idempotency", () => {
  it("a second run over the same corpus in the same window is skipped, with zero engine calls", async () => {
    const h = mkHarness();
    h.captures("bernd", 3);
    const first = await h.sched.runPhase("bernd", "deep", { trigger: "manual" });
    const callsAfterFirst = h.engine.calls.length;
    const second = await h.sched.runPhase("bernd", "deep", { trigger: "manual" });
    assert.equal(first.outcome, "completed");
    assert.equal(second.outcome, "skipped"); assert.equal(second.reason, "idempotent");
    assert.equal(h.engine.calls.length, callsAfterFirst);
    assert.equal(h.store.listRuns({ phase: "deep" }).length, 2);
  });

  it("new captures change the digest, so the same window can run again", async () => {
    const h = mkHarness();
    h.captures("bernd", 3);
    await h.sched.runPhase("bernd", "light", { trigger: "manual" });
    h.captures("bernd", 1);
    const again = await h.sched.runPhase("bernd", "light", { trigger: "manual" });
    assert.equal(again.outcome, "completed");
  });

  it("a failed run gives its key back: the corpus stays eligible and the retry runs", async () => {
    const h = mkHarness();
    h.captures("bernd", 3);
    h.engine.behaviours.set("consolidate-daily", () => ({ outcome: "failed", reason: "error:Boom" }));
    const bad = await h.sched.runPhase("bernd", "deep", { trigger: "manual" });
    assert.equal(bad.outcome, "failed"); assert.equal(bad.claimed, false);
    h.engine.behaviours.delete("consolidate-daily");
    const retry = await h.sched.runPhase("bernd", "deep", { trigger: "manual" });
    assert.equal(retry.outcome, "completed");
  });

  it("an engine job that returns incomplete or throws is never recorded as completed", async () => {
    const h = mkHarness();
    h.captures("bernd", 3);
    h.engine.behaviours.set("rem-dream", () => ({ outcome: "incomplete", reason: "narrative_missing" }));
    const a = await h.sched.runPhase("bernd", "rem", { trigger: "manual" });
    assert.equal(a.outcome, "failed"); assert.equal(a.reason, "incomplete:narrative_missing");
    h.engine.behaviours.set("rem-dream", () => { throw new Error("engine closed"); });
    const b = await h.sched.runPhase("bernd", "rem", { trigger: "manual" });
    assert.equal(b.outcome, "failed"); assert.equal(b.reason, "engine_error");
    assert.match(b.error!.message, /engine closed/);
  });
});

describe("dreams scheduler: circuit breaker", () => {
  it("trips on session count, blocks until the sweep ends, then recovers", async () => {
    const h = mkHarness({ over: { breakerSessions: 2 } });
    h.captures("bernd", 3);
    assert.equal((await h.sched.runPhase("bernd", "rem", { trigger: "manual" })).outcome, "completed");
    assert.equal((await h.sched.runPhase("bernd", "deep", { trigger: "manual" })).outcome, "completed");
    h.captures("bernd", 3); // new corpus, so only the breaker can object
    const remCalls = h.engine.callsOf("rem-dream");
    const tripped = await h.sched.runPhase("bernd", "rem", { trigger: "manual" });
    assert.equal(tripped.outcome, "aborted"); assert.equal(tripped.reason, "breaker_sessions");
    assert.equal(h.engine.callsOf("rem-dream"), remCalls, "the third session never started");
    const st = h.sched.status("bernd").agents[0]!.phases.find((p) => p.phase === "rem")!;
    assert.equal(st.breaker.state, "open"); assert.equal(st.breaker.until, T0 + DAY);
    assert.ok(h.events.some((e) => e.name === "breaker.opened"));
    const blocked = await h.sched.runPhase("bernd", "deep", { trigger: "manual" });
    assert.equal(blocked.outcome, "skipped"); assert.equal(blocked.reason, "breaker_open");
    // a new sweep: the breaker closes and the count starts over
    await h.clock.advance(DAY);
    const ok = await h.sched.runPhase("bernd", "rem", { trigger: "manual" });
    assert.equal(ok.outcome, "completed");
    assert.equal(h.sched.status("bernd").agents[0]!.phases.find((p) => p.phase === "rem")!.breaker.state, "closed");
    assert.ok(h.events.some((e) => e.name === "breaker.closed"));
  });

  it("light runs do not count against the sweep (they are shortlist-only and run every 4 h)", async () => {
    const h = mkHarness({ over: { breakerSessions: 1 } });
    for (let i = 0; i < 4; i++) { h.captures("bernd", 1); assert.equal((await h.sched.runPhase("bernd", "light", { trigger: "manual" })).outcome, "completed"); }
  });
});

describe("dreams scheduler: crash consistency", () => {
  it("a run that never closed is reconciled at start: aborted/crashed, key released, corpus eligible again", async () => {
    const h = mkHarness();
    h.captures("bernd", 3);
    h.engine.behaviours.set("consolidate-daily", () => new Promise(() => {})); // the process "dies" inside the body
    void h.sched.runPhase("bernd", "deep", { trigger: "manual" });
    for (let i = 0; i < 20 && h.engine.callsOf("consolidate-daily") === 0; i++) await new Promise((r) => setImmediate(r));
    assert.equal(h.store.openRuns().length, 1);
    // restart: a new scheduler over the same state
    h.engine.behaviours.delete("consolidate-daily");
    const restarted = h.make();
    await restarted.start();
    assert.equal(h.store.openRuns().length, 0);
    const crashed = h.store.listRuns({ phase: "deep" })[0]!;
    assert.equal(crashed.outcome, "aborted"); assert.equal(crashed.reason, "crashed"); assert.equal(crashed.claimed, false);
    const retry = await restarted.runPhase("bernd", "deep", { trigger: "manual" });
    assert.equal(retry.outcome, "completed", "the key was released and the corpus was not consumed");
    assert.ok(h.events.some((e) => e.name === "reconciled"));
    await restarted.stop();
  });
});

describe("dreams scheduler: one run per agent and phase", () => {
  it("a second run of the same phase while one is in flight is a recorded skip, never a double run", async () => {
    const h = mkHarness();
    h.captures("bernd", 3);
    let release!: () => void;
    h.engine.behaviours.set("rem-dream", () => new Promise((r) => { release = () => r({}); }));
    const first = h.sched.runPhase("bernd", "rem", { trigger: "manual" });
    for (let i = 0; i < 20 && h.engine.callsOf("rem-dream") === 0; i++) await new Promise((r) => setImmediate(r));
    const second = await h.sched.runPhase("bernd", "rem", { trigger: "manual" });
    assert.equal(second.outcome, "skipped"); assert.equal(second.reason, "already_running");
    release();
    assert.equal((await first).outcome, "completed");
    assert.equal(h.engine.callsOf("rem-dream"), 1);
  });
});

describe("dreams scheduler: cancellation and ids", () => {
  it("a run whose caller went away is aborted/cancelled, not shutdown, and the next job never starts", async () => {
    const h = mkHarness();
    h.captures("bernd", 3);
    const ac = new AbortController();
    h.engine.behaviours.set("rem-dream", () => { ac.abort(); return {}; });
    const run = await h.sched.runPhase("bernd", "rem", { trigger: "manual", signal: ac.signal });
    assert.equal(run.outcome, "aborted"); assert.equal(run.reason, "cancelled");
    assert.equal(h.engine.callsOf("discover-semantic-links"), 0);
    assert.equal(run.claimed, false);
  });

  it("refuses an agent id that could not be a path segment", async () => {
    const h = mkHarness({ agents: ["../x"] });
    await assert.rejects(h.sched.runPhase("../x", "rem", { trigger: "manual" }), /invalid agent id/);
    assert.equal(h.store.listRuns().length, 0);
  });
});

describe("dreams scheduler: concurrency and stagger", () => {
  it("never runs more than 3 phase runs at once, and runs them all", async () => {
    const agents = Array.from({ length: 20 }, (_, i) => `a${String(i).padStart(2, "0")}`);
    const h = mkHarness({ agents });
    h.engine.behaviours.set("consolidate-daily", async () => { await new Promise((r) => setImmediate(r)); return {}; });
    for (const a of agents) h.captures(a, 3);
    const runs = await Promise.all(agents.map((a) => h.sched.runPhase(a, "deep", { trigger: "manual" })));
    assert.ok(runs.every((r) => r.outcome === "completed"));
    assert.ok(h.engine.peak <= 3, `engine peak ${h.engine.peak}`);
    assert.equal(h.sched.peakConcurrency, 3);
  });

  it("stagger offsets are stable, in range, and spread across the window", () => {
    const agents = Array.from({ length: 20 }, (_, i) => `a${String(i).padStart(2, "0")}`);
    const h = mkHarness({ agents, over: { staggerWindowS: 1800 } });
    const offs = agents.map((a) => h.sched.staggerOffsetS(a, "deep"));
    assert.ok(offs.every((o) => o >= 0 && o < 1800));
    assert.ok(new Set(offs).size >= 15, "mostly distinct");
    assert.deepEqual(offs, agents.map((a) => h.sched.staggerOffsetS(a, "deep")));
    assert.notEqual(h.sched.staggerOffsetS("a00", "deep"), h.sched.staggerOffsetS("a00", "rem"));
  });
});

describe("dreams scheduler: triggers", () => {
  it("accumulated importance fires a phase before its cron; the minimum gap stops a loop", async () => {
    const h = mkHarness({ over: { phases: { light: { importanceThreshold: 10, minGapMs: HOUR } } } });
    h.sched.recordCapture("bernd", 5); await h.sched.idle();
    assert.equal(h.store.listRuns({ phase: "light" }).length, 0, "below the threshold");
    h.sched.recordCapture("bernd", 5); await h.sched.idle();
    const [run] = h.store.listRuns({ phase: "light" });
    assert.equal(run!.trigger, "importance"); assert.equal(run!.outcome, "completed");
    // the accumulator was consumed by the completed run; crossing it again within the gap does not fire
    h.sched.recordCapture("bernd", 10); await h.sched.idle();
    assert.equal(h.store.listRuns({ phase: "light" }).length, 1, "minGap holds");
    await h.clock.advance(HOUR);
    h.sched.recordCapture("bernd", 10); await h.sched.idle();
    assert.equal(h.store.listRuns({ phase: "light" }).length, 2);
  });

  it("a disabled phase never fires on cron or importance, but still runs on demand", async () => {
    const h = mkHarness({ over: { phases: { light: { importanceThreshold: 1 } } } });
    h.sched.syncAgents();
    h.sched.setSchedule("bernd", "light", { enabled: false });
    await h.sched.start();
    h.captures("bernd", 3);
    await h.advance(8 * HOUR);
    assert.equal(h.store.listRuns({ phase: "light" }).length, 0);
    assert.equal((await h.sched.runPhase("bernd", "light", { trigger: "manual" })).outcome, "completed");
    await h.sched.stop();
  });

  it("setSchedule validates before writing and recomputes the next run", () => {
    const h = mkHarness();
    h.sched.syncAgents();
    assert.throws(() => h.sched.setSchedule("bernd", "deep", { cron: "not a cron" }), /cron/);
    assert.throws(() => h.sched.setSchedule("bernd", "deep", { timezone: "Mars/Olympus" }), /timezone/);
    assert.equal(h.store.getSchedule("bernd", "deep")!.cron, "0 4 * * *");
    const s = h.sched.setSchedule("bernd", "deep", { cron: "30 5 * * *", timezone: "Europe/Berlin" });
    assert.equal(new Date(s.nextRunAt!).toISOString(), "2026-10-06T03:30:00.000Z");
  });

  it("stop() leaves no timer behind and aborts what has not started", async () => {
    const h = mkHarness();
    await h.sched.start();
    assert.equal(h.clock.pending(), 1);
    await h.sched.stop();
    assert.equal(h.clock.pending(), 0);
  });
});

describe("dreams scheduler: retention (ADR-009 Q7 default)", () => {
  it("removes per-run logs after 30 days and ledger rows after 365, never an open run", async () => {
    const h = mkHarness();
    h.captures("bernd", 3);
    const run = await h.sched.runPhase("bernd", "rem", { trigger: "manual" });
    assert.ok(existsSync(run.logPath!));
    await h.clock.advance(29 * DAY);
    h.sched.prune();
    assert.ok(existsSync(run.logPath!), "still inside 30 days");
    await h.clock.advance(2 * DAY);
    h.sched.prune();
    assert.equal(existsSync(run.logPath!), false, "log gone after 30 days");
    const kept = h.store.getRun(run.runId)!;
    assert.equal(kept.outcome, "completed", "the row outlives its log");
    assert.equal(kept.logPath, null);
    // an open run is never pruned, however old
    h.store.insertRun({ runId: "open-1", agentId: "bernd", phase: "deep", jobId: "consolidate-daily", partition: null, idempotencyKey: "z", trigger: "manual", scheduledFor: null, startedAt: T0, logPath: null });
    await h.clock.advance(340 * DAY);
    h.sched.prune();
    assert.equal(h.store.getRun(run.runId), undefined, "row gone after 365 days");
    assert.ok(h.store.getRun("open-1"), "open run kept");
  });
});

describe("dreams store", () => {
  it("creates a versioned schema, reopens it, and refuses a newer one", () => {
    const dir = tempDir("dreams-store-");
    const p = path.join(dir, "d.db");
    const a = new DreamStore(p); assert.equal(a.schemaVersion, SCHEMA_VERSION); a.close();
    const b = new DreamStore(p); assert.equal(b.schemaVersion, SCHEMA_VERSION); b.close();
    // a store written by a newer build
    const newer = new DreamStore(path.join(dir, "n.db")); newer.close();
    const raw = new DatabaseSync(path.join(dir, "n.db")); raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`); raw.close();
    assert.throws(() => new DreamStore(path.join(dir, "n.db")), /newer than this build/);
  });

  it("the idempotency key is unique across claiming runs only", () => {
    const s = new DreamStore(":memory:");
    const mk = (runId: string) => s.insertRun({ runId, agentId: "a", phase: "deep", jobId: "consolidate-daily", partition: "agent-private", idempotencyKey: "K", trigger: "manual", scheduledFor: null, startedAt: 1, logPath: null });
    mk("r1"); mk("r2"); // provisional keys never collide
    assert.equal(s.claimKey("r1", "K"), true);
    assert.equal(s.claimKey("r2", "K"), false);
    s.finishRun("r1", { outcome: "failed", reason: "x", finishedAt: 2, counts: {} });
    assert.equal(s.claimKey("r2", "K"), true, "released by the failure");
  });
});
