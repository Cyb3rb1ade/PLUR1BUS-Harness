// core/import fs-retry.ts: the retry schedule and its bounds, tested with an injected clock (no real waiting) and an injected
// platform. Documented in the file header: on Windows EPERM/EBUSY/EACCES are retried with waits of 25 ms, doubling up to 1 s,
// for 10 s in all ("totalMs in all"); on POSIX and for every other code the first error is final. The existing fs-retry.test.ts
// only asserts "grows" and "9-10 s"; the exact schedule is pinned here.
import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { copyFileRetry, cpRetry, renameRetry, retrySync, RETRY_TOTAL_MS, rmRetry } from "../../src/import/fs-retry.ts";
import { mulberry32, useTempDirs } from "./helpers.ts";

const tmpDir = useTempDirs();
const errno = (code: string) => Object.assign(new Error(`injected ${code}`), { code });
function clock() {
  let t = 1_000_000; const sleeps: number[] = [];
  return { now: () => t, sleep: (ms: number) => { sleeps.push(ms); t += ms; }, sleeps, elapsed: () => t - 1_000_000 };
}
/** Mocks of node:fs reach the module under test only through the ESM export sync; restore both explicitly, inside the test. */
const restore = (t: TestContext) => { t.mock.restoreAll(); syncBuiltinESMExports(); };
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const alwaysFails = (code: string) => { let calls = 0; return { fn: () => { calls++; throw errno(code); }, calls: () => calls }; };

describe("retrySync: schedule", () => {
  it("the total is 10 000 ms", () => assert.equal(RETRY_TOTAL_MS, 10_000));

  it("waits 25, 50, 100, 200, 400, 800, then 1000 ms each, the last one cut to the time left, and sleeps exactly 10 s in all", () => {
    const c = clock(); const f = alwaysFails("EBUSY");
    assert.throws(() => retrySync(f.fn, { platform: "win32", now: c.now, sleep: c.sleep }), { code: "EBUSY" });
    // 25+50+100+200+400+800 = 1575; 8425 ms are left: eight full seconds and a final 425 ms
    assert.deepEqual(c.sleeps, [25, 50, 100, 200, 400, 800, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 425]);
    assert.equal(sum(c.sleeps), 10_000);
    assert.equal(f.calls(), c.sleeps.length + 1, "one attempt before every wait and one after the last");
  });

  it("a custom total bounds the sleeping exactly, for totals around every step of the schedule", () => {
    for (const total of [1, 24, 25, 26, 74, 75, 76, 1575, 1576, 5000, 12_345]) {
      const c = clock(); const f = alwaysFails("EPERM");
      assert.throws(() => retrySync(f.fn, { platform: "win32", totalMs: total, now: c.now, sleep: c.sleep }), { code: "EPERM" });
      assert.equal(sum(c.sleeps), total, `totalMs=${total}: ${c.sleeps.join(",")}`);
      assert.ok(c.sleeps.every((s, i) => s > 0 && s <= Math.min(1000, 25 * 2 ** i)), `totalMs=${total}: no wait exceeds its schedule slot or 1000 ms`);
    }
  });

  it("totalMs 0 (or negative) makes the first transient error final: no sleep, one attempt", () => {
    for (const total of [0, -5]) {
      const c = clock(); const f = alwaysFails("EBUSY");
      assert.throws(() => retrySync(f.fn, { platform: "win32", totalMs: total, now: c.now, sleep: c.sleep }), { code: "EBUSY" });
      assert.deepEqual([c.sleeps, f.calls()], [[], 1], `totalMs=${total}`);
    }
  });

  it("time spent inside fn counts against the budget", () => {
    let t = 0; let calls = 0; const sleeps: number[] = [];
    const now = () => t;
    const sleep = (ms: number) => { sleeps.push(ms); t += ms; };
    const fn = () => { calls++; t += 4000; throw errno("EBUSY"); }; // every attempt itself takes 4 s
    assert.throws(() => retrySync(fn, { platform: "win32", totalMs: 10_000, now, sleep }), { code: "EBUSY" });
    // attempt 1 ends at 4000 (6000 left, wait 25), attempt 2 at 8025 (1975 left, wait 50), attempt 3 at 12075: over budget, final
    assert.deepEqual(sleeps, [25, 50]);
    assert.equal(calls, 3);
  });

  it("returns the value of the first success and sleeps once per failure before it", () => {
    for (const failures of [0, 1, 2, 5, 9]) {
      const c = clock(); let calls = 0;
      const out = retrySync(() => { if (calls++ < failures) throw errno(["EPERM", "EBUSY", "EACCES"][calls % 3]!); return { calls }; }, { platform: "win32", now: c.now, sleep: c.sleep });
      assert.deepEqual([out.calls, c.sleeps.length], [failures + 1, failures], `failures=${failures}`);
    }
  });

  it("the error that is thrown at the end is the last one, not the first", () => {
    const c = clock(); let n = 0;
    const errors: Error[] = [];
    assert.throws(() => retrySync(() => { const e = errno("EBUSY"); (e as { n?: number }).n = ++n; errors.push(e); throw e; }, { platform: "win32", now: c.now, sleep: c.sleep }), (e: unknown) => e === errors.at(-1) && errors.length > 1);
  });

  it("a different code during the retries ends them at once with that error", () => {
    const c = clock(); const codes = ["EBUSY", "EBUSY", "ENOENT", "EBUSY"]; let i = 0;
    assert.throws(() => retrySync(() => { throw errno(codes[i++]!); }, { platform: "win32", now: c.now, sleep: c.sleep }), { code: "ENOENT" });
    assert.deepEqual([c.sleeps, i], [[25, 50], 3]);
  });
});

describe("retrySync: what is retried", () => {
  it("only EPERM, EBUSY and EACCES, only on win32", () => {
    for (const platform of ["win32", "linux", "darwin", "freebsd", "aix"] as const) {
      for (const code of ["EPERM", "EBUSY", "EACCES", "ENOENT", "EEXIST", "ENOTEMPTY", "EMFILE", "EAGAIN", "EIO", "ETIMEDOUT", "EXDEV", "eperm", "EBUSY "]) {
        const c = clock(); const f = alwaysFails(code);
        assert.throws(() => retrySync(f.fn, { platform, totalMs: 100, now: c.now, sleep: c.sleep }), { code });
        const retried = platform === "win32" && ["EPERM", "EBUSY", "EACCES"].includes(code);
        assert.equal(f.calls() > 1, retried, `${platform} ${code}`);
        assert.equal(c.sleeps.length === 0, !retried, `${platform} ${code}`);
      }
    }
  });

  it("an error without a code, a string, a number and undefined are rethrown unchanged on the first attempt", () => {
    for (const thrown of [new Error("plain"), "a string", 42, undefined] as unknown[]) {
      const c = clock(); let calls = 0;
      assert.throws(() => retrySync(() => { calls++; throw thrown; }, { platform: "win32", now: c.now, sleep: c.sleep }), (e: unknown) => e === thrown || (thrown === undefined && e instanceof TypeError));
      assert.deepEqual([calls, c.sleeps.length], [1, 0]);
    }
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - throwing null or undefined surfaces as a TypeError from reading '.code', not the thrown value", () => {
    for (const thrown of [null, undefined]) {
      assert.throws(() => retrySync(() => { throw thrown; }, { platform: "win32" }), TypeError);
    }
  });

  it("the default platform is the host's: on a POSIX host a transient code is final without any option", { skip: process.platform === "win32" ? "the host retries on win32" : undefined }, () => {
    const f = alwaysFails("EBUSY");
    assert.throws(() => retrySync(f.fn), { code: "EBUSY" });
    assert.equal(f.calls(), 1);
  });

  it("the default clock and sleep work: a success on the 2nd attempt on win32 takes about the first wait (25 ms), not seconds", () => {
    let calls = 0;
    const started = performance.now();
    assert.equal(retrySync(() => { if (calls++ === 0) throw errno("EBUSY"); return "ok"; }, { platform: "win32" }), "ok");
    const took = performance.now() - started;
    // Wall-clock on purpose (the default sleep is the code under test): one real 25 ms wait. The upper bound is far above CI jitter
    // and far below the 10 s budget, so a wrong schedule (seconds) still fails.
    assert.ok(took >= 20 && took < 5_000, `${took} ms`);
  });
});

describe("the retrying fs wrappers", () => {
  it("renameRetry, copyFileRetry, cpRetry and rmRetry do the real operation", () => {
    const d = tmpDir();
    writeFileSync(path.join(d, "a"), "A");
    renameRetry(path.join(d, "a"), path.join(d, "b"));
    copyFileRetry(path.join(d, "b"), path.join(d, "c"));
    mkdirSync(path.join(d, "dir", "sub"), { recursive: true });
    writeFileSync(path.join(d, "dir", "sub", "f"), "F");
    cpRetry(path.join(d, "dir"), path.join(d, "dir2"), { recursive: true });
    rmRetry(path.join(d, "dir"), { recursive: true, force: true });
    assert.deepEqual([existsSync(path.join(d, "a")), readFileSync(path.join(d, "b"), "utf8"), readFileSync(path.join(d, "c"), "utf8"), readFileSync(path.join(d, "dir2", "sub", "f"), "utf8"), existsSync(path.join(d, "dir"))], [false, "A", "A", "F", false]);
  });

  it("a non-transient failure (missing source) is final at once, even with win32 semantics and no sleeping", () => {
    const d = tmpDir();
    const c = clock();
    const o = { platform: "win32" as const, now: c.now, sleep: c.sleep };
    assert.throws(() => renameRetry(path.join(d, "missing"), path.join(d, "x"), o), { code: "ENOENT" });
    assert.throws(() => copyFileRetry(path.join(d, "missing"), path.join(d, "x"), o), { code: "ENOENT" });
    assert.throws(() => cpRetry(path.join(d, "missing"), path.join(d, "x"), { recursive: true }, o), { code: "ENOENT" });
    assert.deepEqual(c.sleeps, []);
    assert.doesNotThrow(() => rmRetry(path.join(d, "missing"), { force: true }, o));
    assert.throws(() => rmRetry(path.join(d, "missing"), {}, o), { code: "ENOENT" });
  });

  for (const op of ["renameSync", "copyFileSync", "cpSync", "rmSync"] as const) {
    it(`${op}: two transient lock errors on win32 are waited out (25 ms, then 50 ms) and the third attempt does the real work`, (t) => {
      const d = tmpDir();
      writeFileSync(path.join(d, "src"), "payload");
      mkdirSync(path.join(d, "srcdir"));
      writeFileSync(path.join(d, "srcdir", "f"), "payload");
      const real = fs[op] as (...a: unknown[]) => unknown;
      let attempts = 0;
      t.mock.method(fs, op, (...a: unknown[]) => { if (attempts++ < 2) throw errno(attempts === 1 ? "EBUSY" : "EPERM"); return real(...a); });
      syncBuiltinESMExports();
      const c = clock(); const o = { platform: "win32" as const, now: c.now, sleep: c.sleep };
      try {
        if (op === "renameSync") renameRetry(path.join(d, "src"), path.join(d, "dst"), o);
        if (op === "copyFileSync") copyFileRetry(path.join(d, "src"), path.join(d, "dst"), o);
        if (op === "cpSync") cpRetry(path.join(d, "srcdir"), path.join(d, "dstdir"), { recursive: true }, o);
        if (op === "rmSync") rmRetry(path.join(d, "src"), {}, o);
      } finally { restore(t); }
      if (op === "renameSync") { assert.equal(readFileSync(path.join(d, "dst"), "utf8"), "payload"); assert.ok(!existsSync(path.join(d, "src"))); }
      if (op === "copyFileSync") assert.equal(readFileSync(path.join(d, "dst"), "utf8"), "payload");
      if (op === "cpSync") assert.equal(readFileSync(path.join(d, "dstdir", "f"), "utf8"), "payload");
      if (op === "rmSync") assert.ok(!existsSync(path.join(d, "src")));
      assert.deepEqual([attempts, c.sleeps], [3, [25, 50]]);
    });
  }

  it("a lock that never goes away ends with the lock error after exactly the 10 s budget, with the source untouched", (t) => {
    const d = tmpDir();
    writeFileSync(path.join(d, "src"), "payload");
    t.mock.method(fs, "renameSync", () => { throw errno("EBUSY"); });
    syncBuiltinESMExports();
    const c = clock();
    try { assert.throws(() => renameRetry(path.join(d, "src"), path.join(d, "dst"), { platform: "win32", now: c.now, sleep: c.sleep }), { code: "EBUSY" }); } finally { restore(t); }
    assert.equal(c.elapsed(), RETRY_TOTAL_MS);
    assert.equal(readFileSync(path.join(d, "src"), "utf8"), "payload");
    assert.ok(!existsSync(path.join(d, "dst")));
  });
});

describe("retrySync: random failure sequences (seeded)", () => {
  it("for random sequences of codes the number of attempts, the sleep total and the outcome follow the rules", () => {
    const SEED = 0x2e7a1;
    const rnd = mulberry32(SEED);
    const codes = ["EBUSY", "EPERM", "EACCES", "ENOENT", "EIO"];
    for (let i = 0; i < 300; i++) {
      const plan = Array.from({ length: Math.floor(rnd() * 30) }, () => codes[Math.floor(rnd() * codes.length)]!);
      const total = 1 + Math.floor(rnd() * 12_000);
      const c = clock(); let calls = 0;
      const ctx = `seed=0x${SEED.toString(16)} case=${i} total=${total} plan=${plan.join(",")}`;
      let outcome: string;
      try { outcome = retrySync(() => { const code = plan[calls++]; if (code) throw errno(code); return "ok"; }, { platform: "win32", totalMs: total, now: c.now, sleep: c.sleep }); }
      catch (e) { outcome = (e as NodeJS.ErrnoException).code!; }
      // expected, derived from the rules only: walk the plan until a non-transient code, a success, or the budget runs out
      let spent = 0, wait = 25, attempts = 0, expected = "ok";
      for (;;) {
        const code = plan[attempts++];
        if (!code) { expected = "ok"; break; }
        if (!["EBUSY", "EPERM", "EACCES"].includes(code)) { expected = code; break; }
        const left = total - spent;
        if (left <= 0) { expected = code; break; }
        spent += Math.min(wait, left); wait = Math.min(wait * 2, 1000);
      }
      assert.equal(outcome, expected, ctx);
      assert.equal(calls, attempts, ctx);
      assert.equal(c.elapsed(), spent, ctx);
      assert.ok(c.elapsed() <= total, ctx);
    }
  });
});
