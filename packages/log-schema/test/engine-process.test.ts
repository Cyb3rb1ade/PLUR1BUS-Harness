import { test } from "node:test";
import assert from "node:assert/strict";
import { lookupEvent, validateRecord } from "../src/index.ts";

const record = (event: string, level: string, attrs: Record<string, unknown>) => ({
  ts: "2026-11-01T12:00:00.000Z", level,
  source: { kind: "harness", id: "engine", version: "0.1.0" },
  event, msg: lookupEvent(event)?.msg, attrs,
});

test("engine lifecycle diagnostics have closed, content-free state and reason categories", () => {
  for (const [state, reason] of [
    ["started", "ready"], ["orphaned", "stdin-closed"], ["orphaned", "connection-closed"],
    ["adopted", "adopted"], ["stopping", "shutdown"], ["stopping", "grace-expired"],
    ["stopping", "signal"], ["stopping", "transport-fatal"], ["stopped", "deadline"],
    ["stopped", "shutdown"],
  ]) assert.ok(validateRecord(record("engine.process.lifecycle", "info", { state, reason, pid: 42 })).ok);
  assert.equal(validateRecord(record("engine.process.lifecycle", "info", {
    state: "started", reason: "private-memory-content", pid: 42,
  })).ok, false);
});

test("engine failure diagnostics accept error classes and errno, never foreign error bodies", () => {
  const attrs = { stage: "accept", error_kind: "resource-limit", os_error: 24, pid: 42 };
  assert.ok(validateRecord(record("engine.process.error", "warn", attrs)).ok);
  assert.equal(validateRecord(record("engine.process.error", "warn", { ...attrs, detail: "PRIVATE-MEMORY" })).ok, false);
  assert.equal(validateRecord(record("engine.process.error", "warn", { ...attrs, error_kind: "PRIVATE-MEMORY" })).ok, false);
});
