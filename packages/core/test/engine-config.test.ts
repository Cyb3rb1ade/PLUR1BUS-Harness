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
  // Owner decision 2026-10-18: cloud embeddings and cloud reranking must work; no provider is privileged.
  const ack = (provider: string, endpoint?: string) => ({ provider, acknowledgedAt: "2026-10-18T09:00:00Z", by: "owner", ...(endpoint ? { endpoint } : {}) });
  const remote = (embedding: Record<string, unknown>, privacyAck?: unknown) => {
    const cfg = defaults() as any; cfg.engine.embedding = embedding;
    if (privacyAck) cfg.memory = { ...cfg.memory, embedding: { privacyAck } };
    return cfg;
  };
  it("passes an OpenAI embedding (direct, default endpoint) through to the engine unchanged", () => {
    const e = buildEngineConfig(remote({ provider: "openai", model: "text-embedding-3-small", dimensions: 1536, apiKeyEnv: "OPENAI_API_KEY" }, ack("openai")), l) as any;
    assert.deepEqual(e.embedding, { provider: "openai", model: "text-embedding-3-small", dimensions: 1536, apiKeyEnv: "OPENAI_API_KEY" });
    assert.equal(e.reranker.provider, "local-transformers");
  });
  it("passes a Qwen embedding through an OpenRouter-compatible endpoint", () => {
    const baseUrl = "https://openrouter.ai/api/v1";
    const e = buildEngineConfig(remote({ provider: "openrouter", baseUrl, model: "qwen/qwen3-embedding-8b", dimensions: 4096, apiKeyEnv: "OPENROUTER_API_KEY" }, ack("openrouter", baseUrl)), l) as any;
    assert.deepEqual(e.embedding, { provider: "openrouter", baseUrl, model: "qwen/qwen3-embedding-8b", dimensions: 4096, apiKeyEnv: "OPENROUTER_API_KEY" });
  });
  it("passes a Cohere embedding through Cohere's OpenAI-compatible endpoint", () => {
    const baseUrl = "https://api.cohere.ai/compatibility/v1";
    const e = buildEngineConfig(remote({ provider: "cohere", baseUrl, model: "embed-v4.0", dimensions: 1536, apiKeyEnv: "COHERE_API_KEY" }, ack("cohere", baseUrl)), l) as any;
    assert.equal(e.embedding.provider, "cohere"); assert.equal(e.embedding.baseUrl, baseUrl); assert.equal(e.embedding.model, "embed-v4.0");
    assert.equal(e.embedding.dimensions, 1536); assert.equal(e.embedding.apiKeyEnv, "COHERE_API_KEY");
    assert.equal("local" in e.embedding, false);
  });
  for (const [provider, baseUrl, model, dimensions] of [["jina", "https://api.jina.ai/v1", "jina-embeddings-v3", 1024], ["voyage", "https://api.voyageai.com/v1", "voyage-3", 1024], ["google", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-embedding-001", 3072], ["openai-compatible", "https://embeddings.example.com/v1", "any-model", 768]] as const) {
    it(`passes ${provider} embedding through with its endpoint`, () => {
      const e = buildEngineConfig(remote({ provider, baseUrl, model, dimensions, apiKeyEnv: "EMBED_KEY" }, ack(provider, baseUrl)), l) as any;
      assert.equal(e.embedding.provider, provider); assert.equal(e.embedding.baseUrl, baseUrl); assert.equal(e.embedding.dimensions, dimensions);
    });
  }
  for (const provider of ["ollama", "tei", "vllm", "llamacpp", "omlx", "mtplx"]) {
    it(`passes self-hosted ${provider} embedding on loopback through without substituting another model`, () => {
      const e = buildEngineConfig(remote({ provider, baseUrl: "http://127.0.0.1:11434/v1", model: "other-space", dimensions: 32, apiKeyEnv: "LOCAL_EMBED_KEY" }), l) as any;
      assert.equal(e.embedding.provider, provider); assert.equal(e.embedding.model, "other-space"); assert.equal(e.embedding.dimensions, 32);
    });
    it(`refuses self-hosted ${provider} embedding without an endpoint instead of calling the default one`, () => {
      assert.throws(() => buildEngineConfig(remote({ provider, model: "other-space", dimensions: 32, apiKeyEnv: "LOCAL_EMBED_KEY" }), l),
        (e: any) => e.error === "E_INVALID_PARAMS" && e.reason === "engine-provider-config-incomplete" && /baseUrl/.test(e.message));
    });
  }
  it("passes a Cohere cloud reranker through, mandatory and without a fallback model", () => {
    const cfg = defaults(); cfg.engine.reranker = { provider: "cohere", model: "rerank-v3.5", apiKeyEnv: "COHERE_API_KEY", enabled: false };
    const e = buildEngineConfig(cfg, l) as any;
    assert.deepEqual(e.reranker, { provider: "cohere", model: "rerank-v3.5", apiKeyEnv: "COHERE_API_KEY", enabled: true, fallbackProvider: "disabled" });
    assert.equal(e.embedding.provider, "local-transformers");
  });
  for (const provider of ["jina", "voyage", "openai-compatible", "ollama", "tei", "vllm", "llamacpp", "omlx", "mtplx"]) {
    it(`refuses reranker ${provider}, which the pinned engine has no adapter for, without substituting another model`, () => {
      const cfg = defaults(); cfg.engine.reranker = { provider, model: "other", apiKeyEnv: "RERANK_KEY", baseUrl: "https://example.com" };
      assert.throws(() => buildEngineConfig(cfg, l), (e: any) => e.error === "E_NOT_AVAILABLE" && e.reason === "engine-adapter-factory-unavailable");
    });
  }
  for (const role of ["embedding", "reranker"] as const) {
    for (const provider of ["", null, 3, "bad id!"]) {
      it(`refuses a malformed ${role} provider ${JSON.stringify(provider)}`, () => {
        const cfg = defaults(); cfg.engine[role] = { provider, baseUrl: "https://example.com", model: "m", dimensions: 8, apiKeyEnv: "K" };
        assert.throws(() => buildEngineConfig(cfg, l), (e: any) => e.error === "E_INVALID_PARAMS" && e.reason === "engine-provider-invalid");
      });
    }
    it(`refuses a plaintext ${role} apiKey (only a reference, apiKeyEnv, may stand in the configuration)`, () => {
      const cfg = defaults() as any; cfg.engine[role] = { provider: role === "embedding" ? "openai" : "cohere", model: "m", dimensions: 8, apiKey: "redact-probe-alpha" };
      cfg.memory = { ...cfg.memory, embedding: { privacyAck: ack("openai") } };
      assert.throws(() => buildEngineConfig(cfg, l), (e: any) => e.reason === "secret-in-config" && !String(e.message).includes("redact-probe-alpha"));
    });
    it(`refuses a ${role} cloud provider without a key reference`, () => {
      const cfg = defaults() as any; cfg.engine[role] = { provider: role === "embedding" ? "openai" : "cohere", model: "m", dimensions: 8 };
      cfg.memory = { ...cfg.memory, embedding: { privacyAck: ack("openai") } };
      assert.throws(() => buildEngineConfig(cfg, l), (e: any) => e.reason === "engine-provider-config-incomplete" && /apiKeyEnv/.test(e.message));
    });
    it(`refuses the ${role} key spelling baseURL, which the engine would ignore and so call its default endpoint`, () => {
      const cfg = defaults() as any; cfg.engine[role] = { provider: role === "embedding" ? "openrouter" : "cohere", baseURL: "https://openrouter.ai/api/v1", model: "m", dimensions: 8, apiKeyEnv: "K" };
      assert.throws(() => buildEngineConfig(cfg, l), (e: any) => e.reason === "engine-provider-config-incomplete" && /baseURL/.test(e.message));
    });
  }
  for (const [missing, embedding] of [["model", { provider: "openai", dimensions: 1536, apiKeyEnv: "K" }], ["dimensions", { provider: "openai", model: "text-embedding-3-small", apiKeyEnv: "K" }], ["dimensions", { provider: "openai", model: "text-embedding-3-small", dimensions: 0, apiKeyEnv: "K" }]] as const) {
    it(`refuses a cloud embedding without ${missing}`, () => {
      assert.throws(() => buildEngineConfig(remote(embedding, ack("openai")), l), (e: any) => e.error === "E_INVALID_PARAMS" && e.reason === "engine-provider-config-incomplete" && e.message.includes(missing));
    });
  }
  it("refuses an embedding endpoint that is not http(s) or carries credentials", () => {
    for (const baseUrl of ["ftp://example.com", "not a url", 3]) assert.throws(() => buildEngineConfig(remote({ provider: "x", baseUrl, model: "m", dimensions: 8, apiKeyEnv: "K" }), l), (e: any) => e.reason === "engine-provider-config-incomplete");
    assert.throws(() => buildEngineConfig(remote({ provider: "x", baseUrl: "https://user:pw@example.com/v1", model: "m", dimensions: 8, apiKeyEnv: "K" }), l), (e: any) => e.reason === "secret-in-config");
  });
  it("refuses an embedding fallback model: no silent switch to another vector space", () => {
    assert.throws(() => buildEngineConfig(remote({ provider: "openai", model: "text-embedding-3-small", dimensions: 1536, apiKeyEnv: "K", fallback: { model: "text-embedding-3-large" } }, ack("openai")), l),
      (e: any) => e.reason === "embedding-fallback-refused");
  });
  it("refuses a reranker fallback model and a custom Cohere endpoint the engine would ignore", () => {
    const cfg = defaults(); cfg.engine.reranker = { provider: "cohere", apiKeyEnv: "K", fallbackProvider: "local-transformers" };
    assert.throws(() => buildEngineConfig(cfg, l), (e: any) => e.reason === "reranker-fallback-refused");
    cfg.engine.reranker = { provider: "cohere", apiKeyEnv: "K", baseUrl: "https://example.com" };
    assert.throws(() => buildEngineConfig(cfg, l), (e: any) => e.reason === "engine-provider-config-incomplete");
  });
  it("refuses a remote embedding without the privacy acknowledgment for exactly that provider and endpoint", () => {
    const baseUrl = "https://openrouter.ai/api/v1", e = { provider: "openrouter", baseUrl, model: "qwen/qwen3-embedding-8b", dimensions: 4096, apiKeyEnv: "K" };
    assert.throws(() => buildEngineConfig(remote(e), l), (x: any) => x.error === "E_DENIED" && x.reason === "privacy-acknowledgment-required");
    assert.throws(() => buildEngineConfig(remote(e, ack("openai")), l), (x: any) => x.error === "E_DENIED" && x.reason === "privacy-acknowledgment-mismatch");
    assert.throws(() => buildEngineConfig(remote(e, ack("openrouter", "https://other.example/v1")), l), (x: any) => x.reason === "privacy-acknowledgment-mismatch");
    assert.throws(() => buildEngineConfig(remote(e, { provider: "openrouter", endpoint: baseUrl, by: "", acknowledgedAt: "x" }), l), (x: any) => x.reason === "privacy-acknowledgment-invalid");
  });
  it("needs no privacy acknowledgment for a loopback endpoint (localhost, 127.0.0.0/8, ::1)", () => {
    for (const baseUrl of ["http://localhost:8080/v1", "http://127.0.0.2:8080/v1", "http://[::1]:8080/v1"]) {
      assert.equal((buildEngineConfig(remote({ provider: "tei", baseUrl, model: "m", dimensions: 8, apiKeyEnv: "K" }), l) as any).embedding.baseUrl, baseUrl);
    }
    assert.throws(() => buildEngineConfig(remote({ provider: "tei", baseUrl: "http://192.168.1.5:8080/v1", model: "m", dimensions: 8, apiKeyEnv: "K" }), l), (x: any) => x.reason === "privacy-acknowledgment-required");
  });
  it("KNOWN GAP: an installation- or agent-wide privacy pin (local-only) refuses cloud providers", { todo: "no such config key exists (docs/handoff/2026-10-14-backend-gaps.md item 3, owner question); only per-turn voice pins and the media privacyPinned callback exist" }, () => {
    assert.fail("no installation-wide privacy pin to test against");
  });
  it("KNOWN GAP: a cloud reranker needs a function-specific privacy acknowledgment", { todo: "the config schema has memory.embedding.privacyAck but no reranker acknowledgment; adding one is a schema change" }, () => {
    const cfg = defaults(); cfg.engine.reranker = { provider: "cohere", apiKeyEnv: "K" };
    assert.throws(() => buildEngineConfig(cfg, l));
  });
  it("KNOWN GAP: a key from the harness secret store reaches the engine as a reference", { todo: "the pinned engine resolves keys only from apiKeyEnv or host-SDK SecretRefs the harness does not provide; HostServices has no secret port" }, () => {
    const cfg = defaults() as any; cfg.engine.embedding = { provider: "openai", model: "m", dimensions: 8, apiKey: { source: "store", id: "openai" } };
    cfg.memory = { ...cfg.memory, embedding: { privacyAck: ack("openai") } };
    assert.equal((buildEngineConfig(cfg, l) as any).embedding.apiKey.source, "store");
  });
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
