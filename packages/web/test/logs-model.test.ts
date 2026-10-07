// Log viewer logic without a browser (K8): exact logs.query / logs.tail parameters, redaction markers, export text, the
// rate-limited announcer and the tail loop with its back-off.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createAnnouncer } from "../src/pages/logs/viewer/announce.ts";
import {
  bufferAppend, buildQuery, DEFAULT_FILTERS, exportName, hasRedaction, liveEligible, messageOf, redactionRules, splitRedacted, tailParams, toJson, toNdjson,
  type Filters, type LogPage, type LogRecord,
} from "../src/pages/logs/viewer/model.ts";
import { backoffMs, runTail, type TailFailure, type TailState } from "../src/pages/logs/viewer/tail.ts";

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const f = (o: Partial<Filters> = {}): Filters => ({ ...DEFAULT_FILTERS, ...o });
const rec = (i: number, record: Record<string, unknown> = {}): LogRecord => ({ ts: `2026-10-07T11:00:0${i}.000Z`, level: "info", component: "core", stream: "diagnostic", record: { msg: `m${i}`, ...record } });

describe("logs: query parameters", () => {
  test("defaults ask for the newest 200 of the diagnostic stream and nothing else", () => {
    assert.deepEqual(buildQuery(f(), NOW), { ok: true, params: { stream: "diagnostic", order: "desc", limit: 200 } });
  });
  test("level, component, text, stream and order map to minLevel, component, text, stream, order", () => {
    const r = buildQuery(f({ minLevel: "warn", component: " core ", text: "boom", order: "asc" }), NOW, "c1");
    assert.deepEqual(r, { ok: true, params: { stream: "diagnostic", minLevel: "warn", component: "core", text: "boom", order: "asc", limit: 200, cursor: "c1" } });
  });
  test("the audit stream never sends minLevel", () => {
    assert.deepEqual(buildQuery(f({ stream: "audit", minLevel: "error" }), NOW), { ok: true, params: { stream: "audit", order: "desc", limit: 200 } });
  });
  test("a trace id is sent as text; trace id and text together are refused", () => {
    assert.deepEqual(buildQuery(f({ trace: "4bf92f3577b34da6a3ce929d0e0e4736" }), NOW), { ok: true, params: { stream: "diagnostic", order: "desc", limit: 200, text: "4bf92f3577b34da6a3ce929d0e0e4736" } });
    assert.deepEqual(buildQuery(f({ trace: "abc", text: "x" }), NOW), { ok: false, error: "both" });
  });
  test("presets turn into an inclusive from bound relative to now", () => {
    for (const [range, ms] of [["15m", 900_000], ["1h", 3_600_000], ["24h", 86_400_000]] as const) {
      const r = buildQuery(f({ range }), NOW);
      assert.ok(r.ok);
      assert.equal(r.params.from, new Date(NOW - ms).toISOString());
      assert.equal(r.params.to, undefined);
    }
  });
  test("custom from/to are local times sent as UTC; an inverted or invalid range is refused", () => {
    const r = buildQuery(f({ range: "custom", from: "2026-10-07T10:00", to: "2026-10-07T11:00" }), NOW);
    assert.ok(r.ok);
    assert.equal(r.params.from, new Date("2026-10-07T10:00").toISOString());
    assert.equal(r.params.to, new Date("2026-10-07T11:00").toISOString());
    assert.deepEqual(buildQuery(f({ range: "custom", from: "2026-10-07T12:00", to: "2026-10-07T11:00" }), NOW), { ok: false, error: "emptyRange" });
    assert.deepEqual(buildQuery(f({ range: "custom", from: "nonsense" }), NOW), { ok: false, error: "badDate" });
  });
  test("tail parameters keep the filters but not the time range, order or query cursor", () => {
    const q = buildQuery(f({ minLevel: "info", component: "core", text: "x", range: "1h" }), NOW);
    assert.ok(q.ok);
    assert.deepEqual(tailParams(q.params, { cursor: "t1", waitMs: 15000 }), { stream: "diagnostic", limit: 200, minLevel: "info", component: "core", text: "x", cursor: "t1", waitMs: 15000 });
  });
  test("live tail needs newest-first and no upper bound", () => {
    assert.ok(liveEligible(f()));
    assert.ok(liveEligible(f({ range: "custom", from: "2026-10-07T10:00" })));
    assert.ok(!liveEligible(f({ order: "asc" })));
    assert.ok(!liveEligible(f({ range: "custom", to: "2026-10-07T11:00" })));
  });
});

describe("logs: records", () => {
  test("a row's message is msg, the event code, or action and target for audit", () => {
    assert.equal(messageOf(rec(1)), "m1");
    assert.equal(messageOf(rec(1, { msg: "", event: "core.started" })), "core.started");
    assert.equal(messageOf({ ...rec(1), stream: "audit", level: null, record: { action: "secret.set", target: "api" } }), "secret.set api");
  });
  test("redaction markers are found and split out", () => {
    const r = rec(1, { attrs: { token: "[REDACTED:secret-key]" }, msg: "url [REDACTED:url] ok" });
    assert.ok(hasRedaction(r));
    assert.deepEqual(redactionRules(r).sort(), ["secret-key", "url"]);
    assert.deepEqual(splitRedacted("a [REDACTED:url] b"), [{ text: "a ", redacted: false, rule: "" }, { text: "[REDACTED:url]", redacted: true, rule: "url" }, { text: " b", redacted: false, rule: "" }]);
    assert.ok(!hasRedaction(rec(2)));
  });
  test("export is the records as returned: NDJSON one per line, JSON an array", () => {
    const rs = [rec(1), rec(2, { attrs: { k: "[REDACTED:x]" } })];
    assert.deepEqual(toNdjson(rs).trimEnd().split("\n").map((l) => JSON.parse(l)), rs);
    assert.deepEqual(JSON.parse(toJson(rs)), rs);
    assert.equal(toNdjson([]), "");
    assert.match(exportName(NOW, "ndjson"), /^plur1bus-logs-2026-10-07T12-00-00-000Z\.ndjson$/);
  });
  test("the tail buffer keeps the newest entries and reports what it dropped", () => {
    const r = bufferAppend([1, 2, 3], [4, 5], 4);
    assert.deepEqual(r, { buf: [2, 3, 4, 5], dropped: 1 });
    assert.deepEqual(bufferAppend([], [1], 4), { buf: [1], dropped: 0 });
  });
});

describe("logs: announcer", () => {
  test("announces the first text at once and later ones at most once per interval, latest wins", () => {
    let clock = 0;
    const timers: { fn: () => void; at: number }[] = [];
    const out: string[] = [];
    const a = createAnnouncer((s) => out.push(s), { intervalMs: 5000, now: () => clock, setTimer: (fn, ms) => { timers.push({ fn, at: clock + ms }); return timers.length; }, clearTimer: () => undefined });
    a.say("1 new entry");
    assert.deepEqual(out, ["1 new entry"]);
    clock = 100; a.say("2 new entries"); clock = 200; a.say("3 new entries"); clock = 300; a.say("4 new entries");
    assert.deepEqual(out, ["1 new entry"]);
    assert.equal(timers.length, 1);
    clock = 5000; timers[0]!.fn();
    assert.deepEqual(out, ["1 new entry", "4 new entries"]);
    clock = 12000; a.say("4 new entries");
    assert.equal(out.length, 2, "same text is not repeated");
  });
});

describe("logs: tail loop", () => {
  const page = (records: LogRecord[], nextCursor: string | null): LogPage => ({ records, nextCursor, corrupt: 0, scanned: { files: 1, bytes: 1 }, truncated: false });
  const noSleep = (log: number[]) => (ms: number): Promise<void> => { log.push(ms); return Promise.resolve(); };

  test("anchors first, then follows the cursor, handing records over oldest first", async () => {
    const ctl = new AbortController();
    const cursors: (string | null)[] = [];
    const got: { n: number; anchor: boolean }[] = [];
    const script = [page([rec(1)], "a"), page([rec(2), rec(3)], "b"), page([], "b")];
    await runTail({
      call: (c) => { cursors.push(c); const p = script.shift(); if (!p) { ctl.abort(); return Promise.reject(new Error("done")); } return Promise.resolve(p); },
      onRecords: (r, anchor) => got.push({ n: r.length, anchor }), onState: () => undefined, classify: () => "retry", signal: ctl.signal, sleep: noSleep([]),
      now: () => 0,
    });
    assert.deepEqual(cursors, [null, "a", "b", "b"]);
    assert.deepEqual(got, [{ n: 1, anchor: true }, { n: 2, anchor: false }]);
  });

  test("failures back off 1, 2, 4 ... up to 30 s and recover to live", async () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(backoffMs), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    const ctl = new AbortController();
    const sleeps: number[] = [], states: TailState[] = [];
    let n = 0;
    await runTail({
      call: () => { n += 1; if (n <= 3) return Promise.reject(new Error("net")); if (n === 4) return Promise.resolve(page([rec(1)], "a")); ctl.abort(); return Promise.reject(new Error("x")); },
      onRecords: () => undefined, onState: (s) => states.push(s), classify: () => "retry", signal: ctl.signal, sleep: noSleep(sleeps), now: () => 0,
    });
    assert.deepEqual(sleeps, [1000, 2000, 4000]);
    assert.deepEqual(states, ["retrying", "retrying", "retrying", "live"]);
  });

  test("a denied role or a missing method ends the loop with that state; a bad cursor re-anchors", async () => {
    for (const kind of ["forbidden", "unavailable"] as const) {
      const states: TailState[] = [];
      let calls = 0;
      await runTail({ call: () => { calls += 1; return Promise.reject(new Error(kind)); }, onRecords: () => undefined, onState: (s) => states.push(s), classify: (): TailFailure => kind, signal: new AbortController().signal, sleep: noSleep([]) });
      assert.deepEqual([calls, states], [1, [kind]]);
    }
    const ctl = new AbortController(), cursors: (string | null)[] = [];
    let n = 0;
    await runTail({
      call: (c) => { cursors.push(c); n += 1; if (n === 1) return Promise.resolve(page([], "a")); if (n === 2) return Promise.reject(new Error("bad-cursor")); ctl.abort(); return Promise.reject(new Error("x")); },
      onRecords: () => undefined, onState: () => undefined, classify: (e) => ((e as Error).message === "bad-cursor" ? "reanchor" : "abort"), signal: ctl.signal, sleep: noSleep([]), now: () => 0,
    });
    assert.deepEqual(cursors, [null, "a", null]);
  });

  test("an empty answer that comes back instantly waits the idle gap", async () => {
    const ctl = new AbortController(), sleeps: number[] = [];
    let n = 0;
    await runTail({
      call: () => { n += 1; if (n > 3) { ctl.abort(); return Promise.reject(new Error("x")); } return Promise.resolve(page([], "a")); },
      onRecords: () => undefined, onState: () => undefined, classify: () => "abort", signal: ctl.signal, sleep: noSleep(sleeps), idleMs: 500, now: () => 0,
    });
    assert.deepEqual(sleeps, [500, 500, 500]);
  });
});
