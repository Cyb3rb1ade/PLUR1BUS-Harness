import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLoggerEvents } from "../../src/discovery/events-logger.ts";

interface LogCall {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  fields?: Record<string, unknown>;
}

function makeLogger() {
  const calls: LogCall[] = [];
  return {
    calls,
    debug(msg: string, fields?: object) { calls.push({ level: "debug", msg, fields: fields as Record<string, unknown> }); },
    info(msg: string, fields?: object) { calls.push({ level: "info", msg, fields: fields as Record<string, unknown> }); },
    warn(msg: string, fields?: object) { calls.push({ level: "warn", msg, fields: fields as Record<string, unknown> }); },
    error(msg: string, fields?: object) { calls.push({ level: "error", msg, fields: fields as Record<string, unknown> }); },
  };
}

describe("events logger", () => {
  it("formats and levels events correctly", () => {
    const l = makeLogger();
    const ev = createLoggerEvents(l);

    // 1. discovered -> info
    ev.discovered({ provider: "p1", count: 1, models: ["m1"], reappeared: [], truncated: false, traceId: "t1" });
    assert.equal(l.calls[0]!.level, "info");
    assert.equal(l.calls[0]!.msg, "model.discovered");
    assert.equal(l.calls[0]!.fields?.source, "provider:p1");
    assert.equal(l.calls[0]!.fields?.trace_id, "t1");

    // 2. unavailable: warn if roles non-empty, info if empty
    ev.unavailable({ provider: "p1", count: 1, models: ["m1"], roles: ["chat"], truncated: false, traceId: "t2" });
    assert.equal(l.calls[1]!.level, "warn");
    assert.equal(l.calls[1]!.msg, "model.unavailable");

    ev.unavailable({ provider: "p1", count: 1, models: ["m1"], roles: [], truncated: false, traceId: "t3" });
    assert.equal(l.calls[2]!.level, "info");
    assert.equal(l.calls[2]!.msg, "model.unavailable");

    // 3. scanFailed: warn for network, server, empty; error for auth, invalid
    const baseErr = { code: "network" as const, reason: "r", retryable: true, hint: "h" };
    ev.scanFailed({ provider: "p1", result: "failed:network", nextScanAt: "n", consecutiveFailures: 1, err: baseErr, traceId: "t4" });
    assert.equal(l.calls[3]!.level, "warn");

    ev.scanFailed({ provider: "p1", result: "failed:server", nextScanAt: "n", consecutiveFailures: 1, err: { ...baseErr, code: "server" }, traceId: "t5" });
    assert.equal(l.calls[4]!.level, "warn");

    ev.scanFailed({ provider: "p1", result: "failed:empty", nextScanAt: "n", consecutiveFailures: 0, err: { ...baseErr, code: "invalid-request" }, traceId: "t6" });
    assert.equal(l.calls[5]!.level, "warn");

    ev.scanFailed({ provider: "p1", result: "failed:auth", nextScanAt: "n", consecutiveFailures: 0, err: { ...baseErr, code: "auth" }, traceId: "t7" });
    assert.equal(l.calls[6]!.level, "error");

    ev.scanFailed({ provider: "p1", result: "failed:invalid", nextScanAt: "n", consecutiveFailures: 0, err: { ...baseErr, code: "invalid-request" }, traceId: "t8" });
    assert.equal(l.calls[7]!.level, "error");

    // 4. scanCompleted -> debug
    ev.scanCompleted({ provider: "p1", result: "ok", durationMs: 10, counts: { new: 1, reappeared: 0, unavailable: 0, unchanged: 0, duplicates: 0 }, traceId: "t9" });
    assert.equal(l.calls[8]!.level, "debug");
    assert.equal(l.calls[8]!.msg, "model.scan.completed");
    assert.equal(l.calls[8]!.fields?.source, "provider:p1");
  });
});
