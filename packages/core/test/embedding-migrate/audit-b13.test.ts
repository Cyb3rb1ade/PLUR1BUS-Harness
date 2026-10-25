// Audit b13: races between plan/start/switch/abort, engine answers that disagree with the checkpoint (no mixing of vector
// spaces), a stalled engine, progress counting and storage failures. Scripted engine, in-memory store.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMigrationDriver, MigrationError, type DriverDeps } from "../../src/embedding-migrate/driver.ts";
import type { Checkpoint, StateStore } from "../../src/embedding-migrate/state.ts";
import type { EngineRecord, EngineState, EnginePlan, ReembedEngine, SwitchPort } from "../../src/embedding-migrate/port.ts";
import type { EmbeddingFingerprint } from "../../src/embedding-migrate/probe.ts";

const fp = (model: string, dimensions = 8): EmbeddingFingerprint => ({ provider: "fake", model, dimensions, normalize: true });
const SRC = fp("a");
const TARGET = fp("b", 12);
type Cursor = EngineRecord["cursor"];
const cur = (completedRows: number, tableIndex = 0, offset = 0): Cursor => ({ tableIndex, offset, completedRows, providerCalls: 0, bytes: 0 });

const rec = (state: EngineState, o: { cursor?: Cursor; target?: EngineRecord["target"]; tables?: number[] } = {}): EngineRecord => ({
  id: "m1", state, cursor: o.cursor ?? cur(0),
  source: { generation: "g0", fingerprintId: "s", fingerprint: SRC, tables: (o.tables ?? [5]).map((n, i) => ({ tableId: `t${i}`, version: "1", rowCount: n, estimatedBytes: n })) },
  target: o.target ?? { generation: "g1", fingerprintId: "t-id", fingerprint: TARGET },
});
const enginePlan = (target = TARGET): EnginePlan => ({
  plan: {
    id: "m1", source: { generation: "g0", fingerprintId: "s", fingerprint: SRC, tables: [{ tableId: "t0", version: "1", rowCount: 5, estimatedBytes: 5 }] },
    target: { generation: "g1", fingerprintId: "t-id", fingerprint: target, probeStatus: "passed" },
    estimates: { rows: 5, providerCalls: 5, sourceBytes: 1, targetBytes: 2, requiredFreeBytes: 3, freeBytes: 4 },
  },
  planDigest: "sha256:x", confirmation: { token: "tok" },
});
function memStore(initial: Checkpoint | null = null): StateStore & { cp: Checkpoint | null } {
  const s = { path: "mem", cp: initial, read() { return s.cp; }, write(c: Checkpoint) { s.cp = structuredClone(c); } };
  return s;
}
const checkpoint = (over: Partial<Checkpoint> = {}): Checkpoint => ({
  v: 1, id: "m1", token: "tok", planDigest: "sha256:x", createdAt: 1, updatedAt: 1, phase: "planned", sourceGeneration: "g0", targetGeneration: "g1", target: TARGET,
  counts: { rows: 5, tables: 1, batches: 3, rowsDone: 0, batchesDone: 0 }, throttleMs: 0, abortRequested: false, error: null, ...over,
});
interface Script { plan?: () => Promise<EnginePlan>; status?: () => Promise<EngineRecord | null>; apply?: () => Promise<EngineRecord>; resume?: () => Promise<EngineRecord>; validate?: () => Promise<EngineRecord> }
const engineOf = (s: Script): ReembedEngine => ({
  batchSize: 2,
  plan: s.plan ?? (async () => enginePlan()),
  apply: s.apply ?? (async () => rec("running")),
  resume: s.resume ?? (async () => rec("running")),
  status: s.status ?? (async () => rec("planned")),
  validate: s.validate ?? (async () => rec("ready_to_switch", { cursor: cur(5, 1) })),
});
let ids = 0;
const deps = (o: Partial<DriverDeps> & { engine: ReembedEngine; store: StateStore }): DriverDeps => ({ switchPort: null, now: () => 1000, sleep: async () => {}, newId: () => `m${++ids}`, ...o });
const codeOf = (e: unknown) => (e instanceof MigrationError ? e.code : String(e));
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const tick = () => new Promise<void>((r) => setImmediate(r));

describe("audit b13: concurrent operations", () => {
  it("two plans at once: exactly one wins, the other is refused, one engine plan exists", async () => {
    let plans = 0; const g = gate();
    const store = memStore();
    const d = createMigrationDriver(deps({ engine: engineOf({ plan: async () => { plans++; await g.p; return enginePlan(); } }), store }));
    const all = Promise.allSettled([d.plan({ target: TARGET }), d.plan({ target: TARGET })]);
    await tick(); g.open();
    const res = await all;
    assert.equal(res.filter((r) => r.status === "fulfilled").length, 1);
    const rej = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.equal(codeOf(rej.reason), "migration-active");
    assert.equal(plans, 1, "the second plan never reaches the engine");
  });

  it("start() while a plan is being created is refused, so a plan can never replace a running checkpoint", async () => {
    const g = gate();
    const store = memStore(checkpoint({ expiresAt: 0 })); // an expired plan: a new one is created
    const d = createMigrationDriver(deps({ engine: engineOf({ plan: async () => { await g.p; return enginePlan(); } }), store }));
    const planning = d.plan({ target: TARGET });
    await tick();
    await assert.rejects(() => d.start(), (e) => codeOf(e) === "migration-active");
    g.open(); await planning;
  });

  it("plan() while a run is in flight is refused even when the stored phase is still planned", async () => {
    const g = gate();
    const store = memStore(checkpoint());
    const d = createMigrationDriver(deps({ engine: engineOf({ status: async () => { await g.p; return rec("ready_to_switch"); } }), store }));
    const run = await d.start();
    // simulate a stale reader: the checkpoint on disk still says planned
    store.cp = { ...store.cp!, phase: "planned" };
    await assert.rejects(() => d.plan({ target: TARGET }), (e) => codeOf(e) === "migration-running" || codeOf(e) === "migration-active");
    g.open(); await run.done;
  });

  it("two switches at once apply the selection once", async () => {
    const g = gate(); let applied = 0;
    const port: SwitchPort = { apply: async () => { applied++; await g.p; } };
    const d = createMigrationDriver(deps({ engine: engineOf({ status: async () => rec("ready_to_switch") }), store: memStore(checkpoint({ phase: "ready-to-switch" })), switchPort: port }));
    const all = Promise.allSettled([d.switch(), d.switch()]);
    await tick(); g.open();
    const res = await all;
    assert.equal(applied, 1);
    assert.equal(res.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(codeOf((res.find((r) => r.status === "rejected") as PromiseRejectedResult).reason), "migration-running");
  });

  it("abort() during a switch is refused and does not overwrite the switched phase", async () => {
    const g = gate();
    const store = memStore(checkpoint({ phase: "ready-to-switch" }));
    const d = createMigrationDriver(deps({ engine: engineOf({ status: async () => rec("ready_to_switch") }), store, switchPort: { apply: async () => { await g.p; } } }));
    const sw = d.switch(); await tick();
    await assert.rejects(() => d.abort(), (e) => codeOf(e) === "not-abortable");
    g.open(); assert.equal((await sw).phase, "switched");
    assert.equal(store.cp?.phase, "switched");
  });
});

describe("audit b13: the engine's answer must agree with the checkpoint (no mixed vector spaces)", () => {
  it("a plan whose target dimensions differ from the requested target is refused and writes no checkpoint", async () => {
    const store = memStore();
    const d = createMigrationDriver(deps({ engine: engineOf({ plan: async () => enginePlan(fp("b", 16)) }), store }));
    await assert.rejects(() => d.plan({ target: TARGET }), (e) => codeOf(e) === "plan-refused" && /target/.test((e as Error).message));
    assert.equal(store.cp, null);
  });

  it("a plan for another model than requested is refused", async () => {
    const d = createMigrationDriver(deps({ engine: engineOf({ plan: async () => enginePlan(fp("other", 12)) }), store: memStore() }));
    await assert.rejects(() => d.plan({ target: TARGET }), (e) => codeOf(e) === "plan-refused");
  });

  it("switch refuses an engine record whose target dimensions differ from the checkpoint's target, applying nothing", async () => {
    let applied = 0;
    const bad = rec("ready_to_switch", { target: { generation: "g1", fingerprintId: "t-id", fingerprint: fp("b", 16) } });
    const d = createMigrationDriver(deps({ engine: engineOf({ status: async () => bad }), store: memStore(checkpoint({ phase: "ready-to-switch" })), switchPort: { apply: async () => { applied++; } } }));
    await assert.rejects(() => d.switch(), (e) => codeOf(e) === "not-ready-to-switch" && /target/.test((e as Error).message));
    assert.equal(applied, 0);
  });

  it("switch refuses an engine record whose target generation differs from the checkpoint's", async () => {
    let applied = 0;
    const bad = rec("ready_to_switch", { target: { generation: "g-other", fingerprintId: "t-id", fingerprint: TARGET } });
    const d = createMigrationDriver(deps({ engine: engineOf({ status: async () => bad }), store: memStore(checkpoint({ phase: "ready-to-switch" })), switchPort: { apply: async () => { applied++; } } }));
    await assert.rejects(() => d.switch(), (e) => codeOf(e) === "not-ready-to-switch");
    assert.equal(applied, 0);
  });
});

describe("audit b13: a stalled engine does not loop forever", () => {
  it("a batch that does not move the cursor halts the run resumably instead of repeating", async () => {
    let calls = 0;
    const stuck = async () => { if (++calls > 25) throw new Error("test: runaway loop"); return rec("running", { cursor: cur(2, 0, 2) }); };
    const d = createMigrationDriver(deps({ engine: engineOf({ status: async () => rec("running", { cursor: cur(2, 0, 2) }), resume: stuck }), store: memStore(checkpoint({ phase: "running" })) }));
    const final = await (await d.start()).done;
    assert.ok(calls <= 3, `engine was called ${calls} times`);
    assert.equal(final.phase, "aborted");
    assert.equal(final.error?.code, "engine-error");
    assert.match(final.error!.message, /no progress/);
  });
});

describe("audit b13: progress counting", () => {
  it("percent never exceeds 100 when the engine copied more rows than the plan counted", async () => {
    const d = createMigrationDriver(deps({ engine: engineOf({}), store: memStore(checkpoint({ counts: { rows: 5, tables: 1, batches: 3, rowsDone: 7, batchesDone: 4 } })) }));
    assert.equal((await d.status()).progress.percent, 100);
  });

  it("batchesDone is repaired from the engine cursor after a restart that lost the last checkpoint write", async () => {
    // The engine is at row 4 of 5 (two batches of two done), the checkpoint still says 0 batches.
    const d = createMigrationDriver(deps({
      engine: engineOf({ status: async () => rec("running", { cursor: cur(4, 0, 4) }), resume: async () => rec("validating", { cursor: cur(5, 1, 0) }) }),
      store: memStore(checkpoint({ phase: "running" })),
    }));
    const final = await (await d.start()).done;
    assert.equal(final.counts.batchesDone, 3);
    assert.equal(final.counts.rowsDone, 5);
    assert.equal(final.phase, "ready-to-switch");
  });
});

describe("audit b13: storage failures surface as migration errors", () => {
  const failing = (): StateStore => ({ path: "mem", read: () => null, write: () => { throw Object.assign(new Error("EACCES: permission denied, open '/home/x/state/reembed/migration.json.1.tmp'"), { code: "EACCES" }); } });
  it("plan: a checkpoint that cannot be written is a MigrationError, not a raw exception", async () => {
    const d = createMigrationDriver(deps({ engine: engineOf({}), store: failing() }));
    await assert.rejects(() => d.plan({ target: TARGET }), (e) => e instanceof MigrationError && e.code === "state-unreadable" && !/\/home\/x/.test(e.message));
  });
  it("start: a checkpoint that cannot be written is a MigrationError and no run is left behind", async () => {
    const s = memStore(checkpoint()); const w = failing().write;
    const store: StateStore = { path: "mem", read: () => s.cp, write: w };
    const d = createMigrationDriver(deps({ engine: engineOf({}), store }));
    await assert.rejects(() => d.start(), (e) => e instanceof MigrationError);
    assert.equal((await d.status()).running, false);
  });
});
