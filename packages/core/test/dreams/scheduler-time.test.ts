// dreams/scheduler on an injected virtual clock: runs at the right time, not twice, across restarts; orphaned (never
// closed) runs are reconciled; agents that left the registry and phases that were switched off get no run (ADR-009 A8, L15).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DreamStore } from "../../src/dreams/store.ts";
import type { Phase } from "../../src/dreams/types.ts";
import { DAY, gap, harness, HOUR, settle, T0, useTempDirs } from "./helpers.ts";

const dirs = useTempDirs();
const MIN = 60_000;
// Default crons (docs/dreams.md): light "0 */4 * * *", rem "15 1 * * *", deep "0 4 * * *"; T0 is 2026-10-13T00:00Z, staggerWindowS 0.
const rows = (h: ReturnType<typeof harness>, phase?: Phase, agentId?: string) => h.store.listRuns({ ...(phase ? { phase } : {}), ...(agentId ? { agentId } : {}), limit: 500 });

describe("dreams scheduler: a schedule fires at its instant", () => {
  it("creates three schedule rows per registered agent, with the next firing computed from the cron in the stored zone", async () => {
    const h = harness(dirs);
    await h.sched.start();
    const s = h.store.listSchedules("alpha");
    assert.deepEqual(s.map((x) => x.phase), ["light", "rem", "deep"]);
    assert.deepEqual(s.map((x) => new Date(x.nextRunAt!).toISOString()), ["2026-10-13T04:00:00.000Z", "2026-10-13T01:15:00.000Z", "2026-10-13T04:00:00.000Z"]);
    assert.deepEqual(s.map((x) => x.timezone), ["UTC", "UTC", "UTC"]);
    await h.sched.stop();
  });

  it("rem fires at 01:15 and not one millisecond before; the row says cron and the window it was scheduled for", async () => {
    const h = harness(dirs);
    h.captures("alpha", 3);
    await h.sched.start();
    await h.clock.advance(HOUR + 15 * MIN - 1); await h.sched.idle();
    assert.equal(h.engine.callsOf("rem-dream"), 0); assert.equal(rows(h).length, 0);
    await h.clock.advance(1); await h.sched.idle();
    assert.equal(h.engine.callsOf("rem-dream"), 1);
    const r = rows(h, "rem")[0]!;
    assert.equal(r.trigger, "cron"); assert.equal(r.outcome, "completed"); assert.equal(r.scheduledFor, T0 + HOUR + 15 * MIN); assert.equal(r.startedAt, T0 + HOUR + 15 * MIN);
    await h.sched.stop();
  });

  it("over 24 h each phase gets exactly one ledger row per window: light 6, rem 1, deep 1, none twice", async () => {
    const h = harness(dirs);
    await h.sched.start();
    await h.advance(DAY, 15 * MIN);
    assert.equal(rows(h, "light").length, 6); assert.equal(rows(h, "rem").length, 1); assert.equal(rows(h, "deep").length, 1);
    assert.deepEqual(rows(h, "light").map((r) => r.scheduledFor).reverse(), [4, 8, 12, 16, 20, 24].map((x) => T0 + x * HOUR));
    assert.ok(rows(h).every((r) => r.trigger === "cron" && r.outcome === "skipped" && r.reason === "min_corpus"), "no captures: every window is recorded as a visible skip");
    await h.sched.stop();
  });

  it("one long clock jump lands on one firing per phase, not one per missed window", async () => {
    const h = harness(dirs);
    h.captures("alpha", 3);
    await h.sched.start();
    await h.clock.jump(3 * DAY); await h.sched.idle(); // FakeClock.jump: every overdue timer fires exactly once
    for (const p of ["light", "rem", "deep"] as Phase[]) assert.equal(rows(h, p).length, 1, p);
    assert.ok(h.store.listSchedules("alpha").every((s) => s.nextRunAt! > h.clock.now()), "the next firing is computed from now");
    await h.sched.stop();
  });

  it("the per-phase stagger offset moves the firing instant and stays in [0, 1800) s", async () => {
    const h = harness(dirs, { agents: ["alpha", "beta", "gamma"], over: { staggerWindowS: 1800 } });
    await h.sched.start();
    for (const a of h.agents) for (const s of h.store.listSchedules(a)) {
      assert.ok(s.staggerOffsetS >= 0 && s.staggerOffsetS < 1800, `${a}/${s.phase} offset ${s.staggerOffsetS}`);
      // the firing is a cron instant plus the offset, and the first one strictly after now: light's 00:00 slot still counts when its offset is > 0
      const cronTime = s.phase === "rem" ? T0 + HOUR + 15 * MIN : s.phase === "deep" ? T0 + 4 * HOUR : (s.staggerOffsetS > 0 ? T0 : T0 + 4 * HOUR);
      assert.equal(s.nextRunAt, cronTime + s.staggerOffsetS * 1000, `${a}/${s.phase}`);
    }
    await h.sched.stop();
  });

  it("an agent registered after start gets its schedules within the hour, without a restart", async () => {
    const h = harness(dirs);
    await h.sched.start();
    h.agents.push("beta");
    await h.clock.advance(HOUR); await h.sched.idle();
    assert.deepEqual(h.store.listSchedules("beta").map((s) => s.phase), ["light", "rem", "deep"]);
    await h.sched.stop();
  });
});

describe("dreams scheduler: not twice across restarts and repeated starts", () => {
  it("a restart inside a window neither repeats the finished run nor loses the next one", async () => {
    const h = harness(dirs);
    h.captures("alpha", 3);
    await h.sched.start();
    await h.clock.advance(HOUR + 15 * MIN); await h.sched.idle();
    assert.equal(h.engine.callsOf("rem-dream"), 1);
    await h.sched.stop();
    await h.clock.advance(5 * MIN);
    const restarted = h.make(); h.sched = restarted;
    await restarted.start();
    assert.equal(rows(h, "rem").length, 1, "no catch-up: the window was served");
    assert.equal(h.clock.pending(), 1, "exactly one timer is armed");
    h.captures("alpha", 3);
    await h.clock.advance(3 * HOUR); await restarted.idle(); // to 04:20: deep and light are due
    assert.equal(rows(h, "deep").length, 1); assert.equal(rows(h, "deep")[0]!.trigger, "cron");
    assert.equal(rows(h, "rem").length, 1);
    await restarted.stop();
  });

  it("start() is idempotent: concurrent and repeated calls arm one timer and run one catch-up", async () => {
    const h = harness(dirs);
    h.captures("alpha", 3);
    await h.sched.start();
    await h.sched.stop();
    await h.clock.advance(2 * DAY);
    const again = h.make();
    await Promise.all([again.start(), again.start(), again.start()]);
    await again.start();
    assert.equal(h.clock.pending(), 1);
    assert.equal(rows(h, "rem").length, 1); assert.equal(rows(h, "deep").length, 1); assert.equal(rows(h, "light").length, 1);
    await again.stop();
  });

  it("downtime across several windows: one catch-up per phase, marked catchup, scheduled for the missed window; the next start adds none", async () => {
    const h = harness(dirs);
    h.captures("alpha", 3);
    await h.sched.start(); await h.sched.stop();
    const missed = h.store.listSchedules("alpha").map((s) => s.nextRunAt!);
    await h.clock.advance(3 * DAY + 5 * MIN);
    const a = h.make(); await a.start();
    assert.equal(rows(h).length, 3);
    assert.ok(rows(h).every((r) => r.trigger === "catchup"));
    assert.deepEqual(h.store.listSchedules("alpha").map((s) => rows(h, s.phase)[0]!.scheduledFor), missed);
    assert.ok(h.store.listSchedules("alpha").every((s) => s.nextRunAt! > h.clock.now()), "the next firing is in the future: no burst");
    await a.stop();
    const b = h.make(); await b.start();
    assert.equal(rows(h).length, 3, "a second restart in the same window runs nothing");
    await b.stop();
  });

  it("two schedulers over one ledger never share a timer: after stop() the old instance fires nothing", async () => {
    const h = harness(dirs);
    h.captures("alpha", 3);
    await h.sched.start(); const old = h.sched; await old.stop();
    assert.equal(h.clock.pending(), 0);
    const next = h.make(); await next.start();
    await h.clock.advance(5 * HOUR); await next.idle();
    assert.equal(rows(h, "rem").length, 1);
    await next.stop();
  });
});

describe("dreams scheduler: orphaned runs", () => {
  const openRow = (store: DreamStore, id: string, agentId: string, phase: Phase, claimKey?: string) => {
    store.insertRun({ runId: id, agentId, phase, jobId: "x", partition: "agent-private", idempotencyKey: claimKey ?? `k-${id}`, trigger: "cron", scheduledFor: T0, startedAt: T0 - HOUR, logPath: null });
    if (claimKey) store.claimKey(id, claimKey);
  };

  it("start() closes every run that never closed: aborted/crashed, finished now, with an error, events and counters", async () => {
    const h = harness(dirs);
    openRow(h.store, "o1", "alpha", "deep", "claimed-key"); openRow(h.store, "o2", "alpha", "rem");
    assert.equal(h.store.keyHolder("claimed-key"), "o1");
    await h.sched.start();
    for (const id of ["o1", "o2"]) {
      const r = h.store.getRun(id)!;
      assert.equal(r.outcome, "aborted"); assert.equal(r.reason, "crashed"); assert.equal(r.finishedAt, T0); assert.match(r.error!.message, /stopped before the run finished/);
    }
    assert.equal(h.store.keyHolder("claimed-key"), null, "the key of a crashed run is released");
    assert.deepEqual(h.events.filter((e) => e.name === "reconciled").map((e) => e.runId).sort(), ["o1", "o2"]);
    assert.equal(h.sched.counters.reconciled, 2); assert.equal(h.sched.counters.runs.aborted, 2);
    assert.deepEqual(h.store.openRuns(), []);
    await h.sched.stop();
  });

  it("reconcile() is idempotent and returns how many it closed", () => {
    const h = harness(dirs);
    openRow(h.store, "o1", "alpha", "light");
    assert.equal(h.sched.reconcile(), 1); assert.equal(h.sched.reconcile(), 0);
    assert.equal(h.sched.counters.reconciled, 1);
  });

  it("an orphan of an agent that has left the registry is closed too (no open row outlives its agent)", async () => {
    const h = harness(dirs, { agents: ["alpha"] });
    openRow(h.store, "ghost-run", "ghost", "deep");
    await h.sched.start();
    assert.equal(h.store.getRun("ghost-run")!.outcome, "aborted"); assert.equal(h.store.getRun("ghost-run")!.reason, "crashed");
    await h.sched.stop();
  });

  it("a crashed window is not retried by itself: the next window or an importance trigger picks the corpus up", async () => {
    // characterization: Ist-Verhalten, nicht spezifiziert. docs/dreams.md: "its corpus stays eligible", and says nothing about a retry.
    const h = harness(dirs);
    h.captures("alpha", 3);
    await h.sched.start(); await h.sched.stop();
    // the crash: the deep window at 04:00 was taken (next firing moved on) and its run never closed
    await h.clock.advance(4 * HOUR + 10 * MIN);
    h.store.updateSchedule("alpha", "deep", { nextRunAt: T0 + DAY + 4 * HOUR });
    h.store.updateSchedule("alpha", "light", { nextRunAt: T0 + 8 * HOUR }); h.store.updateSchedule("alpha", "rem", { nextRunAt: T0 + DAY + HOUR + 15 * MIN });
    openRow(h.store, "crash", "alpha", "deep", "k-crash");
    const again = h.make(); await again.start();
    assert.equal(h.store.getRun("crash")!.reason, "crashed");
    assert.equal(h.engine.callsOf("consolidate-daily"), 0, "no automatic retry");
    assert.equal(h.store.getSchedule("alpha", "deep")!.capturesAcc, 3, "the corpus was not consumed");
    const manual = await again.runPhase("alpha", "deep", { trigger: "manual" });
    assert.equal(manual.outcome, "completed");
    await again.stop();
  });

  it("a run that is still open is not reported as running after a restart (the in-flight marker is memory, not ledger)", async () => {
    const h = harness(dirs);
    openRow(h.store, "o1", "alpha", "deep");
    const fresh = h.make();
    assert.equal(fresh.status("alpha").agents[0]!.phases.find((p) => p.phase === "deep")!.running, false);
  });
});

const runPhaseGap = gap("DreamScheduler.runPhase", "kein Lauf und keine Engine-Aufrufe für einen Agenten, der nicht mehr in der Registry steht", "Lauf 'completed' mit Engine-Aufrufen (nur dreams.* in methods.ts prüft requireAgent)");

describe("dreams scheduler: who may dream", () => {
  it("an agent removed from the registry gets no cron run, no catch-up and no importance trigger; its rows stay", async () => {
    const h = harness(dirs, { agents: ["alpha", "beta"] });
    h.captures("alpha", 3); h.captures("beta", 3);
    await h.sched.start();
    h.agents.splice(h.agents.indexOf("beta"), 1);
    await h.advance(DAY, HOUR);
    assert.equal(h.engine.callsFor("beta"), 0);
    assert.ok(h.engine.callsFor("alpha") > 0);
    h.sched.recordCapture("beta", 500);
    await h.sched.idle();
    assert.equal(h.engine.callsFor("beta"), 0, "a capture for a removed agent is ignored");
    assert.equal(h.store.getSchedule("beta", "deep")!.importanceAcc, 3, "and not recorded");
    assert.equal(h.store.listSchedules("beta").length, 3, "characterization: Ist-Verhalten, nicht spezifiziert: the removed agent's schedule rows are kept");
    assert.deepEqual(h.sched.status().agents.map((a) => a.agentId), ["alpha"], "status lists registered agents only");
    await h.sched.stop();
  });

  it("restart after the agent was removed: no catch-up for it", async () => {
    const h = harness(dirs, { agents: ["alpha", "beta"] });
    h.captures("beta", 3);
    await h.sched.start(); await h.sched.stop();
    h.agents.splice(h.agents.indexOf("beta"), 1);
    await h.clock.advance(2 * DAY);
    const again = h.make(); await again.start();
    assert.equal(rows(h, undefined, "beta").length, 0);
    await again.stop();
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert: a removed agent that returns fires its stale firing once as cron (not as catchup)", async () => {
    const h = harness(dirs, { agents: ["alpha", "beta"] });
    h.captures("beta", 3);
    await h.sched.start();
    const stale = h.store.getSchedule("beta", "rem")!.nextRunAt!;
    h.agents.splice(h.agents.indexOf("beta"), 1);
    await h.advance(DAY, HOUR);
    h.agents.push("beta");
    await h.advance(HOUR, HOUR);
    const rem = rows(h, "rem", "beta");
    assert.equal(rem.length, 1); assert.equal(rem[0]!.trigger, "cron"); assert.equal(rem[0]!.scheduledFor, stale);
    await h.sched.stop();
  });

  it(runPhaseGap, { todo: runPhaseGap }, async () => {
    const h = harness(dirs, { agents: ["alpha", "beta"] });
    h.captures("beta", 3);
    await h.sched.start();
    h.agents.splice(h.agents.indexOf("beta"), 1);
    const callsBefore = h.engine.callsFor("beta");
    await h.sched.runPhase("beta", "deep", { trigger: "manual" }).catch(() => undefined);
    const ran = h.engine.callsFor("beta") > callsBefore;
    await h.sched.stop();
    assert.equal(ran, false);
  });

  it("a disabled phase gets no cron run and no catch-up; enabling it again recomputes from now (no burst of missed runs)", async () => {
    const h = harness(dirs);
    h.captures("alpha", 3);
    await h.sched.start();
    h.sched.setSchedule("alpha", "rem", { enabled: false });
    assert.equal(h.sched.status("alpha").agents[0]!.phases.find((p) => p.phase === "rem")!.nextRunAt, null, "a disabled phase reports no next run");
    await h.advance(DAY, HOUR);
    assert.equal(rows(h, "rem").length, 0);
    await h.sched.stop();
    await h.clock.advance(2 * DAY);
    const again = h.make(); await again.start();
    assert.equal(rows(h, "rem").length, 0, "no catch-up for a disabled phase");
    const s = again.setSchedule("alpha", "rem", { enabled: true });
    assert.ok(s.nextRunAt! > h.clock.now(), "re-enabled: the next firing is in the future");
    await again.idle();
    assert.equal(rows(h, "rem").length, 0, "re-enabling does not run immediately");
    await again.stop();
  });

  it("changing the timezone recomputes the next firing in the new zone", async () => {
    const h = harness(dirs);
    await h.sched.start();
    const s = h.sched.setSchedule("alpha", "deep", { timezone: "Asia/Tokyo" }); // 04:00 JST = 19:00Z
    assert.equal(new Date(s.nextRunAt!).toISOString(), "2026-10-13T19:00:00.000Z");
    assert.equal(s.timezone, "Asia/Tokyo");
    await h.sched.stop();
  });
});

describe("dreams scheduler: failures do not stop later runs", () => {
  it("an engine error in one agent's run is recorded and the other agent's run and the next window still happen", async () => {
    const h = harness(dirs, { agents: ["alpha", "beta"] });
    h.captures("alpha", 3); h.captures("beta", 3);
    h.engine.behaviours.set("rem-dream", (agentId) => { if (agentId === "alpha") throw new Error("engine blew up"); return {}; });
    await h.sched.start();
    await h.advance(2 * HOUR, 15 * MIN); // to 02:00: rem windows
    const [a, b] = [rows(h, "rem", "alpha")[0]!, rows(h, "rem", "beta")[0]!];
    assert.equal(a.outcome, "failed"); assert.equal(a.reason, "engine_error"); assert.match(a.error!.message, /engine blew up/);
    assert.equal(b.outcome, "completed");
    h.engine.behaviours.delete("rem-dream");
    await h.advance(DAY, HOUR);
    assert.equal(rows(h, "rem", "alpha").length, 2, "the next day's window is attempted, and the failed corpus is still eligible");
    assert.equal(rows(h, "rem", "alpha")[0]!.outcome, "completed");
    await h.sched.stop();
  });

  it("an onEvent handler that throws does not break a run", async () => {
    const h = harness(dirs, { over: { onEvent: () => { throw new Error("listener bug"); } } });
    h.sched = h.make(); h.captures("alpha", 3);
    const r = await h.sched.runPhase("alpha", "deep", { trigger: "manual" });
    assert.equal(r.outcome, "completed");
    assert.ok(h.warnings.some((w) => /onEvent handler threw/.test(w)));
  });
});

describe("dreams scheduler: stop", () => {
  it("stop() while a job is in flight: the job finishes, the next job never starts, the run is aborted/shutdown", async () => {
    const h = harness(dirs);
    h.captures("alpha", 3);
    let release!: () => void;
    h.engine.behaviours.set("rem-dream", () => new Promise((r) => { release = () => r({}); }));
    const run = h.sched.runPhase("alpha", "rem", { trigger: "manual" });
    await settle();
    const stopping = h.sched.stop();
    release();
    await stopping;
    const r = await run;
    assert.equal(r.outcome, "aborted"); assert.equal(r.reason, "shutdown");
    assert.equal(h.engine.callsOf("discover-semantic-links"), 0);
    assert.equal(h.store.getRun(r.runId)!.claimed, false, "an aborted run gives the key back");
  });

  it("after stop() nothing fires: no timer, no cron run, no importance trigger", async () => {
    const h = harness(dirs);
    h.captures("alpha", 3);
    await h.sched.start(); await h.sched.stop();
    assert.equal(h.clock.pending(), 0);
    await h.clock.advance(2 * DAY);
    h.sched.recordCapture("alpha", 10_000); await h.sched.idle();
    assert.equal(h.engine.calls.length, 0); assert.equal(rows(h).length, 0);
  });

  it("the engine is handed the harness trigger and an abort signal that stop() raises", async () => {
    const h = harness(dirs);
    h.captures("alpha", 3);
    let release!: () => void;
    h.engine.behaviours.set("rem-dream", () => new Promise((r) => { release = () => r({}); }));
    const run = h.sched.runPhase("alpha", "rem", { trigger: "manual" });
    await settle();
    const call = h.engine.calls[0]!;
    assert.equal(call.trigger, "harness"); assert.equal(call.signal!.aborted, false);
    const stopping = h.sched.stop();
    assert.equal(call.signal!.aborted, true);
    release(); await stopping; await run;
  });
});

describe("dreams scheduler: importance state survives a restart", () => {
  it("captures recorded before and after a restart add up to one importance trigger of the light phase", async () => {
    const h = harness(dirs);
    for (let i = 0; i < 29; i++) h.sched.recordCapture("alpha"); // 29 x 5 = 145 < 150
    await h.sched.start(); await h.sched.stop();
    assert.equal(h.engine.calls.length, 0);
    const again = h.make(); h.sched = again; await again.start();
    again.recordCapture("alpha"); // 150
    await again.idle();
    const light = rows(h, "light");
    assert.equal(light.length, 1); assert.equal(light[0]!.trigger, "importance"); assert.equal(light[0]!.outcome, "completed");
    assert.deepEqual(h.events.filter((e) => e.name === "trigger.importance").map((e) => e.phase), ["light"], "rem (300) and deep (450) are far from their thresholds");
    await again.stop();
  });
});
