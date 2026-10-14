// Audit b11: regressions found while reading logs/** (time bounds, poisoned lines, scan budget, legacy envelope).
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CallContext } from "../../src/rpc/server.ts";
import { createLogsMethods } from "../../src/logs/methods.ts";
import { runQuery } from "../../src/logs/query.ts";
import { createRedactor } from "../../src/logs/redact.ts";
import { createWriter } from "../../src/logs/writer.ts";
import { logsDir, put, rec } from "./helpers.ts";

const ctx = (): CallContext => ({ requestId: "r", connectionId: "c", signal: new AbortController().signal });
const diag = { stream: "diagnostic" as const };

describe("b11 logs: time bounds", () => {
  for (const bad of ["2026-02-30T00:00:00Z", "2026-04-31T10:00:00Z", "2026-10-07T24:00:00Z", "2026-13-01T00:00:00Z"]) {
    it(`refuses ${bad} instead of silently moving it to another instant`, async () => {
      const h = createLogsMethods({ dir: logsDir() });
      for (const key of ["from", "to"]) {
        await assert.rejects(h["logs.query"]!({ [key]: bad }, ctx()), (e: any) => e.code === "E_INVALID_PARAMS" || e.error === "E_INVALID_PARAMS" || /bad-timestamp|RFC 3339/.test(String(e.message) + JSON.stringify(e.data ?? e.details ?? {})));
      }
    });
  }
  it("accepts a leap day and a bound with fractional seconds", async () => {
    const h = createLogsMethods({ dir: logsDir() });
    await h["logs.query"]!({ from: "2028-02-29T00:00:00.5Z", to: "2028-02-29T23:59:59Z" }, ctx());
  });
});

describe("b11 logs: timestamps without a zone are UTC, whatever the host zone", () => {
  let prev: string | undefined;
  beforeEach(() => { prev = process.env.TZ; process.env.TZ = "Asia/Tokyo"; });
  afterEach(() => { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; });
  it("a foreign `at` without Z is read as UTC, so a UTC range finds it", async () => {
    const d = logsDir();
    put(d, "core.log", JSON.stringify({ at: "2026-10-07T09:00:00", level: "info", role: "core", msg: "zoneless" }) + "\n");
    const r = await runQuery({ dir: d, filter: { ...diag, from: "2026-10-07T09:00:00.000Z", to: "2026-10-07T09:00:00.000Z" }, order: "asc", limit: 10 });
    assert.deepEqual(r.records.map((x) => x.ts), ["2026-10-07T09:00:00.000Z"]);
  });
});

describe("b11 logs: a poisoned line must not take the query down", () => {
  it("a deeply nested record is returned (bounded) and its neighbours are unaffected", async () => {
    const d = logsDir();
    const deep = "[".repeat(60_000) + "0" + "]".repeat(60_000);
    put(d, "core.log", rec(0, "info", "before") + `{"ts":"2026-10-07T09:00:01.000Z","level":"info","msg":"deep","x":${deep}}\n` + rec(2000, "info", "after"));
    const r = await runQuery({ dir: d, filter: diag, order: "asc", limit: 10 });
    assert.deepEqual(r.records.map((x) => x.record.msg), ["before", "deep", "after"]);
    assert.ok(JSON.stringify(r.records[1]!.record).length < 100_000);
  });
  it("redactor.value keeps a key named __proto__ as data and never changes the prototype", () => {
    const out: any = createRedactor().value(JSON.parse('{"__proto__":{"k":"v"},"a":1}'));
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
    assert.deepEqual(Object.keys(out).sort(), ["__proto__", "a"]);
    assert.deepEqual(JSON.parse(JSON.stringify(out)).__proto__, { k: "v" });
  });
});

describe("b11 logs: scan budget", () => {
  it("is also enforced while skipping corrupt lines", async () => {
    const d = logsDir();
    put(d, "core.log", "garbage garbage garbage\n".repeat(200_000)); // ~4.8 MB, none valid
    const r = await runQuery({ dir: d, filter: diag, order: "asc", limit: 10, maxScanBytes: 256 * 1024 });
    assert.equal(r.truncated, true);
    assert.ok(r.scanned.bytes < 1024 * 1024, `scanned ${r.scanned.bytes}`);
  });
});

describe("b11 logs: legacy writer envelope", () => {
  let root = ""; let dir = "";
  beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), "p1b-b11-")); dir = path.join(root, "logs"); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  it("caller fields named at/level/role cannot overwrite the envelope", () => {
    const T = Date.UTC(2026, 9, 7, 12, 0, 0);
    const w = createWriter({ dir, role: "core", source: { kind: "harness", id: "core", version: null }, now: () => T, timers: false });
    w.writeLegacy("info", "hello", { at: "1970-01-01T00:00:00.000Z", level: "nonsense", role: "evil", extra: 1 }); w.close();
    const f = path.join(dir, "core.log");
    assert.ok(existsSync(f));
    const r = JSON.parse(readFileSync(f, "utf8").trim().split("\n").pop()!);
    assert.equal(r.at, new Date(T).toISOString()); assert.equal(r.level, "info"); assert.equal(r.role, "core"); assert.equal(r.extra, 1);
  });
});
void writeFileSync;
