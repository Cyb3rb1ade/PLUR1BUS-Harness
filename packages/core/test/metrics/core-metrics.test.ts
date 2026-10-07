import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { createServer } from "node:net";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, type CoreClient } from "@plur1bus/module-api";
import { defaults } from "@plur1bus/config-schema";
import { createCore, type Core } from "../../src/core.ts";
import { layout } from "../../src/paths.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { parseExposition } from "./exposition-parser.ts";

function freePort(): Promise<number> {
  return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });
}
function get(port: number, token?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/metrics", headers: token ? { authorization: `Bearer ${token}` } : {}, timeout: 5000 }, (res) => {
      let body = ""; res.setEncoding("utf8"); res.on("data", (c) => (body += c)); res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("timeout"))); req.end();
  });
}
function homeWith(metrics: { enabled: boolean; port: number }): string {
  const home = tempDir("p1b-metrics-core-");
  const cfg = defaults(); cfg.agents.bernd = {}; cfg.metrics = metrics;
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false } };
  writeFileSync(layout(home).configPath, JSON.stringify(cfg));
  return home;
}

describe("core metrics endpoint", () => {
  let core: Core; let c: CoreClient; let port: number; let token: string; let home: string;
  before(async () => {
    port = await freePort(); home = homeWith({ enabled: true, port });
    core = createCore({ home, testInternals: flatTestInternals() });
    await core.start();
    c = await connect({ address: core.address, token: core.token });
    token = readFileSync(join(layout(home).state, "metrics.token"), "utf8").trim();
  });
  after(async () => { await c?.close(); await core?.stop({ budgetMs: 5000 }); });

  it("serves rpc counts, connections and readiness; requires the metrics token (not the core token)", async () => {
    await c.call("core.status");
    assert.equal((await get(port)).status, 401);
    assert.equal((await get(port, core.token)).status, 401, "the core's RPC token does not open the metrics endpoint");
    const r = await get(port, token);
    assert.equal(r.status, 200);
    const fams = parseExposition(r.body);
    const calls = fams.find((f) => f.name === "plur1bus_rpc_calls_total")!;
    assert.ok(calls.samples.find((s) => s.labels.method === "core.status" && s.labels.result === "ok")!.value >= 1);
    assert.equal(fams.find((f) => f.name === "plur1bus_rpc_connections_open")!.samples[0]!.value >= 1, true);
    assert.equal(fams.find((f) => f.name === "plur1bus_agents")!.samples[0]!.value, 1);
    assert.equal(fams.find((f) => f.name === "plur1bus_process_resident_memory_bytes")!.samples[0]!.value > 0, true);
  });

  it("never exposes an agent name, a token or a path", async () => {
    const body = (await get(port, token)).body;
    for (const secret of [token, core.token, "bernd", home]) assert.equal(body.includes(secret), false, secret);
  });

  it("counts a call that fails by its result class", async () => {
    await assert.rejects(c.call("memory.recall", { caller: { channel: "cli", accountId: "a", userId: "u" }, agentId: "nobody", query: "x" }));
    const fams = parseExposition((await get(port, token)).body);
    const s = fams.find((f) => f.name === "plur1bus_rpc_calls_total")!.samples.filter((x) => x.labels.method === "memory.recall" && x.labels.result !== "ok");
    assert.ok(s.length >= 1);
  });

  it("records turns and provider errors given to core.metrics", async () => {
    core.metrics.turn(0.3, "ok"); core.metrics.providerError("openai", "timeout");
    const fams = parseExposition((await get(port, token)).body);
    assert.equal(fams.find((f) => f.name === "plur1bus_provider_errors_total")!.samples.find((s) => s.labels.provider === "openai" && s.labels.kind === "timeout")!.value, 1);
    assert.equal(fams.find((f) => f.name === "plur1bus_turn_duration_seconds")!.samples.find((s) => s.name.endsWith("_count") && s.labels.outcome === "ok")!.value, 1);
  });
});

describe("core metrics endpoint: off by default", () => {
  it("opens no port and writes no token when metrics.enabled is false; the port closes on stop", async () => {
    const port = await freePort(); const home = homeWith({ enabled: false, port });
    const core = createCore({ home, testInternals: flatTestInternals() });
    await core.start();
    try {
      await assert.rejects(get(port));
      assert.equal(existsSync(join(layout(home).state, "metrics.token")), false);
    } finally { await core.stop({ budgetMs: 5000 }); }
  });

  it("a taken port does not keep the core from starting", async () => {
    const blocker = createServer(); await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const port = (blocker.address() as any).port;
    const core = createCore({ home: homeWith({ enabled: true, port }), testInternals: flatTestInternals() });
    try { await core.start(); assert.equal(core.status().process.state, "ready"); }
    finally { await core.stop({ budgetMs: 5000 }); blocker.close(); }
  });

  it("closes the metrics port when the core stops", async () => {
    const port = await freePort();
    const core = createCore({ home: homeWith({ enabled: true, port }), testInternals: flatTestInternals() });
    await core.start(); await core.stop({ budgetMs: 5000 });
    await assert.rejects(get(port));
  });
});
