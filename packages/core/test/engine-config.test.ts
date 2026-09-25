import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaults } from "@plur1bus/config-schema";
import { buildEngineConfig } from "../src/engine-config.ts";
import { layout } from "../src/paths.ts";

describe("engine-config", () => {
  const l = layout("/h/.plur1bus");
  it("forces the harness-owned keys and passes engine keys through", () => {
    const cfg = defaults(); cfg.engine.recallMinScore = 0.42;
    const e = buildEngineConfig(cfg, l) as any;
    assert.equal(e.baseDbPath, "/h/.plur1bus/state/lancedb");
    assert.equal(e.autoRecall, false); assert.equal(e.autoCapture, false);
    assert.equal(e.embedding.provider, "local-transformers"); assert.equal(e.embedding.local.model, "intfloat/multilingual-e5-small"); assert.equal(e.embedding.local.dimensions, 384);
    assert.equal(e.embedding.local.cacheDir, "/h/.plur1bus/models");
    assert.equal(e.reranker.enabled, true); assert.equal(e.reranker.provider, "local-transformers"); assert.equal(e.reranker.local.model, "woxpas-ai/bge-reranker-v2-m3-onnx");
    assert.equal(e.recall.softBudgetMs, 400); assert.equal(e.recall.globalInjectMaxChars, 17000); assert.equal(e.recall.decisionTrace.enabled, true);
    assert.equal(e.recallMinScore, 0.42);
  });
  it("a user cannot override the forced keys through engine.*", () => {
    const cfg = defaults(); cfg.engine.baseDbPath = "/elsewhere"; cfg.engine.autoCapture = true;
    const e = buildEngineConfig(cfg, l) as any;
    assert.equal(e.baseDbPath, "/h/.plur1bus/state/lancedb"); assert.equal(e.autoCapture, false);
  });
  it("baseDbPathOverride wins over the layout (tests only)", () => {
    const cfg = defaults(); cfg.engine.baseDbPathOverride = "/tmp/db";
    assert.equal((buildEngineConfig(cfg, l) as any).baseDbPath, "/tmp/db");
  });
  it("a user cannot override reranker.enabled/provider through engine.reranker", () => {
    const cfg = defaults(); cfg.engine.reranker = { enabled: false, provider: "cohere" };
    const e = buildEngineConfig(cfg, l) as any;
    assert.equal(e.reranker.enabled, true); assert.equal(e.reranker.provider, "local-transformers");
  });
});
