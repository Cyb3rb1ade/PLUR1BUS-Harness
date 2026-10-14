// system-jobs audit (c05): ledger faults must not lose a finished run, clock steps back, log hygiene, corrupt rows, args aliasing.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SystemJobsLedger } from "../../src/system-jobs/ledger.ts";
import { scriptedHandler, setup, T0, useTempDirs, gap } from "./helpers.ts";

const dirs = useTempDirs();

describe("system-jobs audit: ledger faults", () => {
  it("a ledger that fails when the finished row is written does not lose the result or run the handler's outcome through 'failed'", async () => {
    const s = setup(dirs); const h = scriptedHandler({ run: async () => ({ outcome: "completed", detail: { n: 1 } }) });
    s.jobs.register(h.handler);
    // The started row is written; then appends start failing.
    const orig = h.handler.run;
    h.handler.run = async (a, c) => { const r = await orig(a, c); rmAndBlock(s.ledgerPath); return r; };
    const res = await s.jobs.run("test.job", {}, { trigger: "manual" });
    assert.equal(res.record.outcome, "completed");
    assert.deepEqual(res.detail, { n: 1 });
    assert.deepEqual(s.failed, [], "a completed job must not raise a job-failed notice because the ledger broke");
    assert.ok(s.warnings.some((w) => /ledger/.test(w)), "the ledger fault is logged");
  });

  it("a ledger that fails while recording a handler error does not mask the handler's error", async () => {
    const s = setup(dirs); const boom = new Error("job error");
    const h = scriptedHandler({ run: async () => { rmAndBlock(s.ledgerPath); throw boom; } });
    s.jobs.register(h.handler);
    await assert.rejects(s.jobs.run("test.job", {}, { trigger: "manual" }), (e: unknown) => e === boom);
    assert.equal(s.failed.length, 1, "the failure is still announced");
  });
});

function rmAndBlock(p: string): void {
  // Make every further append fail: the ledger path becomes a directory (openSync "a" -> EISDIR).
  rmSync(p, { force: true }); mkdirSync(p);
}

describe("system-jobs audit: system clock steps backwards", () => {
  it("finishedAt is never before startedAt, so the record sorts and filters (since) consistently", async () => {
    const s = setup(dirs);
    s.jobs.register(scriptedHandler({ run: async () => { s.clock.advance(-3_600_000); return { outcome: "completed", detail: null }; } }).handler);
    const { record } = await s.jobs.run("test.job", {}, { trigger: "cron" });
    assert.equal(record.startedAt, T0);
    assert.ok(record.finishedAt >= record.startedAt, `finishedAt ${record.finishedAt} < startedAt ${record.startedAt}`);
    assert.equal(record.durationMs, record.finishedAt - record.startedAt);
    assert.deepEqual(s.jobs.history({ since: T0 }), [record]);
  });
  it("the same holds for a run that throws", async () => {
    const s = setup(dirs);
    s.jobs.register(scriptedHandler({ run: async () => { s.clock.advance(-1000); throw new Error("x"); } }).handler);
    await assert.rejects(s.jobs.run("test.job", {}, { trigger: "cron" }));
    const [r] = s.jobs.history({});
    assert.ok(r!.finishedAt >= r!.startedAt);
  });
});

describe("system-jobs audit: ledger reading", () => {
  const mk = () => {
    const dir = dirs.make(); const file = path.join(dir, "ledger.jsonl"); const warnings: { m: string; f?: object }[] = [];
    const ledger = new SystemJobsLedger({ ledgerPath: file, securePath: () => ({ applied: true }), logger: { warn: (m, f) => { warnings.push({ m, ...(f ? { f } : {}) }); } } });
    return { file, ledger, warnings };
  };
  it("a corrupt line is not copied into the log (it can hold run arguments)", () => {
    const { file, ledger, warnings } = mk();
    const secretish = "PRIVATE-ARG-VALUE-123";
    writeFileSync(file, `{"v":1,"phase":"started","runId":"a","args":{"k":"${secretish}"` + "\n");
    ledger.readAll(new Set());
    assert.ok(warnings.length > 0);
    assert.ok(!JSON.stringify(warnings).includes(secretish), "warning leaked ledger content");
  });
  it("a corrupt entry (valid JSON, version and run id) is not copied into the log either", () => {
    const { file, ledger, warnings } = mk();
    writeFileSync(file, JSON.stringify({ v: 1, runId: 5, args: { k: "PRIVATE-ARG-VALUE-123" } }) + "\n");
    ledger.readAll(new Set());
    assert.ok(!JSON.stringify(warnings).includes("PRIVATE-ARG-VALUE-123"));
  });
  it("a finished row with an unknown outcome or missing fields is skipped with a warning, not returned as a record", () => {
    const { file, ledger, warnings } = mk();
    const good = { v: 1, phase: "finished", runId: "g", job: "j", trigger: "cron", startedAt: 1, finishedAt: 2, durationMs: 1, outcome: "completed", attempt: 1 };
    const rows = [
      { ...good, runId: "bad1", outcome: "bogus" },
      { ...good, runId: "bad2", job: undefined },
      { ...good, runId: "bad3", finishedAt: "yesterday" },
      good,
    ];
    writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const out = ledger.readAll(new Set());
    assert.deepEqual(out.map((r) => r.runId), ["g"]);
    assert.ok(warnings.length >= 3);
  });
});

describe("system-jobs audit: args aliasing", () => {
  it("a handler that mutates its args cannot change what the record and the finished row say was run", async () => {
    const s = setup(dirs);
    s.jobs.register(scriptedHandler({ validateArgs: () => ({ provider: "p1" }), run: async (args) => { args.provider = "changed"; args.extra = 1; return { outcome: "completed", detail: null }; } }).handler);
    const { record } = await s.jobs.run("test.job", {}, { trigger: "manual" });
    assert.deepEqual(record.args, { provider: "p1" });
    const rows = readFileSync(s.ledgerPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((r) => r.args), [{ provider: "p1" }, { provider: "p1" }]);
  });
});

describe("system-jobs audit: overlap of one job", () => {
  // The registry declares `singleton` but only the handler enforces it (models.scan: per provider, in discovery). Serialising
  // here would also serialise different providers, and contradicts the characterization test in run.test.ts.
  it.todo(gap("run", "a second concurrent run of a singleton job without handler-side locking is skipped with already_running", "both handlers run at once"));
});
