import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMigrationDriver, MigrationError, type MigrationDriver } from "../../src/embedding-migrate/driver.ts";
import { createStateStore } from "../../src/embedding-migrate/state.ts";
import { createFakeEngine, fp, type FakeOptions } from "./fake-engine.ts";

interface Rig { fake: ReturnType<typeof createFakeEngine>; driver: MigrationDriver; sleeps: number[]; dir: string; mk: () => MigrationDriver; done: () => void }
function rig(o: FakeOptions & { onSleep?: (n: number, d: MigrationDriver) => void } = {}): Rig {
  const dir = mkdtempSync(path.join(tmpdir(), "p1-reembed-drv-"));
  const fake = createFakeEngine(o);
  const sleeps: number[] = [];
  let driver!: MigrationDriver;
  let n = 0;
  const mk = () => (driver = createMigrationDriver({
    newId: () => `m${++n}`, engine: fake.engine, store: createStateStore(dir), switchPort: fake.switchPort, now: () => 1_000,
    sleep: async (ms) => { sleeps.push(ms); o.onSleep?.(sleeps.length, driver); },
  }));
  mk();
  return { fake, get driver() { return driver; }, sleeps, dir, mk, done: () => rmSync(dir, { recursive: true, force: true }) } as Rig;
}
const target = fp("b", 12);
const codeOf = (e: unknown) => (e instanceof MigrationError ? e.code : String(e));

describe("migration driver: plan", () => {
  it("shows the correct counts and never exposes the confirmation token", async () => {
    const r = rig(); try {
      const out = await r.driver.plan({ target, throttleMs: 200 });
      assert.equal(out.probe.verdict, "migration-needed");
      assert.deepEqual(out.probe.changed, ["model", "dimensions"]);
      const p = out.plan!;
      assert.equal(p.rows, 15); assert.equal(p.tables, 2); assert.equal(p.providerCalls, 15);
      assert.equal(p.batchSize, 3); assert.equal(p.batches, 6, "ceil(10/3)+ceil(5/3)");
      assert.equal(p.minDurationMs, 6 * 200); assert.equal(p.sourceGeneration, "g0");
      assert.equal(p.targetBytes, 15 * 300); assert.ok(p.requiredFreeBytes <= p.freeBytes);
      assert.ok(!JSON.stringify(out).includes("reemb_v1_"));
      assert.ok(!JSON.stringify(await r.driver.status()).includes("reemb_v1_"));
      const st = await r.driver.status();
      assert.equal(st.checkpoint?.phase, "planned"); assert.equal(st.progress.rows, 15); assert.equal(st.progress.rowsDone, 0);
    } finally { r.done(); }
  });

  it("an identical identity is compatible: no plan and no checkpoint", async () => {
    const r = rig(); try {
      const out = await r.driver.plan({ target: r.fake.source });
      assert.equal(out.probe.verdict, "compatible"); assert.equal(out.plan, null);
      assert.equal((await r.driver.status()).checkpoint, null);
    } finally { r.done(); }
  });

  it("refuses an invalid target locally, before the engine is asked", async () => {
    const r = rig(); try {
      const out = await r.driver.plan({ target: { ...target, revision: "main" } });
      assert.equal(out.probe.verdict, "incompatible"); assert.deepEqual(out.probe.reasons, ["target-revision-unpinned"]); assert.equal(out.plan, null);
      assert.deepEqual(r.fake.state.calls, []);
    } finally { r.done(); }
  });

  it("a refused plan (disk) surfaces as plan-refused with the engine's reason", async () => {
    const r = rig({ diskFree: 0 }); try {
      await assert.rejects(r.driver.plan({ target }), (e) => codeOf(e) === "plan-refused" && /disk space/.test((e as Error).message));
      assert.equal((await r.driver.status()).checkpoint, null);
    } finally { r.done(); }
  });

  it("a second plan replaces one that never started, but is refused once anything was copied", async () => {
    const r = rig(); try {
      await r.driver.plan({ target });
      assert.equal((await r.driver.plan({ target: fp("c", 4) })).plan?.id, "m2", "nothing was copied: replaced");
      await r.driver.abort(); // aborted before any batch: still unfinished
      await assert.rejects(r.driver.plan({ target: fp("d", 4) }), (e) => codeOf(e) === "migration-active");
    } finally { r.done(); }
  });
});

describe("migration driver: run", () => {
  it("copies in batches to ready-to-switch without touching the active generation", async () => {
    const r = rig(); try {
      await r.driver.plan({ target, throttleMs: 50 });
      const before = r.fake.recall("topic1 item2");
      const cp = await r.driver.run();
      assert.equal(cp.phase, "ready-to-switch"); assert.equal(cp.counts.rowsDone, 15); assert.equal(cp.counts.batchesDone, 6);
      assert.equal(r.fake.state.activeGeneration, "g0"); assert.deepEqual(r.fake.recall("topic1 item2"), before);
      assert.equal(r.fake.state.calls.filter((c) => c === "apply").length, 1); assert.equal(r.fake.state.calls.filter((c) => c === "resume").length, 5);
      assert.deepEqual(r.fake.switchPort.applied, []);
    } finally { r.done(); }
  });

  it("throttles between batches (not after the last) with the planned pause", async () => {
    const r = rig(); try {
      await r.driver.plan({ target, throttleMs: 250 });
      await r.driver.run();
      assert.deepEqual(r.sleeps, [250, 250, 250, 250, 250]);
    } finally { r.done(); }
  });

  it("recall during the migration is answered by the old store, batch after batch", async () => {
    const seen: string[][] = [];
    const r = rig({ onSleep: () => { seen.push(r.fake.recall("topic2 item6")); } }); try {
      await r.driver.plan({ target });
      const baseline = r.fake.recall("topic2 item6");
      await r.driver.run();
      assert.equal(seen.length, 5); for (const s of seen) assert.deepEqual(s, baseline);
    } finally { r.done(); }
  });

  it("abort in the middle stops at a batch boundary; a later run resumes and finishes without re-embedding", async () => {
    let abortP: Promise<unknown> | null = null;
    const r = rig({ onSleep: (n, d) => { if (n === 2) abortP = d.abort(); } }); try {
      await r.driver.plan({ target });
      const stopped = await r.driver.run();
      await abortP;
      assert.equal(stopped.phase, "aborted"); assert.equal(stopped.counts.rowsDone, 6); assert.equal(stopped.counts.batchesDone, 2);
      assert.equal(stopped.abortRequested, false); assert.equal(stopped.error, null);
      assert.equal(r.fake.state.activeGeneration, "g0");
      const done = await r.driver.run();
      assert.equal(done.phase, "ready-to-switch"); assert.equal(done.counts.rowsDone, 15);
      const g = r.fake.state.generations.get("generation-" + done.id)!;
      const ids = [...g.tables.values()].flat().map((x) => x.id);
      assert.equal(ids.length, 15); assert.equal(new Set(ids).size, 15, "no row embedded twice");
      assert.equal(r.fake.state.calls.filter((c) => c === "apply").length, 1, "the first batch confirmed once; later runs resume");
    } finally { r.done(); }
  });

  it("an engine failure halts the run resumably; a restarted driver finishes from the checkpoint", async () => {
    const r = rig({ failBatch: { n: 3, error: new Error("provider exploded") } }); try {
      await r.driver.plan({ target });
      const halted = await r.driver.run();
      assert.equal(halted.phase, "aborted"); assert.equal(halted.error?.code, "engine-error"); assert.match(halted.error!.message, /provider exploded/);
      assert.equal(halted.counts.rowsDone, 6);
      const fresh = r.mk(); // a new process: only the checkpoint file and the engine's own record remain
      const done = await fresh.run();
      assert.equal(done.phase, "ready-to-switch"); assert.equal(done.error, null); assert.equal(done.counts.rowsDone, 15);
    } finally { r.done(); }
  });

  it("source drift during a run fails the migration for good (re-plan needed) and leaves the active store alone", async () => {
    const r = rig({ onSleep: (n) => { if (n === 2) r.fake.state.sourceVersion += 1; } }); try {
      await r.driver.plan({ target });
      const cp = await r.driver.run();
      assert.equal(cp.phase, "failed"); assert.equal(cp.error?.code, "source-drift");
      assert.equal(r.fake.state.activeGeneration, "g0");
      assert.equal((await r.driver.plan({ target })).plan?.id, "m2", "a failed migration does not block a new plan");
    } finally { r.done(); }
  });

  it("an engine without validate stops at validating, fail closed, and refuses to switch", async () => {
    const r = rig({ withValidate: false }); try {
      await r.driver.plan({ target });
      const cp = await r.driver.run();
      assert.equal(cp.phase, "validating"); assert.equal(cp.error?.code, "engine-validate-unavailable");
      await assert.rejects(r.driver.switch(), (e) => codeOf(e) === "not-ready-to-switch");
      assert.equal(r.fake.state.activeGeneration, "g0");
    } finally { r.done(); }
  });

  it("only one run drives the engine at a time", async () => {
    const r = rig(); try {
      await r.driver.plan({ target });
      const first = await r.driver.start();
      await assert.rejects(r.driver.start(), (e) => codeOf(e) === "migration-running");
      await first.done;
    } finally { r.done(); }
  });

  it("run without a plan, or after the migration is over, is refused", async () => {
    const r = rig(); try {
      await assert.rejects(r.driver.run(), (e) => codeOf(e) === "no-migration");
      await r.driver.plan({ target }); await r.driver.run(); await r.driver.switch();
      await assert.rejects(r.driver.run(), (e) => codeOf(e) === "not-runnable");
    } finally { r.done(); }
  });
});

describe("migration driver: switch and abort", () => {
  it("switches once, from ready-to-switch only, keeping the old generation", async () => {
    const r = rig(); try {
      await assert.rejects(r.driver.switch(), (e) => codeOf(e) === "no-migration");
      await r.driver.plan({ target });
      await assert.rejects(r.driver.switch(), (e) => codeOf(e) === "not-ready-to-switch");
      await r.driver.run();
      const cp = await r.driver.switch();
      assert.equal(cp.phase, "switched");
      assert.equal(r.fake.switchPort.applied.length, 1);
      assert.deepEqual(r.fake.switchPort.applied[0], { generation: "generation-" + cp.id, fingerprint: target, fingerprintId: r.fake.state.records.get(cp.id)!.target.fingerprintId });
      assert.ok(r.fake.state.generations.get("g0")!.tables.get("memories")!.length === 10, "old generation retained");
      await assert.rejects(r.driver.switch(), (e) => codeOf(e) === "not-ready-to-switch");
    } finally { r.done(); }
  });

  it("a failing switch port leaves the phase and the active generation unchanged", async () => {
    const r = rig(); try {
      const failing = createMigrationDriver({ engine: r.fake.engine, store: createStateStore(r.dir), switchPort: { apply: async () => { throw new Error("config busy"); } }, sleep: async () => {} });
      await failing.plan({ target }); await failing.run();
      await assert.rejects(failing.switch(), (e) => codeOf(e) === "switch-failed" && /config busy/.test((e as Error).message));
      const st = (await failing.status()).checkpoint!;
      assert.equal(st.phase, "ready-to-switch"); assert.equal(st.error?.code, "switch-failed"); assert.equal(r.fake.state.activeGeneration, "g0");
    } finally { r.done(); }
  });

  it("without a switch port the switch is unavailable, nothing changes", async () => {
    const r = rig(); try {
      const d = createMigrationDriver({ engine: r.fake.engine, store: createStateStore(r.dir), switchPort: null, sleep: async () => {} });
      await d.plan({ target }); await d.run();
      await assert.rejects(d.switch(), (e) => codeOf(e) === "switch-unavailable");
      assert.equal(r.fake.state.activeGeneration, "g0");
      assert.equal((await d.status()).checkpoint?.error?.code, "switch-unavailable");
    } finally { r.done(); }
  });

  it("stop ends an in-flight run at a batch boundary, resumably", async () => {
    let stopP: Promise<void> | null = null;
    const r = rig({ onSleep: (n, d) => { if (n === 3) stopP = d.stop(5_000); } }); try {
      await r.driver.plan({ target });
      const cp = await r.driver.run(); await stopP;
      assert.equal(cp.phase, "aborted"); assert.equal(cp.error, null); assert.equal(cp.counts.batchesDone, 3);
      assert.equal((await r.driver.run()).phase, "ready-to-switch");
      await r.driver.stop(10); // nothing in flight: a no-op
    } finally { r.done(); }
  });

  it("abort with nothing running marks a started migration aborted; with nothing planned or after a switch it is refused", async () => {
    const r = rig(); try {
      await assert.rejects(r.driver.abort(), (e) => codeOf(e) === "no-migration");
      await r.driver.plan({ target });
      assert.equal((await r.driver.abort()).phase, "aborted");
      await r.driver.run(); await r.driver.switch();
      await assert.rejects(r.driver.abort(), (e) => codeOf(e) === "not-abortable");
    } finally { r.done(); }
  });
});
