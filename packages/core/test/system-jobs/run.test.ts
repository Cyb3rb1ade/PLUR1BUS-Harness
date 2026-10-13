// system-jobs run: unknown jobs, argument validation, the stored record for every result state, failures, concurrency.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { RpcError } from "../../src/rpc/errors.ts";
import type { SystemJobOutcome } from "../../src/system-jobs/index.ts";
import { scriptedHandler, setup, T0, useTempDirs, type Setup } from "./helpers.ts";

const dirs = useTempDirs();
const rowsOf = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("system-jobs run: unknown job", () => {
  it("is E_INVALID_PARAMS with detail 'job', and writes nothing (no ledger file at all)", async () => {
    const s = setup(dirs);
    s.jobs.register(scriptedHandler({ name: "known" }).handler);
    await assert.rejects(s.jobs.run("nope", {}, { trigger: "manual" }), (e: unknown) => e instanceof RpcError && e.error === "E_INVALID_PARAMS" && e.detail === "job" && /unknown system job nope/.test(e.message));
    assert.equal(existsSync(s.ledgerPath), false);
    assert.deepEqual(s.jobs.history({}), []);
  });
  it("names are exact: case and whitespace differences are unknown jobs", async () => {
    const s = setup(dirs);
    s.jobs.register(scriptedHandler({ name: "known" }).handler);
    for (const name of ["Known", "known ", " known", "", "__proto__", "constructor"]) {
      await assert.rejects(s.jobs.run(name, {}, { trigger: "manual" }), (e: unknown) => e instanceof RpcError && e.error === "E_INVALID_PARAMS", JSON.stringify(name));
    }
  });
});

describe("system-jobs run: arguments", () => {
  it("validateArgs sees the raw value and its result, not the raw value, is what the handler gets and what is stored", async () => {
    const s = setup(dirs);
    const h = scriptedHandler({ validateArgs: (a) => ({ provider: String((a as { provider?: unknown }).provider).trim() }) });
    s.jobs.register(h.handler);
    const { record } = await s.jobs.run("test.job", { provider: "  p1 ", extra: "dropped" }, { trigger: "manual" });
    assert.deepEqual(h.validated, [{ provider: "  p1 ", extra: "dropped" }]);
    assert.deepEqual(h.calls[0]!.args, { provider: "p1" });
    assert.deepEqual(record.args, { provider: "p1" });
    assert.deepEqual(rowsOf(s.ledgerPath).map((r) => r.args), [{ provider: "p1" }, { provider: "p1" }]);
  });

  it("empty validated args are not stored (no args key in the record or the rows)", async () => {
    const s = setup(dirs);
    s.jobs.register(scriptedHandler().handler);
    const { record } = await s.jobs.run("test.job", undefined, { trigger: "manual" });
    assert.equal("args" in record, false);
    for (const r of rowsOf(s.ledgerPath)) assert.equal("args" in r, false);
  });

  it("a validation error is the caller's: it propagates unchanged, the handler never runs, and no row is written", async () => {
    const s = setup(dirs);
    const bad = new RpcError("E_INVALID_PARAMS", "args must be an object", { detail: "args" });
    const h = scriptedHandler({ validateArgs: () => { throw bad; } });
    s.jobs.register(h.handler);
    await assert.rejects(s.jobs.run("test.job", 5, { trigger: "manual" }), (e: unknown) => e === bad);
    assert.equal(h.calls.length, 0); assert.equal(existsSync(s.ledgerPath), false); assert.deepEqual(s.failed, []);
  });
});

describe("system-jobs run: the stored result", () => {
  const states: [string, SystemJobOutcome][] = [
    ["completed", { outcome: "completed", detail: { n: 1 } }],
    ["skipped with a reason", { outcome: "skipped", reason: "disabled", detail: null }],
    ["skipped because another run holds it", { outcome: "skipped", reason: "already_running", runningRunId: "run-other", detail: [] }],
    ["failed with a reason", { outcome: "failed", reason: "network", detail: null }],
    ["incomplete", { outcome: "incomplete", reason: "deadline", detail: null }],
    ["abandoned (cancelled)", { outcome: "abandoned", reason: "aborted", detail: null }],
  ];
  for (const [name, outcome] of states) {
    it(`${name}: record, ledger rows and history agree, and the detail is returned unchanged`, async () => {
      const s = setup(dirs);
      s.jobs.register(scriptedHandler({ run: async () => { s.clock.advance(250); return outcome; } }).handler);
      const res = await s.jobs.run("test.job", {}, { trigger: "cron" });
      assert.equal(res.detail, outcome.detail);
      const r = res.record;
      assert.match(r.runId, UUID); assert.equal(r.job, "test.job"); assert.equal(r.kind, "system"); assert.equal(r.trigger, "cron"); assert.equal(r.attempt, 1);
      assert.equal(r.outcome, outcome.outcome); assert.equal(r.reason, outcome.reason); assert.equal(r.runningRunId, outcome.runningRunId);
      assert.equal(r.startedAt, T0);
      const [started, finished] = rowsOf(s.ledgerPath);
      assert.deepEqual([started.phase, finished.phase], ["started", "finished"]);
      assert.equal(finished.outcome, outcome.outcome); assert.equal(finished.reason, outcome.reason); assert.equal(finished.runningRunId, outcome.runningRunId);
      assert.deepEqual(s.jobs.history({}), [r]);
    });
  }

  it("times come from the injected clock: startedAt before the handler, finishedAt after it, durationMs the difference", async () => {
    const s = setup(dirs);
    s.jobs.register(scriptedHandler({ run: async () => { await s.clock.advance(1500); return { outcome: "completed", detail: null }; } }).handler);
    const { record } = await s.jobs.run("test.job", {}, { trigger: "manual" });
    assert.equal(record.startedAt, T0); assert.equal(record.finishedAt, T0 + 1500); assert.equal(record.durationMs, 1500);
  });

  it("a clock that steps backwards never yields a negative duration", async () => {
    const s = setup(dirs);
    s.jobs.register(scriptedHandler({ run: async () => { await s.clock.advance(-5000); return { outcome: "completed", detail: null }; } }).handler);
    const { record } = await s.jobs.run("test.job", {}, { trigger: "manual" });
    assert.equal(record.durationMs, 0);
  });

  it("every trigger is stored as given", async () => {
    const s = setup(dirs);
    s.jobs.register(scriptedHandler().handler);
    for (const trigger of ["cron", "manual", "harness"] as const) assert.equal((await s.jobs.run("test.job", {}, { trigger })).record.trigger, trigger);
    assert.deepEqual(s.jobs.history({}).map((r) => r.trigger), ["harness", "manual", "cron"]);
  });

  it("the handler's context carries the run id of the record, the trigger, and the caller's signal", async () => {
    const s = setup(dirs); const h = scriptedHandler(); s.jobs.register(h.handler);
    const ac = new AbortController();
    const { record } = await s.jobs.run("test.job", {}, { trigger: "manual", signal: ac.signal });
    assert.equal(h.calls[0]!.ctx.runId, record.runId); assert.equal(h.calls[0]!.ctx.trigger, "manual"); assert.equal(h.calls[0]!.ctx.signal, ac.signal);
  });

  it("without a caller signal the handler gets a live signal that is not aborted", async () => {
    const s = setup(dirs); const h = scriptedHandler(); s.jobs.register(h.handler);
    await s.jobs.run("test.job", {}, { trigger: "harness" });
    assert.ok(h.calls[0]!.ctx.signal instanceof AbortSignal); assert.equal(h.calls[0]!.ctx.signal.aborted, false);
  });

  it("a handler that honours an abort stores what it reports; the module does not override a cancelled run's outcome", async () => {
    const s = setup(dirs);
    s.jobs.register(scriptedHandler({ run: async (_a, ctx) => (ctx.signal.aborted ? { outcome: "abandoned", reason: "cancelled", detail: null } : { outcome: "completed", detail: null }) }).handler);
    const ac = new AbortController(); ac.abort();
    assert.equal((await s.jobs.run("test.job", {}, { trigger: "manual", signal: ac.signal })).record.outcome, "abandoned");
    assert.equal((await s.jobs.run("test.job", {}, { trigger: "manual" })).record.outcome, "completed");
  });

  it("run ids are unique across runs", async () => {
    const s = setup(dirs); s.jobs.register(scriptedHandler().handler);
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add((await s.jobs.run("test.job", {}, { trigger: "manual" })).record.runId);
    assert.equal(ids.size, 50);
  });
});

describe("system-jobs run: failures", () => {
  it("a handler that throws is stored as failed/exception, onFailed hears of it, and the original error is rethrown", async () => {
    const s = setup(dirs); const boom = new Error("boom");
    s.jobs.register(scriptedHandler({ run: async () => { await s.clock.advance(40); throw boom; } }).handler);
    await assert.rejects(s.jobs.run("test.job", { a: 1 }, { trigger: "manual" }), (e: unknown) => e === boom);
    const [r] = s.jobs.history({});
    assert.equal(r!.outcome, "failed"); assert.equal(r!.reason, "exception"); assert.equal(r!.durationMs, 40); assert.deepEqual(r!.args, { a: 1 });
    assert.equal(s.failed.length, 1);
    assert.deepEqual({ runId: s.failed[0]!.runId, job: s.failed[0]!.job, reason: s.failed[0]!.reason }, { runId: r!.runId, job: "test.job", reason: "exception" });
  });

  it("onFailed is told for a returned failure too, and only for failures", async () => {
    const s = setup(dirs); let outcome: SystemJobOutcome = { outcome: "completed", detail: null };
    s.jobs.register(scriptedHandler({ run: async () => outcome }).handler);
    for (const o of ["completed", "skipped", "incomplete", "abandoned"] as const) { outcome = { outcome: o, reason: "x", detail: null }; await s.jobs.run("test.job", {}, { trigger: "manual" }); }
    assert.equal(s.failed.length, 0);
    outcome = { outcome: "failed", reason: "network", detail: null };
    const { record } = await s.jobs.run("test.job", {}, { trigger: "manual" });
    const told: Setup["failed"] = s.failed;
    assert.equal(told.length, 1); assert.equal(told[0]!.runId, record.runId); assert.equal(told[0]!.reason, "network");
  });

  it("an onFailed that throws never breaks the run: the result is returned, or the original error is the one thrown", async () => {
    const s = setup(dirs, { onFailed: () => { throw new Error("notice broke"); } });
    let mode: "return" | "throw" = "return"; const boom = new Error("job error");
    s.jobs.register(scriptedHandler({ run: async () => { if (mode === "throw") throw boom; return { outcome: "failed", reason: "x", detail: 7 }; } }).handler);
    const res = await s.jobs.run("test.job", {}, { trigger: "manual" });
    assert.equal(res.record.outcome, "failed"); assert.equal(res.detail, 7);
    mode = "throw";
    await assert.rejects(s.jobs.run("test.job", {}, { trigger: "manual" }), (e: unknown) => e === boom);
    assert.equal(s.jobs.history({}).length, 2);
  });

  it("a failing run does not block the next run of the same job", async () => {
    const s = setup(dirs); let n = 0;
    s.jobs.register(scriptedHandler({ run: async () => { if (++n === 1) throw new Error("first fails"); return { outcome: "completed", detail: null }; } }).handler);
    await assert.rejects(s.jobs.run("test.job", {}, { trigger: "manual" }));
    assert.equal((await s.jobs.run("test.job", {}, { trigger: "manual" })).record.outcome, "completed");
    assert.deepEqual(s.jobs.history({}).map((r) => r.outcome), ["completed", "failed"]);
  });

  it("an error with a non-Error value is rethrown as it is", async () => {
    const s = setup(dirs);
    s.jobs.register(scriptedHandler({ run: async () => { throw "plain string"; } }).handler);
    await assert.rejects(s.jobs.run("test.job", {}, { trigger: "manual" }), (e: unknown) => e === "plain string");
    assert.equal(s.jobs.history({})[0]!.reason, "exception");
  });

  it("when the ledger cannot be secured the run is refused before the handler starts (no job without its row)", async () => {
    const s = setup(dirs, { securePath: () => ({ applied: false }) });
    const h = scriptedHandler(); s.jobs.register(h.handler);
    await assert.rejects(s.jobs.run("test.job", {}, { trigger: "manual" }), /securePath failed to apply permissions/);
    assert.equal(h.calls.length, 0);
  });
});

describe("system-jobs run: concurrency", () => {
  // docs (model-discovery-design §2.3): `singleton` is declared in the registry; for models.scan it is enforced per provider
  // by the discovery service (§2.9), which answers skipped/already_running with the running run's id.
  it("characterization: Ist-Verhalten, nicht spezifiziert: the registry itself does not serialize runs of one job; both start, with distinct run ids", async () => {
    const s = setup(dirs); const releases: (() => void)[] = [];
    const h = scriptedHandler({ run: () => new Promise((r) => { releases.push(() => r({ outcome: "completed", detail: null })); }) });
    s.jobs.register(h.handler);
    const a = s.jobs.run("test.job", {}, { trigger: "manual" }); const b = s.jobs.run("test.job", {}, { trigger: "cron" });
    await new Promise((r) => setImmediate(r));
    assert.equal(h.calls.length, 2, "both handlers are running at once");
    assert.notEqual(h.calls[0]!.ctx.runId, h.calls[1]!.ctx.runId);
    for (const r of releases) r();
    const [ra, rb] = await Promise.all([a, b]);
    assert.notEqual(ra.record.runId, rb.record.runId); assert.equal(s.jobs.history({}).length, 2);
  });

  it("a handler can enforce the singleton with runningRunId: the skipped run points at the run that holds it, and both are in the history", async () => {
    const s = setup(dirs); let holder: string | null = null; let release!: () => void;
    s.jobs.register(scriptedHandler({
      run: (_a, ctx) => {
        if (holder !== null) return Promise.resolve({ outcome: "skipped", reason: "already_running", runningRunId: holder, detail: null } as SystemJobOutcome);
        holder = ctx.runId;
        return new Promise((r) => { release = () => { holder = null; r({ outcome: "completed", detail: null }); }; });
      },
    }).handler);
    const first = s.jobs.run("test.job", {}, { trigger: "manual" });
    await new Promise((r) => setImmediate(r));
    const second = await s.jobs.run("test.job", {}, { trigger: "manual" });
    assert.equal(second.record.outcome, "skipped"); assert.equal(second.record.reason, "already_running");
    release(); const firstRes = await first;
    assert.equal(second.record.runningRunId, firstRes.record.runId);
    assert.deepEqual(s.jobs.history({}).map((r) => r.outcome), ["skipped", "completed"]);
  });

  it("different jobs run side by side", async () => {
    const s = setup(dirs); const releases: (() => void)[] = [];
    const mk = (name: string) => scriptedHandler({ name, run: () => new Promise((r) => { releases.push(() => r({ outcome: "completed", detail: null })); }) });
    const a = mk("a"), b = mk("b"); s.jobs.register(a.handler); s.jobs.register(b.handler);
    const ra = s.jobs.run("a", {}, { trigger: "manual" }), rb = s.jobs.run("b", {}, { trigger: "manual" });
    await new Promise((r) => setImmediate(r));
    assert.equal(a.calls.length + b.calls.length, 2);
    for (const r of releases) r(); await Promise.all([ra, rb]);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert: a run in flight is not listed in the history until it has finished, and then appears once", async () => {
    const s = setup(dirs); let release!: () => void;
    s.jobs.register(scriptedHandler({ run: () => new Promise((r) => { release = () => r({ outcome: "completed", detail: null }); }) }).handler);
    const p = s.jobs.run("test.job", {}, { trigger: "manual" });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(s.jobs.history({}), []);
    release(); const { record } = await p;
    assert.deepEqual(s.jobs.history({}), [record]);
  });
});
