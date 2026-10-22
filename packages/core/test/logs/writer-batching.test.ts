// Perf: the diagnostic writer must pay the per-file OS lock (a SQLite EXCLUSIVE transaction, ~1 ms or more) once per
// batch of queued records, not once per record (OutputLines bursts of exec / MCP stderr lines). Counted, not timed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { acquireExclusiveLock } from "@plur1bus/module-api";
import { createWriter } from "../../src/logs/writer.ts";
import { createSink } from "../../src/logs/sink.ts";
import { logsDir } from "./helpers.ts";

const source = { kind: "harness", id: "core", version: null } as const;
/** Counts lock acquisitions per lock file name; delegates to the real OS lock. */
function countingLock() {
  const counts = new Map<string, number>();
  const acquireLock = (p: string) => { const k = path.basename(p); counts.set(k, (counts.get(k) ?? 0) + 1); return acquireExclusiveLock(p); };
  return { acquireLock, writerLocks: () => counts.get("core.log.writer-lock") ?? 0, reset: () => counts.clear() };
}
const rows = (dir: string, names: string[]) => names.flatMap(n => fs.existsSync(path.join(dir, n)) ? fs.readFileSync(path.join(dir, n), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);
const burst = (w: ReturnType<typeof createWriter>, from: number, n: number) => { for (let i = 0; i < n; i++) w.write("process.output.line", { text: `line ${from + i}`, untrusted: true }, { stream: "stderr", bypassRate: true }); };
const lineNo = (r: { attrs: { text: string } }) => Number(r.attrs.text.slice(5));

describe("writer: one lock acquisition per batch of queued records", () => {
  it("a 200-line output burst takes the role lock a handful of times, not 200", () => {
    const dir = logsDir(); const c = countingLock();
    const w = createWriter({ dir, role: "core", source, timers: false, acquireLock: c.acquireLock });
    c.reset();
    burst(w, 0, 200); w.close();
    assert.ok(c.writerLocks() >= 1 && c.writerLocks() <= Math.ceil(200 / 64) + 1, `writer lock taken ${c.writerLocks()} times`);
    const got = rows(dir, ["core.log"]);
    assert.deepEqual(got.map(lineNo), Array.from({ length: 200 }, (_, i) => i), "all records, in order, none duplicated");
  });
  it("close flushes records queued below the auto-flush threshold under a single lock acquisition", () => {
    const dir = logsDir(); const c = countingLock();
    const w = createWriter({ dir, role: "core", source, timers: false, acquireLock: c.acquireLock });
    burst(w, 0, 10); c.reset(); w.close();
    assert.equal(c.writerLocks(), 1, "drain and fsync share one acquisition");
    assert.deepEqual(rows(dir, ["core.log"]).map(lineNo), Array.from({ length: 10 }, (_, i) => i));
  });
  it("an explicit flush writes and syncs the queue under one acquisition and syncs once", (t) => {
    const sync = t.mock.method(fs, "fsyncSync", fs.fsyncSync); syncBuiltinESMExports();
    const dir = logsDir(); const c = countingLock();
    const w = createWriter({ dir, role: "core", source, timers: false, acquireLock: c.acquireLock });
    try {
      burst(w, 0, 10); c.reset(); sync.mock.resetCalls();
      w.flush();
      assert.equal(c.writerLocks(), 1); assert.equal(sync.mock.callCount(), 1);
      w.flush(); assert.equal(c.writerLocks(), 1, "an idle flush takes no lock"); assert.equal(sync.mock.callCount(), 1);
    } finally { w.close(); sync.mock.restore(); syncBuiltinESMExports(); }
  });
  it("rotation inside a batch keeps order and loses nothing across the rotated files", () => {
    const dir = logsDir(); const c = countingLock();
    const w = createWriter({ dir, role: "core", source, timers: false, maxBytes: 2500, keep: 60, acquireLock: c.acquireLock });
    c.reset();
    burst(w, 0, 150); w.close();
    const names = ["core.log", ...Array.from({ length: 60 }, (_, i) => `core.log.${i + 1}`)];
    assert.ok(fs.existsSync(path.join(dir, "core.log.1")), "the batch rotated at least once");
    for (const n of names.filter(n => fs.existsSync(path.join(dir, n)))) assert.ok(fs.statSync(path.join(dir, n)).size <= 2500, `${n} stays within maxBytes`);
    const oldestFirst = [...names].reverse();
    assert.deepEqual(rows(dir, oldestFirst).map(lineNo), Array.from({ length: 150 }, (_, i) => i));
    assert.ok(c.writerLocks() <= Math.ceil(150 / 64) + 1);
  });
  it("a sink failure keeps the batch queued; the retry writes it once, in order", () => {
    const dir = logsDir(); let fail = false;
    const acquireLock = (p: string) => { if (fail && p.endsWith(".writer-lock")) throw new Error("fixture lock failure"); return acquireExclusiveLock(p); };
    const w = createWriter({ dir, role: "core", source, timers: false, acquireLock });
    try {
      fail = true;
      burst(w, 0, 100); // the auto-flush at 64 fails silently and leaves the records queued
      assert.throws(() => w.flush(), /fixture lock failure/);
      fail = false; burst(w, 100, 5); w.flush();
      assert.deepEqual(rows(dir, ["core.log"]).map(lineNo), Array.from({ length: 105 }, (_, i) => i));
    } finally { fail = false; w.close(); }
  });
});

describe("sink.appendBatch", () => {
  const mk = (o: Partial<Parameters<typeof createSink>[0]> = {}) => createSink({ dir: logsDir(), role: "core", now: Date.now, ...o });
  it("writes all lines in order under one lock and one fsync when durable", (t) => {
    const sync = t.mock.method(fs, "fsyncSync", fs.fsyncSync); syncBuiltinESMExports();
    try {
      const c = countingLock(); const s = mk({ acquireLock: c.acquireLock }); c.reset();
      const done: number[] = [];
      s.appendBatch(["a\n", "b\n", "c\n"], true, n => done.push(n));
      assert.equal(c.writerLocks(), 1); assert.equal(sync.mock.callCount(), 1);
      assert.equal(fs.readFileSync(s.file, "utf8"), "a\nb\nc\n"); assert.equal(done.reduce((a, b) => a + b, 0), 3);
    } finally { sync.mock.restore(); syncBuiltinESMExports(); }
  });
  it("append stays a single-record batch; an empty batch takes no lock", () => {
    const c = countingLock(); const s = mk({ acquireLock: c.acquireLock }); c.reset();
    s.appendBatch([], true); assert.equal(c.writerLocks(), 0);
    s.append("x\n"); assert.equal(c.writerLocks(), 1); assert.equal(fs.readFileSync(s.file, "utf8"), "x\n");
  });
  it("secures the file once per identity across a batch and splits it at the rotation limit", () => {
    const calls: string[] = [];
    const s = mk({ maxBytes: 6, keep: 3, securePath: p => { calls.push(p); return { applied: true }; } });
    s.appendBatch(["aaaa\n", "bbbb\n", "cccc\n"], false); // each line is 5 bytes: one per file
    assert.equal(fs.readFileSync(s.file, "utf8"), "cccc\n");
    assert.equal(fs.readFileSync(`${s.file}.1`, "utf8"), "bbbb\n");
    assert.equal(fs.readFileSync(`${s.file}.2`, "utf8"), "aaaa\n");
    assert.equal(calls.filter(p => p === s.file).length, 3, "three file identities, each secured once");
    s.sync();
  });
  it("reports each written chunk before a later one fails, so a retry cannot duplicate", () => {
    let budget = Infinity;
    const s = mk({ maxBytes: 6, keep: 2, securePath: () => ({ applied: budget-- > 0 }) }); const done: number[] = [];
    budget = 1; // the first file identity is secured; the second (after a rotation) is refused
    assert.throws(() => s.appendBatch(["aaaa\n", "bbbb\n", "cccc\n"], false, n => done.push(n)), /cannot secure log path/);
    assert.equal(done.reduce((a, b) => a + b, 0), 1, "only the line that reached the file is reported");
    assert.equal(fs.readFileSync(s.file + ".1", "utf8"), "aaaa\n");
    budget = Infinity; done.length = 0;
    s.appendBatch(["bbbb\n", "cccc\n"], false, n => done.push(n)); // the caller retries only what was not reported
    assert.equal(done.reduce((a, b) => a + b, 0), 2);
    s.sync();
  });
});

describe("writer: several processes share the role lock", () => {
  it("batched appends from four processes interleave only between batches: every line intact, per-process order kept", async () => {
    const { spawn } = await import("node:child_process"); const { fileURLToPath } = await import("node:url"); const dir = logsDir();
    const worker = fileURLToPath(new URL("./writer-worker.ts", import.meta.url));
    await Promise.all([0, 1000, 2000, 3000].map(base => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", "--conditions=source", "--no-warnings=ExperimentalWarning", worker, dir, String(base), "200"], { stdio: ["ignore", "ignore", "pipe"] });
      let err = ""; child.stderr.on("data", chunk => { err += String(chunk); }); child.on("error", reject); child.on("close", code => code === 0 ? resolve() : reject(new Error(err)));
    })));
    const text = fs.readFileSync(path.join(dir, "core.log"), "utf8"); assert.ok(text.endsWith("\n"));
    const got = text.split("\n").filter(Boolean).map(l => JSON.parse(l) as { attrs: { pid: number } }); // a torn line would not parse
    assert.equal(got.length, 800);
    for (const base of [0, 1000, 2000, 3000]) assert.deepEqual(got.map(r => r.attrs.pid).filter(p => p >= base && p < base + 1000), Array.from({ length: 200 }, (_, i) => base + i));
  });
});
