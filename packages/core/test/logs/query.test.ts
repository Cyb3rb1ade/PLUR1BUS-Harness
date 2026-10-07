import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runQuery, type LogFilter, type Order } from "../../src/logs/query.ts";
import { CursorError } from "../../src/logs/query.ts";
import { add, iso, legacy, logsDir, put, rec, rotate } from "./helpers.ts";

const diag: LogFilter = { stream: "diagnostic" };
const q = (dir: string, filter: LogFilter = diag, o: { order?: Order; limit?: number; cursor?: string; onListed?: () => void; maxScanBytes?: number } = {}) =>
  runQuery({ dir, filter, order: o.order ?? "asc", limit: o.limit ?? 100, ...(o.cursor ? { cursor: o.cursor } : {}), ...(o.onListed ? { onListed: o.onListed } : {}), ...(o.maxScanBytes ? { maxScanBytes: o.maxScanBytes } : {}) });
const msgs = (r: { records: Array<{ record: Record<string, unknown> }> }): string[] => r.records.map((x) => String(x.record.msg));

describe("logs query: reading", () => {
  it("merges the live file and its rotated copies, oldest first or newest first", async () => {
    const d = logsDir();
    put(d, "core.log.2", rec(0, "info", "a") + rec(1000, "info", "b"));
    put(d, "core.log.1", rec(2000, "info", "c") + rec(3000, "info", "d"));
    put(d, "core.log", rec(4000, "info", "e"));
    assert.deepEqual(msgs(await q(d)), ["a", "b", "c", "d", "e"]);
    assert.deepEqual(msgs(await q(d, diag, { order: "desc" })), ["e", "d", "c", "b", "a"]);
  });
  it("merges several components by time and reports the file role as the component", async () => {
    const d = logsDir();
    put(d, "core.log", rec(0, "info", "c0") + rec(2000, "info", "c2"));
    put(d, "supervisor.log", legacy(1000, "warn", "s1", "supervisor") + legacy(3000, "info", "s3", "supervisor"));
    const r = await q(d);
    assert.deepEqual(msgs(r), ["c0", "s1", "c2", "s3"]);
    assert.deepEqual(r.records.map((x) => x.component), ["core", "supervisor", "core", "supervisor"]);
    assert.equal(r.records[1]!.ts, iso(1000)); // the legacy `at` is normalised to ts
  });
  it("ignores an unterminated last line and counts corrupt lines instead of failing", async () => {
    const d = logsDir();
    put(d, "core.log", rec(0, "info", "ok1") + "not json at all\n" + '{"ts":"2026-10-07T09:00:01.000Z","level":"loud","msg":"bad level"}\n' + '{"level":"info","msg":"no ts"}\n' + "[1,2]\n" + rec(5000, "info", "ok2") + '{"ts":"2026-10-07T09:00:09.000Z","level":"info","msg":"half');
    const r = await q(d);
    assert.deepEqual(msgs(r), ["ok1", "ok2"]);
    assert.equal(r.corrupt, 4);
    assert.equal(r.truncated, false);
  });
  it("counts a line over the cap once and keeps going", async () => {
    const d = logsDir();
    put(d, "core.log", rec(0, "info", "a") + rec(1000, "info", "x".repeat(300_000)) + rec(2000, "info", "b"));
    const r = await q(d);
    assert.deepEqual(msgs(r), ["a", "b"]); assert.equal(r.corrupt, 1);
  });
  it("does not read payload.log, *.out.log is its own component, symlinks are not followed, a missing directory is empty", async () => {
    const d = logsDir();
    put(d, "payload.log", rec(0, "info", "payload"));
    put(d, "hermes.out.log", rec(1000, "info", "child output"));
    const outside = put(logsDir(), "secret.log", rec(2000, "info", "outside"));
    try { symlinkSync(outside, path.join(d, "evil.log")); } catch { /* no symlinks on this platform */ }
    const r = await q(d);
    assert.deepEqual(msgs(r), ["child output"]); assert.equal(r.records[0]!.component, "hermes.out");
    assert.deepEqual((await q(path.join(d, "nope"))).records, []);
  });
  it("serves the audit stream from audit.log only, with a null level", async () => {
    const d = logsDir();
    put(d, "core.log", rec(0, "info", "diag"));
    put(d, "audit.log", JSON.stringify({ at: iso(1000), actor: { user: "u", host: "h" }, action: "rbac.denied", target: "jobs.run", detail: { reason: "role-denied" } }) + "\n"
      + JSON.stringify({ ts: iso(2000), actor: { user: "u", host: "h" }, action: "config.set", target: "core.logLevel", detail: {} }) + "\n");
    const a = await q(d, { stream: "audit" });
    assert.deepEqual(a.records.map((x) => [x.ts, x.level, x.component, x.stream]), [[iso(1000), null, "audit", "audit"], [iso(2000), null, "audit", "audit"]]);
    assert.deepEqual((await q(d, { stream: "audit", component: "rbac" })).records.map((x) => x.record.action), ["rbac.denied"]);
    assert.deepEqual(msgs(await q(d)), ["diag"]);
  });
});

describe("logs query: filters", () => {
  const fixture = (): string => {
    const d = logsDir();
    put(d, "core.log",
      rec(0, "debug", "boot", { source: { kind: "harness", id: "core", version: null } })
      + rec(1000, "info", "listening on socket")
      + rec(2000, "warn", "slow recall", { source: { kind: "provider", id: "openai", version: "p@3" } })
      + rec(3000, "error", "provider failed: Timeout")
      + rec(4000, "info", "done"));
    put(d, "supervisor.log", legacy(2500, "error", "child exited", "supervisor"));
    return d;
  };
  it("time range is inclusive on both ends", async () => {
    const d = fixture();
    assert.deepEqual(msgs(await q(d, { ...diag, from: iso(1000), to: iso(3000) })), ["listening on socket", "slow recall", "child exited", "provider failed: Timeout"]);
    assert.deepEqual(msgs(await q(d, { ...diag, from: iso(4000) })), ["done"]);
    assert.deepEqual(msgs(await q(d, { ...diag, to: iso(0) })), ["boot"]);
  });
  it("minLevel keeps that level and above", async () => {
    const d = fixture();
    assert.deepEqual(msgs(await q(d, { ...diag, minLevel: "warn" })), ["slow recall", "child exited", "provider failed: Timeout"]);
    assert.deepEqual(msgs(await q(d, { ...diag, minLevel: "error" })), ["child exited", "provider failed: Timeout"]);
  });
  it("component matches the file role, source.id, or source.kind", async () => {
    const d = fixture();
    assert.deepEqual(msgs(await q(d, { ...diag, component: "supervisor" })), ["child exited"]);
    assert.deepEqual(msgs(await q(d, { ...diag, component: "openai" })), ["slow recall"]);
    assert.deepEqual(msgs(await q(d, { ...diag, component: "provider" })), ["slow recall"]);
    assert.deepEqual((await q(d, { ...diag, component: "core" })).records.length, 5);
    assert.deepEqual((await q(d, { ...diag, component: "nobody" })).records, []);
  });
  it("text is a case-insensitive substring of the record", async () => {
    const d = fixture();
    assert.deepEqual(msgs(await q(d, { ...diag, text: "TIMEOUT" })), ["provider failed: Timeout"]);
    assert.deepEqual(msgs(await q(d, { ...diag, text: "openai" })), ["slow recall"]); // inside source
  });
  it("filters combine (AND)", async () => {
    const d = fixture();
    const f: LogFilter = { ...diag, from: iso(1000), to: iso(3500), minLevel: "warn", component: "core", text: "provider" };
    assert.deepEqual(msgs(await q(d, f)), ["slow recall", "provider failed: Timeout"]); // both mention "provider" (source.kind / msg)
    assert.deepEqual((await q(d, { ...f, component: "supervisor" })).records, []);
  });
  it("the text search runs on the redacted record: a secret cannot be confirmed by searching for it", async () => {
    const d = logsDir();
    const secret = "sk-" + "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2";
    put(d, "core.log", rec(0, "error", `provider said no to ${secret}`, { attrs: { api_key: "plain-key-value-123", note: "n" } }));
    for (const needle of [secret, "plain-key-value-123", "Zz9Yy8Xx7"]) assert.deepEqual((await q(d, { ...diag, text: needle })).records, [], needle);
    const all = await q(d);
    assert.ok(!JSON.stringify(all).includes(secret) && !JSON.stringify(all).includes("plain-key-value-123"));
    assert.match(String(all.records[0]!.record.msg), /\[REDACTED:pattern\]/);
    assert.deepEqual(all.records[0]!.record.attrs, { api_key: "[REDACTED:key]", note: "n" });
    assert.equal((await q(d, { ...diag, text: "REDACTED:key" })).records.length, 1);
  });
});

describe("logs query: cursor and paging", () => {
  const many = (n: number): string => Array.from({ length: n }, (_, i) => rec(i * 10, i % 7 === 0 ? "error" : "info", `m${i}`)).join("");
  it("pages in both directions cover every record exactly once", async () => {
    const d = logsDir(); put(d, "core.log", many(57));
    for (const order of ["asc", "desc"] as const) {
      const seen: string[] = []; let cursor: string | undefined;
      for (let guard = 0; guard < 20; guard++) {
        const r = await q(d, diag, { order, limit: 10, ...(cursor ? { cursor } : {}) });
        seen.push(...msgs(r));
        if (!r.nextCursor) break; cursor = r.nextCursor;
      }
      const all = Array.from({ length: 57 }, (_, i) => `m${i}`);
      assert.deepEqual(seen, order === "asc" ? all : [...all].reverse(), order);
    }
  });
  it("a cursor stays valid when lines are appended, and the next page is exactly the new lines", async () => {
    const d = logsDir(); put(d, "core.log", many(5));
    const p1 = await q(d, diag, { limit: 3 });
    add(d, "core.log", rec(1000, "info", "late1") + rec(1010, "info", "late2"));
    const p2 = await q(d, diag, { limit: 100, cursor: p1.nextCursor! });
    assert.deepEqual(msgs(p1), ["m0", "m1", "m2"]);
    assert.deepEqual(msgs(p2), ["m3", "m4", "late1", "late2"]);
    assert.equal(p2.nextCursor, null);
  });
  it("a cursor stays valid across a rotation: no record twice, none lost", async () => {
    const d = logsDir(); put(d, "core.log", many(6));
    const p1 = await q(d, diag, { limit: 4 });
    rotate(d, "core.log");
    add(d, "core.log", rec(500, "info", "after-rotation-1") + rec(510, "info", "after-rotation-2"));
    rotate(d, "core.log");
    add(d, "core.log", rec(600, "info", "after-rotation-3"));
    const p2 = await q(d, diag, { limit: 100, cursor: p1.nextCursor! });
    assert.deepEqual(msgs(p1), ["m0", "m1", "m2", "m3"]);
    assert.deepEqual(msgs(p2), ["m4", "m5", "after-rotation-1", "after-rotation-2", "after-rotation-3"]);
  });
  it("lines with the same timestamp keep a total order, so the cursor between them is stable", async () => {
    const d = logsDir();
    put(d, "core.log", Array.from({ length: 9 }, (_, i) => rec(0, "info", `same-${i}`)).join(""));
    const seen: string[] = []; let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard++) { const r = await q(d, diag, { limit: 2, ...(cursor ? { cursor } : {}) }); seen.push(...msgs(r)); if (!r.nextCursor) break; cursor = r.nextCursor; }
    assert.deepEqual([...seen].sort(), Array.from({ length: 9 }, (_, i) => `same-${i}`).sort());
    assert.equal(new Set(seen).size, 9);
  });
  it("a cursor with other filters, a garbled cursor and a forged cursor are refused", async () => {
    const d = logsDir(); put(d, "core.log", many(20));
    const p = await q(d, diag, { limit: 5 });
    await assert.rejects(q(d, { ...diag, minLevel: "error" }, { cursor: p.nextCursor! }), (e) => e instanceof CursorError && e.reason === "cursor-mismatch");
    await assert.rejects(q(d, diag, { cursor: p.nextCursor!, order: "desc" }), (e) => e instanceof CursorError && e.reason === "cursor-mismatch");
    for (const bad of ["x", "%%%", Buffer.from("{}").toString("base64url"), Buffer.from(JSON.stringify({ v: 1, ts: "no", h: "h", fp: "f" })).toString("base64url")]) {
      await assert.rejects(q(d, diag, { cursor: bad }), (e) => e instanceof CursorError && e.reason === "bad-cursor", bad);
    }
  });
});

describe("logs query: rotation during the read", () => {
  it("a rotation between listing and opening is detected and the read retried: nothing twice, nothing lost", async () => {
    const d = logsDir();
    put(d, "core.log", rec(0, "info", "a") + rec(1000, "info", "b"));
    let first = true;
    const r = await q(d, diag, { onListed: () => { if (first) { first = false; rotate(d, "core.log"); add(d, "core.log", rec(2000, "info", "c")); } } });
    assert.deepEqual(msgs(r), ["a", "b", "c"]);
  });
  it("a file rotated away after it was opened is still read from its descriptor", async () => {
    const d = logsDir();
    put(d, "core.log", Array.from({ length: 4000 }, (_, i) => rec(i, "info", `n${i}`)).join(""));
    const r1 = await runQuery({ dir: d, filter: diag, order: "asc", limit: 3000, onListed: () => {} });
    assert.equal(r1.records.length, 3000);
  });
});

describe("logs query: large files", () => {
  it("answers the newest page of a ~60 MiB file by reading a small part of it", async () => {
    const d = logsDir();
    const line = (i: number): string => JSON.stringify({ ts: new Date(Date.UTC(2026, 0, 1) + i * 100).toISOString(), level: i % 1000 === 0 ? "error" : "info", source: { kind: "harness", id: "core", version: null }, event: "core.test", msg: `message number ${i} ${"word ".repeat(12)}` }) + "\n";
    const p = path.join(d, "core.log"); writeFileSync(p, "");
    for (let b = 0; b < 60; b++) { let chunk = ""; for (let i = b * 10_000; i < (b + 1) * 10_000; i++) chunk += line(i); appendFileSync(p, chunk); }
    assert.ok(statSync(p).size > 55 * 1024 * 1024);
    const newest = await q(d, diag, { order: "desc", limit: 20 });
    assert.equal(newest.records.length, 20); assert.equal(newest.records[0]!.record.msg, `message number 599999 ${"word ".repeat(12)}`);
    assert.ok(newest.scanned.bytes < 1_000_000, `read ${newest.scanned.bytes} bytes`);
    const mid = await q(d, { ...diag, from: new Date(Date.UTC(2026, 0, 1) + 300_000 * 100).toISOString() }, { limit: 5 });
    assert.equal(mid.records[0]!.record.msg, `message number 300000 ${"word ".repeat(12)}`);
    assert.ok(mid.scanned.bytes < 1_000_000, `read ${mid.scanned.bytes} bytes`);
    const hit = await q(d, { ...diag, from: new Date(Date.UTC(2026, 0, 1) + 300_000 * 100).toISOString(), to: new Date(Date.UTC(2026, 0, 1) + 300_050 * 100).toISOString(), minLevel: "error" }, { order: "desc" });
    assert.deepEqual(hit.records.map((x) => x.record.msg), [`message number 300000 ${"word ".repeat(12)}`]);
    assert.ok(hit.scanned.bytes < 2_000_000, `read ${hit.scanned.bytes} bytes`);
  });
  it("a full scan that finds nothing stops at the scan budget and hands back a cursor that continues", async () => {
    const d = logsDir();
    put(d, "core.log", Array.from({ length: 3000 }, (_, i) => rec(i, "info", `filler ${i}`)).join("") + rec(9999, "info", "needle"));
    const f: LogFilter = { ...diag, text: "needle" };
    let cursor: string | undefined; let found: string[] = []; let rounds = 0;
    for (; rounds < 50; rounds++) {
      const r = await q(d, f, { maxScanBytes: 100_000, ...(cursor ? { cursor } : {}) });
      found = found.concat(msgs(r));
      if (!r.nextCursor) break;
      assert.ok(r.truncated); cursor = r.nextCursor;
    }
    assert.deepEqual(found, ["needle"]);
    assert.ok(rounds >= 1, "the budget forced more than one call");
  });
});
