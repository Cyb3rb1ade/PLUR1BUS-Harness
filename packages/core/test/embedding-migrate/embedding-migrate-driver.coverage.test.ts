import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMigrationDriver, publicView, MigrationError, type DriverDeps } from "../../src/embedding-migrate/driver.ts";
import { MigrationStateError, type Checkpoint, type StateStore } from "../../src/embedding-migrate/state.ts";
import type { EngineRecord, EngineState, EnginePlan, PlanRequest, ReembedEngine, SwitchPort } from "../../src/embedding-migrate/port.ts";
import type { EmbeddingFingerprint } from "../../src/embedding-migrate/probe.ts";

const fp = (model: string, dimensions = 8): EmbeddingFingerprint => ({ provider: "fake", model, dimensions, normalize: true });
const SRC = fp("a");
const TARGET = fp("b", 12);

const rec = (state: EngineState, completedRows = 0, error?: { code: string } | null): EngineRecord => ({
  id: "m1", state,
  cursor: { tableIndex: 0, offset: 0, completedRows, providerCalls: 0, bytes: 0 },
  source: { generation: "g0", fingerprintId: "s", fingerprint: SRC, tables: [{ tableId: "t", version: "1", rowCount: 4, estimatedBytes: 4 }] },
  target: { generation: "g1", fingerprintId: "t-id", fingerprint: TARGET },
  ...(error !== undefined ? { error } : {}),
});

function enginePlan(probeStatus = "passed", tables = [{ tableId: "t", version: "1", rowCount: 5, estimatedBytes: 5 }]): EnginePlan {
  return {
    plan: {
      id: "m1",
      source: { generation: "g0", fingerprintId: "s", fingerprint: SRC, tables },
      target: { generation: "g1", fingerprintId: "t-id", fingerprint: TARGET, probeStatus },
      estimates: { rows: 5, providerCalls: 5, sourceBytes: 1, targetBytes: 2, requiredFreeBytes: 3, freeBytes: 4 },
    },
    planDigest: "sha256:x",
    confirmation: { token: "tok" },
  };
}

function memStore(initial: Checkpoint | null = null): StateStore & { cp: Checkpoint | null; writes: number } {
  const s = {
    path: "mem", cp: initial, writes: 0,
    read() { return s.cp; },
    write(c: Checkpoint) { s.cp = structuredClone(c); s.writes += 1; },
  };
  return s;
}

interface Script { plan?: (r: PlanRequest) => Promise<EnginePlan>; status?: (id: string) => Promise<EngineRecord | null>; apply?: () => Promise<EngineRecord>; resume?: () => Promise<EngineRecord>; validate?: ((a: { id: string }) => Promise<EngineRecord>) | null; batchSize?: number }
function engineOf(s: Script): ReembedEngine & { planReqs: PlanRequest[] } {
  const planReqs: PlanRequest[] = [];
  const e: ReembedEngine & { planReqs: PlanRequest[] } = {
    planReqs, batchSize: s.batchSize ?? 2,
    plan: async (r) => { planReqs.push(r); return s.plan ? s.plan(r) : enginePlan(); },
    apply: async () => (s.apply ? s.apply() : rec("running", 2)),
    resume: async () => (s.resume ? s.resume() : rec("running", 4)),
    status: async (id) => (s.status ? s.status(id) : rec("planned")),
  };
  if (s.validate !== null) e.validate = s.validate ?? (async () => rec("ready_to_switch", 4));
  return e;
}

const deps = (o: Partial<DriverDeps> & { engine: ReembedEngine; store: StateStore }): DriverDeps => ({ switchPort: null, now: () => 1000, sleep: async () => {}, newId: () => "m1", ...o });
const codeOf = (e: unknown) => (e instanceof MigrationError ? e.code : String(e));

const checkpoint = (over: Partial<Checkpoint> = {}): Checkpoint => ({
  v: 1, id: "m1", token: "tok", planDigest: "sha256:x", createdAt: 1, updatedAt: 1, phase: "planned", sourceGeneration: "g0", targetGeneration: "g1", target: TARGET,
  counts: { rows: 5, tables: 1, batches: 3, rowsDone: 0, batchesDone: 0 }, throttleMs: 10, abortRequested: false, error: null, ...over,
});
const flush = () => new Promise<void>((r) => setImmediate(r));

describe("migration driver coverage: state errors", () => {
  const cases: { name: string; err: Error; expect: string }[] = [
    { name: "state-corrupt maps to state-corrupt", err: new MigrationStateError("state-corrupt", "bad"), expect: "state-corrupt" },
    { name: "state-unreadable maps to state-unreadable", err: new MigrationStateError("state-unreadable", "nope"), expect: "state-unreadable" },
    { name: "any other state error code is reported as state-unreadable", err: new MigrationStateError("something-else", "x"), expect: "state-unreadable" },
  ];
  for (const c of cases) {
    it(`status: ${c.name}`, async () => {
      const store = memStore(); store.read = () => { throw c.err; };
      const d = createMigrationDriver(deps({ engine: engineOf({}), store }));
      await assert.rejects(() => d.status(), (e) => codeOf(e) === c.expect);
      await assert.rejects(() => d.plan({ target: TARGET }), (e) => codeOf(e) === c.expect);
      await assert.rejects(() => d.start(), (e) => codeOf(e) === c.expect);
      await assert.rejects(() => d.abort(), (e) => codeOf(e) === c.expect);
      await assert.rejects(() => d.switch(), (e) => codeOf(e) === c.expect);
    });
  }
  it("a non-state error from the store is rethrown unchanged", async () => {
    const boom = new TypeError("disk on fire");
    const store = memStore(); store.read = () => { throw boom; };
    const d = createMigrationDriver(deps({ engine: engineOf({}), store }));
    await assert.rejects(() => d.status(), (e) => e === boom);
  });
});

describe("migration driver coverage: plan", () => {
  it("rejects bad throttle values with plan-refused", async () => {
    const d = createMigrationDriver(deps({ engine: engineOf({}), store: memStore() }));
    for (const throttleMs of [-1, 1.5, 60_001, Number.NaN, Infinity]) {
      await assert.rejects(() => d.plan({ target: TARGET, throttleMs }), (e) => codeOf(e) === "plan-refused", `throttle ${throttleMs}`);
    }
  });
  it("accepts the boundary throttles 0 and 60000", async () => {
    for (const throttleMs of [0, 60_000]) {
      const d = createMigrationDriver(deps({ engine: engineOf({}), store: memStore() }));
      const out = await d.plan({ target: TARGET, throttleMs });
      assert.equal(out.plan?.throttleMs, throttleMs);
    }
  });
  it("passes targetGeneration and the confirmation TTL to the engine, omits it when absent", async () => {
    const engine = engineOf({});
    const d = createMigrationDriver(deps({ engine, store: memStore() }));
    await d.plan({ target: TARGET, targetGeneration: "gen-x" });
    await d.plan({ target: TARGET });
    assert.equal(engine.planReqs[0]!.targetGeneration, "gen-x");
    assert.equal(engine.planReqs[0]!.confirmationTtlMs, 3_600_000);
    assert.ok(!("targetGeneration" in engine.planReqs[1]!));
  });
  it("an empty targetGeneration string is treated as absent", async () => {
    const engine = engineOf({});
    const d = createMigrationDriver(deps({ engine, store: memStore() }));
    await d.plan({ target: TARGET, targetGeneration: "" });
    assert.ok(!("targetGeneration" in engine.planReqs[0]!));
  });
  it("a refused target never reaches the engine", async () => {
    const engine = engineOf({});
    const d = createMigrationDriver(deps({ engine, store: memStore() }));
    const out = await d.plan({ target: { provider: "", model: "", dimensions: 0 } as EmbeddingFingerprint });
    assert.equal(out.plan, null);
    assert.equal(out.probe.verdict, "incompatible");
    assert.equal(engine.planReqs.length, 0);
  });
  it("engine says the fingerprint is unchanged: compatible, no plan, nothing written", async () => {
    const store = memStore();
    const d = createMigrationDriver(deps({ engine: engineOf({ plan: async () => { throw new Error("reembedding plan does not change the embedding fingerprint"); } }), store }));
    const out = await d.plan({ target: TARGET });
    assert.equal(out.plan, null);
    assert.equal(out.probe.verdict, "compatible");
    assert.equal(store.writes, 0);
  });
  it("other engine errors (Error and non-Error) become plan-refused, message cut to 500 chars", async () => {
    const long = "x".repeat(900);
    const d1 = createMigrationDriver(deps({ engine: engineOf({ plan: async () => { throw new Error(long); } }), store: memStore() }));
    await assert.rejects(() => d1.plan({ target: TARGET }), (e) => { assert.equal(codeOf(e), "plan-refused"); assert.equal((e as Error).message.length, 500); return true; });
    const d2 = createMigrationDriver(deps({ engine: engineOf({ plan: async () => { throw "plain string"; } }), store: memStore() }));
    await assert.rejects(() => d2.plan({ target: TARGET }), (e) => codeOf(e) === "plan-refused" && (e as Error).message === "plain string");
  });
  const probeCases: { status: string; verdict: string }[] = [
    { status: "passed", verdict: "migration-needed" },
    { status: "probe_deferred_local_artifact", verdict: "migration-needed" },
    { status: "failed", verdict: "incompatible" },
  ];
  for (const c of probeCases) {
    it(`engine probeStatus ${c.status} gives verdict ${c.verdict}`, async () => {
      const d = createMigrationDriver(deps({ engine: engineOf({ plan: async () => enginePlan(c.status) }), store: memStore() }));
      const out = await d.plan({ target: TARGET });
      assert.equal(out.probe.verdict, c.verdict);
      assert.equal(out.plan?.probeStatus, c.status);
    });
  }
  it("replaces a planned migration and refuses over terminal-free active phases; a terminal one may be replaced", async () => {
    for (const phase of ["running", "aborted", "validating", "ready-to-switch"] as const) {
      const d = createMigrationDriver(deps({ engine: engineOf({}), store: memStore(checkpoint({ phase })) }));
      await assert.rejects(() => d.plan({ target: TARGET }), (e) => codeOf(e) === "migration-active", phase);
    }
    for (const phase of ["planned", "switched", "failed"] as const) {
      const d = createMigrationDriver(deps({ engine: engineOf({}), store: memStore(checkpoint({ phase })) }));
      assert.ok((await d.plan({ target: TARGET })).plan, phase);
    }
  });
  it("a plan with zero tables has zero batches", async () => {
    const d = createMigrationDriver(deps({ engine: engineOf({ plan: async () => enginePlan("passed", []) }), store: memStore() }));
    const out = await d.plan({ target: TARGET });
    assert.equal(out.plan?.batches, 0);
    assert.equal(out.plan?.minDurationMs, 0);
  });
  it("logs the plan when a logger is given", async () => {
    const infos: string[] = [];
    const d = createMigrationDriver(deps({ engine: engineOf({}), store: memStore(), logger: { info: (m) => { infos.push(m); }, warn() {} } }));
    await d.plan({ target: TARGET });
    assert.deepEqual(infos, ["re-embedding planned"]);
  });
  it("defaults: ids carry the clock and random hex, throttle 250", async () => {
    const engine = engineOf({});
    const store = memStore();
    const d = createMigrationDriver({ engine, store, switchPort: null, now: () => 42 });
    const out = await d.plan({ target: TARGET });
    assert.match(engine.planReqs[0]!.id, /^reembed-42-[0-9a-f]{8}$/);
    assert.equal(out.plan?.throttleMs, 250);
  });
  it("uses Date.now when no clock is injected", async () => {
    const store = memStore();
    const d = createMigrationDriver({ engine: engineOf({}), store, switchPort: null, newId: () => "m1" });
    const before = Date.now();
    await d.plan({ target: TARGET });
    assert.ok(store.cp!.createdAt >= before);
  });
});

describe("migration driver coverage: run loop", () => {
  const start = async (engine: ReembedEngine, store = memStore(checkpoint()), extra: Partial<DriverDeps> = {}) => {
    const d = createMigrationDriver(deps({ engine, store, ...extra }));
    const r = await d.start();
    return { d, r, store, final: await r.done };
  };
  it("engine has no record: failed with engine-record-missing", async () => {
    const { final } = await start(engineOf({ status: async () => null }));
    assert.equal(final.phase, "failed");
    assert.equal(final.error?.code, "engine-record-missing");
  });
  it("engine state failed: with and without an engine error code", async () => {
    const a = await start(engineOf({ apply: async () => rec("failed", 0, { code: "E_X" }) }));
    assert.equal(a.final.phase, "failed"); assert.equal(a.final.error?.code, "E_X");
    const b = await start(engineOf({ apply: async () => rec("failed", 0, null) }));
    assert.equal(b.final.error?.code, "engine-failed");
    const c = await start(engineOf({ apply: async () => rec("failed", 0) }));
    assert.equal(c.final.error?.code, "engine-failed");
  });
  it("engine state switching or completed marks the checkpoint switched", async () => {
    for (const s of ["switching", "completed"] as const) {
      const { final } = await start(engineOf({ status: async () => rec(s) }));
      assert.equal(final.phase, "switched", s);
    }
  });
  it("unexpected engine states fail with engine-state-unexpected", async () => {
    for (const s of ["rollback_planned", "rolling_back", "rolled_back"] as const) {
      const { final } = await start(engineOf({ status: async () => rec(s) }));
      assert.equal(final.phase, "failed", s);
      assert.equal(final.error?.code, "engine-state-unexpected");
      assert.match(final.error!.message, new RegExp(s));
    }
  });
  it("a ready_to_switch record ends in ready-to-switch without any batch", async () => {
    let applies = 0;
    const { final } = await start(engineOf({ status: async () => rec("ready_to_switch"), apply: async () => { applies++; return rec("running"); } }));
    assert.equal(final.phase, "ready-to-switch");
    assert.equal(applies, 0);
  });
  it("validating without engine.validate stops at validating with a reason", async () => {
    const { final } = await start(engineOf({ status: async () => rec("validating"), validate: null }));
    assert.equal(final.phase, "validating");
    assert.equal(final.error?.code, "engine-validate-unavailable");
  });
  it("validating with engine.validate reaches ready-to-switch; validate failure halts resumably", async () => {
    const ok = await start(engineOf({ status: async () => rec("validating") }));
    assert.equal(ok.final.phase, "ready-to-switch");
    const bad = await start(engineOf({ status: async () => rec("validating"), validate: async () => { throw new Error("row count mismatch"); } }));
    assert.equal(bad.final.phase, "aborted");
    assert.equal(bad.final.error?.code, "engine-error");
  });
  it("running state resumes via resume(), planned/confirmed via apply(); counters follow the engine's cursor", async () => {
    const calls: string[] = [];
    const states: EngineState[] = ["running", "validating"];
    const engine = engineOf({
      status: async () => rec("running", 1),
      resume: async () => { calls.push("resume"); return rec(states.shift()!, 3); },
    });
    const { final } = await start(engine);
    assert.deepEqual(calls, ["resume", "resume"]);
    assert.equal(final.counts.rowsDone, 4, "validate reports the full count");
    assert.equal(final.counts.batchesDone, 2, "two batches; validate is not a batch");
    assert.equal(final.phase, "ready-to-switch");
    const calls2: string[] = [];
    await start(engineOf({ status: async () => rec("confirmed"), apply: async () => { calls2.push("apply"); return rec("validating", 4); } }));
    assert.deepEqual(calls2, ["apply"]);
  });
  it("an abort requested while a batch runs ends the loop right after it, without sleeping", async () => {
    let driver!: ReturnType<typeof createMigrationDriver>;
    const sleeps: number[] = [];
    let abortPromise: Promise<unknown> | undefined;
    const engine = engineOf({ apply: async () => { abortPromise = driver.abort(); await flush(); return rec("running", 2); } });
    driver = createMigrationDriver(deps({ engine, store: memStore(checkpoint()), sleep: async (ms) => { sleeps.push(ms); } }));
    const r = await driver.start();
    const final = await r.done;
    await abortPromise;
    assert.equal(final.phase, "aborted");
    assert.deepEqual(sleeps, []);
  });
  it("an abort that arrives while status() is awaited stops at the loop head, before any batch", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let applies = 0;
    const engine = engineOf({ status: async () => { await gate; return rec("planned"); }, apply: async () => { applies++; return rec("running", 2); } });
    const driver = createMigrationDriver(deps({ engine, store: memStore(checkpoint()) }));
    const r = await driver.start();
    const aborting = driver.abort();
    release();
    const out = await aborting;
    assert.equal(out.phase, "aborted");
    assert.equal((await r.done).phase, "aborted");
    assert.equal(applies, 0);
  });
  it("final classification: source drift and invalid confirmation are final, others resumable", async () => {
    const cases: { msg: string; phase: string; code: string }[] = [
      { msg: "reembedding source generation drift: x", phase: "failed", code: "source-drift" },
      { msg: "source config revision drift", phase: "failed", code: "source-drift" },
      { msg: "reembedding source version drift: t", phase: "failed", code: "source-drift" },
      { msg: "workspace policy changed", phase: "failed", code: "source-drift" },
      { msg: "invalid or expired reembedding confirmation", phase: "failed", code: "confirmation-invalid" },
      { msg: "network down", phase: "aborted", code: "engine-error" },
    ];
    for (const c of cases) {
      const warns: string[] = [];
      const { final } = await start(engineOf({ apply: async () => { throw new Error(c.msg); } }), memStore(checkpoint()), { logger: { info() {}, warn: (m) => { warns.push(m); } } });
      assert.equal(final.phase, c.phase, c.msg); assert.equal(final.error?.code, c.code, c.msg);
      assert.deepEqual(warns, ["re-embedding run halted"]);
    }
  });
  it("non-Error throws are stringified and capped at 500 chars", async () => {
    const { final } = await start(engineOf({ apply: async () => { throw "z".repeat(800); } }));
    assert.equal(final.error?.code, "engine-error");
    assert.equal(final.error?.message.length, 500);
  });
  it("sleep receives the checkpoint throttle between batches only while running", async () => {
    const sleeps: number[] = [];
    await start(engineOf({ apply: async () => rec("running", 2), resume: async () => rec("validating", 4) }), memStore(checkpoint({ throttleMs: 77 })), { sleep: async (ms) => { sleeps.push(ms); } });
    assert.deepEqual(sleeps, [77]);
  });
});

describe("migration driver coverage: start / status / abort / stop", () => {
  it("start refuses while a loop runs, with no checkpoint and for non-runnable phases", async () => {
    const d0 = createMigrationDriver(deps({ engine: engineOf({}), store: memStore() }));
    await assert.rejects(() => d0.start(), (e) => codeOf(e) === "no-migration");
    await assert.rejects(() => d0.run(), (e) => codeOf(e) === "no-migration");
    for (const phase of ["switched", "failed", "ready-to-switch"] as const) {
      const d = createMigrationDriver(deps({ engine: engineOf({}), store: memStore(checkpoint({ phase })) }));
      await assert.rejects(() => d.start(), (e) => codeOf(e) === "not-runnable", phase);
    }
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    const d = createMigrationDriver(deps({ engine: engineOf({ status: async () => { if (first) { first = false; await gate; } return rec("ready_to_switch"); } }), store: memStore(checkpoint()) }));
    const r = await d.start();
    await assert.rejects(() => d.start(), (e) => codeOf(e) === "migration-running");
    assert.equal((await d.status()).running, true);
    release();
    await r.done;
    assert.equal((await d.status()).running, false);
  });
  it("start runs resumable phases (running, aborted, validating) and run() resolves to the final public checkpoint", async () => {
    for (const phase of ["running", "aborted", "validating", "planned"] as const) {
      const d = createMigrationDriver(deps({ engine: engineOf({ status: async () => rec("ready_to_switch") }), store: memStore(checkpoint({ phase, error: { code: "old", message: "old" } })) }));
      const out = await d.run();
      assert.equal(out.phase, "ready-to-switch", phase);
      assert.equal(out.error, null);
      assert.ok(!("token" in out));
    }
  });
  it("start returns a public checkpoint (no token) marked running", async () => {
    const d = createMigrationDriver(deps({ engine: engineOf({ status: async () => rec("ready_to_switch") }), store: memStore(checkpoint()) }));
    const r = await d.start();
    assert.equal(r.checkpoint.phase, "running");
    assert.ok(!("token" in r.checkpoint));
    await r.done;
  });
  it("status: no checkpoint gives zero progress; engine state errors give null; percent is floored", async () => {
    const d = createMigrationDriver(deps({ engine: engineOf({}), store: memStore() }));
    const empty = await d.status();
    assert.deepEqual(empty, { checkpoint: null, engineState: null, running: false, progress: { rows: 0, rowsDone: 0, batches: 0, batchesDone: 0, percent: 0 } });

    const store = memStore(checkpoint({ counts: { rows: 3, tables: 1, batches: 2, rowsDone: 1, batchesDone: 1 } }));
    const d2 = createMigrationDriver(deps({ engine: engineOf({ status: async () => { throw new Error("engine down"); } }), store }));
    const s2 = await d2.status();
    assert.equal(s2.engineState, null);
    assert.equal(s2.progress.percent, 33);
    assert.ok(!("token" in s2.checkpoint!));

    const d3 = createMigrationDriver(deps({ engine: engineOf({ status: async () => null }), store }));
    assert.equal((await d3.status()).engineState, null);
    const d4 = createMigrationDriver(deps({ engine: engineOf({ status: async () => rec("running") }), store }));
    assert.equal((await d4.status()).engineState, "running");
  });
  it("status with rows 0 yields percent 0 even when rowsDone is set", async () => {
    const store = memStore(checkpoint({ counts: { rows: 0, tables: 0, batches: 0, rowsDone: 0, batchesDone: 0 } }));
    const d = createMigrationDriver(deps({ engine: engineOf({}), store }));
    assert.equal((await d.status()).progress.percent, 0);
  });
  it("abort: no migration, terminal phases refused, idle phases aborted directly", async () => {
    const d0 = createMigrationDriver(deps({ engine: engineOf({}), store: memStore() }));
    await assert.rejects(() => d0.abort(), (e) => codeOf(e) === "no-migration");
    for (const phase of ["switched", "failed"] as const) {
      const d = createMigrationDriver(deps({ engine: engineOf({}), store: memStore(checkpoint({ phase })) }));
      await assert.rejects(() => d.abort(), (e) => codeOf(e) === "not-abortable", phase);
    }
    const store = memStore(checkpoint({ phase: "ready-to-switch", abortRequested: true }));
    const d = createMigrationDriver(deps({ engine: engineOf({}), store }));
    const out = await d.abort();
    assert.equal(out.phase, "aborted");
    assert.equal(out.abortRequested, false);
  });
  it("abort during a run waits for the loop and returns its final public checkpoint", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const d = createMigrationDriver(deps({ engine: engineOf({ apply: async () => { await gate; return rec("running", 2); } }), store: memStore(checkpoint()) }));
    const r = await d.start();
    await flush();
    const aborting = d.abort();
    release();
    const out = await aborting;
    assert.equal(out.phase, "aborted");
    assert.ok(!("token" in out));
    assert.equal((await r.done).phase, "aborted");
  });
  it("stop without a loop is a no-op", async () => {
    const d = createMigrationDriver(deps({ engine: engineOf({}), store: memStore() }));
    await d.stop(10);
  });
  it("stop aborts an in-flight run and returns once it ended", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const store = memStore(checkpoint());
    const d = createMigrationDriver(deps({ engine: engineOf({ apply: async () => { await gate; return rec("running", 2); } }), store }));
    const r = await d.start();
    await flush();
    const stopping = d.stop(60_000);
    release();
    await stopping;
    assert.equal((await r.done).phase, "aborted");
  });
  it("stop gives up after waitMs when the loop does not end (fake timers)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const d = createMigrationDriver(deps({ engine: engineOf({ apply: async () => { await gate; return rec("running", 2); } }), store: memStore(checkpoint()) }));
    const r = await d.start();
    await flush();
    let stopped = false;
    const stopping = d.stop(500).then(() => { stopped = true; });
    await flush();
    assert.equal(stopped, false);
    t.mock.timers.tick(500);
    await stopping;
    assert.equal(stopped, true);
    assert.equal((await d.status()).running, true, "the loop is still in flight");
    release();
    await r.done;
  });
});

describe("migration driver coverage: default sleep", () => {
  const running = () => engineOf({ apply: async () => rec("running", 2), resume: async () => rec("validating", 4) });
  it("waits the throttle with a timer between batches (fake timers)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const d = createMigrationDriver({ engine: running(), store: memStore(checkpoint({ throttleMs: 250 })), switchPort: null, now: () => 1 });
    const r = await d.start();
    let done = false;
    void r.done.then(() => { done = true; });
    await flush();
    assert.equal(done, false, "parked on the throttle timer");
    t.mock.timers.tick(249);
    await flush();
    assert.equal(done, false);
    t.mock.timers.tick(1);
    assert.equal((await r.done).phase, "ready-to-switch");
  });
  it("throttle 0 does not arm a timer", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const d = createMigrationDriver({ engine: running(), store: memStore(checkpoint({ throttleMs: 0 })), switchPort: null, now: () => 1 });
    const r = await d.start();
    assert.equal((await r.done).phase, "ready-to-switch");
  });
  it("an abort wakes the sleep early and cleans up", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const d = createMigrationDriver({ engine: running(), store: memStore(checkpoint({ throttleMs: 60_000 })), switchPort: null, now: () => 1 });
    const r = await d.start();
    await flush();
    const out = await d.abort();
    assert.equal(out.phase, "aborted");
    assert.equal((await r.done).phase, "aborted");
  });
});

describe("migration driver coverage: switch", () => {
  const ready = (over: Partial<Checkpoint> = {}) => memStore(checkpoint({ phase: "ready-to-switch", ...over }));
  const port = (fn?: SwitchPort["apply"]): SwitchPort & { applied: unknown[] } => {
    const p = { applied: [] as unknown[], apply: async (sel: Parameters<SwitchPort["apply"]>[0]) => { p.applied.push(sel); if (fn) await fn(sel); } };
    return p;
  };
  it("no migration and wrong phases are refused", async () => {
    const d0 = createMigrationDriver(deps({ engine: engineOf({}), store: memStore(), switchPort: port() }));
    await assert.rejects(() => d0.switch(), (e) => codeOf(e) === "no-migration");
    for (const phase of ["planned", "running", "aborted", "validating", "switched", "failed"] as const) {
      const d = createMigrationDriver(deps({ engine: engineOf({}), store: memStore(checkpoint({ phase })), switchPort: port() }));
      await assert.rejects(() => d.switch(), (e) => codeOf(e) === "not-ready-to-switch", phase);
    }
  });
  it("switch while a loop is active is refused", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const store = memStore(checkpoint());
    let first = true;
    const d = createMigrationDriver(deps({ engine: engineOf({ status: async () => { if (first) { first = false; await gate; } return rec("ready_to_switch"); } }), store, switchPort: port() }));
    const r = await d.start();
    // start moved the phase to running: restore the ready phase to isolate the loop guard
    store.cp = checkpoint({ phase: "ready-to-switch" });
    await assert.rejects(() => d.switch(), (e) => codeOf(e) === "not-ready-to-switch");
    release();
    await r.done;
  });
  it("without a switch port: switch-unavailable, recorded on the checkpoint, phase unchanged", async () => {
    const store = ready();
    const d = createMigrationDriver(deps({ engine: engineOf({}), store, switchPort: null }));
    await assert.rejects(() => d.switch(), (e) => codeOf(e) === "switch-unavailable");
    assert.equal(store.cp?.phase, "ready-to-switch");
    assert.equal(store.cp?.error?.code, "switch-unavailable");
  });
  it("engine without a record or in another state refuses the switch", async () => {
    const d1 = createMigrationDriver(deps({ engine: engineOf({ status: async () => null }), store: ready(), switchPort: port() }));
    await assert.rejects(() => d1.switch(), (e) => codeOf(e) === "not-ready-to-switch" && /no record/.test((e as Error).message));
    const d2 = createMigrationDriver(deps({ engine: engineOf({ status: async () => rec("running") }), store: ready(), switchPort: port() }));
    await assert.rejects(() => d2.switch(), (e) => codeOf(e) === "not-ready-to-switch" && /running/.test((e as Error).message));
  });
  it("applies generation, fingerprint and the engine's fingerprintId, then marks switched and clears the error", async () => {
    const infos: string[] = [];
    const p = port();
    const store = ready({ error: { code: "switch-failed", message: "earlier" } });
    const d = createMigrationDriver(deps({ engine: engineOf({ status: async () => rec("ready_to_switch") }), store, switchPort: p, logger: { info: (m) => { infos.push(m); }, warn() {} } }));
    const out = await d.switch();
    assert.equal(out.phase, "switched");
    assert.equal(out.error, null);
    assert.ok(!("token" in out));
    assert.deepEqual(p.applied, [{ generation: "g1", fingerprint: TARGET, fingerprintId: "t-id" }]);
    assert.deepEqual(infos, ["re-embedding switched"]);
  });
  it("a switch port failure becomes switch-failed (Error, non-Error, and passthrough of MigrationError), phase stays", async () => {
    const cases: { thrown: unknown; code: string; message: string }[] = [
      { thrown: new Error("disk full"), code: "switch-failed", message: "disk full" },
      { thrown: "plain", code: "switch-failed", message: "plain" },
      { thrown: new Error("y".repeat(700)), code: "switch-failed", message: "y".repeat(500) },
      { thrown: new MigrationError("switch-unavailable", "no supervisor"), code: "switch-unavailable", message: "no supervisor" },
    ];
    for (const c of cases) {
      const store = ready();
      const d = createMigrationDriver(deps({ engine: engineOf({ status: async () => rec("ready_to_switch") }), store, switchPort: port(async () => { throw c.thrown; }) }));
      await assert.rejects(() => d.switch(), (e) => codeOf(e) === c.code && (e as Error).message === c.message);
      assert.equal(store.cp?.phase, "ready-to-switch");
      assert.equal(store.cp?.error?.code, c.code);
    }
  });
});

describe("migration driver coverage: helpers", () => {
  it("publicView drops only the token", () => {
    const v = publicView(checkpoint());
    assert.ok(!("token" in v));
    assert.equal(v.id, "m1");
    assert.equal(v.planDigest, "sha256:x");
  });
  it("MigrationError carries name and code", () => {
    const e = new MigrationError("no-migration", "m");
    assert.equal(e.name, "MigrationError");
    assert.equal(e.code, "no-migration");
    assert.ok(e instanceof Error);
  });
});
