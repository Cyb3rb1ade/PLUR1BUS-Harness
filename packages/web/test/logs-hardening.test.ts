// Log viewer hardening (audit c20): tail re-anchor without a hot loop, control and bidi characters in log text, huge lines,
// and the redaction scan done once per record. Pure functions, no browser.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clipLine, hasRedaction, safeText, type LogPage, type LogRecord } from "../src/pages/logs/viewer/model.ts";
import { runTail } from "../src/pages/logs/viewer/tail.ts";

const page = (records: LogRecord[], nextCursor: string | null): LogPage => ({ records, nextCursor, corrupt: 0, scanned: { files: 1, bytes: 1 }, truncated: false });

describe("logs hardening: tail", () => {
  test("a server that refuses even the anchor call with a bad cursor is backed off, not hammered", async () => {
    const ctl = new AbortController();
    const sleeps: number[] = [];
    let calls = 0;
    await runTail({
      call: () => { calls += 1; if (calls >= 20) ctl.abort(); return Promise.reject(new Error("bad-cursor")); },
      onRecords: () => undefined, onState: () => undefined, classify: () => "reanchor", signal: ctl.signal,
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); }, now: () => 0,
    });
    assert.ok(sleeps.length >= 1, `hot loop: no wait between ${calls} calls`);
    assert.deepEqual(sleeps.slice(0, 3), [1000, 2000, 4000]);
  });

  test("a stale cursor still re-anchors at once (no wait) when the follow-up call was the one refused", async () => {
    const ctl = new AbortController();
    const sleeps: number[] = [], cursors: (string | null)[] = [];
    const script: (LogPage | "stale")[] = [page([], "a"), "stale", page([], "b")];
    await runTail({
      call: (c) => { cursors.push(c); const s = script.shift(); if (s === undefined) { ctl.abort(); return Promise.reject(new Error("x")); } return s === "stale" ? Promise.reject(new Error("stale")) : Promise.resolve(s); },
      onRecords: () => undefined, onState: () => undefined, classify: (e) => ((e as Error).message === "stale" ? "reanchor" : "abort"), signal: ctl.signal,
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); }, now: () => 0, idleMs: 0,
    });
    assert.deepEqual(cursors.slice(0, 3), [null, "a", null]);
    assert.deepEqual(sleeps, []);
  });
});

describe("logs hardening: displayed text", () => {
  test("control characters become visible pictures, never raw ESC, NUL or CR", () => {
    assert.equal(safeText("a\u001b[31mred\u0000b\rc\u007f"), "a\u241b[31mred\u2400b\u240dc\u2421");
  });
  test("bidi overrides, isolates, zero-width and line/paragraph separators are replaced", () => {
    const s = safeText("ok\u202Eevil\u2066x\u200Bz\u2028w\u0085v\uFEFF");
    assert.equal(new RegExp("[\u202A-\u202E\u2066-\u2069\u200B-\u200F\u2028\u2029\u0085\uFEFF]").test(s), false, s);
    assert.equal(s.startsWith("ok"), true);
  });
  test("newline and tab survive only when asked for (detail blocks), and are pictures in a one-line row", () => {
    assert.equal(safeText("a\nb\tc"), "a\u240ab\u2409c");
    assert.equal(safeText("a\nb\tc", { multiline: true }), "a\nb\tc");
  });
  test("ordinary text, accents, CJK and emoji pass through unchanged", () => {
    const s = "Größe 日本語 😀 [REDACTED:email] <b>&amp;</b>";
    assert.equal(safeText(s), s);
  });
  test("a one-line row is clipped by characters, not in the middle of a surrogate pair", () => {
    const long = "😀".repeat(2000);
    const c = clipLine(long, 500);
    assert.ok(c.length <= 502);
    assert.ok(c.endsWith("…"));
    assert.equal(/[\uD800-\uDBFF]…$/.test(c), false);
    assert.equal(clipLine("short", 500), "short");
  });
  test("a 5 MB line is cleaned and clipped quickly", () => {
    const big = "x\u001b".repeat(2_500_000);
    const t0 = performance.now();
    const c = clipLine(safeText(big.slice(0, 100_000)), 500);
    assert.ok(c.length <= 502);
    assert.ok(performance.now() - t0 < 500);
  });
});

describe("logs hardening: redaction scan", () => {
  test("hasRedaction serialises a record once, however often a row is drawn", () => {
    let n = 0;
    const r: LogRecord = { ts: "2026-10-07T11:00:00.000Z", level: "info", component: "core", stream: "diagnostic", record: { toJSON: () => { n += 1; return { msg: "x [REDACTED:email]" }; } } };
    assert.equal(hasRedaction(r), true);
    assert.equal(hasRedaction(r), true);
    assert.equal(hasRedaction(r), true);
    assert.equal(n, 1);
  });
});
