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
  it("a user cannot disable the mandatory local reranker", () => {
    const cfg = defaults(); cfg.engine.reranker = { enabled: false, provider: "local-transformers" };
    const e = buildEngineConfig(cfg, l) as any;
    assert.equal(e.reranker.enabled, true); assert.equal(e.reranker.provider, "local-transformers");
  });
  for (const role of ["embedding", "reranker"] as const) {
    for (const provider of ["openai", "google", "cohere", "jina", "voyage", "openrouter", "openai-compatible", "unknown", "", null, 3]) {
      it(`refuses unapproved ${role} provider ${String(provider)} before engine construction`, () => {
        const cfg = defaults(); cfg.engine[role] = { provider, baseURL: "https://example.com" };
        assert.throws(() => buildEngineConfig(cfg, l), (e: any) => e.reason === "embedding-provider-not-approved");
      });
    }
    for (const provider of ["ollama", "tei", "vllm", "llamacpp", "omlx", "mtplx"]) {
      it(`refuses unsupported ${role} ${provider} without silently substituting another model`, () => {
        const cfg = defaults(); cfg.engine[role] = { provider, model: "other-space", dimensions: 32 };
        assert.throws(() => buildEngineConfig(cfg, l), (e: any) => e.reason === "engine-adapter-factory-unavailable");
      });
    }
  }
  it("passes the 7.18.5–7.18.20 engine keys through (contract 1.12.0)", () => {
    const cfg = defaults();
    cfg.engine.captureChunkingMode = "automatisch";
    cfg.engine.captureChunkingJev = { apiKeyEnv: "TYPESAFE_API_KEY", model: "jev-latest", minConfidence: 0.85, timeoutMs: 5000 };
    cfg.engine.runtime = { deferPostTurnLlm: true };
    cfg.engine.dreaming = { narrative: { diaryFromUserChats: false } };
    cfg.engine.recall = { fullTextTopRecords: 3, fullTextMaxChars: 2000 };
    const e = buildEngineConfig(cfg, l) as any;
    assert.equal(e.captureChunkingMode, "automatisch");
    assert.equal(e.captureChunkingJev.model, "jev-latest");
    assert.equal(e.runtime.deferPostTurnLlm, true);
    assert.equal(e.dreaming.narrative.diaryFromUserChats, false);
    assert.equal(e.recall.fullTextTopRecords, 3);
    assert.equal(e.recall.fullTextMaxChars, 2000);
    assert.equal(e.recall.softBudgetMs, 400);
    assert.equal(e.recall.decisionTrace.enabled, true);
  });
});
