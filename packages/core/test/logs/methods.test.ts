import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RpcError } from "../../src/rpc/errors.ts";
import type { CallContext } from "../../src/rpc/server.ts";
import { createLogsMethods } from "../../src/logs/methods.ts";
import { add, iso, logsDir, put, rec, rotate } from "./helpers.ts";

const ctx = (signal = new AbortController().signal): CallContext => ({ requestId: "r", connectionId: "c", signal });
const msgs = (r: any): string[] => r.records.map((x: any) => x.record.msg);
async function code(p: Promise<unknown>): Promise<{ error?: string; reason?: string }> {
  try { await p; return {}; } catch (e) { return e instanceof RpcError ? { error: e.error, ...(e.reason ? { reason: e.reason } : {}) } : { error: String(e) }; }
}

/** A clock and a sleep that only the test moves: no real waiting. */
function fakeTime(onSleep?: (n: number) => void) {
  let t = 1_000_000; let sleeps = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; sleeps++; onSleep?.(sleeps); }, sleeps: () => sleeps };
}

describe("logs.query handler", () => {
  it("defaults to the newest 100 first and answers the documented shape", async () => {
    const d = logsDir(); put(d, "core.log", Array.from({ length: 150 }, (_, i) => rec(i, "info", `m${i}`)).join(""));
    const h = createLogsMethods({ dir: d });
    const r: any = await h["logs.query"]!({}, ctx());
    assert.deepEqual(Object.keys(r).sort(), ["corrupt", "nextCursor", "records", "scanned", "truncated"]);
    assert.equal(r.records.length, 100); assert.equal(r.records[0].record.msg, "m149"); assert.equal(typeof r.nextCursor, "string");
    assert.deepEqual(Object.keys(r.records[0]).sort(), ["component", "level", "record", "stream", "ts"]);
  });
  it("refuses bad bounds, an empty range, a level on the audit stream and a foreign cursor with typed reasons", async () => {
    const d = logsDir(); put(d, "core.log", rec(0, "info", "a") + rec(1, "info", "b")); const h = createLogsMethods({ dir: d });
    const call = (p: object) => code(h["logs.query"]!(p, ctx()));
    assert.deepEqual(await call({ from: "yesterday" }), { error: "E_INVALID_PARAMS", reason: "bad-timestamp" });
    assert.deepEqual(await call({ to: "2026-13-45T00:00:00Z" }), { error: "E_INVALID_PARAMS", reason: "bad-timestamp" });
    assert.deepEqual(await call({ from: iso(10), to: iso(0) }), { error: "E_INVALID_PARAMS", reason: "empty-range" });
    assert.deepEqual(await call({ stream: "audit", minLevel: "warn" }), { error: "E_INVALID_PARAMS", reason: "level-not-applicable" });
    assert.deepEqual(await call({ cursor: "garbage" }), { error: "E_INVALID_PARAMS", reason: "bad-cursor" });
    const r: any = await h["logs.query"]!({ limit: 1, order: "asc" }, ctx());
    assert.equal(typeof r.nextCursor, "string");
    assert.deepEqual(await call({ cursor: r.nextCursor, order: "asc", minLevel: "error" }), { error: "E_INVALID_PARAMS", reason: "cursor-mismatch" });
  });
  it("accepts second-precision bounds", async () => {
    const d = logsDir(); put(d, "core.log", rec(500, "info", "in") + rec(2500, "info", "out"));
    const r: any = await createLogsMethods({ dir: d })["logs.query"]!({ from: "2026-10-07T09:00:00Z", to: "2026-10-07T09:00:01Z" }, ctx());
    assert.deepEqual(msgs(r), ["in"]);
  });
});

describe("logs.tail handler", () => {
  it("first call: the newest matches oldest-first and a cursor; next calls: only what came after", async () => {
    const d = logsDir(); put(d, "core.log", Array.from({ length: 10 }, (_, i) => rec(i * 10, "info", `m${i}`)).join(""));
    const h = createLogsMethods({ dir: d, ...fakeTime() });
    const a: any = await h["logs.tail"]!({ limit: 3 }, ctx());
    assert.deepEqual(msgs(a), ["m7", "m8", "m9"]);
    const none: any = await h["logs.tail"]!({ cursor: a.nextCursor }, ctx());
    assert.deepEqual(msgs(none), []); assert.equal(none.nextCursor, a.nextCursor);
    add(d, "core.log", rec(1000, "info", "n1") + rec(1010, "info", "n2"));
    const b: any = await h["logs.tail"]!({ cursor: a.nextCursor }, ctx());
    assert.deepEqual(msgs(b), ["n1", "n2"]);
    const c: any = await h["logs.tail"]!({ cursor: b.nextCursor }, ctx());
    assert.deepEqual(msgs(c), []);
  });
  it("a rotation in the middle of the tail loses and repeats nothing", async () => {
    const d = logsDir(); put(d, "core.log", rec(0, "info", "m0") + rec(10, "info", "m1"));
    const h = createLogsMethods({ dir: d, ...fakeTime() });
    let cur = ((await h["logs.tail"]!({}, ctx())) as any).nextCursor as string;
    const seen: string[] = [];
    const step = async (): Promise<void> => { const r: any = await h["logs.tail"]!({ cursor: cur }, ctx()); seen.push(...msgs(r)); cur = r.nextCursor; };
    add(d, "core.log", rec(20, "info", "a")); await step();
    rotate(d, "core.log"); add(d, "core.log", rec(30, "info", "b") + rec(40, "info", "c")); await step();
    rotate(d, "core.log"); rotate(d, "core.log"); add(d, "core.log", rec(50, "info", "d")); await step();
    await step();
    assert.deepEqual(seen, ["a", "b", "c", "d"]);
  });
  it("a tail whose filter matches nothing still anchors, so a later match is found", async () => {
    const d = logsDir(); put(d, "core.log", rec(0, "info", "quiet"));
    const h = createLogsMethods({ dir: d, ...fakeTime() });
    const a: any = await h["logs.tail"]!({ minLevel: "error" }, ctx());
    assert.deepEqual(msgs(a), []); assert.equal(typeof a.nextCursor, "string");
    add(d, "core.log", rec(10, "info", "still quiet") + rec(20, "error", "boom"));
    assert.deepEqual(msgs(await h["logs.tail"]!({ minLevel: "error", cursor: a.nextCursor }, ctx())), ["boom"]);
  });
  it("waitMs holds the call until a line arrives (long poll), then answers at once", async () => {
    const d = logsDir(); put(d, "core.log", rec(0, "info", "m0"));
    const time = fakeTime((n) => { if (n === 3) add(d, "core.log", rec(100, "info", "arrived")); });
    const h = createLogsMethods({ dir: d, pollMs: 250, ...time });
    const a: any = await h["logs.tail"]!({}, ctx());
    const r: any = await h["logs.tail"]!({ cursor: a.nextCursor, waitMs: 10_000 }, ctx());
    assert.deepEqual(msgs(r), ["arrived"]); assert.equal(time.sleeps(), 3);
  });
  it("waitMs ends empty when nothing comes, and ends early when the connection or the core stops", async () => {
    const d = logsDir(); put(d, "core.log", rec(0, "info", "m0"));
    const time = fakeTime();
    const h = createLogsMethods({ dir: d, pollMs: 250, ...time });
    const a: any = await h["logs.tail"]!({}, ctx());
    const r: any = await h["logs.tail"]!({ cursor: a.nextCursor, waitMs: 1000 }, ctx());
    assert.deepEqual(msgs(r), []); assert.equal(r.nextCursor, a.nextCursor); assert.equal(time.sleeps(), 4);
    const conn = new AbortController();
    const t2 = fakeTime((n) => { if (n === 2) conn.abort(); });
    const h2 = createLogsMethods({ dir: d, pollMs: 250, ...t2 });
    const r2: any = await h2["logs.tail"]!({ cursor: a.nextCursor, waitMs: 30_000 }, ctx(conn.signal));
    assert.deepEqual(msgs(r2), []); assert.equal(t2.sleeps(), 2);
    const core = new AbortController();
    const t3 = fakeTime((n) => { if (n === 1) core.abort(); });
    const r3: any = await createLogsMethods({ dir: d, signal: core.signal, pollMs: 250, ...t3 })["logs.tail"]!({ cursor: a.nextCursor, waitMs: 30_000 }, ctx());
    assert.deepEqual(msgs(r3), []); assert.equal(t3.sleeps(), 1);
  });
  it("redacts what it returns", async () => {
    const d = logsDir(); put(d, "core.log", rec(0, "error", "x", { attrs: { token: "abc", h: "Bearer abcdefghijklmnop" } }));
    const h = createLogsMethods({ dir: d, ...fakeTime() });
    const a: any = await h["logs.tail"]!({}, ctx());
    assert.ok(!JSON.stringify(a).includes("abcdefghijklmnop") && !JSON.stringify(a).includes('"abc"'));
  });
});
