import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackfillJob, createBudgetCallback, type BackfillConfig } from "../../src/media-search/backfill.ts";
import { FakePort, recorder, silentLogger } from "./fakes.ts";

function setup(cfg: Partial<BackfillConfig> = {}, port = new FakePort()) {
  const dir = mkdtempSync(join(tmpdir(), "media-bf-"));
  const stateFile = join(dir, "state", "media-search.json");
  const ev = recorder();
  const ticks: (() => void)[] = [];
  const job = createBackfillJob({
    port: () => port, config: () => ({ enabled: true, provider: "local", backfill: "auto", ...cfg }), events: ev, logger: silentLogger, stateFile,
    schedule: fn => { ticks.push(fn); return () => { ticks.length = 0; }; },
  });
  return { port, job, ev, stateFile, ticks };
}

describe("backfill job", () => {
  it("auto-starts on first enable and records the fingerprint", async () => {
    const { port, job, stateFile } = setup();
    assert.equal(await job.init(), "started");
    assert.deepEqual(port.starts, ["enable"]);
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).fingerprint, "fp-1");
  });
  it("same fingerprint on the next start: nothing", async () => {
    const a = setup();
    await a.job.init();
    a.port.starts.length = 0; a.port.bf = { state: "done", done: 3, total: 3 };
    assert.equal(await a.job.init(), "idle");
    assert.deepEqual(a.port.starts, []);
  });
  it("changed fingerprint starts with reason model-change", async () => {
    const { port, job, stateFile } = setup();
    await job.init();
    port.starts.length = 0; port.bf = { state: "done", done: 3, total: 3 }; port.fingerprint = "fp-2";
    assert.equal(await job.init(), "started");
    assert.deepEqual(port.starts, ["model-change"]);
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).fingerprint, "fp-2");
  });
  it("manual never auto-starts", async () => {
    const { port, job } = setup({ backfill: "manual" });
    assert.equal(await job.init(), "idle");
    assert.deepEqual(port.starts, []);
  });
  it("disabled or provider off never starts", async () => {
    for (const c of [{ enabled: false }, { provider: "off" }]) {
      const { port, job } = setup(c);
      assert.equal(await job.init(), "idle");
      assert.deepEqual(port.starts, []);
    }
  });
  it("restart: running or budget/error-paused resumes, user-paused stays paused", async () => {
    for (const bf of [{ state: "running" }, { state: "paused", pausedReason: "budget" }, { state: "paused", pausedReason: "error" }] as const) {
      const { port, job } = setup(); port.bf = { ...bf, done: 1, total: 3 };
      assert.equal(await job.init(), "resumed");
      assert.deepEqual(port.calls, ["resume"]);
    }
    const { port, job } = setup(); port.bf = { state: "paused", pausedReason: "user", done: 1, total: 3 };
    assert.equal(await job.init(), "idle");
    assert.deepEqual(port.calls, []);
  });
  it("budget exhausted pauses with pausedReason budget and emits status", async () => {
    const port = new FakePort();
    let refuse = false;
    const budget = { checkBeforeCall: () => (refuse ? { kind: "refuse" } : { kind: "allow", reservationId: "r" }), releaseUnused() {} } as any;
    const cb = createBudgetCallback(budget);
    port.budget = cb;
    const { job, ev } = setup({}, port);
    await job.init();
    await port.step();
    await job.poll();
    refuse = true;
    await port.step();
    const s = await job.poll();
    assert.equal(s!.backfill.pausedReason, "budget");
    assert.equal(ev.events.at(-1)!.name, "media.index.status");
    assert.equal((ev.events.at(-1)!.payload as any).backfill.pausedReason, "budget");
  });
  it("budget callback: null budget allows, refusal denies, allowance is released", async () => {
    assert.equal(await createBudgetCallback(null).canContinue(), true);
    const released: string[] = [];
    const ok = createBudgetCallback({ checkBeforeCall: () => ({ kind: "allow", reservationId: "r9" }), releaseUnused: (id: string) => { released.push(id); } } as any);
    assert.equal(await ok.canContinue(), true);
    assert.deepEqual(released, ["r9"]);
  });
  it("poll emits only on change; watch uses the injected scheduler", async () => {
    const { job, ev, ticks } = setup();
    await job.poll(); await job.poll();
    assert.equal(ev.events.length, 1);
    const stop = job.watch();
    assert.equal(ticks.length, 1);
    stop();
  });
  it("pause/resume/cancel delegate; reindex = cancel + start manual", async () => {
    const { port, job } = setup();
    await job.pause(); await job.resume(); await job.cancel();
    assert.deepEqual(port.calls, ["pause", "resume", "cancel"]);
    port.calls.length = 0;
    await job.reindex();
    assert.deepEqual(port.calls, ["cancel", "start"]);
    assert.deepEqual(port.starts, ["manual"]);
  });
  it("survives a corrupt state file", async () => {
    const { port, job, stateFile } = setup();
    await job.init(); writeFileSync(stateFile, "{not json");
    port.starts.length = 0; port.bf = { state: "idle", done: 0, total: 0 };
    assert.equal(await job.init(), "started");
  });
});
