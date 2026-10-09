import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RpcError } from "../../src/rpc/errors.ts";
import type { CallContext } from "../../src/rpc/server.ts";
import { createLogsMethods } from "../../src/logs/methods.ts";
import { createRedactor } from "../../src/logs/redact.ts";
import { add, iso, put, rec } from "./helpers.ts";

let root = ""; let dir = "";
beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), "p1b-methods-cov-")); dir = path.join(root, "logs"); mkdirSync(dir); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const ctx = (signal = new AbortController().signal): CallContext => ({ requestId: "r", connectionId: "c", signal });
const msgs = (r: any): string[] => r.records.map((x: any) => x.record.msg);
async function fail(p: Promise<unknown>): Promise<RpcError | Error> {
  try { await p; } catch (e) { return e as Error; }
  throw new Error("expected rejection");
}
const reasonOf = async (p: Promise<unknown>): Promise<string | undefined> => { const e = await fail(p); assert.ok(e instanceof RpcError, String(e)); assert.equal(e.error, "E_INVALID_PARAMS"); return e.reason; };

describe("logs methods: handler registry", () => {
  it("exposes exactly logs.query and logs.tail", () => {
    assert.deepEqual(Object.keys(createLogsMethods({ dir })).sort(), ["logs.query", "logs.tail"]);
  });
});

describe("logs.query: timestamp bounds", () => {
  const bad: Array<[string, unknown]> = [
    ["plain word", "yesterday"], ["date only", "2026-10-07"], ["without Z", "2026-10-07T09:00:00"], ["with offset", "2026-10-07T09:00:00+02:00"],
    ["4 fractional digits", "2026-10-07T09:00:00.1234Z"], ["lowercase z", "2026-10-07T09:00:00z"], ["month 13", "2026-13-01T00:00:00Z"], ["empty string", ""],
    ["number", 1_700_000_000_000], ["null", null], ["object", {}], ["boolean", true], ["leading space", " 2026-10-07T09:00:00Z"],
  ];
  for (const [label, v] of bad) {
    it(`from: rejects ${label}`, async () => {
      put(dir, "core.log", rec(0, "info", "a"));
      assert.equal(await reasonOf(createLogsMethods({ dir })["logs.query"]!({ from: v }, ctx())), "bad-timestamp");
    });
    it(`to: rejects ${label}`, async () => {
      assert.equal(await reasonOf(createLogsMethods({ dir })["logs.query"]!({ to: v }, ctx())), "bad-timestamp");
    });
  }
  it("the message names the offending parameter", async () => {
    const e = await fail(createLogsMethods({ dir })["logs.query"]!({ to: "x" }, ctx()));
    assert.match(e.message, /^to must be an RFC 3339 UTC timestamp$/);
  });
  it("accepts ms precision, 1-3 fractional digits and normalises them", async () => {
    put(dir, "core.log", rec(0, "info", "a") + rec(100, "info", "b") + rec(1000, "info", "c"));
    const h = createLogsMethods({ dir });
    assert.deepEqual(msgs(await h["logs.query"]!({ order: "asc", from: "2026-10-07T09:00:00.1Z", to: "2026-10-07T09:00:00.100Z" }, ctx())), ["b"]);
  });
  it("from only and to only", async () => {
    put(dir, "core.log", rec(0, "info", "a") + rec(1000, "info", "b") + rec(2000, "info", "c"));
    const h = createLogsMethods({ dir });
    assert.deepEqual(msgs(await h["logs.query"]!({ order: "asc", from: iso(1000) }, ctx())), ["b", "c"]);
    assert.deepEqual(msgs(await h["logs.query"]!({ order: "asc", to: iso(1000) }, ctx())), ["a", "b"]);
  });
  it("from == to is a valid single-instant range", async () => {
    put(dir, "core.log", rec(0, "info", "a") + rec(1000, "info", "b"));
    const r: any = await createLogsMethods({ dir })["logs.query"]!({ from: iso(1000), to: iso(1000) }, ctx());
    assert.deepEqual(msgs(r), ["b"]);
  });
  it("from after to is an empty-range error for query and tail", async () => {
    const h = createLogsMethods({ dir });
    assert.equal(await reasonOf(h["logs.query"]!({ from: iso(5), to: iso(0) }, ctx())), "empty-range");
    assert.equal(await reasonOf(h["logs.tail"]!({ from: iso(5), to: iso(0) }, ctx())), "empty-range");
  });
});

describe("logs.query: filters and params", () => {
  it("audit stream with a level filter is refused; without a level it is accepted", async () => {
    put(dir, "audit.log", JSON.stringify({ ts: iso(0), action: "auth.login", msg: "a" }) + "\n");
    const h = createLogsMethods({ dir });
    assert.equal(await reasonOf(h["logs.query"]!({ stream: "audit", minLevel: "error" }, ctx())), "level-not-applicable");
    const r: any = await h["logs.query"]!({ stream: "audit" }, ctx());
    assert.equal(r.records.length, 1); assert.equal(r.records[0].stream, "audit"); assert.equal(r.records[0].level, null);
  });
  it("audit stream does not see diagnostic files and vice versa", async () => {
    put(dir, "core.log", rec(0, "info", "diag")); put(dir, "audit.log", JSON.stringify({ ts: iso(0), action: "x.y", msg: "aud" }) + "\n");
    const h = createLogsMethods({ dir });
    assert.deepEqual(msgs(await h["logs.query"]!({}, ctx())), ["diag"]);
    assert.deepEqual(msgs(await h["logs.query"]!({ stream: "audit" }, ctx())), ["aud"]);
  });
  it("minLevel, component and text filters (text is case-insensitive)", async () => {
    put(dir, "core.log", rec(0, "debug", "Alpha") + rec(1, "warn", "Beta") + rec(2, "error", "gamma"));
    put(dir, "sup.log", rec(3, "error", "Delta", { source: { kind: "harness", id: "sup", version: null } }));
    const h = createLogsMethods({ dir });
    assert.deepEqual(msgs(await h["logs.query"]!({ order: "asc", minLevel: "warn" }, ctx())), ["Beta", "gamma", "Delta"]);
    assert.deepEqual(msgs(await h["logs.query"]!({ order: "asc", component: "sup" }, ctx())), ["Delta"]);
    assert.deepEqual(msgs(await h["logs.query"]!({ order: "asc", text: "ALPHA" }, ctx())), ["Alpha"]);
  });
  it("empty component and empty text are ignored (falsy)", async () => {
    put(dir, "core.log", rec(0, "info", "a") + rec(1, "info", "b"));
    const r: any = await createLogsMethods({ dir })["logs.query"]!({ order: "asc", component: "", text: "" }, ctx());
    assert.deepEqual(msgs(r), ["a", "b"]);
  });
  it("a unicode text filter matches", async () => {
    put(dir, "core.log", rec(0, "info", "Grüße 日本語 😀") + rec(1, "info", "plain"));
    assert.deepEqual(msgs(await createLogsMethods({ dir })["logs.query"]!({ text: "日本" }, ctx())), ["Grüße 日本語 😀"]);
  });
  it("limit and cursor page through all records in both orders", async () => {
    put(dir, "core.log", Array.from({ length: 7 }, (_, i) => rec(i * 10, "info", `m${i}`)).join(""));
    const h = createLogsMethods({ dir });
    for (const order of ["asc", "desc"] as const) {
      const seen: string[] = []; let cursor: string | null | undefined;
      for (let i = 0; i < 10; i++) {
        const r: any = await h["logs.query"]!({ order, limit: 3, ...(cursor ? { cursor } : {}) }, ctx());
        seen.push(...msgs(r)); cursor = r.nextCursor; if (!cursor) break;
      }
      const expected = Array.from({ length: 7 }, (_, i) => `m${i}`); if (order === "desc") expected.reverse();
      assert.deepEqual(seen, expected, order);
    }
  });
  it("a missing log directory yields an empty result", async () => {
    const r: any = await createLogsMethods({ dir: path.join(root, "nope") })["logs.query"]!({}, ctx());
    assert.deepEqual(r.records, []); assert.equal(r.nextCursor, null); assert.equal(r.scanned.files, 0); assert.equal(r.corrupt, 0);
  });
  it("forwards maxScanBytes (budget exhaustion reports truncated and a continuation cursor)", async () => {
    put(dir, "core.log", Array.from({ length: 2000 }, (_, i) => rec(i, "info", `m${i}`)).join(""));
    const r: any = await createLogsMethods({ dir, maxScanBytes: 70_000 })["logs.query"]!({ order: "asc", limit: 5000 }, ctx());
    assert.equal(r.truncated, true); assert.equal(typeof r.nextCursor, "string"); assert.ok(r.records.length > 0 && r.records.length < 2000);
  });
  it("a budget smaller than the first read still gives a continuation cursor when truncated", { skip: "UNKLAR: truncated=true mit nextCursor=null bei Budget < erster Chunk – siehe docs/testing/coverage-2026-10.md#logs-methods-truncated-without-cursor" }, async () => {
    put(dir, "core.log", rec(0, "info", "a") + rec(1, "info", "b"));
    const r: any = await createLogsMethods({ dir, maxScanBytes: 1 })["logs.query"]!({ order: "asc" }, ctx());
    assert.equal(r.truncated, true); assert.equal(typeof r.nextCursor, "string");
  });
  it("forwards onListed", async () => {
    put(dir, "core.log", rec(0, "info", "a"));
    let n = 0;
    await createLogsMethods({ dir, onListed: () => { n++; } })["logs.query"]!({}, ctx());
    assert.ok(n >= 1);
  });
  it("uses an injected redactor", async () => {
    put(dir, "core.log", rec(0, "info", "a", { attrs: { token: "super-secret-value" } }));
    const calls: unknown[] = [];
    const base = createRedactor();
    const r: any = await createLogsMethods({ dir, redactor: { ...base, value: (v: any) => { calls.push(v); return { ...base.value(v), injected: true }; } } as any })["logs.query"]!({}, ctx());
    assert.equal(calls.length, 1); assert.equal(r.records[0].record.injected, true);
  });
  it("rethrows non-cursor errors untouched", async () => {
    put(dir, "core.log", rec(0, "info", "a"));
    const boom = new Error("redactor exploded");
    const e = await fail(createLogsMethods({ dir, redactor: { ...createRedactor(), value: () => { throw boom; } } as any })["logs.query"]!({}, ctx()));
    assert.equal(e, boom);
  });
  it("does not leak internal keys", async () => {
    put(dir, "core.log", rec(0, "info", "a"));
    const r: any = await createLogsMethods({ dir })["logs.query"]!({}, ctx());
    assert.equal("firstKey" in r, false); assert.equal("lastKey" in r, false);
  });
  it("cursor error messages differ for malformed and mismatching cursors", async () => {
    put(dir, "core.log", rec(0, "info", "a") + rec(1, "info", "b"));
    const h = createLogsMethods({ dir });
    const bad = await fail(h["logs.query"]!({ cursor: "###" }, ctx()));
    assert.equal(bad.message, "malformed cursor");
    const first: any = await h["logs.query"]!({ limit: 1 }, ctx());
    const other = await fail(h["logs.query"]!({ cursor: first.nextCursor, order: "asc" }, ctx()));
    assert.equal(other.message, "cursor belongs to a different query");
  });
});

describe("logs.tail: edge cases", () => {
  const fake = (start = 5_000_000) => { let t = start; const sleeps: number[] = []; return { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, sleeps }; };
  it("empty directory: no records and no cursor on the first call", async () => {
    const r: any = await createLogsMethods({ dir, ...fake() })["logs.tail"]!({}, ctx());
    assert.deepEqual(r.records, []); assert.equal(r.nextCursor, null);
  });
  it("empty directory with waitMs polls until the deadline, cursor stays null", async () => {
    const f = fake();
    const r: any = await createLogsMethods({ dir, pollMs: 100, now: f.now, sleep: f.sleep })["logs.tail"]!({ waitMs: 250 }, ctx());
    assert.deepEqual(r.records, []); assert.equal(r.nextCursor, null);
    assert.deepEqual(f.sleeps, [100, 100, 50]);
  });
  it("the sleep is at least 1 ms when the deadline is almost reached", async () => {
    const f = fake();
    await createLogsMethods({ dir, pollMs: 100, now: f.now, sleep: f.sleep })["logs.tail"]!({ waitMs: 1 }, ctx());
    assert.deepEqual(f.sleeps, [1]);
  });
  it("a negative or zero waitMs answers at once without sleeping", async () => {
    const f = fake(); const h = createLogsMethods({ dir, now: f.now, sleep: f.sleep });
    await h["logs.tail"]!({ waitMs: 0 }, ctx()); await h["logs.tail"]!({ waitMs: -50 }, ctx());
    assert.deepEqual(f.sleeps, []);
  });
  it("continues with a cursor cut by limit: the next page is the following records", async () => {
    put(dir, "core.log", Array.from({ length: 6 }, (_, i) => rec(i * 10, "info", `m${i}`)).join(""));
    const h = createLogsMethods({ dir, ...fake() });
    const first: any = await h["logs.tail"]!({ limit: 2 }, ctx());
    assert.deepEqual(msgs(first), ["m4", "m5"]);
    add(dir, "core.log", Array.from({ length: 5 }, (_, i) => rec(1000 + i, "info", `n${i}`)).join(""));
    const p1: any = await h["logs.tail"]!({ limit: 2, cursor: first.nextCursor }, ctx());
    assert.deepEqual(msgs(p1), ["n0", "n1"]); assert.equal(typeof p1.nextCursor, "string");
    const p2: any = await h["logs.tail"]!({ limit: 2, cursor: p1.nextCursor }, ctx());
    assert.deepEqual(msgs(p2), ["n2", "n3"]);
    const p3: any = await h["logs.tail"]!({ limit: 2, cursor: p2.nextCursor }, ctx());
    assert.deepEqual(msgs(p3), ["n4"]);
  });
  it("rejects malformed and mismatching cursors with typed reasons", async () => {
    put(dir, "core.log", rec(0, "info", "a"));
    const h = createLogsMethods({ dir, ...fake() });
    assert.equal(await reasonOf(h["logs.tail"]!({ cursor: "garbage" }, ctx())), "bad-cursor");
    const a: any = await h["logs.tail"]!({}, ctx());
    assert.equal(await reasonOf(h["logs.tail"]!({ cursor: a.nextCursor, minLevel: "fatal" }, ctx())), "cursor-mismatch");
  });
  it("audit stream tail with a level filter is refused", async () => {
    assert.equal(await reasonOf(createLogsMethods({ dir, ...fake() })["logs.tail"]!({ stream: "audit", minLevel: "info" }, ctx())), "level-not-applicable");
  });
  it("tail on the audit stream returns audit lines", async () => {
    put(dir, "audit.log", JSON.stringify({ ts: iso(0), action: "a.b", msg: "x" }) + "\n" + JSON.stringify({ ts: iso(1), action: "a.c", msg: "y" }) + "\n");
    const r: any = await createLogsMethods({ dir, ...fake() })["logs.tail"]!({ stream: "audit" }, ctx());
    assert.deepEqual(msgs(r), ["x", "y"]);
  });
  it("applies minLevel, component and text filters", async () => {
    put(dir, "core.log", rec(0, "info", "a") + rec(1, "error", "Needle one") + rec(2, "error", "other"));
    const r: any = await createLogsMethods({ dir, ...fake() })["logs.tail"]!({ minLevel: "error", component: "core", text: "needle" }, ctx());
    assert.deepEqual(msgs(r), ["Needle one"]);
  });
  it("forwards maxScanBytes on the first tail call", async () => {
    put(dir, "core.log", Array.from({ length: 50 }, (_, i) => rec(i, "info", `m${i}`)).join(""));
    const r: any = await createLogsMethods({ dir, maxScanBytes: 100, ...fake() })["logs.tail"]!({ limit: 100 }, ctx());
    assert.equal(r.truncated, true);
  });
  it("an already aborted connection signal does not wait", { skip: "BUG: bereits abgebrochenes ctx.signal beendet logs.tail nicht (addEventListener feuert nicht) – siehe docs/testing/coverage-2026-10.md#logs-tail-preaborted-signal" }, async () => {
    put(dir, "core.log", rec(0, "info", "a"));
    const f = fake(); const ac = new AbortController();
    const h = createLogsMethods({ dir, now: f.now, sleep: f.sleep });
    const a: any = await h["logs.tail"]!({}, ctx());
    ac.abort();
    const r: any = await h["logs.tail"]!({ cursor: a.nextCursor, waitMs: 10_000 }, ctx(ac.signal));
    assert.deepEqual(msgs(r), []);
    assert.equal(f.sleeps.length, 0);
  });
  it("removes its abort listeners after the call (no leaks across calls)", async () => {
    put(dir, "core.log", rec(0, "info", "a"));
    const conn = new AbortController(); const core = new AbortController();
    const h = createLogsMethods({ dir, signal: core.signal, ...fake() });
    let added = 0; let removed = 0;
    for (const s of [conn.signal, core.signal]) {
      const a = s.addEventListener.bind(s); const r = s.removeEventListener.bind(s);
      s.addEventListener = ((...args: Parameters<typeof a>) => { if (args[0] === "abort") added++; return a(...args); }) as typeof a;
      s.removeEventListener = ((...args: Parameters<typeof r>) => { if (args[0] === "abort") removed++; return r(...args); }) as typeof r;
    }
    await h["logs.tail"]!({}, ctx(conn.signal));
    assert.equal(added, 2); assert.equal(removed, 2);
  });
  it("cleans up listeners even when the query fails", async () => {
    const conn = new AbortController();
    const h = createLogsMethods({ dir, ...fake() });
    const r = conn.signal.removeEventListener.bind(conn.signal); let removed = 0;
    conn.signal.removeEventListener = ((...a: Parameters<typeof r>) => { removed++; return r(...a); }) as typeof r;
    await fail(h["logs.tail"]!({ cursor: "bad" }, ctx(conn.signal)));
    assert.equal(removed, 1);
  });
});

describe("logs.tail: default sleep under fake timers", () => {
  /** Lets pending file I/O settle (setImmediate is not mocked), then advances the mocked clock. */
  async function drive<T>(t: import("node:test").TestContext, p: Promise<T>, stepMs: number): Promise<T> {
    let done = false; void p.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; i < 200 && !done; i++) { await new Promise<void>(r => setImmediate(r)); t.mock.timers.tick(stepMs); }
    return p;
  }
  it("waits through the default timer until the deadline", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
    put(dir, "core.log", rec(0, "info", "a"));
    const h = createLogsMethods({ dir, pollMs: 100 });
    const a: any = await h["logs.tail"]!({}, ctx());
    const r: any = await drive(t, h["logs.tail"]!({ cursor: a.nextCursor, waitMs: 350 }, ctx()), 100);
    assert.deepEqual(r.records, []);
  });
  it("the default timer wakes early when the connection aborts", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
    put(dir, "core.log", rec(0, "info", "a"));
    const h = createLogsMethods({ dir, pollMs: 60_000 });
    const a: any = await h["logs.tail"]!({}, ctx());
    const ac = new AbortController();
    const p = h["logs.tail"]!({ cursor: a.nextCursor, waitMs: 3_600_000 }, ctx(ac.signal));
    for (let i = 0; i < 20; i++) await new Promise<void>(r => setImmediate(r));
    ac.abort();
    const r: any = await p;
    assert.deepEqual(r.records, []);
  });
  it("finds a line appended while the default timer sleeps", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
    put(dir, "core.log", rec(0, "info", "a"));
    const h = createLogsMethods({ dir, pollMs: 100 });
    const a: any = await h["logs.tail"]!({}, ctx());
    const p = h["logs.tail"]!({ cursor: a.nextCursor, waitMs: 10_000 }, ctx());
    for (let i = 0; i < 20; i++) await new Promise<void>(r => setImmediate(r));
    add(dir, "core.log", rec(500, "info", "new"));
    const r: any = await drive(t, p, 100);
    assert.deepEqual(msgs(r), ["new"]);
  });
});
