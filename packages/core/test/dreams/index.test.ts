// dreams/index: createDreams wiring: the ledger lives under <state>/dreams, runs a killed core left open are closed at
// construction (also with the scheduler's timers off), the diary path comes from the agent's workspace, stop closes the store.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { FakeClock } from "../../src/discovery/testing.ts";
import { createDreams, DreamScheduler, DreamStore, buildDreamsMethods, SCHEMA_VERSION } from "../../src/dreams/index.ts";
import { layout } from "../../src/paths.ts";
import { ScriptedEngine, T0, useTempDirs } from "./helpers.ts";

const dirs = useTempDirs();
const quiet = { info() {}, warn() {}, error() {} };
const registry = (ws: Record<string, string>) => ({ list: () => Object.keys(ws), has: (id: string) => id in ws, scaffold: () => {}, workspaceOf: (id: string) => ws[id] });

function make(over: { ws?: Record<string, string>; scheduler?: object } = {}) {
  const home = dirs.make();
  const l = layout(home);
  const clock = new FakeClock(T0);
  const engine = new ScriptedEngine();
  const agents = registry(over.ws ?? { alpha: path.join(home, "ws", "alpha") });
  const dreams = createDreams({ engine, layout: l, clock, logger: quiet, agents, ...(over.scheduler ? { scheduler: over.scheduler } : {}) });
  return { home, l, clock, engine, agents, dreams };
}

describe("dreams/index: createDreams", () => {
  it("re-exports the surface the core wires (scheduler, store, methods, schema version)", () => {
    assert.equal(typeof DreamScheduler, "function"); assert.equal(typeof DreamStore, "function"); assert.equal(typeof buildDreamsMethods, "function"); assert.equal(SCHEMA_VERSION, 1);
  });

  it("puts the ledger at <state>/dreams/dreams.db and the per-run logs beside it", async () => {
    const { l, dreams } = make();
    assert.equal(dreams.store.path, path.join(l.state, "dreams", "dreams.db"));
    assert.equal(existsSync(dreams.store.path), true);
    if (process.platform !== "win32") assert.equal(statSync(path.join(l.state, "dreams")).mode & 0o777, 0o700);
    dreams.scheduler.recordCapture("alpha"); dreams.scheduler.recordCapture("alpha"); dreams.scheduler.recordCapture("alpha");
    const r = await dreams.scheduler.runPhase("alpha", "deep", { trigger: "manual" });
    assert.equal(r.logPath, path.join(l.state, "dreams", "alpha", "deep", `${r.runId}.log`));
    assert.equal(existsSync(r.logPath!), true);
    await dreams.stop();
  });

  it("closes runs a killed core left open at construction, without start(): the scheduler's timers can stay off", async () => {
    const home = dirs.make(); const l = layout(home);
    const first = new DreamStore(path.join(l.state, "dreams", "dreams.db"));
    first.insertRun({ runId: "left-open", agentId: "alpha", phase: "deep", jobId: "consolidate-daily", partition: "agent-private", idempotencyKey: "k", trigger: "cron", scheduledFor: T0, startedAt: T0 - 1000, logPath: null });
    first.close();
    const dreams = createDreams({ engine: new ScriptedEngine(), layout: l, clock: new FakeClock(T0), logger: quiet, agents: registry({ alpha: "/ws/alpha" }) });
    const r = dreams.store.getRun("left-open")!;
    assert.equal(r.outcome, "aborted"); assert.equal(r.reason, "crashed");
    assert.deepEqual(dreams.store.openRuns(), []);
    await dreams.stop();
  });

  it("the diary path is <workspace>/DREAMS.md of the registered agent, and null for an agent without a workspace", async () => {
    const { home, dreams } = make({ ws: { alpha: "/ws/alpha" } });
    dreams.scheduler.recordCapture("alpha");
    const st = dreams.scheduler.status("alpha").agents[0]!;
    assert.equal(st.diary!.path, path.join("/ws/alpha", "DREAMS.md")); assert.equal(st.diary!.exists, false);
    assert.equal(dreams.scheduler.status("nobody").agents[0]!.diary, null, home);
    await dreams.stop();
  });

  it("the agent list is the registry's, read live: an agent registered later is scheduled, one dropped is not listed", async () => {
    const ws: Record<string, string> = { alpha: "/ws/alpha" };
    const { dreams } = make({ ws });
    assert.deepEqual(dreams.scheduler.status().agents.map((a) => a.agentId), ["alpha"]);
    ws.beta = "/ws/beta";
    assert.deepEqual(dreams.scheduler.status().agents.map((a) => a.agentId), ["alpha", "beta"]);
    delete ws.alpha;
    assert.deepEqual(dreams.scheduler.status().agents.map((a) => a.agentId), ["beta"]);
    await dreams.stop();
  });

  it("scheduler overrides are forwarded (zone, stagger window)", async () => {
    const { dreams } = make({ scheduler: { defaultTimezone: "Asia/Tokyo", staggerWindowS: 0 } });
    const s = dreams.scheduler.getSchedules("alpha");
    assert.ok(s.every((x) => x.timezone === "Asia/Tokyo" && x.staggerOffsetS === 0));
    await dreams.stop();
  });

  it("start() arms the scheduler on the injected clock; stop() disarms it and closes the ledger", async () => {
    const { clock, dreams } = make();
    await dreams.start();
    assert.equal(clock.pending(), 1);
    await dreams.stop();
    assert.equal(clock.pending(), 0);
    assert.throws(() => dreams.store.listRuns(), /database is not open|closed/i);
  });

  it("stop() closes the ledger even when a scheduler stop fails to settle cleanly (try/finally)", async () => {
    const { dreams } = make();
    const orig = dreams.scheduler.stop.bind(dreams.scheduler);
    dreams.scheduler.stop = async () => { await orig(); throw new Error("stop failed"); };
    await assert.rejects(dreams.stop(), /stop failed/);
    assert.throws(() => dreams.store.listRuns(), /database is not open|closed/i);
  });
});
