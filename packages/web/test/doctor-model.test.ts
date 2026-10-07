// Pure parts of the Doctor page: parsers for the documented wire shapes, uptime formatting, the 1staid.check/1 reader.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHECK_SCHEMA, formatUptime, MAX_CHECK_BYTES, parseAgents, parseCheckDoc, parseCoreStatus, parseHealth } from "../src/pages/doctor/model.ts";

describe("formatUptime", () => {
  test("shows at most the two largest non-zero units, localised", () => {
    const ms = ((1 * 24 + 3) * 60 + 7) * 60_000 + 5_000; // 1 d 3 h 7 min 5 s
    assert.equal(formatUptime(ms, "en"), "1 day, 3 hr");
    assert.equal(formatUptime(ms, "de"), "1 Tg., 3 Std.");
  });
  test("small and odd values", () => {
    assert.equal(formatUptime(0, "en"), "0 sec");
    assert.equal(formatUptime(4_000, "en"), "4 sec");
    assert.equal(formatUptime(125_000, "en"), "2 min, 5 sec");
    assert.equal(formatUptime(-5, "en"), "0 sec");
    assert.equal(formatUptime(Number.NaN, "en"), "0 sec");
  });
});

describe("parseHealth", () => {
  const ok = { schema: "health/1", status: "ok", api: { version: "1.4.0" }, core: { reachable: true, rpc: "1.3.0", contract: "2.0.0", uptimeMs: 1000, engineReady: true, degraded: false } };
  test("reads the documented 200 body", () => {
    assert.deepEqual(parseHealth(ok), { status: "ok", apiVersion: "1.4.0", core: { reachable: true, rpc: "1.3.0", contract: "2.0.0", uptimeMs: 1000, engineReady: true, degraded: false } });
  });
  test("the 503 body has only reachable", () => {
    const h = parseHealth({ schema: "health/1", status: "down", api: { version: "1.4.0" }, core: { reachable: false } });
    assert.equal(h?.status, "down");
    assert.equal(h?.core.reachable, false);
    assert.equal(h?.core.uptimeMs, undefined);
  });
  test("anything else is null", () => {
    for (const bad of [null, 5, "x", {}, { status: "fine", api: {}, core: {} }, { status: "ok", core: { reachable: true } }]) assert.equal(parseHealth(bad), null);
  });
});

describe("parseAgents", () => {
  test("agents with activity", () => {
    const body = { schema: "agents.list/1", agents: [{ agentId: "main", open: true, activity: { state: "dreaming", since: 5, phase: "rem" } }, { agentId: "b", open: false, activity: { state: "idle", since: 1 } }] };
    const a = parseAgents(body);
    assert.equal(a?.length, 2);
    assert.deepEqual(a?.[0], { agentId: "main", open: true, activity: { state: "dreaming", since: 5, phase: "rem" } });
    assert.equal(a?.[1]?.activity.phase, undefined);
  });
  test("empty list is an empty array; a malformed body is null; unknown phase is dropped", () => {
    assert.deepEqual(parseAgents({ schema: "agents.list/1", agents: [] }), []);
    assert.equal(parseAgents({ agents: "x" }), null);
    assert.equal(parseAgents(null), null);
    assert.equal(parseAgents({ agents: [{ agentId: 1 }] }), null);
    assert.equal(parseAgents({ agents: [{ agentId: "a", open: true, activity: { state: "idle", since: 1, phase: "weird" } }] })?.[0]?.activity.phase, undefined);
  });
});

describe("parseCoreStatus", () => {
  test("degraded details, models, store schema", () => {
    const s = parseCoreStatus({
      process: { state: "degraded", reason: "x" }, contract: "2.0.0", rpc: "1.3.0", instanceId: "i", pid: 1, uptimeMs: 9, agents: [],
      engine: { ready: false, degraded: { reason: "embedder-failed", capability: "recall", detail: "d" }, models: { embedder: { state: "failed", warming: false, checkedAt: 1, id: "m", error: "boom" }, reranker: { state: "disabled", warming: false, checkedAt: null, id: null } }, storeSchema: { current: "3", expected: "4" } },
    });
    assert.equal(s?.process.state, "degraded");
    assert.deepEqual(s?.engine.degraded, { reason: "embedder-failed", capability: "recall", detail: "d" });
    assert.equal(s?.engine.models?.embedder.state, "failed");
    assert.deepEqual(s?.engine.storeSchema, { current: "3", expected: "4" });
  });
  test("minimal and malformed", () => {
    assert.equal(parseCoreStatus({ process: { state: "ready" }, engine: { ready: true, degraded: null } })?.engine.degraded, null);
    assert.equal(parseCoreStatus({}), null);
    assert.equal(parseCoreStatus(null), null);
  });
});

describe("parseCheckDoc (1staid.check/1)", () => {
  const doc = { schema: CHECK_SCHEMA, ok: false, checks: [{ id: "config.valid", status: "ok", summary: "fine" }, { id: "run.permissions", status: "fail", summary: "run/ is 777", detail: { mode: "777" }, hint: "plur1bus 1staid repair" }] };
  test("keeps the raw text byte for byte", () => {
    const raw = `  ${JSON.stringify(doc, null, 4)}\n\n`;
    const r = parseCheckDoc(raw);
    assert.ok(r.ok);
    assert.equal(r.raw, raw);
    assert.equal(r.doc.ok, false);
    assert.equal(r.doc.checks.length, 2);
    assert.deepEqual(r.doc.checks[1], { id: "run.permissions", status: "fail", summary: "run/ is 777", hint: "plur1bus 1staid repair" });
  });
  test("refuses with a machine reason", () => {
    assert.deepEqual(parseCheckDoc("{nope"), { ok: false, reason: "not-json" });
    assert.deepEqual(parseCheckDoc(JSON.stringify({ ...doc, schema: "other/1" })), { ok: false, reason: "wrong-schema" });
    assert.deepEqual(parseCheckDoc(JSON.stringify({ schema: CHECK_SCHEMA, ok: true, checks: [{ id: "a", status: "great", summary: "" }] })), { ok: false, reason: "malformed" });
    assert.deepEqual(parseCheckDoc(JSON.stringify({ schema: CHECK_SCHEMA, ok: true })), { ok: false, reason: "malformed" });
    assert.deepEqual(parseCheckDoc("x".repeat(MAX_CHECK_BYTES + 1)), { ok: false, reason: "too-large" });
  });
  test("all five documented statuses are accepted", () => {
    const checks = ["ok", "info", "warn", "fail", "skip"].map((status, i) => ({ id: `c${i}`, status, summary: "s" }));
    const r = parseCheckDoc(JSON.stringify({ schema: CHECK_SCHEMA, ok: true, checks }));
    assert.ok(r.ok);
    assert.equal(r.doc.checks.length, 5);
  });
});
