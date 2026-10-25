// The whole stack against the REAL engine (flat embedder and flat target provider seams, no model download): RPC → driver →
// engine port → the pinned engine's re-embedding coordinator. What the fakes cannot prove: the answers' shapes, the engine's
// own "no change" refusal text, a copy of a store with data and the engine's validation (contract 1.17.0) up to
// `ready-to-switch`. The switch itself writes config.json through the supervisor, which this in-process core has none of: it
// is refused with the reason and the old model stays active (tests/system/reembed.test.ts makes the switch).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import type { CoreClient } from "@plur1bus/module-api";
import { connect } from "../helpers/connect.ts";
import { defaults } from "@plur1bus/config-schema";
import { validateResult } from "@plur1bus/rpc-schema";
import { createCore, type Core } from "../../src/core.ts";
import { layout } from "../../src/paths.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const E5 = "intfloat/multilingual-e5-small";
const caller = { channel: "cli" as const, accountId: "macbooker", userId: "cyberblade" };
const JINA = "jinaai/jina-embeddings-v3";

describe("re-embedding over the real engine (in-process core)", () => {
  const home = tempDir("p1b-reembed-");
  let core: Core; let c: CoreClient;
  before(async () => {
    const cfg = defaults(); cfg.agents.bernd = {};
    cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false } };
    writeFileSync(layout(home).configPath, JSON.stringify(cfg));
    core = createCore({ home, testInternals: flatTestInternals() });
    await core.start();
    c = await connect({ address: core.address, token: core.token });
    // The recall-path warm-up creates the memories table lazily (two Lance versions). A plan taken before it ends
    // records version N and the run then finds N+1 (source-drift): the engine is right to refuse, so the test plans
    // against a settled store. Slow runners (Windows CI) land the warm-up after the first plan.
    const until = Date.now() + 30_000;
    while (!core.status().engine.ready && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    assert.equal(core.status().engine.ready, true, "the engine warm-up finished");
    // A memory to move: the engine's validation recalls one source memory from the copied generation.
    await c.call("memory.capture", { caller, agentId: "bernd", wait: true, messages: [{ role: "user", content: "Please remember that the boiler service is on Tuesday." }, { role: "assistant", content: "Noted." }] });
  });
  after(async () => { await c?.close(); await core?.stop({ budgetMs: 5000 }); });

  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const r = await c.call(method, params);
    assert.deepEqual(validateResult(method, r), { ok: true }, `${method}: ${JSON.stringify(r)}`);
    return r as any;
  };

  it("advertises the four methods", () => {
    for (const m of ["admin.reembed.plan", "admin.reembed.run", "admin.reembed.status", "admin.reembed.abort"]) {
      assert.equal(c.hello.capabilities?.methods[m]?.stability, "experimental", m);
      assert.ok(c.supports(m), m);
    }
  });

  it("admin.embedding.check says what a config set does to the embedding of a store with data", async () => {
    assert.equal(c.hello.capabilities?.methods["admin.embedding.check"]?.stability, "experimental");
    const current = { provider: "local-transformers", model: E5, dimensions: 384 };
    assert.deepEqual(await call("admin.embedding.check", { changes: [{ key: "engine.embedding.local.model", value: E5 }] }), { effect: "unchanged", current, target: null, canSwitch: true });
    // Agent bernd's table holds a memory, so another model moves the store; the engine validates (1.17.0), so the run switches.
    assert.deepEqual(await call("admin.embedding.check", { changes: [{ key: "engine.embedding.local.model", value: "google/embeddinggemma-2" }] }),
      { effect: "move", current, target: { provider: "local-transformers", model: "google/embeddinggemma-2", dimensions: 768 }, canSwitch: true });
    // A non-commercial model needs its persisted licence confirmation, as at the engine start; an unpinned one is refused.
    await assert.rejects(c.call("admin.embedding.check", { changes: [{ key: "engine.embedding.local", value: { model: JINA } }] }), (e: any) => e.error === "E_DENIED" && e.reason === "model-licence-required");
    await assert.rejects(c.call("admin.embedding.check", { changes: [{ key: "engine.embedding.local.model", value: "Qwen/Qwen3-Embedding-0.6B" }] }), (e: any) => e.error === "E_INVALID_PARAMS" && e.reason === "embedding-model-unavailable");
  });

  it("the harness default model is already the store's identity: compatible, nothing to migrate", async () => {
    const r = await call("admin.reembed.plan", { model: E5 });
    assert.equal(r.probe.verdict, "compatible"); assert.equal(r.plan, null);
    assert.equal((await call("admin.reembed.status")).checkpoint, null);
  });

  it("a different pinned model plans against the real engine, copies the store and the engine validates it: ready to switch", async () => {
    const plan = await call("admin.reembed.plan", { model: "google/embeddinggemma-2", throttleMs: 0 });
    assert.equal(plan.probe.verdict, "migration-needed", JSON.stringify(plan.probe));
    assert.ok(plan.probe.changed.includes("model")); assert.equal(plan.plan.sourceGeneration.length > 0, true);
    assert.equal(plan.plan.batchSize, 8);
    assert.ok(!JSON.stringify(plan).includes("reemb_v1_"));
    const planned = await call("admin.reembed.status");
    assert.equal(planned.checkpoint.phase, "planned"); assert.equal(planned.engineState, "planned");

    // The engine keeps an unconfirmed plan for its confirmation lifetime and refuses a second record meanwhile. Planning
    // the same target again (a dry run, then the apply) reuses that plan; another target is a clear conflict.
    const again = await call("admin.reembed.plan", { model: "google/embeddinggemma-2", throttleMs: 0 });
    assert.equal(again.plan.id, plan.plan.id, "the unstarted plan is reused");
    assert.deepEqual(again, plan);
    await assert.rejects(c.call("admin.reembed.plan", { model: JINA }),
      (e: any) => e.error === "E_CONFLICT" && e.reason === "migration-active" && /until \d{4}-\d\d-\d\dT/.test(e.message) && /--abort/.test(e.message));
    assert.equal((await call("admin.reembed.status")).checkpoint.id, plan.plan.id);

    await call("admin.reembed.run", { switch: false });
    let st = await call("admin.reembed.status");
    for (let i = 0; i < 200 && st.running; i++) { await new Promise((r) => setTimeout(r, 25)); st = await call("admin.reembed.status"); }
    assert.equal(st.checkpoint.phase, "ready-to-switch", JSON.stringify(st.checkpoint));
    assert.equal(st.checkpoint.error, null);
    assert.equal(st.engineState, "ready_to_switch");
    assert.ok(st.progress.rows >= 1); assert.equal(st.progress.rowsDone, st.progress.rows);
  });

  it("the switch needs the supervisor: refused with the reason, the old model stays active; a second plan waits for it", async () => {
    await assert.rejects(c.call("admin.reembed.run", { switch: true }), (e: any) => e.reason === "switch-unavailable");
    const st = await call("admin.reembed.status");
    assert.equal(st.checkpoint.phase, "ready-to-switch"); assert.equal(st.checkpoint.error.code, "switch-unavailable");
    assert.deepEqual((await call("admin.embedding.check", { changes: [{ key: "engine.embedding.local.model", value: E5 }] })).effect, "unchanged");
    await assert.rejects(c.call("admin.reembed.plan", { model: JINA }), (e: any) => e.error === "E_CONFLICT" && e.reason === "migration-active");
    const r = await call("admin.reembed.abort");
    assert.equal(r.checkpoint.phase, "aborted");
  });
});
