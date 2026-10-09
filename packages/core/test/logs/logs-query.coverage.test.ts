import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CursorError, decodeCursor, fingerprint, mintCursor, runQuery, type Key, type LogFilter, type Order } from "../../src/logs/query.ts";
import { createRedactor } from "../../src/logs/redact.ts";

let root = ""; let dir = "";
beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), "p1b-query-cov-")); dir = path.join(root, "logs"); mkdirSync(dir); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const BASE = Date.UTC(2026, 9, 7, 9, 0, 0);
const iso = (ms: number): string => new Date(BASE + ms).toISOString();
const diag: LogFilter = { stream: "diagnostic" };
const audit: LogFilter = { stream: "audit" };
const put = (name: string, text: string): void => { writeFileSync(path.join(dir, name), text); };
const add = (name: string, text: string): void => { appendFileSync(path.join(dir, name), text); };
const rec = (ms: number, level: string, msg: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ ts: iso(ms), level, source: { kind: "harness", id: "core", version: null }, event: "core.test", msg, ...extra }) + "\n";
const q = (filter: LogFilter = diag, o: { order?: Order; limit?: number; cursor?: string; maxScanBytes?: number; maxLine?: number } = {}) =>
  runQuery({ dir, filter, order: o.order ?? "asc", limit: o.limit ?? 1000, ...(o.cursor ? { cursor: o.cursor } : {}), ...(o.maxScanBytes ? { maxScanBytes: o.maxScanBytes } : {}), ...(o.maxLine ? { maxLine: o.maxLine } : {}) });
const msgs = (r: { records: Array<{ record: Record<string, unknown> }> }): string[] => r.records.map(x => String(x.record.msg));

describe("cursor encoding", () => {
  const key: Key = { ts: "2026-10-07T09:00:00.000Z", h: "abcdef0123456789" };
  const enc = (o: unknown): string => Buffer.from(typeof o === "string" ? o : JSON.stringify(o), "utf8").toString("base64url");
  const fp = fingerprint(diag, "asc");

  it("mint and decode round-trip", () => {
    assert.deepEqual(decodeCursor(mintCursor(diag, "asc", key), fp), key);
  });
  it("a cursor is URL-safe base64 of a v1 document", () => {
    const c = mintCursor(diag, "desc", key);
    assert.match(c, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(JSON.parse(Buffer.from(c, "base64url").toString("utf8")), { v: 1, ts: key.ts, h: key.h, fp: fingerprint(diag, "desc") });
  });
  it("the fingerprint has 12 hex chars and depends on every filter field and the order", () => {
    const variants: Array<[string, LogFilter, Order]> = [
      ["base", diag, "asc"], ["order", diag, "desc"], ["stream", audit, "asc"], ["from", { ...diag, from: iso(0) }, "asc"], ["to", { ...diag, to: iso(0) }, "asc"],
      ["minLevel", { ...diag, minLevel: "warn" }, "asc"], ["component", { ...diag, component: "core" }, "asc"], ["text", { ...diag, text: "x" }, "asc"],
    ];
    const prints = variants.map(([, f, o]) => fingerprint(f, o));
    for (const p of prints) assert.match(p, /^[0-9a-f]{12}$/);
    assert.equal(new Set(prints).size, variants.length);
    assert.equal(fingerprint({ ...diag }, "asc"), fingerprint(diag, "asc"));
  });
  it("null and omitted filter fields fingerprint alike", () => {
    assert.equal(fingerprint({ stream: "diagnostic" } as LogFilter, "asc"), fingerprint(diag, "asc"));
  });
  const bad: Array<[string, string]> = [
    ["empty", ""], ["not base64/json", "!!!"], ["json null", enc("null")], ["json number", enc("5")], ["json string", enc('"x"')], ["json array", enc("[]")],
    ["json garbage", enc("{not json")], ["empty object", enc({})], ["wrong version", enc({ v: 2, ts: key.ts, h: "h", fp })], ["version as string", enc({ v: "1", ts: key.ts, h: "h", fp })],
    ["ts missing", enc({ v: 1, h: "h", fp })], ["ts not string", enc({ v: 1, ts: 5, h: "h", fp })], ["ts without millis", enc({ v: 1, ts: "2026-10-07T09:00:00Z", h: "h", fp })],
    ["ts with offset", enc({ v: 1, ts: "2026-10-07T09:00:00.000+00:00", h: "h", fp })], ["h not string", enc({ v: 1, ts: key.ts, h: 7, fp })], ["h missing", enc({ v: 1, ts: key.ts, fp })],
    ["fp not string", enc({ v: 1, ts: key.ts, h: "h", fp: 1 })], ["fp missing", enc({ v: 1, ts: key.ts, h: "h" })],
  ];
  for (const [label, c] of bad) it(`rejects as bad-cursor: ${label}`, () => {
    assert.throws(() => decodeCursor(c, fp), (e) => e instanceof CursorError && e.reason === "bad-cursor" && e.message === "bad-cursor" && e.name === "Error");
  });
  it("a foreign fingerprint is a cursor-mismatch", () => {
    assert.throws(() => decodeCursor(mintCursor(diag, "desc", key), fp), (e) => e instanceof CursorError && e.reason === "cursor-mismatch");
  });
  it("accepts an empty h string and ignores extra fields", () => {
    assert.deepEqual(decodeCursor(enc({ v: 1, ts: key.ts, h: "", fp, extra: true }), fp), { ts: key.ts, h: "" });
  });
});

describe("timestamps: legacy and numeric forms", () => {
  it("accepts `at` as epoch milliseconds (number) and normalises it", async () => {
    put("core.log", JSON.stringify({ at: BASE + 5, level: "info", msg: "num" }) + "\n" + JSON.stringify({ at: iso(10), level: "info", msg: "str" }) + "\n");
    const r = await q();
    assert.deepEqual(msgs(r), ["num", "str"]); assert.equal(r.records[0]!.ts, iso(5));
  });
  it("`ts` wins over `at`; a null/invalid `ts` falls back to `at` only via ??", async () => {
    put("core.log",
      JSON.stringify({ ts: iso(1), at: iso(99), level: "info", msg: "both" }) + "\n"
      + JSON.stringify({ ts: null, at: iso(2), level: "info", msg: "null-ts" }) + "\n"
      + JSON.stringify({ ts: "garbage", at: iso(3), level: "info", msg: "bad-ts" }) + "\n");
    const r = await q();
    assert.deepEqual(msgs(r), ["both", "null-ts"]); assert.equal(r.records[0]!.ts, iso(1)); assert.equal(r.corrupt, 1);
  });
  const corruptTs: Array<[string, unknown]> = [
    ["boolean", true], ["object", {}], ["array", [1]], ["out-of-range number", 1e17], ["negative out-of-range", -1e17], ["non-date string", "not a date"], ["empty string", ""], ["NaN-like string", "NaN"],
  ];
  for (const [label, v] of corruptTs) it(`counts a line with ${label} timestamp as corrupt`, async () => {
    put("core.log", JSON.stringify({ ts: v, level: "info", msg: "x" }) + "\n" + rec(1, "info", "ok"));
    const r = await q(); assert.deepEqual(msgs(r), ["ok"]); assert.equal(r.corrupt, 1);
  });
  it("accepts epoch zero and a date-only string", async () => {
    put("core.log", JSON.stringify({ ts: 0, level: "info", msg: "epoch" }) + "\n" + JSON.stringify({ ts: "2026-10-07", level: "info", msg: "dateonly" }) + "\n");
    const r = await q();
    assert.deepEqual(msgs(r), ["epoch", "dateonly"]); assert.equal(r.records[0]!.ts, "1970-01-01T00:00:00.000Z");
  });
  it("a JSON array or primitive line is corrupt", async () => {
    put("core.log", "[1,2]\n42\n\"str\"\nnull\ntrue\n" + rec(0, "info", "ok"));
    const r = await q(); assert.deepEqual(msgs(r), ["ok"]); assert.equal(r.corrupt, 5);
  });
  it("blank, CR and CRLF-only lines are skipped silently (not corrupt)", async () => {
    put("core.log", "\n\r\n" + rec(0, "info", "ok").replace("\n", "\r\n"));
    const r = await q(); assert.deepEqual(msgs(r), ["ok"]); assert.equal(r.corrupt, 0);
  });
  it("a level of the wrong type is corrupt on the diagnostic stream, but irrelevant on the audit stream", async () => {
    put("core.log", JSON.stringify({ ts: iso(0), level: 5, msg: "x" }) + "\n" + JSON.stringify({ ts: iso(1), msg: "nolevel" }) + "\n");
    assert.equal((await q()).corrupt, 2);
    put("audit.log", JSON.stringify({ ts: iso(0), level: 5, action: "a.b" }) + "\n" + JSON.stringify({ ts: iso(1), action: "a.c" }) + "\n");
    const a = await q(audit); assert.equal(a.records.length, 2); assert.equal(a.records[0]!.level, null);
  });
});

describe("filters: branches", () => {
  const fixture = (): void => {
    put("core.log",
      rec(0, "trace", "t") + rec(1, "debug", "d") + rec(2, "info", "i") + rec(3, "warn", "w") + rec(4, "error", "e") + rec(5, "fatal", "f"));
  };
  for (const [level, expected] of [["trace", ["t", "d", "i", "w", "e", "f"]], ["debug", ["d", "i", "w", "e", "f"]], ["info", ["i", "w", "e", "f"]], ["warn", ["w", "e", "f"]], ["error", ["e", "f"]], ["fatal", ["f"]]] as const) {
    it(`minLevel ${level}`, async () => { fixture(); assert.deepEqual(msgs(await q({ ...diag, minLevel: level })), [...expected]); });
  }
  it("from/to exclude outside, include the exact bound (both orders)", async () => {
    fixture();
    for (const order of ["asc", "desc"] as const) {
      const r = await q({ ...diag, from: iso(2), to: iso(4) }, { order });
      assert.deepEqual(msgs(r), order === "asc" ? ["i", "w", "e"] : ["e", "w", "i"]);
    }
  });
  it("from after the last line and to before the first line give empty results", async () => {
    fixture();
    assert.deepEqual((await q({ ...diag, from: iso(1000) })).records, []);
    assert.deepEqual((await q({ ...diag, to: iso(-1000) })).records, []);
    assert.deepEqual((await q({ ...diag, to: iso(-1000) }, { order: "desc" })).records, []);
    assert.deepEqual((await q({ ...diag, from: iso(1000) }, { order: "desc" })).records, []);
  });
  it("component matches the audit action's first segment, `role`, source.id and source.kind; a non-string action never matches", async () => {
    put("audit.log",
      JSON.stringify({ ts: iso(0), action: "rbac.denied", msg: "a" }) + "\n" + JSON.stringify({ ts: iso(1), action: 7, msg: "b" }) + "\n" + JSON.stringify({ ts: iso(2), msg: "c" }) + "\n");
    assert.deepEqual(msgs(await q({ ...audit, component: "rbac" })), ["a"]);
    assert.deepEqual(msgs(await q({ ...audit, component: "audit" })), ["a", "b", "c"]); // the file role
    assert.deepEqual(msgs(await q({ ...audit, component: "denied" })), []);
    put("legacy.log", JSON.stringify({ at: iso(0), level: "info", role: "worker", msg: "r" }) + "\n" + JSON.stringify({ at: iso(1), level: "info", source: null, msg: "nosrc" }) + "\n");
    assert.deepEqual(msgs(await q({ ...diag, component: "worker" })), ["r"]);
    assert.deepEqual(msgs(await q({ ...diag, component: "legacy" })), ["r", "nosrc"]);
  });
  it("component with a source that is not an object does not crash", async () => {
    put("core.log", JSON.stringify({ ts: iso(0), level: "info", source: "plain", msg: "s" }) + "\n" + JSON.stringify({ ts: iso(1), level: "info", source: {}, msg: "o" }) + "\n");
    assert.deepEqual(msgs(await q({ ...diag, component: "nothing" })), []);
    assert.deepEqual(msgs(await q({ ...diag, component: "core" })), ["s", "o"]);
  });
  it("component filter is exact: no prefix match, case sensitive", async () => {
    fixture();
    assert.deepEqual(await q({ ...diag, component: "cor" }).then(r => r.records), []);
    assert.deepEqual(await q({ ...diag, component: "Core" }).then(r => r.records), []);
  });
  it("an empty text needle matches every record; a needle only in the key names matches too", async () => {
    fixture();
    assert.equal((await q({ ...diag, text: "" })).records.length, 6);
    assert.equal((await q({ ...diag, text: "source" })).records.length, 6);
    assert.equal((await q({ ...diag, text: "does-not-occur" })).records.length, 0);
  });
  it("the redactor is injectable and applies before the text match", async () => {
    put("core.log", rec(0, "info", "plain", { attrs: { marker: "RAW" } }));
    const base = createRedactor();
    const r = await runQuery({ dir, filter: { ...diag, text: "masked" }, order: "asc", limit: 10, redactor: { ...base, value: (v: any) => ({ ...v, attrs: { marker: "MASKED" } }) } as any });
    assert.equal(r.records.length, 1); assert.deepEqual((r.records[0]!.record as any).attrs, { marker: "MASKED" });
    const miss = await runQuery({ dir, filter: { ...diag, text: "raw" }, order: "asc", limit: 10, redactor: { ...base, value: (v: any) => ({ ...v, attrs: { marker: "MASKED" } }) } as any });
    assert.equal(miss.records.length, 0);
  });
  it("limit 0 returns no records but reports a cursor when there is more; negative limit behaves like 0", async () => {
    fixture();
    const a = await q(diag, { limit: 0 }); assert.deepEqual(a.records, []); 
    assert.equal(a.nextCursor === null || typeof a.nextCursor === "string", true);
  });
  it("limit larger than the data returns everything and no cursor", async () => {
    fixture(); const r = await q(diag, { limit: 1_000_000 }); assert.equal(r.records.length, 6); assert.equal(r.nextCursor, null);
  });
  it("scanned reports the number of files and bytes", async () => {
    fixture(); put("other.log", rec(0, "info", "o"));
    const r = await q(); assert.equal(r.scanned.files, 2); assert.ok(r.scanned.bytes > 0);
  });
  it("empty directory: nothing, no cursor, firstKey/lastKey null", async () => {
    const r = await q(); assert.deepEqual(r.records, []); assert.equal(r.nextCursor, null); assert.equal(r.firstKey, null); assert.equal(r.lastKey, null); assert.equal(r.truncated, false);
  });
  it("an empty file contributes a scanned file but no records", async () => {
    put("core.log", ""); const r = await q(); assert.equal(r.scanned.files, 1); assert.deepEqual(r.records, []);
  });
});

describe("max line option", () => {
  it("a custom maxLine marks longer lines as corrupt in both orders", async () => {
    put("core.log", rec(0, "info", "a") + rec(1, "info", "x".repeat(500)) + rec(2, "info", "b"));
    for (const order of ["asc", "desc"] as const) {
      const r = await q(diag, { order, maxLine: 300 });
      assert.deepEqual(msgs(r).sort(), ["a", "b"]); assert.equal(r.corrupt, 1);
    }
  });
});

describe("ordering of equal timestamps", () => {
  it("lines with one timestamp come out in hash order, mirrored for desc", async () => {
    put("core.log", Array.from({ length: 12 }, (_, i) => rec(0, "info", `same-${i}`)).join(""));
    const asc = msgs(await q(diag, { order: "asc" })); const desc = msgs(await q(diag, { order: "desc" }));
    assert.equal(asc.length, 12); assert.deepEqual(desc, [...asc].reverse());
  });
  it("groups of equal timestamps stay sorted when interleaved with other times", async () => {
    put("core.log", rec(0, "info", "a1") + rec(0, "info", "a2") + rec(5, "info", "b") + rec(10, "info", "c1") + rec(10, "info", "c2"));
    const r = await q(); assert.deepEqual(msgs(r).map(m => m[0]), ["a", "a", "b", "c", "c"]);
  });
  it("a single group of more than 10 000 equal timestamps is cut and still delivers every line exactly once", async () => {
    const n = 10_050;
    put("core.log", Array.from({ length: n }, (_, i) => `{"ts":"${iso(0)}","level":"info","n":${i}}\n`).join(""));
    const r = await q(diag, { limit: 20_000 });
    assert.equal(r.records.length, n);
    assert.equal(new Set(r.records.map(x => (x.record as any).n)).size, n);
    const d = await q(diag, { limit: 20_000, order: "desc" });
    assert.equal(d.records.length, n);
  });
  it("identical lines at a page boundary stay together (up to 100 extra), then the cursor skips the rest", async () => {
    put("core.log", rec(0, "info", "first") + Array.from({ length: 5 }, () => rec(10, "info", "dup")).join("") + rec(20, "info", "last"));
    const r = await q(diag, { limit: 3 });
    assert.deepEqual(msgs(r), ["first", "dup", "dup", "dup", "dup", "dup"]);
    assert.equal(typeof r.nextCursor, "string");
    const next = await q(diag, { limit: 3, cursor: r.nextCursor! });
    assert.deepEqual(msgs(next), ["last"]);
  });
  it("at most 100 extra identical lines are held back at a boundary", async () => {
    put("core.log", Array.from({ length: 150 }, () => rec(10, "info", "dup")).join(""));
    const r = await q(diag, { limit: 2 });
    assert.equal(r.records.length, 102); // limit + 100
    assert.equal(typeof r.nextCursor, "string");
  });
  it("a non-identical line at the boundary is not pulled in", async () => {
    put("core.log", rec(10, "info", "a") + rec(10, "info", "b") + rec(10, "info", "c"));
    const r = await q(diag, { limit: 1 }); assert.equal(r.records.length, 1); assert.equal(typeof r.nextCursor, "string");
  });
});

describe("cursor continuation with ranges", () => {
  const many = (n: number): string => Array.from({ length: n }, (_, i) => rec(i * 10, "info", `m${i}`)).join("");
  it("asc: a cursor combined with `from` continues after the cursor, whichever is later", async () => {
    put("core.log", many(20));
    const p1 = await q({ ...diag, from: iso(30) }, { limit: 3 });
    assert.deepEqual(msgs(p1), ["m3", "m4", "m5"]);
    const p2 = await q({ ...diag, from: iso(30) }, { limit: 3, cursor: p1.nextCursor! });
    assert.deepEqual(msgs(p2), ["m6", "m7", "m8"]);
  });
  it("desc: a cursor combined with `to` continues before the cursor, whichever is earlier", async () => {
    put("core.log", many(20));
    const p1 = await q({ ...diag, to: iso(150) }, { limit: 3, order: "desc" });
    assert.deepEqual(msgs(p1), ["m15", "m14", "m13"]);
    const p2 = await q({ ...diag, to: iso(150) }, { limit: 3, order: "desc", cursor: p1.nextCursor! });
    assert.deepEqual(msgs(p2), ["m12", "m11", "m10"]);
  });
  it("a cursor from one filter is refused for each other filter field", async () => {
    put("core.log", many(10));
    const p = await q(diag, { limit: 2 });
    for (const other of [{ ...diag, from: iso(0) }, { ...diag, to: iso(1000) }, { ...diag, minLevel: "info" as const }, { ...diag, component: "core" }, { ...diag, text: "m" }, audit]) {
      await assert.rejects(q(other, { cursor: p.nextCursor! }), (e) => e instanceof CursorError && e.reason === "cursor-mismatch");
    }
  });
  it("a cursor at the very end yields an empty page and no further cursor", async () => {
    put("core.log", many(3));
    const p = await q(diag, { limit: 2 });
    const rest = await q(diag, { limit: 2, cursor: p.nextCursor! });
    assert.deepEqual(msgs(rest), ["m2"]); assert.equal(rest.nextCursor, null);
    const none = await q(diag, { limit: 2, cursor: mintCursor(diag, "asc", rest.lastKey!) });
    assert.deepEqual(none.records, []); assert.equal(none.nextCursor, null);
  });
});

describe("budget", () => {
  it("scanning stops when the budget is exceeded and says so", async () => {
    put("core.log", Array.from({ length: 6000 }, (_, i) => rec(i, "info", `m${i}`)).join(""));
    const r = await q(diag, { maxScanBytes: 130_000 });
    assert.equal(r.truncated, true); assert.ok(r.records.length > 0 && r.records.length < 6000); assert.equal(typeof r.nextCursor, "string");
    const rest = await q(diag, { maxScanBytes: 1_000_000, cursor: r.nextCursor! });
    assert.ok(rest.records.length > 0);
    assert.equal(msgs(r).at(-1), `m${r.records.length - 1}`);
    assert.equal(msgs(rest)[0], `m${r.records.length}`);
  });
  it("a budget of 0 falls back to the default (it is falsy in the caller only when omitted)", async () => {
    put("core.log", rec(0, "info", "a"));
    const r = await runQuery({ dir, filter: diag, order: "asc", limit: 10, maxScanBytes: 0 });
    assert.equal(r.truncated, true); // 0 is a real budget: the first read already exceeds it
  });
});

describe("large files: seek paths", () => {
  const N = 4000; const PAD = "p".repeat(80);
  const line = (i: number, style: "prefix" | "late" | "legacy-num" | "legacy-str"): string => {
    const t = BASE + i * 10;
    switch (style) {
      case "prefix": return `{"ts":"${new Date(t).toISOString()}","level":"info","msg":"n${i}","pad":"${PAD}"}\n`;
      case "late": return `{"level":"info","msg":"n${i}","pad":"${PAD}","ts":"${new Date(t).toISOString()}"}\n`;
      case "legacy-num": return `{"at":${t},"level":"info","msg":"n${i}","pad":"${PAD}"}\n`;
      case "legacy-str": return `{ "at" : "${new Date(t).toISOString()}" , "level":"info","msg":"n${i}","pad":"${PAD}"}\n`;
    }
  };
  for (const style of ["prefix", "late", "legacy-num", "legacy-str"] as const) {
    it(`seeks by timestamp when the timestamp is written as ${style}`, async () => {
      put("core.log", Array.from({ length: N }, (_, i) => line(i, style)).join(""));
      const total = (await q(diag, { limit: 100_000 })).scanned.bytes;
      const from = new Date(BASE + 3000 * 10).toISOString();
      const asc = await q({ ...diag, from }, { limit: 5 });
      assert.deepEqual(msgs(asc), ["n3000", "n3001", "n3002", "n3003", "n3004"]);
      assert.ok(asc.scanned.bytes < total / 2, `${asc.scanned.bytes} vs ${total}`);
      const to = new Date(BASE + 1000 * 10).toISOString();
      const desc = await q({ ...diag, to }, { limit: 3, order: "desc" });
      assert.deepEqual(msgs(desc), ["n1000", "n999", "n998"]);
      assert.ok(desc.scanned.bytes < total / 2, `${desc.scanned.bytes} vs ${total}`);
    });
  }
  it("falls back to a full scan when the probe line is corrupt (no timestamp), and is still correct", async () => {
    put("core.log", Array.from({ length: N }, (_, i) => (i % 2 ? "garbage line without json " + PAD + "\n" : line(i, "prefix"))).join(""));
    const r = await q({ ...diag, from: new Date(BASE + 3000 * 10).toISOString() }, { limit: 3 });
    assert.deepEqual(msgs(r), ["n3000", "n3002", "n3004"]);
  });
  it("falls back when probe lines are JSON but not objects", async () => {
    put("core.log", Array.from({ length: N }, (_, i) => (i % 2 ? "[1,2,3] " + "\n" : line(i, "prefix"))).join(""));
    const r = await q({ ...diag, from: new Date(BASE + 3500 * 10).toISOString() }, { limit: 2 });
    assert.deepEqual(msgs(r), ["n3500", "n3502"]);
  });
  it("falls back when a probe line is JSON null or an invalid epoch", async () => {
    put("core.log", Array.from({ length: N }, (_, i) => (i % 3 === 1 ? "null\n" : i % 3 === 2 ? `{"at":99999999999999999,"level":"info","pad":"${PAD}"}\n` : line(i, "prefix"))).join(""));
    const r = await q({ ...diag, from: new Date(BASE + 3000 * 10).toISOString() }, { limit: 2 });
    assert.deepEqual(msgs(r), ["n3000", "n3003"]);
  });
  it("from and to together on a large file", async () => {
    put("core.log", Array.from({ length: N }, (_, i) => line(i, "prefix")).join(""));
    const r = await q({ ...diag, from: new Date(BASE + 2000 * 10).toISOString(), to: new Date(BASE + 2002 * 10).toISOString() });
    assert.deepEqual(msgs(r), ["n2000", "n2001", "n2002"]);
    const d = await q({ ...diag, from: new Date(BASE + 2000 * 10).toISOString(), to: new Date(BASE + 2002 * 10).toISOString() }, { order: "desc" });
    assert.deepEqual(msgs(d), ["n2002", "n2001", "n2000"]);
  });
  it("a cursor on a large file continues exactly after it in both orders", async () => {
    put("core.log", Array.from({ length: N }, (_, i) => line(i, "prefix")).join(""));
    const a1 = await q(diag, { limit: 3 }); const a2 = await q(diag, { limit: 3, cursor: a1.nextCursor! });
    assert.deepEqual(msgs(a2), ["n3", "n4", "n5"]);
    const d1 = await q(diag, { limit: 3, order: "desc" }); const d2 = await q(diag, { limit: 3, order: "desc", cursor: d1.nextCursor! });
    assert.deepEqual(msgs(d2), ["n3996", "n3995", "n3994"]);
  });
  it("a stale cursor from the far past scans on a large file and finds the right continuation", async () => {
    put("core.log", Array.from({ length: N }, (_, i) => line(i, "prefix")).join(""));
    const c = mintCursor(diag, "asc", { ts: new Date(BASE + 3990 * 10 + 5).toISOString(), h: "0000000000000000" });
    const r = await q(diag, { cursor: c, limit: 100 });
    assert.equal(r.records.length, 9); assert.equal(msgs(r)[0], "n3991");
  });
  it("a line that is out of order inside the seek window is still seen", async () => {
    const lines = Array.from({ length: N }, (_, i) => line(i, "prefix"));
    const swap = lines[2000]!; lines[2000] = lines[2001]!; lines[2001] = swap;
    put("core.log", lines.join(""));
    const r = await q({ ...diag, from: new Date(BASE + 2000 * 10).toISOString() }, { limit: 2 });
    assert.deepEqual(msgs(r).sort(), ["n2000", "n2001"]);
  });
});

describe("multiple files and streams", () => {
  it("merges rotated generations of different components in time order in both directions", async () => {
    put("core.log.2", rec(0, "info", "c0") + rec(30, "info", "c3"));
    put("core.log.1", rec(40, "info", "c4"));
    put("core.log", rec(60, "info", "c6"));
    put("web.log", rec(10, "info", "w1") + rec(50, "info", "w5"));
    assert.deepEqual(msgs(await q(diag, { order: "asc" })), ["c0", "w1", "c3", "c4", "w5", "c6"]);
    assert.deepEqual(msgs(await q(diag, { order: "desc" })), ["c6", "w5", "c4", "c3", "w1", "c0"]);
  });
  it("audit stream reads only audit files including rotated ones", async () => {
    put("audit.log.1", JSON.stringify({ ts: iso(0), action: "a.b" }) + "\n"); put("audit.log", JSON.stringify({ ts: iso(5), action: "a.c" }) + "\n"); put("core.log", rec(1, "info", "d"));
    const r = await q(audit); assert.deepEqual(r.records.map(x => (x.record as any).action), ["a.b", "a.c"]);
  });
  it("payload.log is never read", async () => {
    put("payload.log", rec(0, "info", "secret payload")); put("core.log", rec(1, "info", "ok"));
    assert.deepEqual(msgs(await q()), ["ok"]);
    assert.deepEqual((await q(audit)).records, []);
  });
  it("closes all descriptors and can be repeated many times", async () => {
    put("core.log", rec(0, "info", "a"));
    for (let i = 0; i < 50; i++) assert.equal((await q()).records.length, 1);
  });
});
