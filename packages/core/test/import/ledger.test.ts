// core/import ledger.ts (docs/import.md §5.2 idempotency keys, §5.3 resumability): the key functions and the ImportLedger file.
// The ledger is the proof a resumed run uses to skip finished work and the proof rollback uses to know what a run created, so the
// properties are: one JSON object per line, appended and fsynced before record() returns, a torn last line repaired by the next
// append, a corrupt line counted but never fatal on load, and a failed append never remembered as done.
import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs, { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import {
  ImportLedger, agentIdempotencyKey, cardIdempotencyKey, channelIdempotencyKey, cronIdempotencyKey, fileIdempotencyKey,
  memoryBatchIdempotencyKey, storeIdempotencyKey, type LedgerEntry,
} from "../../src/import/ledger.ts";
import { mulberry32, useTempDirs } from "./helpers.ts";

const tmpDir = useTempDirs();
const FIXED = () => new Date("2026-10-13T12:00:00.000Z");
/** Mocks of node:fs only reach the ledger through the ESM export sync; restore both explicitly, inside the test. */
const restore = (t: TestContext) => { t.mock.restoreAll(); syncBuiltinESMExports(); };
const lines = (file: string) => readFileSync(file, "utf8").split("\n");

describe("idempotency keys", () => {
  // Expected digests were computed with the sha256sum tool (first 16 hex characters of the digest of the quoted input).
  it("agent and file keys are the documented plain concatenations", () => {
    assert.equal(agentIdempotencyKey("openclaw", "alpha"), "agent:openclaw:alpha");
    assert.equal(agentIdempotencyKey("hermes", "work"), "agent:hermes:work");
    assert.equal(fileIdempotencyKey("alpha", "SOUL.md", "ab12"), "file:alpha:SOUL.md:ab12");
  });

  it("memory batch key is the plain concatenation", () => assert.equal(memoryBatchIdempotencyKey("alpha", 3, "deadbeef"), "memory:alpha:3:deadbeef"));

  it("store key: store:<first 16 hex of sha256 of the source path> (docs/import.md §5.2)", () => {
    assert.equal(storeIdempotencyKey("/home/u/.openclaw/memory/lancedb"), "store:a6a9532b9990575a");
    assert.notEqual(storeIdempotencyKey("/home/u/.openclaw/memory/lancedb/"), storeIdempotencyKey("/home/u/.openclaw/memory/lancedb"), "the path is hashed as given (the caller resolves it)");
  });

  it("cron key: cron:<job id>:<first 16 hex of sha256 of the schedule>", () => {
    assert.equal(cronIdempotencyKey("nightly", "0 3 * * *"), "cron:nightly:51c662a2b4ac1c6b");
    assert.notEqual(cronIdempotencyKey("nightly", "0 3 * * *"), cronIdempotencyKey("nightly", "0 4 * * *"), "a changed schedule is a different job");
    assert.notEqual(cronIdempotencyKey("a", "0 3 * * *"), cronIdempotencyKey("b", "0 3 * * *"));
  });

  it("channel key: channel:<platform>:<first 16 hex of sha256 of the sorted, comma-joined entries>", () => {
    assert.equal(channelIdempotencyKey("telegram", ["b", "a"]), "channel:telegram:1eb7c54d52831bbf");
    assert.equal(channelIdempotencyKey("telegram", []), "channel:telegram:e3b0c44298fc1c14", "an empty list hashes the empty string");
  });

  it("channel key does not depend on the order of the entries and does not change the caller's array (seeded permutations)", () => {
    const SEED = 0x5ca1e;
    const rnd = mulberry32(SEED);
    for (let i = 0; i < 100; i++) {
      const entries = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => rnd().toString(16).slice(2, 10));
      const shuffled = entries.slice().sort(() => rnd() - 0.5);
      const copy = shuffled.slice();
      assert.equal(channelIdempotencyKey("matrix", shuffled), channelIdempotencyKey("matrix", entries), `seed=0x${SEED.toString(16)} case=${i}`);
      assert.deepEqual(shuffled, copy, "the input array is not sorted in place");
    }
  });

  it("channel key differs by platform and by content", () => {
    assert.notEqual(channelIdempotencyKey("telegram", ["a"]), channelIdempotencyKey("discord", ["a"]));
    assert.notEqual(channelIdempotencyKey("telegram", ["a"]), channelIdempotencyKey("telegram", ["a", "b"]));
    assert.notEqual(channelIdempotencyKey("telegram", ["a"]), channelIdempotencyKey("telegram", ["a", "a"]), "duplicates are not collapsed");
  });

  it("card key: <source type>:<profile>:<source file>:<first 16 hex of sha256 of the trimmed text> (docs/import.md §5.2); never contains a run id", () => {
    assert.equal(cardIdempotencyKey("hermes", "default", "MEMORY.md", "remember the milk"), "hermes:default:MEMORY.md:0057061a4f16934b");
    assert.equal(cardIdempotencyKey("hermes", "default", "MEMORY.md", "  remember the milk \n"), "hermes:default:MEMORY.md:0057061a4f16934b", "surrounding whitespace does not matter");
    assert.notEqual(cardIdempotencyKey("hermes", "default", "MEMORY.md", "remember  the milk"), cardIdempotencyKey("hermes", "default", "MEMORY.md", "remember the milk"), "inner whitespace does");
    assert.notEqual(cardIdempotencyKey("hermes", "work", "MEMORY.md", "x"), cardIdempotencyKey("hermes", "default", "MEMORY.md", "x"));
    assert.notEqual(cardIdempotencyKey("hermes", "default", "USER.md", "x"), cardIdempotencyKey("hermes", "default", "MEMORY.md", "x"));
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - parts are joined with ':' unescaped, so ids that contain ':' can collide", () => {
    assert.equal(agentIdempotencyKey("openclaw", "a:b"), agentIdempotencyKey("openclaw:a", "b"));
    assert.equal(fileIdempotencyKey("a:b", "c", "s"), fileIdempotencyKey("a", "b:c", "s"));
    assert.equal(channelIdempotencyKey("t", ["a,b"]), channelIdempotencyKey("t", ["a", "b"]), "an entry containing ',' equals two entries");
    assert.equal(memoryBatchIdempotencyKey("a:1", 2, "h"), memoryBatchIdempotencyKey("a", 1, "2:h"));
  });
});

describe("ImportLedger: loading", () => {
  it("a missing file is an empty ledger and is not created by loading", () => {
    const file = path.join(tmpDir(), "imports", "r1", "ledger.jsonl");
    const l = new ImportLedger(file, "r1");
    assert.deepEqual([l.entries().length, l.corruptLineCount, l.has("x"), l.get("x"), existsSync(file)], [0, 0, false, undefined, false]);
    assert.deepEqual([l.filePath, l.runId], [file, "r1"]);
  });

  const good = (key: string, extra: Record<string, unknown> = {}) => JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", runId: "old", entity: "file", idempotencyKey: key, action: "created", ...extra });

  it("loads every valid line, keeps the entries' own run ids, ignores blank lines and tolerates CRLF", () => {
    const file = path.join(tmpDir(), "ledger.jsonl");
    writeFileSync(file, `${good("k1")}\r\n\n   \n${good("k2", { action: "skipped" })}\n`);
    const l = new ImportLedger(file, "new-run");
    assert.deepEqual(l.entries().map((e) => [e.idempotencyKey, e.runId, e.action]), [["k1", "old", "created"], ["k2", "old", "skipped"]]);
    assert.equal(l.corruptLineCount, 0);
    assert.equal(l.get("k2")?.action, "skipped");
  });

  it("counts lines that are not ledger entries and keeps loading: broken JSON, missing key, missing entity, and non-object JSON", () => {
    const file = path.join(tmpDir(), "ledger.jsonl");
    writeFileSync(file, [
      good("k1"), "{not json", JSON.stringify({ entity: "file", action: "created" }), JSON.stringify({ idempotencyKey: "no-entity" }),
      "null", "5", "\"a string\"", "[]", JSON.stringify({ idempotencyKey: 7, entity: "file" }), good("k2"),
    ].join("\n") + "\n");
    const l = new ImportLedger(file, "r");
    assert.deepEqual(l.entries().map((e) => e.idempotencyKey), ["k1", "k2"]);
    assert.equal(l.corruptLineCount, 8);
  });

  it("when a key appears twice the later line wins for get()/has(), and entries() keeps both in file order", () => {
    const file = path.join(tmpDir(), "ledger.jsonl");
    writeFileSync(file, `${good("k", { action: "created" })}\n${good("other")}\n${good("k", { action: "replace" })}\n`);
    const l = new ImportLedger(file, "r");
    assert.equal(l.get("k")?.action, "replace");
    assert.deepEqual(l.entries().map((e) => e.action), ["created", "created", "replace"]);
  });

  it("an unreadable ledger (a directory in its place) counts as one corrupt line instead of throwing", () => {
    const d = tmpDir();
    fs.mkdirSync(path.join(d, "ledger.jsonl"));
    const l = new ImportLedger(path.join(d, "ledger.jsonl"), "r");
    assert.deepEqual([l.entries().length, l.corruptLineCount], [0, 1]);
  });

  it("a torn last line (a crash in the middle of an append) is counted as corrupt, the lines before it load", () => {
    const file = path.join(tmpDir(), "ledger.jsonl");
    writeFileSync(file, `${good("k1")}\n${good("k2").slice(0, 25)}`);
    const l = new ImportLedger(file, "r");
    assert.deepEqual([l.entries().map((e) => e.idempotencyKey), l.corruptLineCount], [["k1"], 1]);
  });
});

describe("ImportLedger: record()", () => {
  it("appends one JSON line per record, newline-terminated, and returns the stored entry", () => {
    const file = path.join(tmpDir(), "ledger.jsonl");
    const l = new ImportLedger(file, "run-7");
    const e = l.record({ entity: "agent", idempotencyKey: "agent:openclaw:alpha", action: "created", sourceRef: "agents/alpha", targetRef: "agents/alpha", now: FIXED });
    assert.deepEqual(e, { ts: "2026-10-13T12:00:00.000Z", runId: "run-7", entity: "agent", idempotencyKey: "agent:openclaw:alpha", action: "created", sourceRef: "agents/alpha", targetRef: "agents/alpha", sha256: null, reason: null, details: undefined });
    const text = readFileSync(file, "utf8");
    assert.ok(text.endsWith("\n") && text.split("\n").length === 2);
    assert.deepEqual(JSON.parse(text), { ts: "2026-10-13T12:00:00.000Z", runId: "run-7", entity: "agent", idempotencyKey: "agent:openclaw:alpha", action: "created", sourceRef: "agents/alpha", targetRef: "agents/alpha", sha256: null, reason: null });
    assert.ok(!("now" in JSON.parse(text)), "the injected clock is not persisted");
  });

  it("stamps the ledger's run id and the clock's time, keeps sha256, reason and details, and drops undefined fields", () => {
    const file = path.join(tmpDir(), "ledger.jsonl");
    const l = new ImportLedger(file, "run-8");
    l.record({ entity: "file", idempotencyKey: "k", action: "rename", sha256: "ab".repeat(32), reason: "conflict", details: { n: 2, nested: { ok: true } }, now: FIXED });
    const stored = JSON.parse(lines(file)[0]!);
    assert.deepEqual(stored, { ts: "2026-10-13T12:00:00.000Z", runId: "run-8", entity: "file", idempotencyKey: "k", action: "rename", sha256: "ab".repeat(32), reason: "conflict", details: { n: 2, nested: { ok: true } } });
  });

  it("makes the entry visible through has()/get()/entries() and a fresh ledger on the same file sees the same entries", () => {
    const file = path.join(tmpDir(), "ledger.jsonl");
    const l = new ImportLedger(file, "r");
    l.record({ entity: "file", idempotencyKey: "k1", action: "created", now: FIXED });
    l.record({ entity: "cron", idempotencyKey: "k2", action: "deferred", now: FIXED });
    assert.deepEqual([l.has("k1"), l.has("k2"), l.has("k3"), l.entries().length], [true, true, false, 2]);
    const again = new ImportLedger(file, "r");
    assert.deepEqual(again.entries(), l.entries().map((e) => JSON.parse(JSON.stringify(e))));
    assert.equal(again.corruptLineCount, 0);
  });

  it("creates the directory chain; on POSIX the file is 0o600 and a directory it creates is 0o700", { skip: process.platform === "win32" ? "POSIX modes" : undefined }, () => {
    const d = tmpDir();
    const file = path.join(d, "imports", "r1", "ledger.jsonl");
    new ImportLedger(file, "r1").record({ entity: "system", idempotencyKey: "k", action: "created", now: FIXED });
    const umask = process.umask();
    assert.equal(statSync(file).mode & 0o777, 0o600 & ~umask);
    assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700 & ~umask);
  });

  it("one entry stays one line whatever the text: newlines, U+2028, quotes and a lone surrogate in reason and details", () => {
    const file = path.join(tmpDir(), "ledger.jsonl");
    const l = new ImportLedger(file, "r");
    const nasty = "line1\nline2\r\n  \"quoted\" \\ back \ud800 end";
    l.record({ entity: "file", idempotencyKey: "k", action: "skipped", reason: nasty, details: { nasty, [nasty]: 1 }, now: FIXED });
    l.record({ entity: "file", idempotencyKey: "k2", action: "skipped", now: FIXED });
    const raw = lines(file);
    assert.equal(raw.length, 3, "two entries and the final empty string");
    const reloaded = new ImportLedger(file, "r");
    assert.equal(reloaded.corruptLineCount, 0);
    assert.equal(reloaded.get("k")?.reason, nasty);
  });

  it("appends to existing content without touching it", () => {
    const file = path.join(tmpDir(), "ledger.jsonl");
    const first = JSON.stringify({ ts: "t", runId: "r", entity: "file", idempotencyKey: "old", action: "created" }) + "\n";
    writeFileSync(file, first);
    new ImportLedger(file, "r").record({ entity: "file", idempotencyKey: "new", action: "created", now: FIXED });
    const text = readFileSync(file, "utf8");
    assert.ok(text.startsWith(first));
    assert.equal(text.split("\n").length, 3);
  });

  it("writes, then fsyncs, then closes the same descriptor before it returns (the entry is durable when record() returns)", (t) => {
    const file = path.join(tmpDir(), "ledger.jsonl");
    const l = new ImportLedger(file, "r");
    const events: string[] = [];
    const rw = fs.writeSync, rf = fs.fsyncSync, rc = fs.closeSync;
    t.mock.method(fs, "writeSync", (fd: number, ...a: unknown[]) => { events.push(`write:${fd}`); return (rw as (...x: unknown[]) => number)(fd, ...a); });
    t.mock.method(fs, "fsyncSync", (fd: number) => { events.push(`fsync:${fd}`); return rf(fd); });
    t.mock.method(fs, "closeSync", (fd: number) => { events.push(`close:${fd}`); return rc(fd); });
    syncBuiltinESMExports();
    try { l.record({ entity: "file", idempotencyKey: "k", action: "created", now: FIXED }); } finally { restore(t); }
    const fd = events[0]!.split(":")[1];
    assert.deepEqual(events, [`write:${fd}`, `fsync:${fd}`, `close:${fd}`]);
  });

  it("a failed append is not remembered and releases the descriptor; the next record works", (t) => {
    const file = path.join(tmpDir(), "ledger.jsonl");
    const l = new ImportLedger(file, "r");
    const rw = fs.writeSync;
    let fail = true; const closed: number[] = []; const rc = fs.closeSync;
    t.mock.method(fs, "writeSync", (...a: unknown[]) => { if (fail) throw Object.assign(new Error("injected ENOSPC"), { code: "ENOSPC" }); return (rw as (...x: unknown[]) => number)(...a); });
    t.mock.method(fs, "closeSync", (fd: number) => { closed.push(fd); return rc(fd); });
    syncBuiltinESMExports();
    try { assert.throws(() => l.record({ entity: "file", idempotencyKey: "lost", action: "created", now: FIXED }), { code: "ENOSPC" }); } finally { restore(t); }
    assert.deepEqual([l.has("lost"), l.entries().length, closed.length], [false, 0, 1]);
    fail = false;
    l.record({ entity: "file", idempotencyKey: "kept", action: "created", now: FIXED });
    assert.deepEqual([l.has("lost"), l.has("kept")], [false, true]);
    assert.deepEqual(new ImportLedger(file, "r").entries().map((e) => e.idempotencyKey), ["kept"]);
  });

  it("a failed fsync is not remembered either (the entry may be on disk, but the run must not rely on it)", (t) => {
    const file = path.join(tmpDir(), "ledger.jsonl");
    const l = new ImportLedger(file, "r");
    t.mock.method(fs, "fsyncSync", () => { throw Object.assign(new Error("injected EIO"), { code: "EIO" }); });
    syncBuiltinESMExports();
    try { assert.throws(() => l.record({ entity: "file", idempotencyKey: "k", action: "created", now: FIXED }), { code: "EIO" }); } finally { restore(t); }
    assert.equal(l.has("k"), false);
  });
});

describe("ImportLedger: torn-line repair (docs/import.md §5.3)", () => {
  it("a file that does not end in a newline gets a newline and a repair marker before the next entry; the torn text stays a corrupt line", () => {
    const file = path.join(tmpDir(), "ledger.jsonl");
    const complete = JSON.stringify({ ts: "t", runId: "r", entity: "file", idempotencyKey: "k1", action: "created" });
    writeFileSync(file, `${complete}\n{"ts":"t","runId":"r","entity":"fi`);
    const l = new ImportLedger(file, "r");
    assert.equal(l.corruptLineCount, 1);
    l.record({ entity: "file", idempotencyKey: "k2", action: "created", now: FIXED });
    const raw = lines(file);
    assert.equal(raw.length, 5, "complete, torn, repair marker, new entry, trailing empty");
    assert.equal(raw[1], "{\"ts\":\"t\",\"runId\":\"r\",\"entity\":\"fi");
    const marker = JSON.parse(raw[2]!);
    assert.deepEqual([marker.entity, marker.action, marker.idempotencyKey, marker.runId], ["system", "repaired", "repair:torn-line", "r"]);
    assert.equal(JSON.parse(raw[3]!).idempotencyKey, "k2");
    const reloaded = new ImportLedger(file, "r");
    assert.deepEqual([reloaded.corruptLineCount, reloaded.has("k1"), reloaded.has("k2"), reloaded.has("repair:torn-line")], [1, true, true, true]);
  });

  it("after the repair the file is newline-terminated again, so a third record adds no further marker", () => {
    const file = path.join(tmpDir(), "ledger.jsonl");
    writeFileSync(file, "{\"torn");
    const l = new ImportLedger(file, "r");
    l.record({ entity: "file", idempotencyKey: "a", action: "created", now: FIXED });
    l.record({ entity: "file", idempotencyKey: "b", action: "created", now: FIXED });
    const markers = lines(file).filter((x) => x.includes("repair:torn-line"));
    assert.equal(markers.length, 1);
  });

  it("an empty existing file and a newline-terminated file get no marker", () => {
    const d = tmpDir();
    writeFileSync(path.join(d, "empty"), "");
    new ImportLedger(path.join(d, "empty"), "r").record({ entity: "file", idempotencyKey: "a", action: "created", now: FIXED });
    assert.ok(!readFileSync(path.join(d, "empty"), "utf8").includes("repair:torn-line"));
    const ok = path.join(d, "ok");
    writeFileSync(ok, JSON.stringify({ ts: "t", runId: "r", entity: "file", idempotencyKey: "x", action: "created" }) + "\n");
    new ImportLedger(ok, "r").record({ entity: "file", idempotencyKey: "a", action: "created", now: FIXED });
    assert.ok(!readFileSync(ok, "utf8").includes("repair:torn-line"));
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - a last line that is complete JSON but lacks the newline also gets a repair marker", () => {
    const file = path.join(tmpDir(), "ledger.jsonl");
    writeFileSync(file, JSON.stringify({ ts: "t", runId: "r", entity: "file", idempotencyKey: "k1", action: "created" }));
    new ImportLedger(file, "r").record({ entity: "file", idempotencyKey: "k2", action: "created", now: FIXED });
    assert.ok(readFileSync(file, "utf8").includes("repair:torn-line"));
    assert.equal(new ImportLedger(file, "r").corruptLineCount, 0);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - the repair marker is written with the real clock, not the injected one", () => {
    const file = path.join(tmpDir(), "ledger.jsonl");
    writeFileSync(file, "{\"torn");
    new ImportLedger(file, "r").record({ entity: "file", idempotencyKey: "k", action: "created", now: FIXED });
    const marker = JSON.parse(lines(file)[1]!) as LedgerEntry;
    assert.notEqual(marker.ts, "2026-10-13T12:00:00.000Z");
  });

  it("a crash simulated at every byte of a pending line: the old entries always load, the next record always yields a loadable ledger (seeded cut points)", () => {
    const SEED = 0x70a4;
    const rnd = mulberry32(SEED);
    const d = tmpDir();
    const pending = JSON.stringify({ ts: "t", runId: "r", entity: "file", idempotencyKey: "pending", action: "created", reason: "x".repeat(40) }) + "\n";
    for (let i = 0; i < 60; i++) {
      const cut = Math.floor(rnd() * (pending.length - 1)) + 1; // never the whole line, never zero bytes
      const file = path.join(d, `l${i}`);
      writeFileSync(file, JSON.stringify({ ts: "t", runId: "r", entity: "file", idempotencyKey: "done", action: "created" }) + "\n");
      appendFileSync(file, pending.slice(0, cut));
      const ctx = `seed=0x${SEED.toString(16)} case=${i} cut=${cut}`;
      const l = new ImportLedger(file, "r");
      assert.ok(l.has("done"), ctx);
      l.record({ entity: "file", idempotencyKey: "after", action: "created", now: FIXED });
      const reloaded = new ImportLedger(file, "r");
      assert.ok(reloaded.has("done") && reloaded.has("after") && !reloaded.has("pending"), ctx);
      assert.ok(reloaded.corruptLineCount <= 1, ctx);
    }
  });
});
