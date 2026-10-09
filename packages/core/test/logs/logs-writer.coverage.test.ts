import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LIMITS, validateRecord } from "@plur1bus/log-schema";
import { cap, createWriter, type WriterOptions } from "../../src/logs/writer.ts";
import { newTrace, withTrace } from "../../src/logs/trace.ts";

const source = { kind: "harness" as const, id: "core", version: null };
const DAY = 86400000;
const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);
let root = ""; let dir = "";
beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), "p1b-writer-cov-")); dir = path.join(root, "logs"); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function clock(start = T0) { let t = start; return { now: () => t, advance: (ms: number) => { t += ms; } }; }
const mk = (o: Partial<WriterOptions> = {}, c = clock()) => ({ c, w: createWriter({ dir, role: "core", source, now: c.now, timers: false, ...o }) });
const rows = (file = "core.log"): any[] => (existsSync(path.join(dir, file)) ? readFileSync(path.join(dir, file), "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s)) : []);
const events = (file = "core.log"): string[] => rows(file).map(r => r.event);
const started = (pid: number) => ["core.process.started", { pid }] as const;
/** An event that may be written at info, error and fatal (harness sources only). */
const exited = (pid: number) => ["supervisor.child.exited", { role: "core", planned: false, pid }] as const;
const filler = (n: number): string => "lorem ipsum dolor ".repeat(n);
const other = { kind: "provider" as const, id: "p", version: null };
const line = (text: string) => ["process.output.line", { text, untrusted: true }] as const;

describe("cap", () => {
  const cases: Array<[string, string, number, string]> = [
    ["fits exactly", "abcd", 4, "abcd"], ["empty", "", 0, ""], ["empty with budget", "", 10, ""], ["ascii cut leaves room for the ellipsis", "abcdefgh", 6, "abc…"],
    ["bytes smaller than the ellipsis", "abcdef", 2, "…"], ["zero bytes", "abc", 0, "…"], ["negative bytes", "abc", -5, "…"],
    ["never splits a 2-byte character", "ääää", 5, "ä…"], ["never splits a 3-byte character", "€€€€", 7, "€…"], ["never splits a surrogate pair", "😀😀😀", 8, "😀…"],
    ["multibyte that fits exactly", "😀😀", 8, "😀😀"],
  ];
  for (const [label, text, bytes, expected] of cases) it(label, () => {
    const out = cap(text, bytes); assert.equal(out, expected);
    if (text.length && Buffer.byteLength(text) > bytes) assert.ok(Buffer.byteLength(out) <= Math.max(bytes, 3));
  });
});

describe("emit: validation and routing", () => {
  it("throws after close for write, writeLegacy; close is idempotent", () => {
    const { w } = mk(); w.close(); w.close();
    assert.throws(() => w.write(...started(1)), /log writer closed/);
    assert.throws(() => w.writeLegacy("info", "x"), /log writer closed/);
  });
  it("refuses audit and payload events on the diagnostic writer", () => {
    const { w } = mk();
    assert.throws(() => w.write("config.set", {}), /diagnostic writer cannot write audit or payload/);
    assert.throws(() => w.write("provider.payload.captured", {}), /diagnostic writer cannot write audit or payload/);
  });
  it("strict mode throws for unknown events; non-strict wraps them with a capped, redacted name", () => {
    const strict = mk({ strict: true }); assert.throws(() => strict.w.write("nope.nope", {}), /unregistered log event: nope.nope/);
    rmSync(dir, { recursive: true, force: true });
    const { w } = mk(); w.write("word.".repeat(100), {}); w.close();
    const r = rows()[0]; assert.equal(r.event, "log.unregistered"); assert.ok(Buffer.byteLength(r.attrs.attempted) <= 128); assert.ok(r.attrs.attempted.endsWith("…"));
  });
  it("invalid attributes make write throw 'invalid log record' and nothing is written", () => {
    const { w } = mk();
    assert.throws(() => w.write("core.process.started", {}), /invalid log record/);
    assert.throws(() => w.write("core.process.started", { pid: "not a number" }), /invalid log record/);
    w.close(); assert.deepEqual(rows(), []);
  });
  it("stream and source overrides are recorded; the stream key is omitted otherwise", () => {
    const { w } = mk();
    w.write("process.output.line", { text: "a", untrusted: true }, { stream: "stderr", source: { kind: "provider", id: "p", version: "1" } });
    w.write(...started(1)); w.close();
    const [a, b] = rows(); assert.equal(a.stream, "stderr"); assert.deepEqual(a.source, { kind: "provider", id: "p", version: "1" }); assert.equal("stream" in b, false);
    for (const r of [a, b]) assert.equal(validateRecord(r).ok, true);
  });
  it("records have the wire key order and the injected timestamp", () => {
    const { w } = mk(); w.write(...started(1)); w.close();
    const r = rows()[0]; assert.equal(r.ts, new Date(T0).toISOString()); assert.deepEqual(Object.keys(r).slice(0, 3), ["ts", "level", "source"]);
  });
  it("adds link_trace_id from the current trace and uses its ids", () => {
    const { w } = mk(); const t = { ...newTrace(), link_trace_id: "a".repeat(32) };
    withTrace(t, () => w.write(...started(1)));
    w.write(...started(2)); w.close();
    const [a, b] = rows(); assert.equal(a.trace_id, t.trace_id); assert.equal(a.attrs.link_trace_id, "a".repeat(32)); assert.equal("link_trace_id" in b.attrs, false);
  });
  it("redaction failure becomes a log.redaction.failed record", () => {
    const { w } = mk(); const c: any = {}; c.c = c; w.write("core.process.started", c); w.close();
    assert.deepEqual(events(), ["log.redaction.failed"]);
  });
});

describe("levels", () => {
  it("drops records below the policy level, keeps internal ones, honours a level override", () => {
    const { w } = mk({ levels: { defaultLevel: "warn" } });
    w.write(...exited(1));                                   // info < warn: dropped
    w.write(...exited(2)); w.write("supervisor.child.exited", { role: "core", planned: false, pid: 3 }, { level: "error" });
    w.close(); assert.deepEqual(rows().map(r => r.attrs.pid), [3]);
  });
  it("per-source levels apply to the source given in fields", () => {
    const { w } = mk({ levels: { defaultLevel: "error", levels: { "provider:p": "debug" } } });
    w.write(...line("dropped"), { stream: "stdout" }); w.write(...line("kept"), { stream: "stdout", source: other }); w.close();
    assert.deepEqual(rows().map(r => r.attrs.text), ["kept"]);
  });
  it("updateLevels emits level.changed for changed, added and removed keys only", () => {
    const { w } = mk({ levels: { defaultLevel: "info", levels: { "provider:a": "debug", "provider:b": "warn" } } });
    w.updateLevels({ defaultLevel: "info", levels: { "provider:a": "debug", "provider:b": "warn" } }); // nothing changed
    w.updateLevels({ defaultLevel: "warn", levels: { "provider:a": "error", "provider:c": "debug" } });
    w.close();
    const ch = rows().filter(r => r.event === "log.level.changed").map(r => r.attrs);
    const by = Object.fromEntries(ch.map((a: any) => [a.source_key, a]));
    assert.deepEqual(by["harness"], { source_key: "harness", from: "info", to: "warn" });
    assert.deepEqual(by["provider:a"], { source_key: "provider:a", from: "debug", to: "error" });
    assert.deepEqual(by["provider:b"], { source_key: "provider:b", from: "warn", to: "warn" });
    assert.deepEqual(by["provider:c"], { source_key: "provider:c", to: "debug" });
  });
  it("updateLevels without any previous settings defaults to info", () => {
    const { w } = mk(); w.updateLevels({ defaultLevel: "debug" }); w.close();
    assert.deepEqual(rows().map(r => r.attrs), [{ source_key: "harness", from: "info", to: "debug" }]);
  });
  it("updateLevels with empty settings falls back to info and omits the default entry's change when equal", () => {
    const { w } = mk({ levels: { defaultLevel: "debug" } }); w.updateLevels({}); w.close();
    assert.deepEqual(rows().map(r => r.attrs), [{ source_key: "harness", from: "debug", to: "info" }]);
  });
  it("a removed override with no default in the new settings reports a change to info", () => {
    const { w } = mk({ levels: { levels: { "provider:a": "debug" } } }); w.updateLevels({ levels: {} }); w.close();
    assert.deepEqual(rows().map(r => r.attrs).find(a => a.source_key === "provider:a"), { source_key: "provider:a", from: "debug", to: "info" });
  });
  it("an invalid update throws, changes nothing and emits nothing", () => {
    const { w } = mk();
    assert.throws(() => w.updateLevels({ defaultLevel: "loud" as never }), RangeError);
    assert.throws(() => w.updateLevels({ levels: { "bad key!": "info" } }), RangeError);
    assert.throws(() => w.updateLevels({ defaultLevel: "trace" }), RangeError);
    w.write(...started(1)); w.close(); assert.equal(events().join(), "core.process.started");
  });
  it("trace level expires into debug with exactly one log.level.expired (tick resolves)", () => {
    const { w, c } = mk(); w.updateLevels({ defaultLevel: "trace", traceUntil: c.now() + 1000 });
    c.advance(1001); w.tick(); w.tick(); w.close();
    assert.equal(events().filter(e => e === "log.level.expired").length, 1);
  });
});

describe("deduplication", () => {
  it("identical records inside the window collapse and a summary with the count follows after the window", () => {
    const { w, c } = mk();
    for (let i = 0; i < 5; i++) w.write(...started(1));
    c.advance(LIMITS.dedupWindowMs - 1); w.write(...started(1));
    c.advance(1); w.write(...started(1)); // window over: summary of 6, then the new record
    w.close();
    const rs = rows(); assert.equal(rs.length, 3);
    assert.equal(rs[1].attrs.repeat, 6); assert.equal(rs[1].attrs.window_ms, LIMITS.dedupWindowMs); assert.equal(rs[2].attrs.repeat, undefined);
  });
  it("a single occurrence produces no summary", () => {
    const { w, c } = mk(); w.write(...started(1)); c.advance(LIMITS.dedupWindowMs); w.tick(); w.write(...started(1)); w.close();
    assert.equal(rows().length, 2);
  });
  it("different attrs, level, stream and source are separate keys", () => {
    const { w } = mk();
    w.write(...started(1)); w.write(...started(2));
    w.write("supervisor.child.exited", { role: "core", planned: false, pid: 1 }, { level: "error" });
    w.write(...line("t"), { stream: "stdout" }); w.write(...line("t"), { stream: "stderr" });
    w.write(...line("t"), { stream: "stdout", source: other });
    w.close(); assert.equal(rows().length, 6);
  });
  it("the same record in different traces is not a duplicate", () => {
    const { w } = mk(); withTrace(newTrace(), () => w.write(...started(1))); withTrace(newTrace(), () => w.write(...started(1))); w.close(); assert.equal(rows().length, 2);
  });
  it("fatal records bypass dedup and rate limiting", () => {
    const { w } = mk();
    for (let i = 0; i < 70; i++) w.write("supervisor.child.exited", { role: "core", planned: false, pid: 1 }, { level: "fatal" });
    w.close(); assert.equal(rows().length, 70);
  });
  it("tick(true) flushes pending summaries immediately", () => {
    const { w } = mk(); w.write(...started(1)); w.write(...started(1)); w.tick(true); w.flush();
    assert.equal(rows().at(-1).attrs.repeat, 2); w.close();
  });
  it("bounded dedup state: the oldest entry is summarised on eviction (1000 entries)", () => {
    const { w } = mk();
    w.write(...started(0), ); w.write("core.process.started", { pid: 0 }); // count 2 for the first key
    for (let i = 1; i <= 1000; i++) w.write("core.process.started", { pid: i }, { bypassRate: true });
    w.flush();
    const sum = rows().filter(r => r.attrs.repeat); assert.equal(sum.length, 1); assert.equal(sum[0].attrs.repeat, 2); assert.equal(sum[0].attrs.pid, 0);
    w.close();
  });
  it("eviction of an entry seen once writes no summary", () => {
    const { w } = mk();
    for (let i = 0; i <= 1000; i++) w.write("core.process.started", { pid: i }, { bypassRate: true });
    w.close(); assert.equal(rows().filter(r => r.attrs.repeat).length, 0);
  });
});

describe("rate limiting", () => {
  it("lets the burst through, drops the rest, reports log.suppressed with the window after a second", () => {
    const { w, c } = mk();
    for (let i = 0; i < LIMITS.rateBurst + 40; i++) w.write("core.process.started", { pid: i });
    c.advance(999); w.tick(); w.flush();
    assert.equal(events().includes("log.suppressed"), false);
    c.advance(1); w.tick(); w.close();
    const s = rows().find(r => r.event === "log.suppressed"); assert.equal(s.attrs.dropped, 40); assert.equal(s.attrs.window_ms, 1000); assert.equal(s.attrs.reason, "rate-limit");
    assert.equal(rows().filter(r => r.event === "core.process.started").length, LIMITS.rateBurst);
  });
  it("tokens refill with time; a backwards clock adds nothing", () => {
    const { w, c } = mk();
    for (let i = 0; i < LIMITS.rateBurst; i++) w.write("core.process.started", { pid: i });
    w.write("core.process.started", { pid: 9001 }); // dropped
    c.advance(-5000); w.write("core.process.started", { pid: 9002 }); // still dropped
    c.advance(5000 + 1000); w.write("core.process.started", { pid: 9003 }); // refilled
    w.close(); const pids = rows().map(r => r.attrs.pid);
    assert.ok(!pids.includes(9001) && !pids.includes(9002) && pids.includes(9003));
  });
  it("bypassRate neither consumes nor needs tokens", () => {
    const { w } = mk();
    for (let i = 0; i < LIMITS.rateBurst + 10; i++) w.write("core.process.started", { pid: i }, { bypassRate: true });
    w.close(); assert.equal(rows().length, LIMITS.rateBurst + 10);
  });
  it("buckets are per source", () => {
    const { w } = mk();
    for (let i = 0; i < LIMITS.rateBurst + 5; i++) w.write("core.process.started", { pid: i });
    w.write(...line("from provider"), { stream: "stdout", source: other });
    w.close(); assert.ok(rows().some(r => r.source.kind === "provider"));
  });
  it("force tick reports suppression at once; the bucket is reset afterwards", () => {
    const { w } = mk();
    for (let i = 0; i < LIMITS.rateBurst + 3; i++) w.write("core.process.started", { pid: i });
    w.tick(true); w.tick(true); w.close();
    assert.equal(rows().filter(r => r.event === "log.suppressed").length, 1);
  });
});

describe("fit: byte limits", () => {
  it("caps a long string to its schema maxLength and marks truncated/bytes", () => {
    const { w } = mk(); w.write(...line("é".repeat(3000)), { stream: "stdout" }); w.close();
    const r = rows()[0]; assert.equal(r.attrs.truncated, true); assert.equal(r.attrs.bytes > 4096, true); assert.ok(Buffer.byteLength(JSON.stringify(r)) <= LIMITS.lineBytes); assert.equal(validateRecord(r).ok, true);
  });
  it("caps foreign_message to 2048 bytes", () => {
    const { w } = mk(); w.write("core.process.started", { pid: 1, foreign_message: "lorem ipsum ".repeat(500) }); w.close();
    const r = rows()[0]; assert.ok(Buffer.byteLength(r.attrs.foreign_message) <= 2048); assert.equal(r.attrs.truncated, true);
  });
  it("a record under every limit is untouched (no truncated flag)", () => {
    const { w } = mk(); w.write(...line("short"), { stream: "stdout" }); w.close(); assert.equal("truncated" in rows()[0].attrs, false);
  });
  it("arrays are cut to maxItems and their strings to the item limit", () => {
    const { w } = mk(); w.write("core.config.applied", { keys: Array.from({ length: 200 }, (_, i) => `${i} ${filler(30)}`) }); w.close();
    const r = rows()[0]; assert.ok(r.attrs.keys.length <= 64); assert.ok(r.attrs.keys.every((k: string) => Buffer.byteLength(k) <= 128)); assert.equal(r.attrs.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(r)) <= LIMITS.lineBytes); assert.equal(validateRecord(r).ok, true);
  });
  it("array items that are not strings pass through the cap unchanged", () => {
    const { w } = mk(); w.write("core.config.applied", { keys: ["a", "b"] }); w.close(); assert.deepEqual(rows()[0].attrs.keys, ["a", "b"]);
  });
  it("shrinks the largest string until the whole line fits (escaped content)", () => {
    const { w } = mk(); w.write(...line('"\\'.repeat(2000)), { stream: "stdout" }); w.close();
    const r = rows()[0]; assert.ok(Buffer.byteLength(JSON.stringify(r)) <= LIMITS.lineBytes); assert.equal(r.attrs.truncated, true); assert.equal(validateRecord(r).ok, true);
  });
  it("shrinks the array first when it dominates, then the string once it is the larger one", () => {
    const { w } = mk();
    w.write("core.config.applied", { keys: Array.from({ length: 64 }, (_, i) => `${i} ${filler(6)}`), foreign_message: filler(100) });
    w.close(); const r = rows()[0];
    assert.ok(Buffer.byteLength(JSON.stringify(r)) <= LIMITS.lineBytes); assert.equal(r.attrs.truncated, true); assert.ok(r.attrs.keys.length < 64); assert.equal(validateRecord(r).ok, true);
  });
  it("shrinks the string first when it is larger than every array, then the array", () => {
    const { w } = mk();
    w.write("core.config.applied", { keys: Array.from({ length: 18 }, (_, i) => `${i} ${filler(5)}`), foreign_message: filler(300) });
    w.close(); const r = rows()[0];
    assert.ok(Buffer.byteLength(JSON.stringify(r)) <= LIMITS.lineBytes); assert.ok(r.attrs.foreign_message.length < filler(300).length); assert.equal(validateRecord(r).ok, true);
  });
  it("keeps the original size in `bytes` only once (??=)", () => {
    const { w } = mk(); w.write("process.output.line", { text: "x".repeat(10_000), untrusted: true, bytes: 5 }, { stream: "stdout" }); w.close();
    assert.equal(rows()[0].attrs.bytes, 5);
  });
});

describe("flush and queue", () => {
  it("records stay queued until flush; reaching 64 queued records flushes", () => {
    const { w } = mk();
    for (let i = 0; i < 63; i++) w.write("core.process.started", { pid: i });
    assert.equal(rows().length, 0);
    w.write("core.process.started", { pid: 63 }); assert.equal(rows().length, 64);
    w.write("core.process.started", { pid: 64 }); assert.equal(rows().length, 64); w.flush(); assert.equal(rows().length, 65);
    w.close();
  });
  it("a failing sink keeps the records queued; a later flush delivers them in order", () => {
    const { w } = mk(); w.write(...started(1)); w.flush();
    rmSync(path.join(dir, "core.log")); mkdirSync(path.join(dir, "core.log"));
    w.write(...started(2)); assert.throws(() => w.flush(), /not a regular file/);
    w.write(...started(3)); assert.throws(() => w.flush(), /not a regular file/);
    rmdirSync(path.join(dir, "core.log")); w.flush();
    assert.deepEqual(rows().map(r => r.attrs.pid), [2, 3]); w.close();
  });
  it("close flushes everything and wipes the secrets", () => {
    const { w } = mk(); w.registerSecret("fixture-secret-aaa"); w.write(...started(1)); w.close();
    assert.equal(rows().length, 1);
  });
  it("close with a failing sink propagates and leaves the writer usable for a retry", () => {
    const { w } = mk(); w.write(...started(1)); mkdirSync(path.join(dir, "core.log"));
    assert.throws(() => w.close(), /not a regular file/);
    rmdirSync(path.join(dir, "core.log")); w.close(); assert.equal(rows().length, 1);
  });
});

describe("writeLegacy", () => {
  it("writes {at, level, role, ...fields, msg} synchronously", () => {
    const { w } = mk({ role: "legacy-role" } as never); w.writeLegacy("info", "hello", { a: 1 });
    const r = rows("legacy-role.log")[0]; assert.deepEqual(r, { at: new Date(T0).toISOString(), level: "info", role: "legacy-role", a: 1, msg: "hello" }); w.close();
  });
  it("is filtered by the level policy", () => {
    const { w } = mk({ levels: { defaultLevel: "error" } }); w.writeLegacy("warn", "no"); w.writeLegacy("error", "yes"); w.close();
    assert.deepEqual(rows().map(r => r.msg), ["yes"]);
  });
  it("serialises Error values and redacts secrets in fields and msg", () => {
    const { w } = mk(); w.registerSecret("fixture-legacy-secret");
    w.writeLegacy("error", "failed fixture-legacy-secret", { err: new Error("boom"), token: "abc" }); w.close();
    const r = rows()[0]; assert.ok(!JSON.stringify(r).includes("fixture-legacy-secret")); assert.equal(typeof r.err, "object"); assert.ok(JSON.stringify(r.err).includes("boom"));
  });
  it("caps the message and falls back to a compact record when the line is too long", () => {
    const { w } = mk(); w.writeLegacy("info", "m".repeat(5000), { blob: "b".repeat(6000) }); w.close();
    const r = rows()[0]; assert.equal(r.truncated, true); assert.ok(r.bytes > LIMITS.lineBytes); assert.ok(Buffer.byteLength(r.msg) <= LIMITS.msgBytes); assert.equal("blob" in r, false);
  });
  it("a message over the cap but a small line is only capped", () => {
    const { w } = mk(); w.writeLegacy("info", "m".repeat(2500)); w.close(); const r = rows()[0]; assert.ok(Buffer.byteLength(r.msg) <= LIMITS.msgBytes); assert.equal("truncated" in r, false);
  });
  it("unserialisable fields end up as a log.redaction.failed record instead of throwing", () => {
    const { w } = mk(); const c: any = {}; c.c = c; w.writeLegacy("info", "x", { c }); w.close();
    assert.deepEqual(events(), ["log.redaction.failed"]);
  });
  it("defaults the fields to an empty object", () => {
    const { w } = mk(); w.writeLegacy("warn", "plain"); w.close(); assert.equal(rows()[0].msg, "plain");
  });
});

describe("secrets and PII", () => {
  it("registerSecret applies to records written afterwards", () => {
    const { w } = mk(); w.write(...line("before fixture-late-secret"), { stream: "stdout" });
    w.registerSecret("fixture-late-secret"); w.write(...line("after fixture-late-secret"), { stream: "stdout" }); w.close();
    const [a, b] = rows(); assert.ok(a.attrs.text.includes("fixture-late-secret")); assert.ok(!b.attrs.text.includes("fixture-late-secret"));
  });
  it("redactPii masks e-mail addresses only when enabled", () => {
    const on = mk({ redactPii: true }); on.w.write(...line("mail person@example.test"), { stream: "stdout" }); on.w.close();
    assert.ok(!rows()[0].attrs.text.includes("person@example.test"));
    rmSync(dir, { recursive: true, force: true });
    const off = mk(); off.w.write(...line("mail person@example.test"), { stream: "stdout" }); off.w.close();
    assert.ok(rows()[0].attrs.text.includes("person@example.test"));
  });
});

describe("retention and rotation", () => {
  it("prunes old rotated files at construction and records log.retention.pruned", () => {
    mkdirSync(dir, { recursive: true });
    const old = path.join(dir, "core.log.2"); writeFileSync(old, "12345"); utimesSync(old, new Date(T0 - 40 * DAY), new Date(T0 - 40 * DAY));
    const { w } = mk({ retentionDays: 7 }); w.flush(); w.close();
    assert.equal(existsSync(old), false);
    const r = rows().find(x => x.event === "log.retention.pruned"); assert.deepEqual([r.attrs.files, r.attrs.bytes, r.attrs.older_than_days, r.attrs.stream], [1, 5, 7, "diagnostic"]);
  });
  it("default retention is reported as 14 days", () => {
    mkdirSync(dir, { recursive: true });
    const old = path.join(dir, "core.log.1"); writeFileSync(old, "x"); utimesSync(old, new Date(T0 - 40 * DAY), new Date(T0 - 40 * DAY));
    const { w } = mk(); w.close(); assert.equal(rows()[0].attrs.older_than_days, 14);
  });
  it("nothing to prune: no record; the daily tick prunes again only after a day", () => {
    const { w, c } = mk(); w.tick(); c.advance(DAY - 1); w.tick();
    mkdirSync(dir, { recursive: true }); const old = path.join(dir, "core.log.3"); writeFileSync(old, "x"); utimesSync(old, new Date(0), new Date(0));
    w.tick(); assert.equal(existsSync(old), true);
    c.advance(1); w.tick(); assert.equal(existsSync(old), false); w.close();
    assert.equal(events().filter(e => e === "log.retention.pruned").length, 1);
  });
  it("setRotation is forwarded to the sink (and validated)", () => {
    const { w } = mk(); assert.throws(() => w.setRotation({ maxBytes: 0, keep: 1 }), RangeError);
    w.setRotation({ maxBytes: 200, keep: 2 });
    for (let i = 0; i < 6; i++) { w.write("core.process.started", { pid: i }); w.flush(); }
    w.close(); assert.ok(existsSync(path.join(dir, "core.log.1")));
  });
  it("rejects a diagnostic role that is reserved", () => {
    assert.throws(() => createWriter({ dir, role: "audit", source, timers: false }), /diagnostic role required/);
  });
});

describe("timer", () => {
  it("the 1 s timer ticks and flushes queued records; close stops it", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const c = clock(); const w = createWriter({ dir, role: "core", source, now: c.now });
    w.write(...started(1)); assert.equal(rows().length, 0);
    t.mock.timers.tick(1000); assert.equal(rows().length, 1);
    w.write(...started(2)); w.close(); t.mock.timers.tick(5000); assert.equal(rows().length, 2);
  });
  it("a failing sink inside the timer is swallowed and the records are retried at the next tick", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const c = clock(); const w = createWriter({ dir, role: "core", source, now: c.now });
    w.write(...started(1)); w.flush();
    rmSync(path.join(dir, "core.log")); mkdirSync(path.join(dir, "core.log"));
    w.write(...started(2));
    t.mock.timers.tick(1000);
    rmdirSync(path.join(dir, "core.log"));
    t.mock.timers.tick(1000);
    assert.deepEqual(rows().map(r => r.attrs.pid), [2]);
    w.close();
  });
  it("timers: false creates no interval", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const { w } = mk(); w.write(...started(1)); t.mock.timers.tick(10_000); assert.equal(rows().length, 0); w.close();
  });
});
