import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { METHODS_BY_SERVER } from "@plur1bus/rpc-schema";
import { createMetrics, MAX_TOTAL_SERIES, RPC_CALLS_MAX_SERIES } from "../../src/metrics/metrics.ts";
import { parseExposition } from "./exposition-parser.ts";

const fam = (text: string, name: string) => parseExposition(text).find((f) => f.name === name);

describe("harness metrics", () => {
  const base = { memoryUsage: () => ({ rss: 100, heapTotal: 50, heapUsed: 40, external: 7, arrayBuffers: 3 }) };

  it("counts rpc calls per known method and result class", () => {
    const m = createMetrics({ ...base, connections: () => 2 });
    m.rpcCall("memory.recall", "ok"); m.rpcCall("memory.recall", "ok"); m.rpcCall("memory.recall", "E_UNAUTHORIZED");
    m.rpcCall("core.status", "E_INTERNAL");
    const f = fam(m.render(), "plur1bus_rpc_calls_total")!;
    const v = (method: string, result: string) => f.samples.find((s) => s.labels.method === method && s.labels.result === result)?.value;
    assert.equal(v("memory.recall", "ok"), 2);
    assert.equal(v("memory.recall", "unauthorized"), 1);
    assert.equal(v("core.status", "internal"), 1);
  });

  it("never turns a caller-supplied method name or error code into a label", () => {
    const m = createMetrics({ ...base, connections: () => 0 });
    for (let i = 0; i < 500; i++) m.rpcCall(`agent.${i}.secret`, `E_WEIRD_${i}`);
    const f = fam(m.render(), "plur1bus_rpc_calls_total")!;
    assert.deepEqual(f.samples.map((s) => [s.labels.method, s.labels.result]), [["other", "other"]]);
    assert.equal(f.samples[0]!.value, 500);
  });

  it("knows every method the core serves", () => {
    const m = createMetrics({ ...base, connections: () => 0 });
    for (const method of METHODS_BY_SERVER.core) m.rpcCall(method, "ok");
    const f = fam(m.render(), "plur1bus_rpc_calls_total")!;
    assert.equal(f.samples.some((s) => s.labels.method === "other"), false);
    assert.equal(f.samples.length, METHODS_BY_SERVER.core.length);
  });

  it("observes turn durations in a histogram with a fixed outcome enumeration", () => {
    const m = createMetrics({ ...base, connections: () => 0 });
    m.turn(0.4, "ok"); m.turn(70, "error"); m.turn(1, "who-knows");
    const f = fam(m.render(), "plur1bus_turn_duration_seconds")!;
    assert.equal(f.type, "histogram");
    const count = (o: string) => f.samples.find((s) => s.name.endsWith("_count") && s.labels.outcome === o)!.value;
    assert.deepEqual([count("ok"), count("error"), count("aborted")], [1, 2, 0]); // unknown outcome -> error
  });

  it("counts provider errors under fixed provider and kind enumerations, all series present from the start", () => {
    const m = createMetrics({ ...base, connections: () => 0 });
    const before = fam(m.render(), "plur1bus_provider_errors_total")!;
    assert.ok(before.samples.length > 0 && before.samples.every((s) => s.value === 0));
    m.providerError("anthropic", "rate_limit"); m.providerError("my-private-endpoint.example", "weird");
    const f = fam(m.render(), "plur1bus_provider_errors_total")!;
    assert.equal(f.samples.length, before.samples.length);
    assert.equal(f.samples.find((s) => s.labels.provider === "anthropic" && s.labels.kind === "rate_limit")!.value, 1);
    assert.equal(f.samples.find((s) => s.labels.provider === "other" && s.labels.kind === "other")!.value, 1);
  });

  it("exposes memory, connections, readiness, journal backlog and agent count as numbers", () => {
    const m = createMetrics({ ...base, connections: () => 3, health: () => ({ ready: true, journalBacklog: 4, agents: 2, uptimeSeconds: 12 }) });
    const text = m.render();
    const val = (n: string) => fam(text, n)!.samples[0]!.value;
    assert.equal(val("plur1bus_rpc_connections_open"), 3);
    assert.equal(val("plur1bus_process_resident_memory_bytes"), 100);
    assert.equal(val("plur1bus_process_heap_used_bytes"), 40);
    assert.equal(val("plur1bus_engine_ready"), 1);
    assert.equal(val("plur1bus_journal_backlog_entries"), 4);
    assert.equal(val("plur1bus_agents"), 2);
    assert.equal(val("plur1bus_core_uptime_seconds"), 12);
  });

  it("stays below the global series bound even when every enumeration is exercised", () => {
    const m = createMetrics({ ...base, connections: () => 0 });
    for (const method of METHODS_BY_SERVER.core) for (const r of ["ok", "E_INVALID_PARAMS", "E_UNAUTHORIZED", "E_NOT_AVAILABLE", "E_INTERNAL", "E_X"]) m.rpcCall(method, r);
    const n = parseExposition(m.render()).reduce((a, f) => a + f.samples.length, 0);
    assert.ok(n <= MAX_TOTAL_SERIES, `${n} series`);
  });

  it("starts with the schema's full RPC method list even when its label space exceeds the generic per-metric cap", () => {
    const m = createMetrics({ ...base, connections: () => 0 }); // threw "label space of N series exceeds the cap of 1024" at 150 core methods
    m.rpcCall(METHODS_BY_SERVER.core[0]!, "ok");
    assert.ok(RPC_CALLS_MAX_SERIES >= (METHODS_BY_SERVER.core.length + 1) * 7);
  });

  it("carries no agent, user, path or host label anywhere", () => {
    const m = createMetrics({ ...base, connections: () => 0 });
    const labels = new Set(parseExposition(m.render()).flatMap((f) => f.samples.flatMap((s) => Object.keys(s.labels))));
    for (const l of labels) assert.ok(["method", "result", "outcome", "provider", "kind", "le", "reason", "status"].includes(l), `label ${l}`);
  });

  it("counts bounded tool usage, need reasons, skill loading and triage latency", () => {
    const m = createMetrics({ ...base, connections: () => 0 });
    m.turnTelemetry({
      rounds: 3, toolCalls: 2, metaCalls: { search: 1, skillLoad: 2, skillRead: 3 },
      skills: { injected: 1, loaded: 2 }, toolChoice: { status: "required", forced: true },
      toolNeed: { detected: true, reasons: ["path", "url"] }, errorsReturned: 1,
      endReason: "completed", triageDurationMs: 25,
    });
    const value = (name: string, key?: string) => fam(m.render(), name)!.samples
      .find(s => key === undefined || Object.values(s.labels).includes(key))!.value;
    assert.equal(value("plur1bus_turn_rounds_total"), 3);
    assert.equal(value("plur1bus_turn_tool_calls_total", "real"), 2);
    assert.equal(value("plur1bus_turn_tool_calls_total", "search"), 1);
    assert.equal(value("plur1bus_turn_tool_calls_total", "skill_load"), 2);
    assert.equal(value("plur1bus_turn_tool_calls_total", "skill_read"), 3);
    assert.equal(value("plur1bus_turn_skills_total", "injected"), 1);
    assert.equal(value("plur1bus_turn_skills_total", "loaded"), 2);
    assert.equal(value("plur1bus_turn_tool_need_total", "path"), 1);
    assert.equal(value("plur1bus_turn_tool_need_total", "url"), 1);
    assert.equal(value("plur1bus_turn_tool_choice_total", "required"), 1);
    assert.equal(value("plur1bus_turn_tool_errors_returned_total"), 1);
    assert.equal(value("plur1bus_turn_end_total", "completed"), 1);
    const latency = fam(m.render(), "plur1bus_turn_triage_duration_seconds")!;
    assert.equal(latency.samples.find(s => s.name.endsWith("_sum"))!.value, 0.025);
    assert.deepEqual(m.turnTelemetrySummary().triage, { count: 1, p50Ms: 25, p95Ms: 25 });
  });

  it("folds unknown telemetry strings and bounds the retained triage quantile sample", () => {
    const m = createMetrics({ ...base, connections: () => 0 });
    for (let i = 0; i < 1100; i++) m.turnTelemetry({
      rounds: 1, toolCalls: 0, metaCalls: { search: 0, skillLoad: 0, skillRead: 0 },
      skills: { injected: 0, loaded: 0 },
      toolChoice: { status: "private-value" as "auto", forced: false },
      toolNeed: { detected: true, reasons: ["private-value" as "path"] }, errorsReturned: 0,
      endReason: "private-value" as "completed", triageDurationMs: i,
    });
    const text = m.render();
    assert.equal(text.includes("private-value"), false);
    const summary = m.turnTelemetrySummary();
    assert.equal(summary.turns, 1100);
    assert.equal(summary.withoutNeededTool, 1100);
    assert.deepEqual(summary.triage, { count: 1024, p50Ms: 587, p95Ms: 1048 });
  });
});
