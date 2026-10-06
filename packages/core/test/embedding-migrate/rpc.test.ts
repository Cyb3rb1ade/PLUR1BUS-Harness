import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateParams, validateResult } from "@plur1bus/rpc-schema";
import { createMigrationDriver } from "../../src/embedding-migrate/driver.ts";
import { buildReembedMethods, REEMBED_METHODS } from "../../src/embedding-migrate/rpc.ts";
import { createStateStore } from "../../src/embedding-migrate/state.ts";
import { createFakeEngine } from "./fake-engine.ts";

const logger = { debug() {}, info() {}, warn() {} };
const E5 = "intfloat/multilingual-e5-small";

function rig(o: { stopping?: () => boolean; onSleep?: (n: number) => void; switchPort?: null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "p1-reembed-rpc-"));
  const fake = createFakeEngine({ rows: { memories: 10, shared: 5 } });
  let n = 0;
  const driver = createMigrationDriver({ engine: fake.engine, store: createStateStore(dir), switchPort: o.switchPort === null ? null : fake.switchPort, sleep: async () => { o.onSleep?.(++n); }, newId: () => "r1" });
  const m = buildReembedMethods({ driver, isStopping: o.stopping ?? (() => false), logger });
  const call = async (method: (typeof REEMBED_METHODS)[number], params: unknown = {}) => {
    assert.deepEqual(validateParams(method, params), { ok: true }, `${method} params`);
    const r = await (m[method] as (p: unknown, c?: unknown) => Promise<unknown>)(params, {});
    assert.deepEqual(validateResult(method, r), { ok: true }, `${method} result: ${JSON.stringify(r)}`);
    return r as any;
  };
  const settle = async () => { for (let i = 0; i < 200 && (await driver.status()).running; i++) await new Promise((r) => setTimeout(r, 5)); };
  return { fake, driver, call, m, settle, done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("admin.reembed.* handlers", () => {
  it("plan answers the probe verdict and counts; the token never appears on the wire", async () => {
    const r = rig(); try {
      const out = await r.call("admin.reembed.plan", { model: E5, throttleMs: 0 });
      assert.equal(out.probe.verdict, "migration-needed"); assert.equal(out.plan.rows, 15); assert.equal(out.plan.batches, 6, "ceil(10/3)+ceil(5/3)");
      assert.ok(!JSON.stringify(out).includes("reemb_v1_"));
      assert.ok(!JSON.stringify(await r.call("admin.reembed.status")).includes("reemb_v1_"));
    } finally { r.done(); }
  });

  it("an unpinned model is refused with the reason, nothing planned", async () => {
    const r = rig(); try {
      const out = await r.call("admin.reembed.plan", { model: "x/unpinned" });
      assert.equal(out.probe.verdict, "incompatible"); assert.deepEqual(out.probe.reasons, ["target-model-unpinned"]); assert.equal(out.plan, null);
      assert.equal((await r.call("admin.reembed.status")).checkpoint, null);
    } finally { r.done(); }
  });

  it("run returns at once, continues in the background, and switches after validation", async () => {
    const r = rig(); try {
      await r.call("admin.reembed.plan", { model: E5, throttleMs: 0 });
      const started = await r.call("admin.reembed.run");
      assert.equal(started.checkpoint.phase, "running");
      await r.settle();
      // the follow-up switch runs after the loop's promise settles
      for (let i = 0; i < 100 && (await r.call("admin.reembed.status")).checkpoint.phase !== "switched"; i++) await new Promise((res) => setTimeout(res, 5));
      const st = await r.call("admin.reembed.status");
      assert.equal(st.checkpoint.phase, "switched"); assert.equal(st.progress.percent, 100); assert.equal(r.fake.switchPort.applied.length, 1);
    } finally { r.done(); }
  });

  it("run with switch:false stops at ready-to-switch; a second run performs only the switch", async () => {
    const r = rig(); try {
      await r.call("admin.reembed.plan", { model: E5, throttleMs: 0 });
      await r.call("admin.reembed.run", { switch: false }); await r.settle();
      const st = await r.call("admin.reembed.status");
      assert.equal(st.checkpoint.phase, "ready-to-switch"); assert.equal(r.fake.switchPort.applied.length, 0); assert.equal(st.engineState, "ready_to_switch");
      const second = await r.call("admin.reembed.run");
      assert.equal(second.checkpoint.phase, "switched"); assert.equal(r.fake.switchPort.applied.length, 1);
    } finally { r.done(); }
  });

  it("abort mid-run, then run finishes", async () => {
    const holder: { abort?: () => Promise<unknown> } = {};
    let abortP: Promise<unknown> | undefined;
    const r = rig({ onSleep: (n) => { if (n === 2) abortP = holder.abort!(); } }); try {
      holder.abort = () => r.call("admin.reembed.abort");
      await r.call("admin.reembed.plan", { model: E5, throttleMs: 0 });
      await r.call("admin.reembed.run", { switch: false }); await r.settle(); await abortP;
      const st = await r.call("admin.reembed.status");
      assert.equal(st.checkpoint.phase, "aborted"); assert.ok(st.progress.rowsDone > 0 && st.progress.rowsDone < 15);
      await r.call("admin.reembed.run", { switch: false }); await r.settle();
      assert.equal((await r.call("admin.reembed.status")).checkpoint.phase, "ready-to-switch");
    } finally { r.done(); }
  });

  it("maps driver failures onto stable wire errors", async () => {
    const r = rig(); try {
      const rejects = (p: Promise<unknown>, error: string, reason: string) => assert.rejects(p, (e: any) => e.error === error && e.reason === reason, `${error}/${reason}`);
      await rejects(r.m["admin.reembed.run"]({}, {} as never) as Promise<unknown>, "E_NOT_FOUND", "no-migration");
      await rejects(r.m["admin.reembed.abort"]({}, {} as never) as Promise<unknown>, "E_NOT_FOUND", "no-migration");
      await r.call("admin.reembed.plan", { model: E5 });
      await rejects(r.m["admin.reembed.plan"]({ model: E5 }, {} as never) as Promise<unknown>, "E_CONFLICT", "migration-active");
    } finally { r.done(); }
  });

  it("a switch that cannot be made (no supervisor) leaves ready-to-switch with the reason in the checkpoint", async () => {
    const r = rig({ switchPort: null }); try {
      await r.call("admin.reembed.plan", { model: E5, throttleMs: 0 });
      await r.call("admin.reembed.run"); await r.settle();
      // the follow-up switch attempt runs after the loop settles and records why it could not be made
      for (let i = 0; i < 200 && (await r.call("admin.reembed.status")).checkpoint.error === null; i++) await new Promise((res) => setTimeout(res, 5));
      const st = await r.call("admin.reembed.status");
      assert.equal(st.checkpoint.phase, "ready-to-switch"); assert.equal(st.checkpoint.error.code, "switch-unavailable");
      assert.equal(r.fake.state.activeGeneration, "g0");
    } finally { r.done(); }
  });

  it("refuses everything while the core is stopping", async () => {
    const r = rig({ stopping: () => true }); try {
      for (const m of REEMBED_METHODS) await assert.rejects(r.m[m]({ model: E5 }, {} as never) as Promise<unknown>, (e: any) => e.error === "E_CORE_UNAVAILABLE");
    } finally { r.done(); }
  });
});
