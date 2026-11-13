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
  let calls = 0, waitForAbort = false;
  let started!: () => void, observedAbort!: () => void;
  const providerStarted = new Promise<void>(resolve => { started = resolve; });
  const providerAborted = new Promise<void>(resolve => { observedAbort = resolve; });
  const secret = "completion-input-secret-must-not-be-logged";
  const core = createCore({ home, testInternals: flatTestInternals(), dreams: { scheduler: false }, discovery: { scheduler: false }, composition: { providers: { profiles: { default: [{ provider: "fixture", model: "m", adapter: { async *stream(_request, options) {
    calls++;
    if (waitForAbort) {
      started();
      await new Promise<void>((_resolve, reject) => {
        const abort = () => { observedAbort(); reject(options!.signal!.reason); };
        options!.signal!.addEventListener("abort", abort, { once: true });
        if (options!.signal!.aborted) abort();
      });
    }
    yield { type: "done", result: { text: "completed", toolCalls: [], finishReason: "stop", usage: { inputTokens: 3, outputTokens: 1 }, meta: {} } } as never;
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
  await client.call("agent.open", { agentId: "alpha" });
  waitForAbort = true;
  const pending = reverse.call("host.llm.complete", params);
  const rejected = assert.rejects(pending);
  await providerStarted;
  await reverse.close();
  await providerAborted;
  await rejected;
  const audit = readFileSync(join(l.logs, "audit.log"), "utf8");
  assert.match(audit, /engine\.llm\.complete/);
  assert.match(audit, /engine:v1:alpha/);
  assert.equal(audit.includes(secret), false);
  assert.equal(readFileSync(join(l.logs, "core.log"), "utf8").includes(secret), false);
});

test("the Core Dreams scheduler reads A1 recall statistics only with the advertised flag", async () => {
  const { createRpcServer, createLogger, engineAddress, engineRunFiles } = await import("@plur1bus/module-api");
  const { buildCapabilities, RPC_VERSION } = await import("@plur1bus/rpc-schema");
  const { mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { DreamStore } = await import("../../src/dreams/store.ts");
  const now = Date.UTC(2026, 0, 14, 12);
  const cardId = "synthetic-card";
  for (const recallStats of [false, true]) {
    const home = tempDir("rust-engine-dreams-core-");
    const l = layout(home);
    const token = "d".repeat(64);
    mkdirSync(l.run, { recursive: true, mode: 0o700 });
    const run = engineRunFiles(home);
    writeFileSync(run.token, token, { mode: 0o600 });
    writeFileSync(run.pid, `${process.pid} fixture\n`, { mode: 0o600 });
    const cfg = defaults();
    cfg.agents.alpha = {};
    cfg.engine = { implementation: "rust" };
    writeFileSync(l.configPath, JSON.stringify(cfg));

    const logger = createLogger({ file: join(home, "engine.log"), level: "error", role: "engine" });
    const reads: Array<{ ids: unknown; p: unknown; a: unknown }> = [];
    let promotions = 0;
    const identity = { fingerprintId: "fixture", provider: "fixture", model: "fixture", dimensions: 3 };
    const engine = createRpcServer({
      server: "engine", address: engineAddress(home), token, logger,
      hello: () => ({ contract: "1.18.0", rpc: RPC_VERSION, instanceId: "fixture", pid: process.pid,
        capabilities: buildCapabilities([], "engine"), engineCapabilities: { recallStats, knowledgePromotion: false } }),
      methods: {
        "engine.status": async () => ({
          ready: true, degraded: null, agents: 0, contract: "1.18.0",
          storeSchema: { current: "1", expected: "1" }, jobs: { ledger: "ok", agents: [] },
          models: { embedder: { state: "ready", warming: false, checkedAt: now, identity },
            reranker: { state: "disabled", warming: false, checkedAt: null, provider: null } },
          journal: null, sharedMemory: { supported: false, mode: "unavailable" },
        }),
        "engine.jobs.list": async () => [{ name: "consolidate-daily", needsLlm: false, singleton: false, phase: "deep" }],
        "engine.embedding.identities": async () => [],
        "engine.systemSupplement": async () => [],
        "engine.memory.list": async () => ({
          agentId: "alpha",
          items: [{ id: cardId, text: "Synthetic private evidence", summary: "Synthetic evidence",
            scope: "agent-private", createdAt: now - 86_400_000, origin: null, epistemicStatus: null }],
          truncated: false,
        }),
        "engine.memory.stats": async ({ ids, p, a }) => {
          reads.push({ ids, p, a });
          return { agentId: "alpha", items: [{ id: cardId, recalls: 4, distinctQueries: 3, lastRecalledAt: now - 100 }] };
        },
        "engine.memory.promote": async () => { promotions++; throw new Error("promotion is disabled"); },
        "engine.jobs.run": async () => ({
          runId: "fixture-run", job: "consolidate-daily", phase: "deep", agentId: "alpha", trigger: "harness",
          startedAt: now, finishedAt: now, durationMs: 0, outcome: "completed", attempt: 1, cost: { ms: 0 }, counts: {},
        }),
      },
    });
    const core = createCore({ home, clock: () => now, testInternals: flatTestInternals(),
      dreams: { defaultTimezone: "UTC", scheduler: false }, discovery: { scheduler: false } });
    let client: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      await engine.listen();
      await core.start();
      client = await connect({ address: core.address, token: core.token });
      await client.call("dreams.schedule.get", { agentId: "alpha" });
      // Seed only the scheduler's corpus counter. The candidate list and stats traverse the actual Core's RPC client.
      const store = new DreamStore(join(l.state, "dreams", "dreams.db"));
      try { store.updateSchedule("alpha", "deep", { capturesAcc: 3 }); }
      finally { store.close(); }

      const result = await client.call<{ outcome: string; counts: Record<string, number> }>(
        "dreams.run", { agentId: "alpha", phase: "deep" },
      );
      assert.equal(result.outcome, "completed", JSON.stringify(result));
      assert.equal(result.counts.candidates, 1);
      assert.equal(result.counts.promotionUnavailable ?? 0, recallStats ? 1 : 0);
      assert.equal(promotions, 0);
      assert.equal(reads.length, recallStats ? 1 : 0);
      if (recallStats) {
        assert.deepEqual(reads[0]!.ids, [cardId]);
        assert.equal((reads[0]!.p as { agentId: string }).agentId, "alpha");
        assert.deepEqual(reads[0]!.a, { origin: "system", background: false });
      }
    } finally {
      await client?.close();
      await core.stop();
      await engine.close();
      logger.close();
    }
  }
});
