// The whole stack against the REAL engine (flat embedder seam, no model download): RPC → driver → engine port →
// the pinned engine's re-embedding coordinator. What the fakes cannot prove: the answers' shapes, the engine's own
// "no change" refusal text, the empty-store plan and the fail-closed stop at `validating` (the pinned contract has no
// validate).
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

  it("the harness default model is already the store's identity: compatible, nothing to migrate", async () => {
    const r = await call("admin.reembed.plan", { model: E5 });
    assert.equal(r.probe.verdict, "compatible"); assert.equal(r.plan, null);
    assert.equal((await call("admin.reembed.status")).checkpoint, null);
  });

  it("a different pinned model plans against the real engine, runs, and stops fail-closed at validating", async () => {
    const plan = await call("admin.reembed.plan", { model: JINA, throttleMs: 0 });
    assert.equal(plan.probe.verdict, "migration-needed", JSON.stringify(plan.probe));
    assert.ok(plan.probe.changed.includes("model")); assert.equal(plan.plan.sourceGeneration.length > 0, true);
    assert.equal(plan.plan.batchSize, 8);
    assert.ok(!JSON.stringify(plan).includes("reemb_v1_"));
    const planned = await call("admin.reembed.status");
    assert.equal(planned.checkpoint.phase, "planned"); assert.equal(planned.engineState, "planned");

    await call("admin.reembed.run", { switch: false });
    let st = await call("admin.reembed.status");
    for (let i = 0; i < 200 && st.running; i++) { await new Promise((r) => setTimeout(r, 25)); st = await call("admin.reembed.status"); }
    assert.equal(st.checkpoint.phase, "validating", JSON.stringify(st.checkpoint));
    assert.equal(st.checkpoint.error.code, "engine-validate-unavailable");
    assert.equal(st.engineState, "validating");
    assert.equal(st.progress.rowsDone, st.progress.rows);
  });

  it("a switch is never made from there, and a second plan is refused while it is unfinished", async () => {
    await assert.rejects(c.call("admin.reembed.plan", { model: JINA }), (e: any) => e.error === "E_CONFLICT" && e.reason === "migration-active");
    const r = await call("admin.reembed.abort");
    assert.equal(r.checkpoint.phase, "aborted");
  });
});
