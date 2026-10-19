// `memory reembed` in every direction (owner decision 2026-10-18: "das System soll in alle Richtungen migrationsfähig
// sein"): local→cloud, cloud→local, cloud→cloud, local→local. Each runs plan → run → switch through the real RPC handlers,
// the real driver, the real target rules and the real config switch port (buildEngineConfig decides what the engine
// would accept), over the fake engine. No network: the egress decision and the call budget are stubs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaults, type HarnessConfig } from "@plur1bus/config-schema";
import { validateParams, validateResult } from "@plur1bus/rpc-schema";
import { normalizeEmbeddingConfig } from "@cyb3rb1ade/plur1bus-memory/lib/providers/config-normalize.js";
import { embeddingFingerprintFromNormalizedConfig } from "@cyb3rb1ade/plur1bus-memory/lib/reembedding/runtime-config.js";
import { createMigrationDriver, type BatchBudget } from "../../src/embedding-migrate/driver.ts";
import { buildReembedMethods, REEMBED_METHODS } from "../../src/embedding-migrate/rpc.ts";
import { createStateStore } from "../../src/embedding-migrate/state.ts";
import { createConfigSwitchPort } from "../../src/embedding-migrate/switch.ts";
import { blockRemote, reembedTargetPolicy, targetFromSpec } from "../../src/embedding-migrate/target.ts";
import { checkEngineEgress, buildEngineConfig } from "../../src/engine-config.ts";
import type { EmbeddingFingerprint } from "../../src/embedding-migrate/probe.ts";
import { layout } from "../../src/paths.ts";
import { createFakeEngine } from "./fake-engine.ts";

const l = layout("/tmp/p1-directions-home");
const logger = { debug() {}, info() {}, warn() {} };

const OPENROUTER = { provider: "openrouter", model: "qwen/qwen3-embedding-8b", dimensions: 4096, baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" };
const JINA = { provider: "jina", model: "jina-embeddings-v3", dimensions: 1024, baseUrl: "https://api.jina.ai/v1", apiKeyEnv: "JINA_API_KEY" };
const E5 = { model: "intfloat/multilingual-e5-small" };
const JINA_LOCAL = { provider: "local-transformers", model: "jinaai/jina-embeddings-v5-text-nano-retrieval" };
type Spec = typeof OPENROUTER | typeof E5 | typeof JINA_LOCAL;
const ackFor = (s: { provider: string; baseUrl: string }) => ({ provider: s.provider, acknowledgedAt: "2026-10-18T10:00:00.000Z", by: "person-owner", endpoint: s.baseUrl });
const isCloud = (s: Spec): s is typeof OPENROUTER => "apiKeyEnv" in s;

/** The engine block a configuration holds for a provider, and the fingerprint the engine derives from it. */
function configured(s: Spec): Record<string, unknown> {
  if (isCloud(s)) return { ...s };
  return s.model === E5.model ? {} : { provider: "local-transformers", local: { model: s.model } };
}
function fingerprintOf(cfg: HarnessConfig): EmbeddingFingerprint {
  const n = normalizeEmbeddingConfig(buildEngineConfig(cfg, l).embedding as Record<string, unknown>);
  return embeddingFingerprintFromNormalizedConfig({ ...n, dimensions: n.dimensions }) as unknown as EmbeddingFingerprint;
}

interface RigOptions { budget?: BatchBudget | null; failBatch?: { n: number; error: Error; times?: number }; egressAllowed?: boolean; sleeps?: number[] }
function rig(from: Spec, to: Spec, o: RigOptions = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "p1-reembed-dir-"));
  const cfg = structuredClone(defaults()) as HarnessConfig;
  (cfg.engine as Record<string, unknown>).embedding = configured(from);
  // The configured acknowledgment admits the provider in use (a cloud source), else the cloud target. Cloud → cloud
  // acknowledges the target at plan time (acknowledgePrivacy) and the switch writes it with the new block.
  const acked = isCloud(from) ? from : isCloud(to) ? to : null;
  if (acked) (cfg.memory as Record<string, unknown>).embedding = { privacyAck: ackFor(acked) };
  const fake = createFakeEngine({ rows: { memories: 10, shared: 5 }, source: fingerprintOf(cfg), ...(o.failBatch ? { failBatch: o.failBatch } : {}) });
  const writes: { key: string; value: unknown }[][] = [];
  const real = createConfigSwitchPort({ layout: l, config: { current: () => cfg, set: async (changes) => {
    writes.push(changes);
    for (const c of changes) {
      const keys = c.key.split("."); let node = cfg as unknown as Record<string, unknown>;
      for (const k of keys.slice(0, -1)) node = (node[k] ??= {}) as Record<string, unknown>;
      node[keys.at(-1)!] = structuredClone(c.value);
    }
  } } });
  const egress = { decide: async (url: string) => (o.egressAllowed === false ? { allowed: false as const, reason: "host-not-allowed" as const, message: `refused ${new URL(url).host}` } : { allowed: true as const, host: new URL(url).hostname, port: 443, address: "93.184.216.34", family: 4 as const }) };
  const driver = createMigrationDriver({
    engine: fake.engine, store: createStateStore(dir), newId: () => "r1",
    sleep: async (ms) => { o.sleeps?.push(ms); },
    // the real config write first, then the fake engine's active generation (the restart that follows a config.set)
    switchPort: { async apply(sel) { await real.apply(sel); await fake.switchPort.apply(sel); } },
    budget: () => o.budget ?? null,
    // the core's wiring (core.ts): re-check a remote target before a run
    admitRun: async (c) => {
      const t = targetFromSpec({ provider: c.target.provider, model: c.target.model, dimensions: c.target.dimensions, ...blockRemote(c) }, { ...reembedTargetPolicy(cfg), ...(c.remote?.privacyAck ? { privacyAck: c.remote.privacyAck } : {}) });
      if (t.ok && !t.local) await checkEngineEgress({ embedding: t.block }, egress);
    },
  });
  const m = buildReembedMethods({ driver, isStopping: () => false, logger, targetPolicy: () => reembedTargetPolicy(cfg), egress });
  const call = async (method: (typeof REEMBED_METHODS)[number], params: unknown = {}) => {
    assert.deepEqual(validateParams(method, params), { ok: true }, `${method} params`);
    const r = await (m[method] as (p: unknown, c?: unknown) => Promise<unknown>)(params, {});
    assert.deepEqual(validateResult(method, r), { ok: true }, `${method} result: ${JSON.stringify(r)}`);
    return r as any;
  };
  const planParams = (s: Spec) => ({ ...s, throttleMs: 0, ...(isCloud(s) && isCloud(from) && s.provider !== from.provider ? { acknowledgePrivacy: true } : {}) });
  /** run and wait until the background loop and its follow-up switch settled */
  const runToEnd = async () => {
    const started = await call("admin.reembed.run");
    for (let i = 0; i < 400; i++) {
      const st = await call("admin.reembed.status");
      if (!st.running && ["switched", "failed", "aborted"].includes(st.checkpoint.phase) || (!st.running && st.checkpoint.error)) return st;
      await new Promise((r) => setTimeout(r, 5));
    }
    return started;
  };
  return { cfg, fake, writes, call, planParams, runToEnd, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const embeddingOf = (cfg: HarnessConfig) => (cfg.engine as Record<string, unknown>).embedding as Record<string, unknown>;

describe("memory reembed: every direction migrates (plan, run, switch)", () => {
  const cases: [string, Spec, Spec][] = [
    ["local → cloud", E5, OPENROUTER],
    ["cloud → local", OPENROUTER, E5],
    ["cloud → cloud (another provider, model and dimension count)", OPENROUTER, JINA],
    ["local → local (another pinned model)", E5, JINA_LOCAL],
  ];
  for (const [name, from, to] of cases) {
    it(name, async () => {
      const r = rig(from, to);
      try {
        const before = structuredClone(embeddingOf(r.cfg));
        const plan = await r.call("admin.reembed.plan", r.planParams(to));
        assert.equal(plan.probe.verdict, "migration-needed", JSON.stringify(plan.probe));
        assert.equal(plan.plan.rows, 15);
        const sent = r.fake.state.planRequests.at(-1)!;
        if (isCloud(to)) {
          assert.equal(plan.plan.cloud.provider, to.provider); assert.equal(plan.plan.cloud.cards, 15); assert.equal(plan.plan.cloud.sendsText, true);
          assert.ok(plan.plan.cloud.estimatedTokens > 0); assert.equal(plan.plan.cloud.endpoint, new URL(to.baseUrl).origin);
          assert.equal("estimatedCostMicros" in plan.plan.cloud, false, "tokens only: no cost estimate");
          assert.deepEqual(sent.target.secretRef, { source: "env", provider: "default", id: to.apiKeyEnv });
          assert.ok(!JSON.stringify(plan).includes("reemb_v1_"));
        } else {
          assert.equal("cloud" in plan.plan, false); assert.equal(sent.target.secretRef, undefined);
        }
        assert.deepEqual(embeddingOf(r.cfg), before, "planning changes no configuration");

        const st = await r.runToEnd();
        assert.equal(st.checkpoint.phase, "switched", JSON.stringify(st.checkpoint));
        assert.equal(r.writes.length, 1, "one config.set");
        const after = embeddingOf(r.cfg);
        if (isCloud(to)) assert.deepEqual(after, { provider: to.provider, model: to.model, dimensions: to.dimensions, baseUrl: to.baseUrl, apiKeyEnv: to.apiKeyEnv });
        else { assert.equal(after.provider, "local-transformers"); assert.equal((after.local as { model: string }).model, to.model); assert.ok(!("apiKeyEnv" in after) && !("baseUrl" in after)); }
        // the engine would accept the written configuration and derive exactly the target identity
        assert.equal(JSON.stringify(fingerprintOf(r.cfg)), JSON.stringify(r.fake.state.activeFingerprint));
        assert.ok(!JSON.stringify(r.cfg).includes("apiKey\""), "no key in the configuration");
        const ackNow = (r.cfg.memory as { embedding?: { privacyAck?: { provider: string; endpoint?: string } } }).embedding?.privacyAck;
        if (isCloud(to)) assert.deepEqual([ackNow?.provider, ackNow?.endpoint], [to.provider, to.baseUrl], "the acknowledgment in force admits the new provider");
        assert.deepEqual(r.writes[0]!.map((w) => w.key), ["engine.embedding", "engine.reembedding", ...(isCloud(from) && isCloud(to) ? ["memory.embedding.privacyAck"] : [])]);
      } finally { r.done(); }
    });
  }
});

describe("memory reembed: refusals come only from the provider rules", () => {
  it("privacy.localOnly blocks a cloud target at plan time (E_DENIED reason local-only); a local target stays possible", async () => {
    const r = rig(E5, OPENROUTER);
    try {
      (r.cfg as unknown as Record<string, unknown>).privacy = { localOnly: true, localEndpoints: [] };
      await assert.rejects(r.call("admin.reembed.plan", r.planParams(OPENROUTER)), (e: any) => e.error === "E_DENIED" && e.reason === "local-only");
      assert.equal(r.fake.state.planRequests.length, 0, "the engine is never asked");
      assert.equal((await r.call("admin.reembed.plan", r.planParams(JINA_LOCAL))).probe.verdict, "migration-needed");
    } finally { r.done(); }
  });

  it("a missing privacy acknowledgment blocks a cloud target (E_DENIED reason privacy-acknowledgment-required)", async () => {
    const r = rig(E5, OPENROUTER);
    try {
      (r.cfg.memory as Record<string, unknown>).embedding = {};
      await assert.rejects(r.call("admin.reembed.plan", r.planParams(OPENROUTER)), (e: any) => e.error === "E_DENIED" && e.reason === "privacy-acknowledgment-required");
      assert.equal(r.fake.state.planRequests.length, 0);
    } finally { r.done(); }
  });

  it("the egress policy blocks a cloud endpoint it does not allow (E_DENIED reason egress-denied)", async () => {
    const r = rig(E5, OPENROUTER, { egressAllowed: false });
    try {
      await assert.rejects(r.call("admin.reembed.plan", r.planParams(OPENROUTER)), (e: any) => e.error === "E_DENIED" && e.reason === "egress-denied");
    } finally { r.done(); }
  });

  it("privacy.localOnly switched on after the plan stops the run before any batch; the old configuration stays", async () => {
    const r = rig(E5, OPENROUTER);
    try {
      const before = structuredClone(embeddingOf(r.cfg));
      await r.call("admin.reembed.plan", r.planParams(OPENROUTER));
      (r.cfg as unknown as Record<string, unknown>).privacy = { localOnly: true, localEndpoints: [] };
      await assert.rejects(r.call("admin.reembed.run"), (e: any) => e.error === "E_DENIED" && e.reason === "local-only");
      assert.equal(r.fake.state.providerBatches, 0); assert.deepEqual(embeddingOf(r.cfg), before);
    } finally { r.done(); }
  });
});

describe("memory reembed to a cloud target: abort, budget, rate limits", () => {
  it("an interrupted run keeps the old configuration active and continues from the checkpoint", async () => {
    const r = rig(E5, OPENROUTER, { failBatch: { n: 3, error: new Error("upstream answered 400: invalid input") } });
    try {
      const before = structuredClone(embeddingOf(r.cfg));
      await r.call("admin.reembed.plan", r.planParams(OPENROUTER));
      const halted = await r.runToEnd();
      assert.equal(halted.checkpoint.phase, "aborted"); assert.equal(halted.checkpoint.error.code, "engine-error");
      assert.equal(halted.progress.batchesDone, 2);
      assert.deepEqual(embeddingOf(r.cfg), before, "the old configuration stays active"); assert.equal(r.writes.length, 0);
      const resumed = await r.runToEnd();
      assert.equal(resumed.checkpoint.phase, "switched"); assert.equal(embeddingOf(r.cfg).provider, "openrouter");
      assert.equal(r.fake.state.providerBatches, 7, "6 batches plus the one failed attempt: nothing copied twice");
    } finally { r.done(); }
  });

  it("a hard budget limit pauses the run (aborted, budget-exceeded, visible in status) and --run continues once it allows it", async () => {
    let allowed = 2; const settled: number[] = []; let released = 0; const asked: { provider: string; model: string; estimatedTokens: number }[] = [];
    const budget: BatchBudget = { admit(a) {
      asked.push(a);
      if (allowed <= 0) return { ok: false, message: "global tokens limit 100 reached (used 100)" };
      allowed--; return { ok: true, ticket: { settle: (t) => settled.push(t), release: () => { released++; } } };
    } };
    const r = rig(E5, OPENROUTER, { budget });
    try {
      const before = structuredClone(embeddingOf(r.cfg));
      const plan = await r.call("admin.reembed.plan", r.planParams(OPENROUTER));
      const paused = await r.runToEnd();
      assert.equal(paused.checkpoint.phase, "aborted"); assert.equal(paused.checkpoint.error.code, "budget-exceeded");
      assert.match(paused.checkpoint.error.message, /limit 100/);
      assert.equal(r.fake.state.providerBatches, 2, "no batch beyond the limit was sent");
      assert.deepEqual(embeddingOf(r.cfg), before);
      assert.equal(asked[0]!.provider, "openrouter"); assert.equal(asked[0]!.model, OPENROUTER.model);
      assert.equal(asked[0]!.estimatedTokens, 3 * paused.checkpoint.remote.tokensPerRow, "batch rows x per-card estimate");
      assert.ok(Math.abs(paused.checkpoint.remote.tokensPerRow * 15 - plan.plan.cloud.estimatedTokens) < 15);
      assert.deepEqual(settled.length, 2); assert.equal(released, 0);
      allowed = 100;
      const done = await r.runToEnd();
      assert.equal(done.checkpoint.phase, "switched"); assert.equal(r.fake.state.providerBatches, 6);
    } finally { r.done(); }
  });

  it("429 and 5xx answers are retried with exponential backoff; the budget reservation of a refused attempt is released", async () => {
    const sleeps: number[] = []; let released = 0, settled = 0;
    const budget: BatchBudget = { admit: () => ({ ok: true, ticket: { settle: () => { settled++; }, release: () => { released++; } } }) };
    const r = rig(E5, OPENROUTER, { failBatch: { n: 2, times: 2, error: new Error("429 Too Many Requests") }, sleeps, budget });
    try {
      await r.call("admin.reembed.plan", r.planParams(OPENROUTER));
      const st = await r.runToEnd();
      assert.equal(st.checkpoint.phase, "switched");
      assert.deepEqual(sleeps.filter((ms) => ms >= 1000), [1000, 2000], "1 s, then 2 s");
      assert.equal(released, 2); assert.equal(settled, 6);
    } finally { r.done(); }
  });

  it("a provider that keeps failing halts the run after the retries (resumable, old configuration active)", async () => {
    const sleeps: number[] = [];
    const r = rig(E5, OPENROUTER, { failBatch: { n: 1, times: 50, error: new Error("503 Service Unavailable") }, sleeps });
    try {
      await r.call("admin.reembed.plan", r.planParams(OPENROUTER));
      const st = await r.runToEnd();
      assert.equal(st.checkpoint.phase, "aborted"); assert.equal(st.checkpoint.error.code, "engine-error");
      assert.deepEqual(sleeps.filter((ms) => ms >= 1000), [1000, 2000, 4000, 8000]);
      assert.equal(embeddingOf(r.cfg).provider, undefined, "still the default local embedding");
    } finally { r.done(); }
  });
});
