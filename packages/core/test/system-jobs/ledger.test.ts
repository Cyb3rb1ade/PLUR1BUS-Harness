// system-jobs ledger: append-only JSON lines, 0600/0700, fsynced, one rotated generation at 1 MiB, tolerant reads,
// and an unfinished run that is not in flight reads back as abandoned/core_stopped.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SystemJobsLedger } from "../../src/system-jobs/ledger.ts";
import { T0, useTempDirs } from "./helpers.ts";

const dirs = useTempDirs();
const MIB = 1024 * 1024;
const NONE: ReadonlySet<string> = new Set();

function make(over: { securePath?: (p: string) => unknown } = {}) {
  const dir = dirs.make(); const file = path.join(dir, "nested", "ledger.jsonl");
  const warnings: { m: string; f?: object }[] = []; const secured: string[] = [];
  const ledger = new SystemJobsLedger({ ledgerPath: file, securePath: over.securePath ?? ((p) => { secured.push(p); return { applied: true }; }), logger: { warn: (m, f) => { warnings.push({ m, ...(f ? { f } : {}) }); } } });
  return { dir, file, ledger, warnings, secured };
}
const start = (id: string, over: object = {}) => ({ runId: id, job: "j", trigger: "manual" as const, startedAt: T0, ...over });
const finish = (id: string, over: object = {}) => ({ runId: id, job: "j", trigger: "manual" as const, startedAt: T0, finishedAt: T0 + 5, durationMs: 5, outcome: "completed" as const, ...over });
const lines = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean);
/** A valid finished row of about `bytes` bytes, for filling a ledger up to the rotation size without 4000 fsyncs. */
const filler = (n: number) => JSON.stringify({ v: 1, phase: "finished", runId: `fill-${n}`, job: "fill", trigger: "cron", startedAt: T0, finishedAt: T0, durationMs: 0, outcome: "completed", attempt: 1, pad: "x".repeat(900) }) + "\n";

describe("system-jobs ledger: writing", () => {
  it("begin and finish append one JSON line each, versioned, newline-terminated", () => {
    const { ledger, file } = make();
    ledger.begin(start("r1", { args: { provider: "p" } })); ledger.finish(finish("r1", { reason: "why", runningRunId: "r0", args: { provider: "p" } }));
    const raw = readFileSync(file, "utf8");
    assert.equal(raw.endsWith("\n"), true);
    const [a, b] = lines(file).map((l) => JSON.parse(l));
    assert.deepEqual(a, { v: 1, phase: "started", runId: "r1", job: "j", trigger: "manual", startedAt: T0, args: { provider: "p" } });
    assert.deepEqual(b, { v: 1, phase: "finished", runId: "r1", job: "j", trigger: "manual", startedAt: T0, finishedAt: T0 + 5, durationMs: 5, outcome: "completed", reason: "why", runningRunId: "r0", attempt: 1, args: { provider: "p" } });
  });

  it("optional fields are absent, not null, when not given", () => {
    const { ledger, file } = make();
    ledger.begin(start("r1")); ledger.finish(finish("r1"));
    const [a, b] = lines(file).map((l) => JSON.parse(l));
    for (const k of ["args"]) assert.equal(k in a, false);
    for (const k of ["args", "reason", "runningRunId"]) assert.equal(k in b, false);
  });

  it("creates the directory (0700) and the file (0600), and secures both", () => {
    const { ledger, file, secured } = make();
    ledger.begin(start("r1"));
    assert.deepEqual(secured, [path.dirname(file), file]);
    if (process.platform !== "win32") {
      assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
      assert.equal(statSync(file).mode & 0o777, 0o600);
    }
  });

  it("secures an existing file once per ledger instance, not on every append", () => {
    const { ledger, file, secured } = make();
    mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, "");
    ledger.begin(start("r1")); ledger.begin(start("r2")); ledger.begin(start("r3"));
    assert.deepEqual(secured, [file]);
  });

  it("securePath reporting applied:false refuses the write, and nothing is appended", () => {
    const { ledger, file } = make({ securePath: () => ({ applied: false }) });
    assert.throws(() => ledger.begin(start("r1")), /securePath failed to apply permissions/);
    assert.equal(!existsSync(file) || readFileSync(file, "utf8") === "", true);
  });

  it("a securePath that returns nothing is accepted (only an explicit applied:false is a refusal)", () => {
    const { ledger, file } = make({ securePath: () => undefined });
    ledger.begin(start("r1"));
    assert.equal(lines(file).length, 1);
  });

  it("a torn last line (a crash mid-write, no newline) does not swallow the next row", () => {
    const { ledger, file, warnings } = make();
    ledger.begin(start("r1"));
    appendFileSync(file, '{"v":1,"phase":"sta');
    ledger.begin(start("r2"));
    const all = ledger.readAll(NONE);
    assert.deepEqual(all.map((r) => r.runId), ["r1", "r2"]);
    assert.ok(warnings.some((w) => w.m === "unreadable line in system jobs ledger"));
  });
});

describe("system-jobs ledger: reading", () => {
  it("no file: nothing", () => { assert.deepEqual(make().ledger.readAll(NONE), []); });

  it("a started row without a finished row, not in flight, reads as abandoned/core_stopped with zero duration and its args", () => {
    const { ledger } = make();
    ledger.begin(start("r1", { args: { provider: "p" }, trigger: "cron", startedAt: T0 + 7 }));
    assert.deepEqual(ledger.readAll(NONE), [{ runId: "r1", job: "j", kind: "system", trigger: "cron", startedAt: T0 + 7, finishedAt: T0 + 7, durationMs: 0, outcome: "abandoned", reason: "core_stopped", attempt: 1, args: { provider: "p" } }]);
  });

  it("the same unfinished run is left out while it is in flight in this process", () => {
    const { ledger } = make();
    ledger.begin(start("r1")); ledger.begin(start("r2"));
    assert.deepEqual(ledger.readAll(new Set(["r1"])).map((r) => r.runId), ["r2"]);
  });

  it("a finished row wins over its started row and keeps the order of the first sighting", () => {
    const { ledger } = make();
    ledger.begin(start("r1")); ledger.begin(start("r2")); ledger.finish(finish("r2")); ledger.finish(finish("r1", { outcome: "failed", reason: "x" }));
    const got = ledger.readAll(NONE);
    assert.deepEqual(got.map((r) => [r.runId, r.outcome]), [["r1", "failed"], ["r2", "completed"]]);
  });

  it("a finished row without a started row is still a record (the started row may have rotated away)", () => {
    const { ledger } = make();
    ledger.finish(finish("lonely"));
    assert.deepEqual(ledger.readAll(NONE).map((r) => r.runId), ["lonely"]);
  });

  it("a second finished row for one run replaces the first (the last one wins)", () => {
    const { ledger } = make();
    ledger.begin(start("r1")); ledger.finish(finish("r1", { outcome: "failed", reason: "first" })); ledger.finish(finish("r1", { outcome: "completed" }));
    const [r] = ledger.readAll(NONE);
    assert.equal(r!.outcome, "completed"); assert.equal("reason" in r!, false);
  });

  it("unreadable lines, entries of another version, entries without a run id, and unknown phases are skipped with a warning; valid rows around them survive", () => {
    const { ledger, file, warnings } = make();
    ledger.begin(start("r1")); ledger.finish(finish("r1"));
    appendFileSync(file, [
      "not json at all",
      JSON.stringify({ v: 2, phase: "finished", runId: "future" }),
      JSON.stringify({ v: 1, phase: "finished" }),
      JSON.stringify({ v: 1, phase: "finished", runId: 42 }),
      JSON.stringify(null), "[1,2]", "   ",
      JSON.stringify({ v: 1, phase: "paused", runId: "weird" }),
      "",
    ].join("\n") + "\n");
    ledger.begin(start("r2")); ledger.finish(finish("r2"));
    const got = ledger.readAll(NONE);
    assert.deepEqual(got.map((r) => r.runId), ["r1", "r2"]);
    const msgs = warnings.map((w) => w.m);
    assert.equal(msgs.filter((m) => m === "unreadable line in system jobs ledger").length, 1);
    assert.equal(msgs.filter((m) => m === "corrupt entry in system jobs ledger").length, 5);
    assert.equal(msgs.filter((m) => m === "unknown phase in system jobs ledger").length, 1);
  });

  it("a ledger path that is a directory is unreadable: a warning and no records, not a crash", () => {
    const dir = dirs.make(); const ledgerPath = path.join(dir, "ledger.jsonl"); mkdirSync(ledgerPath);
    const warnings: string[] = [];
    const ledger = new SystemJobsLedger({ ledgerPath, securePath: () => ({ applied: true }), logger: { warn: (m) => { warnings.push(m); } } });
    assert.deepEqual(ledger.readAll(NONE), []);
    assert.ok(warnings.includes("failed to read system jobs ledger"));
  });

  it("args survive the round trip with nested values and unicode", () => {
    const { ledger } = make(); const args = { provider: "p", nested: { list: [1, "två", null, true], deep: { ok: "日本語" } } };
    ledger.begin(start("r1", { args })); ledger.finish(finish("r1", { args }));
    assert.deepEqual(ledger.readAll(NONE)[0]!.args, args);
  });

  it("job names that look like object internals are plain data", () => {
    const { ledger } = make();
    for (const job of ["__proto__", "constructor", "toString"]) { ledger.begin(start(`r-${job}`, { job })); ledger.finish(finish(`r-${job}`, { job })); }
    assert.deepEqual(ledger.readAll(NONE).map((r) => r.job), ["__proto__", "constructor", "toString"]);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  it("a finished row that is valid JSON with version and run id but lacks its other fields is skipped with a warning, not turned into a record with undefined fields (c05)", () => {
    const { ledger, file, warnings } = make();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ v: 1, phase: "finished", runId: "thin" }) + "\n");
    assert.deepEqual(ledger.readAll(NONE), []);
    assert.ok(warnings.some((w) => w.m === "invalid finished entry in system jobs ledger"));
  });
});

describe("system-jobs ledger: rotation at 1 MiB", () => {
  function fill(file: string, minBytes = MIB) {
    mkdirSync(path.dirname(file), { recursive: true });
    let n = 0, size = 0; const parts: string[] = [];
    while (size < minBytes) { const l = filler(n++); parts.push(l); size += Buffer.byteLength(l); }
    writeFileSync(file, parts.join(""), { mode: 0o600 });
    return n;
  }

  it("a full file is moved to .1 and a new file starts; reading sees both, older first", () => {
    const { ledger, file } = make();
    const n = fill(file);
    ledger.begin(start("fresh"));
    assert.equal(existsSync(`${file}.1`), true);
    assert.deepEqual(lines(file).map((l) => JSON.parse(l).runId), ["fresh"]);
    const ids = ledger.readAll(new Set(["fresh"])).map((r) => r.runId);
    assert.equal(ids.length, n); assert.equal(ids[0], "fill-0"); assert.equal(ids.at(-1), `fill-${n - 1}`);
  });

  it("just under the limit does not rotate", () => {
    const { ledger, file } = make();
    mkdirSync(path.dirname(file), { recursive: true });
    let size = 0, n = 0; const parts: string[] = [];
    while (size + Buffer.byteLength(filler(n)) < MIB - 10) { const l = filler(n++); parts.push(l); size += Buffer.byteLength(l); }
    writeFileSync(file, parts.join(""), { mode: 0o600 });
    ledger.begin(start("fresh"));
    assert.equal(existsSync(`${file}.1`), false);
    assert.equal(lines(file).length, n + 1);
  });

  it("a run that started before the rotation and finished after it is still one record", () => {
    const { ledger, file } = make();
    ledger.begin(start("straddle"));
    const before = readFileSync(file, "utf8");
    fill(file); writeFileSync(file, before + readFileSync(file, "utf8")); // the started row, then enough filler to reach the limit
    ledger.finish(finish("straddle", { outcome: "failed", reason: "late" }));
    const rec = ledger.readAll(NONE).find((r) => r.runId === "straddle")!;
    assert.equal(rec.outcome, "failed"); assert.equal(rec.reason, "late");
  });

  it("the new file is secured again after a rotation", () => {
    const { ledger, file, secured } = make();
    ledger.begin(start("first"));
    const before = secured.filter((p) => p === file).length;
    writeFileSync(file, readFileSync(file, "utf8") + fillText());
    ledger.begin(start("after"));
    assert.equal(secured.filter((p) => p === file).length, before + 1);
    function fillText() { let s = "", i = 0; while (Buffer.byteLength(s) < MIB) s += filler(i++); return s; }
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert: only one rotated generation is kept, so a second rotation drops the oldest records for good", () => {
    const { ledger, file } = make();
    fill(file); ledger.begin(start("gen2"));            // first rotation: fill-* now in .1
    appendFileSync(file, Array.from({ length: 1200 }, (_, i) => filler(10_000 + i)).join(""));
    ledger.begin(start("gen3"));                        // second rotation: .1 (fill-*) is replaced by the previous current file
    const ids = ledger.readAll(new Set(["gen3"])).map((r) => r.runId);
    assert.equal(ids.includes("fill-0"), false, "the first generation is gone");
    assert.equal(ids[0], "gen2", "the second generation is kept as .1");
    assert.equal(ids.includes("fill-10000"), true);
  });
});
