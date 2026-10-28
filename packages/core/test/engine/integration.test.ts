import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { defaults } from "@plur1bus/config-schema";
import { createCore } from "../../src/core.ts";
import { layout } from "../../src/paths.ts";
import { connect } from "../helpers/connect.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";

test("Core serves normally when the selected Rust engine is unavailable", async () => {
  const home = tempDir("rust-engine-core-");
  const cfg = defaults(); cfg.agents.alpha = {};
  cfg.engine = { implementation: "rust", neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
    merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false } };
  writeFileSync(layout(home).configPath, JSON.stringify(cfg));
  const core = createCore({ home, testInternals: flatTestInternals() });
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await core.start();
    client = await connect({ address: core.address, token: core.token });
    const status = await client.call<any>("core.status");
    assert.equal(status.engine.ready, false);
    await assert.rejects(client.call("memory.recall", { agentId: "alpha", query: "hello", caller: { channel: "cli", accountId: "local", userId: "owner" } }),
      (e: any) => e.error === "E_NOT_AVAILABLE" && e.reason === "engine-unavailable");
    assert.ok(await client.call("agent.list"));
  } finally { await client?.close(); await core.stop(); }
});

test("the production Core binds engine completions to its own agent work and composed provider", async t => {
  const { createRpcServer, createLogger, engineAddress, engineRunFiles } = await import("@plur1bus/module-api");
  const { buildCapabilities, RPC_VERSION } = await import("@plur1bus/rpc-schema");
  const { mkdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const home = tempDir("rust-engine-llm-core-"), l = layout(home), token = "e".repeat(64);
  mkdirSync(l.run, { recursive: true, mode: 0o700 });
  const run = engineRunFiles(home);
  writeFileSync(run.token, token, { mode: 0o600 });
  writeFileSync(run.pid, `${process.pid} fixture\n`, { mode: 0o600 });
  const logger = createLogger({ file: join(home, "engine.log"), level: "debug", role: "engine" });
  const identity = { fingerprintId: "fixture", provider: "fixture", model: "fixture", dimensions: 3 };
  const engine = createRpcServer({ server: "engine", address: engineAddress(home), token, logger,
    hello: () => ({ contract: "1.17.0", rpc: RPC_VERSION, instanceId: "fixture", pid: process.pid, capabilities: buildCapabilities([], "engine") }),
    methods: {
      "engine.status": async () => ({ ready: true, degraded: null, agents: 0, contract: "1.17.0", storeSchema: { current: "1", expected: "1" }, jobs: { ledger: "ok", agents: [] }, models: { embedder: { state: "ready", warming: false, checkedAt: 1, identity }, reranker: { state: "disabled", warming: false, checkedAt: null, provider: null } }, journal: null, sharedMemory: { supported: false, mode: "unavailable", reason: "platform" } }),
      "engine.jobs.list": async () => [], "engine.embedding.identities": async () => [identity],
      "engine.systemSupplement": async () => [], "engine.open": async ({ agentId }) => ({ agentId }), "engine.agent.close": async () => ({}),
    },
  });
  await engine.listen();
  t.after(async () => { await engine.close(); logger.close(); });
  const cfg = defaults(); cfg.agents.alpha = {}; cfg.agents.beta = {};
  cfg.engine = { implementation: "rust", neo: { enabled: false }, gc: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false } };
  writeFileSync(l.configPath, JSON.stringify(cfg));
  let calls = 0;
  const secret = "completion-input-secret-must-not-be-logged";
  const core = createCore({ home, testInternals: flatTestInternals(), dreams: { scheduler: false }, discovery: { scheduler: false }, composition: { providers: { profiles: { default: [{ provider: "fixture", model: "m", adapter: { async *stream() {
    calls++; yield { type: "done", result: { text: "completed", toolCalls: [], finishReason: "stop", usage: { inputTokens: 3, outputTokens: 1 }, meta: {} } } as never;
  } } }] } } } });
  await core.start();
  t.after(() => core.stop());
  const client = await connect({ address: core.address, token: core.token });
  const reverse = await connect({ address: core.address, token, engine: { clientId: "plur1bus-engine", token } });
  t.after(async () => { await reverse.close(); await client.close(); });
  const params = { agentId: "alpha", params: { messages: [{ role: "user", content: secret }] } };
  await assert.rejects(reverse.call("host.llm.complete", params), (e: any) => e.error === "E_DENIED" && e.reason === "engine-agent-required");
  await client.call("agent.open", { agentId: "alpha" });
  await assert.rejects(client.call("host.llm.complete", params), (e: any) => e.error === "E_DENIED" && e.reason === "engine-principal-required");
  for (const agentId of [undefined, "unknown", "beta"]) await assert.rejects(reverse.call("host.llm.complete", { ...params, agentId }), (e: any) => e.error === "E_DENIED" && e.reason === "engine-agent-required");
  assert.equal(calls, 0);
  assert.equal((await reverse.call<any>("host.llm.complete", params)).text, "completed");
  assert.equal(calls, 1);
  await client.call("agent.close", { agentId: "alpha" });
  await assert.rejects(reverse.call("host.llm.complete", params), (e: any) => e.error === "E_DENIED" && e.reason === "engine-agent-required");
  const audit = readFileSync(join(l.logs, "audit.log"), "utf8");
  assert.match(audit, /engine\.llm\.complete/);
  assert.match(audit, /engine:v1:alpha/);
  assert.equal(audit.includes(secret), false);
  assert.equal(readFileSync(join(l.logs, "core.log"), "utf8").includes(secret), false);
});
