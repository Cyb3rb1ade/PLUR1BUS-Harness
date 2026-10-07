import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { METHODS_BY_SERVER } from "@plur1bus/rpc-schema";
import { createMetrics, MAX_TOTAL_SERIES } from "../../src/metrics/metrics.ts";
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

  it("carries no agent, user, path or host label anywhere", () => {
    const m = createMetrics({ ...base, connections: () => 0 });
    const labels = new Set(parseExposition(m.render()).flatMap((f) => f.samples.flatMap((s) => Object.keys(s.labels))));
    for (const l of labels) assert.ok(["method", "result", "outcome", "provider", "kind", "le"].includes(l), `label ${l}`);
  });
});
