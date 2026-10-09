import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireExclusiveLock } from "@plur1bus/module-api";
import { createSink } from "../../src/logs/sink.ts";

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
let root = "";
let dir = "";
beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), "p1b-sink-cov-")); dir = path.join(root, "logs"); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const ok = () => ({ applied: true as const });
const mk = (o: Partial<Parameters<typeof createSink>[0]> = {}) => createSink({ dir, role: "core", now: () => NOW, securePath: ok, ...o });
const gens = (): string[] => readdirSync(dir).filter(n => /^core\.log(\.\d+)?$/.test(n)).sort();
const setAge = (p: string, ms: number) => { const d = new Date(ms); utimesSync(p, d, d); };

describe("sink: constructor validation", () => {
  const badRoles = ["", "Core", "-x", ".x", "a b", "a/b", "audit", "audit.x", "payload", "payload.1", "x".repeat(129)];
  for (const role of badRoles) {
    it(`rejects role ${JSON.stringify(role.length > 20 ? role.slice(0, 10) + "...(" + role.length + ")" : role)}`, () => {
      assert.throws(() => mk({ role }), { name: "RangeError", message: "diagnostic role required" });
    });
  }
  for (const role of ["core", "a", "x".repeat(128), "audit2", "payloadx", "my.role_1-b", "0abc"]) {
    it(`accepts role of ${role.length} chars: ${role.slice(0, 12)}`, () => {
      assert.equal(mk({ role }).file, path.join(dir, `${role}.log`));
    });
  }
  for (const retentionDays of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    it(`rejects retentionDays ${retentionDays}`, () => {
      assert.throws(() => mk({ retentionDays }), { name: "RangeError", message: "invalid retention days" });
    });
  }
  it("rejects a log directory that is a symlink (lstat is not a directory)", () => {
    mkdirSync(root, { recursive: true });
    const real = path.join(root, "real"); mkdirSync(real);
    symlinkSync(real, dir);
    assert.throws(() => mk(), /log directory is not a directory/);
  });
  it("creates nested directories", () => {
    const nested = path.join(root, "a", "b", "c");
    const s = createSink({ dir: nested, role: "core", now: () => NOW, securePath: ok });
    s.append("x\n");
    assert.equal(readFileSync(s.file, "utf8"), "x\n");
  });
  it("fails when securing the directory is not applied", () => {
    assert.throws(() => mk({ securePath: () => ({ applied: false }) as never }), /cannot secure log path/);
  });
  it("fails when securing the file is not applied on first append", () => {
    let calls = 0;
    const s = mk({ securePath: () => (++calls <= 2 ? { applied: true } : { applied: false }) as never });
    assert.throws(() => s.append("x\n"), /cannot secure log path/);
  });
  it("uses the default secure path when none is given", () => {
    const s = createSink({ dir, role: "core", now: () => NOW });
    s.append("hello\n");
    assert.equal(readFileSync(s.file, "utf8"), "hello\n");
    if (process.platform !== "win32") assert.equal(statSync(s.file).mode & 0o777, 0o600);
  });
});

describe("sink: lock contention", () => {
  const steppingDate = (t: import("node:test").TestContext) => {
    let n = 0;
    t.mock.method(Date, "now", () => (n += 60_000));
  };
  it("throws 'log writer busy' when the writer lock is held", (t) => {
    const s = mk();
    const lock = acquireExclusiveLock(`${s.file}.writer-lock`);
    assert.ok(lock);
    try {
      steppingDate(t);
      assert.throws(() => s.append("x\n"), /log writer busy/);
      assert.throws(() => s.prune(), /log writer busy/);
    } finally { lock.release(); }
  });
  it("throws when the directory security lock is held at construction", (t) => {
    mkdirSync(dir, { recursive: true });
    const lock = acquireExclusiveLock(path.join(dir, ".directory-security-lock"));
    assert.ok(lock);
    try {
      steppingDate(t);
      assert.throws(() => mk(), /log writer busy/);
    } finally { lock.release(); }
  });
  it("retries until the lock is released and then succeeds", (t) => {
    const s = mk();
    const lock = acquireExclusiveLock(`${s.file}.writer-lock`);
    assert.ok(lock);
    let calls = 0;
    const real = Date.now.bind(Date);
    t.mock.method(Date, "now", () => { if (++calls === 3) lock.release(); return real(); });
    s.append("later\n");
    assert.equal(readFileSync(s.file, "utf8"), "later\n");
  });
});

describe("sink: setRotation", () => {
  const bad: Array<[string, { maxBytes: number; keep: number }]> = [
    ["zero maxBytes", { maxBytes: 0, keep: 1 }], ["negative maxBytes", { maxBytes: -1, keep: 1 }], ["NaN maxBytes", { maxBytes: Number.NaN, keep: 1 }],
    ["Infinity maxBytes", { maxBytes: Number.POSITIVE_INFINITY, keep: 1 }], ["zero keep", { maxBytes: 1, keep: 0 }], ["fractional keep", { maxBytes: 1, keep: 1.5 }],
    ["negative keep", { maxBytes: 1, keep: -2 }], ["NaN keep", { maxBytes: 1, keep: Number.NaN }],
  ];
  for (const [label, r] of bad) it(`rejects ${label}`, () => { assert.throws(() => mk().setRotation(r), { name: "RangeError", message: "invalid rotation" }); });
  it("a failed setRotation keeps the previous limits", () => {
    const s = mk({ maxBytes: 1000, keep: 2 });
    assert.throws(() => s.setRotation({ maxBytes: 0, keep: 9 }));
    s.append("aaaa\n"); s.append("bbbb\n");
    assert.deepEqual(gens(), ["core.log"]);
  });
  it("accepts fractional maxBytes", () => {
    const s = mk({ maxBytes: 4, keep: 1 });
    s.setRotation({ maxBytes: 2.5, keep: 1 });
    s.append("ab\n"); s.append("cd\n");
    assert.equal(readFileSync(`${s.file}.1`, "utf8"), "ab\n");
  });
});

describe("sink: append and rotation", () => {
  it("appends to an existing empty file without rotating, even if the single line exceeds maxBytes", () => {
    const s = mk({ maxBytes: 2, keep: 2 });
    writeFileSync(s.file, "");
    s.append("a long line exceeding the limit\n");
    assert.equal(readFileSync(s.file, "utf8"), "a long line exceeding the limit\n");
    assert.equal(readdirSync(dir).includes("core.log.1"), false);
  });
  it("rotates when the next line would exceed maxBytes; a line that exactly fits does not rotate", () => {
    const s = mk({ maxBytes: 6, keep: 3 });
    s.append("abc\n"); s.append("d\n");
    assert.equal(readFileSync(s.file, "utf8"), "abc\nd\n");
    s.append("e\n");
    assert.equal(readFileSync(`${s.file}.1`, "utf8"), "abc\nd\n");
    assert.equal(readFileSync(s.file, "utf8"), "e\n");
  });
  it("counts bytes, not characters (multi-byte Unicode)", () => {
    const s = mk({ maxBytes: 10, keep: 2 });
    s.append("ä€😀\n"); // 2+3+4+1 = 10 bytes
    assert.equal(readdirSync(dir).includes("core.log.1"), false);
    s.append("x\n");
    assert.equal(readFileSync(`${s.file}.1`, "utf8"), "ä€😀\n");
  });
  it("shifts the generations and drops the oldest beyond keep (gaps are tolerated)", () => {
    const s = mk({ maxBytes: 3, keep: 3 });
    writeFileSync(`${s.file}.3`, "g3\n");
    writeFileSync(`${s.file}.1`, "g1\n"); // .2 is missing: existsSync false branch
    s.append("aa\n"); s.append("bb\n");
    assert.equal(readFileSync(`${s.file}.1`, "utf8"), "aa\n");
    assert.equal(readFileSync(`${s.file}.2`, "utf8"), "g1\n");
    assert.equal(readdirSync(dir).includes("core.log.3"), false);
    assert.equal(readFileSync(s.file, "utf8"), "bb\n");
  });
  it("keep=1 deletes the previous rotated copy and renames the live file", () => {
    const s = mk({ maxBytes: 3, keep: 1 });
    writeFileSync(`${s.file}.1`, "old\n");
    s.append("aa\n"); s.append("bb\n");
    assert.equal(readFileSync(`${s.file}.1`, "utf8"), "aa\n");
    assert.deepEqual(gens(), ["core.log", "core.log.1"]);
  });
  it("rotates a file that is from a previous day even if it is small", () => {
    const s = mk({ maxBytes: 1 << 20, keep: 2 });
    writeFileSync(s.file, "yesterday\n"); setAge(s.file, NOW - DAY);
    s.append("today\n");
    assert.equal(readFileSync(`${s.file}.1`, "utf8"), "yesterday\n");
    assert.equal(readFileSync(s.file, "utf8"), "today\n");
  });
  it("does not rotate a file touched on the same UTC day", () => {
    const s = mk({ maxBytes: 1 << 20, keep: 2 });
    writeFileSync(s.file, "same\n"); setAge(s.file, Date.UTC(2026, 9, 7, 0, 0, 1));
    s.append("again\n");
    assert.equal(readFileSync(s.file, "utf8"), "same\nagain\n");
  });
  it("sets the file mtime to the injected clock", () => {
    const s = mk(); s.append("x\n");
    assert.equal(statSync(s.file).mtimeMs, NOW);
  });
  it("appends an empty line without error", () => {
    const s = mk(); s.append(""); s.append("");
    assert.equal(readFileSync(s.file, "utf8"), "");
  });
  it("refuses when the live log path is a directory", () => {
    const s = mk(); mkdirSync(s.file);
    assert.throws(() => s.append("x\n"), /log path is not a regular file/);
  });
  it("refuses to rotate when a rotated slot is a directory (keep slot)", () => {
    const s = mk({ maxBytes: 3, keep: 2 });
    s.append("aa\n");
    mkdirSync(`${s.file}.2`);
    assert.throws(() => s.append("bb\n"), /not a regular file/);
  });
  it("refuses to rotate when an intermediate slot is a directory", () => {
    const s = mk({ maxBytes: 3, keep: 3 });
    s.append("aa\n");
    mkdirSync(`${s.file}.2`);
    assert.throws(() => s.append("bb\n"), /not a regular file/);
  });
  it("re-secures the file after the file was replaced behind the sink's back", () => {
    const calls: string[] = [];
    const s = mk({ securePath: (p) => { calls.push(p); return { applied: true }; } });
    s.append("a\n");
    const before = calls.filter(p => p === s.file).length;
    rmSync(s.file); writeFileSync(s.file, "");
    s.append("b\n");
    assert.ok(calls.filter(p => p === s.file).length >= before);
    assert.equal(readFileSync(s.file, "utf8"), "b\n");
  });
});

describe("sink: prune", () => {
  const seed = (s: ReturnType<typeof mk>, names: Array<[string, number, string]>) => {
    for (const [n, age, text] of names) { const p = path.join(dir, n); writeFileSync(p, text); setAge(p, NOW - age); }
    void s;
  };
  it("removes only old rotated copies of its own role and reports the byte count", () => {
    const s = mk({ retentionDays: 7 });
    seed(s, [["core.log.1", 8 * DAY, "12345"], ["core.log.2", 30 * DAY, "123"], ["core.log.3", 6 * DAY, "keep"], ["core.log", 90 * DAY, "live"],
      ["other.log.1", 90 * DAY, "other"], ["audit.log.1", 90 * DAY, "audit"], ["payload.log.1", 90 * DAY, "payload"], ["core.log.x", 90 * DAY, "nan"],
      ["core.log.", 90 * DAY, "empty"], ["core.log.1a", 90 * DAY, "mixed"], ["core.log.1.bak", 90 * DAY, "bak"]]);
    assert.deepEqual(s.prune(), { files: 2, bytes: 8 });
    assert.deepEqual(readdirSync(dir).filter(n => !n.startsWith(".") && !n.endsWith("-lock")).sort(), ["audit.log.1", "core.log", "core.log.", "core.log.1a", "core.log.1.bak", "core.log.3", "core.log.x", "other.log.1", "payload.log.1"].sort());
  });
  it("retentionDays 0 disables pruning", () => {
    const s = mk({ retentionDays: 0 });
    seed(s, [["core.log.1", 400 * DAY, "x"]]);
    assert.deepEqual(s.prune(), { files: 0, bytes: 0 });
    assert.ok(readdirSync(dir).includes("core.log.1"));
  });
  it("default retention is 14 days (boundary: exactly 14 days is kept, a bit older is removed)", () => {
    const s = mk();
    seed(s, [["core.log.1", 14 * DAY, "a"], ["core.log.2", 14 * DAY + 1000, "b"]]);
    assert.deepEqual(s.prune(), { files: 1, bytes: 1 });
    assert.deepEqual(gens(), ["core.log.1"]);
  });
  it("skips a directory that has a rotated-copy name", () => {
    const s = mk({ retentionDays: 1 });
    mkdirSync(path.join(dir, "core.log.4")); setAge(path.join(dir, "core.log.4"), NOW - 50 * DAY);
    assert.deepEqual(s.prune(), { files: 0, bytes: 0 });
    assert.ok(readdirSync(dir).includes("core.log.4"));
  });
  it("an empty directory prunes nothing", () => {
    assert.deepEqual(mk().prune(), { files: 0, bytes: 0 });
  });
});
