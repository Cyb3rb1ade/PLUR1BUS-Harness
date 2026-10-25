import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaults } from "@plur1bus/config-schema";
import { buildEngineConfig, checkEngineEgress } from "../src/engine-config.ts";
import { createEgress } from "../src/egress/index.ts";
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
    const cfg = defaults() as any; cfg.engine.reranker = { provider: "cohere", model: "rerank-v3.5", apiKeyEnv: "COHERE_API_KEY", enabled: false };
    cfg.memory = { ...cfg.memory, reranker: { privacyAck: ack("cohere") } };
    const e = buildEngineConfig(cfg, l) as any;
    assert.deepEqual(e.reranker, { provider: "cohere", model: "rerank-v3.5", apiKeyEnv: "COHERE_API_KEY", enabled: true, fallbackProvider: "disabled" });
    assert.equal(e.embedding.provider, "local-transformers");
  });
  for (const provider of ["openai-compatible", "ollama", "tei", "vllm", "llamacpp", "omlx", "mtplx"]) {
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
  it("refuses a reranker fallback model and checks custom endpoint privacy", () => {
    const cfg = defaults(); cfg.engine.reranker = { provider: "cohere", apiKeyEnv: "K", fallbackProvider: "local-transformers" };
    assert.throws(() => buildEngineConfig(cfg, l), (e: any) => e.reason === "reranker-fallback-refused");
    cfg.engine.reranker = { provider: "cohere", apiKeyEnv: "K", baseUrl: "https://example.com" };
    assert.throws(() => buildEngineConfig(cfg, l), (e: any) => e.reason === "privacy-acknowledgment-required");
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
  // Owner decision 2026-10-18: "Nur lokal" exists; a cloud reranker needs its own privacy acknowledgment.
  const localOnly = (cfg: any, endpoints: string[] = []) => { cfg.privacy = { localOnly: true, localEndpoints: endpoints }; return cfg; };
  it("privacy.localOnly refuses every cloud embedding with E_DENIED reason local-only, even with a privacy acknowledgment", () => {
    for (const [embedding, privacyAck] of [
      [{ provider: "openai", model: "text-embedding-3-small", dimensions: 1536, apiKeyEnv: "K" }, ack("openai")],
      [{ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "qwen/qwen3-embedding-8b", dimensions: 4096, apiKeyEnv: "K" }, ack("openrouter", "https://openrouter.ai/api/v1")],
    ] as const) {
      assert.throws(() => buildEngineConfig(localOnly(remote(embedding, privacyAck)), l), (e: any) => e.error === "E_DENIED" && e.reason === "local-only" && /privacy\.localOnly/.test(e.message));
    }
  });
  it("privacy.localOnly treats a LAN embedding server as cloud unless privacy.localEndpoints lists its exact origin", () => {
    const baseUrl = "http://192.168.1.20:11434/v1", e = { provider: "ollama", baseUrl, model: "nomic-embed-text", dimensions: 768, apiKeyEnv: "K" };
    assert.throws(() => buildEngineConfig(localOnly(remote(e, ack("ollama", baseUrl))), l), (x: any) => x.reason === "local-only");
    assert.throws(() => buildEngineConfig(localOnly(remote(e, ack("ollama", baseUrl)), ["http://192.168.1.20:8080"]), l), (x: any) => x.reason === "local-only");
    assert.equal((buildEngineConfig(localOnly(remote(e, ack("ollama", baseUrl)), ["http://192.168.1.20:11434"]), l) as any).embedding.baseUrl, baseUrl);
    // Listed as local, the endpoint is still off this machine: the privacy acknowledgment stays required.
    assert.throws(() => buildEngineConfig(localOnly(remote(e), ["http://192.168.1.20:11434"]), l), (x: any) => x.reason === "privacy-acknowledgment-required");
  });
  it("privacy.localOnly keeps loopback and the pinned local models", () => {
    const e = buildEngineConfig(localOnly(remote({ provider: "tei", baseUrl: "http://127.0.0.1:8080/v1", model: "m", dimensions: 8, apiKeyEnv: "K" })), l) as any;
    assert.equal(e.embedding.baseUrl, "http://127.0.0.1:8080/v1");
    const d = buildEngineConfig(localOnly(defaults() as any), l) as any;
    assert.equal(d.embedding.provider, "local-transformers"); assert.equal(d.reranker.provider, "local-transformers");
  });
  it("privacy.localOnly refuses the Cohere cloud reranker", () => {
    const cfg = localOnly(defaults() as any); cfg.engine.reranker = { provider: "cohere", apiKeyEnv: "K" };
    cfg.memory = { ...cfg.memory, reranker: { privacyAck: ack("cohere") } };
    assert.throws(() => buildEngineConfig(cfg, l), (e: any) => e.error === "E_DENIED" && e.reason === "local-only");
  });
  it("one local-only agent keeps the shared engine local; an agent lifting the switch does not open it", () => {
    const cfg = remote({ provider: "openai", model: "text-embedding-3-small", dimensions: 1536, apiKeyEnv: "K" }, ack("openai"));
    cfg.agents = { bernd: { privacy: { localOnly: true } } };
    assert.throws(() => buildEngineConfig(cfg, l), (e: any) => e.reason === "local-only-shared-engine" && e.message.includes("bernd"));
    cfg.privacy = { localOnly: true, localEndpoints: [] }; cfg.agents = { bernd: { privacy: { localOnly: false } } };
    assert.throws(() => buildEngineConfig(cfg, l), (e: any) => e.reason === "local-only");
    cfg.privacy = { localOnly: false, localEndpoints: [] }; cfg.agents = { bernd: { privacy: { localOnly: false } } };
    assert.equal((buildEngineConfig(cfg, l) as any).embedding.provider, "openai");
  });
  it("privacy.localOnly refuses an engine LLM feature with a cloud transport or a key without endpoint", () => {
    for (const [key, value] of [["merging", { baseUrl: "https://api.openai.com/v1", model: "gpt-x", apiKey: "${OPENAI}" }], ["emotion", { t3: { baseUrl: "https://example.com/v1" } }], ["skillMiner", { apiKeyEnv: "K", model: "m" }]] as const) {
      const cfg = localOnly(defaults() as any); cfg.engine[key] = value;
      assert.throws(() => buildEngineConfig(cfg, l), (e: any) => e.error === "E_DENIED" && e.reason === "local-only" && e.message.includes(key), key);
    }
    const cfg = localOnly(defaults() as any); cfg.engine.merging = { baseUrl: "http://localhost:11434/v1", model: "llama" };
    assert.equal((buildEngineConfig(cfg, l) as any).merging.baseUrl, "http://localhost:11434/v1");
    const off = defaults() as any; off.engine.merging = { baseUrl: "https://api.openai.com/v1", model: "gpt-x" };
    assert.equal((buildEngineConfig(off, l) as any).merging.baseUrl, "https://api.openai.com/v1");
  });
  it("a cloud reranker needs memory.reranker.privacyAck for exactly that provider", () => {
    const cfg = defaults() as any; cfg.engine.reranker = { provider: "cohere", apiKeyEnv: "K" };
    assert.throws(() => buildEngineConfig(cfg, l), (e: any) => e.error === "E_DENIED" && e.reason === "privacy-acknowledgment-required" && /memory\.reranker\.privacyAck/.test(e.message));
    cfg.memory = { ...cfg.memory, embedding: { privacyAck: ack("cohere") } };
    assert.throws(() => buildEngineConfig(cfg, l), (e: any) => e.reason === "privacy-acknowledgment-required", "the embedding acknowledgment does not stand in for the reranker");
    cfg.memory = { ...cfg.memory, reranker: { privacyAck: ack("jina") } };
    assert.throws(() => buildEngineConfig(cfg, l), (e: any) => e.reason === "privacy-acknowledgment-mismatch");
    cfg.memory = { ...cfg.memory, reranker: { privacyAck: ack("cohere", "https://api.cohere.com/v2/rerank") } };
    assert.throws(() => buildEngineConfig(cfg, l), (e: any) => e.reason === "privacy-acknowledgment-mismatch", "the engine fixes the endpoint, so the acknowledgment binds the provider alone");
    cfg.memory = { ...cfg.memory, reranker: { privacyAck: ack("cohere") } };
    assert.equal((buildEngineConfig(cfg, l) as any).reranker.provider, "cohere");
  });
  describe("egress check at construction", () => {
    const egressFor = (allowHosts: string[], extra: { allowLoopback?: boolean; allowPorts?: number[] } = {}) => createEgress({ config: () => ({ allowHosts, allowPorts: extra.allowPorts ?? [443], allowLoopback: extra.allowLoopback ?? false }), resolver: async (host: string) => host === "localhost" ? [{ address: "127.0.0.1", family: 4 }] : host.endsWith(".invalid") ? [] : [{ address: "93.184.216.34", family: 4 }] });
    const openrouter = () => buildEngineConfig(remote({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "qwen/qwen3-embedding-8b", dimensions: 4096, apiKeyEnv: "K" }, ack("openrouter", "https://openrouter.ai/api/v1")), l);
    it("refuses a cloud embedding endpoint the egress policy does not list with E_DENIED reason egress-denied", async () => {
      await assert.rejects(checkEngineEgress(openrouter(), egressFor([])), (e: any) => e.error === "E_DENIED" && e.reason === "egress-denied" && /embedding/.test(e.message) && /host-not-allowed/.test(e.message));
      await checkEngineEgress(openrouter(), egressFor(["openrouter.ai"]));
    });
    it("checks the default OpenAI endpoint, the Cohere reranker and engine LLM feature endpoints", async () => {
      const cfg = remote({ provider: "openai", model: "text-embedding-3-small", dimensions: 1536, apiKeyEnv: "K" }, ack("openai"));
      cfg.engine.reranker = { provider: "cohere", apiKeyEnv: "K" }; cfg.memory.reranker = { privacyAck: ack("cohere") };
      cfg.engine.merging = { baseUrl: "https://llm.example.com/v1", model: "m" };
      const e = buildEngineConfig(cfg, l);
      await assert.rejects(checkEngineEgress(e, egressFor(["api.openai.com", "api.cohere.com"])), (x: any) => x.reason === "egress-denied" && /merging/.test(x.message));
      await assert.rejects(checkEngineEgress(e, egressFor(["api.openai.com", "llm.example.com"])), (x: any) => x.reason === "egress-denied" && /reranker/.test(x.message));
      await checkEngineEgress(e, egressFor(["api.openai.com", "api.cohere.com", "llm.example.com"]));
    });
    it("a loopback endpoint needs egress.allowLoopback and its name listed, like every harness provider call", async () => {
      const e = buildEngineConfig(remote({ provider: "tei", baseUrl: "http://localhost:8080/v1", model: "m", dimensions: 8, apiKeyEnv: "K" }), l);
      await assert.rejects(checkEngineEgress(e, egressFor(["localhost"], { allowPorts: [8080] })), (x: any) => x.reason === "egress-denied");
      await checkEngineEgress(e, egressFor(["localhost"], { allowLoopback: true, allowPorts: [8080] }));
    });
    it("the pinned local models call nothing; an unresolvable name and a feature without baseUrl are reported, not refused", async () => {
      await checkEngineEgress(buildEngineConfig(defaults(), l), egressFor([]));
      const warned: string[] = [];
      const cfg = remote({ provider: "openrouter", baseUrl: "https://emb.invalid/v1", model: "m", dimensions: 8, apiKeyEnv: "K" }, ack("openrouter", "https://emb.invalid/v1"));
      cfg.engine.skillMiner = { apiKeyEnv: "K", model: "m" };
      await checkEngineEgress(buildEngineConfig(cfg, l), egressFor(["emb.invalid"]), (m, f) => warned.push(`${f.role}: ${m}`));
      assert.equal(warned.length, 2);
      assert.ok(warned.some(w => w.startsWith("embedding:")) && warned.some(w => w.startsWith("skillMiner:")));
    });
  });
  it("passes a secret-store reference to the engine without requiring an environment key", () => {
    const cfg = remote({ provider: "openai", model: "m", dimensions: 8, apiKeyRef: "models/openai" }, ack("openai"));
    assert.equal((buildEngineConfig(cfg, l) as any).embedding.apiKeyRef, "models/openai");
  });
  for (const provider of ["jina", "voyage", "remote"]) {
    it(`admits ${provider} HTTP reranking with protocol and an endpoint-bound acknowledgment`, () => {
      const cfg = defaults() as any, baseUrl = "https://rerank.example/v1";
      cfg.engine.reranker = { provider, baseUrl, model: "chosen", protocol: "tei", apiKeyRef: "models/rerank" };
      cfg.memory.reranker = { privacyAck: ack(provider, baseUrl) };
      const rer = (buildEngineConfig(cfg, l) as any).reranker;
      assert.deepEqual(rer, { provider, baseUrl, model: "chosen", protocol: "tei", apiKeyRef: "models/rerank", enabled: true, fallbackProvider: "disabled" });
      cfg.memory.reranker.privacyAck = ack(provider, "https://another.example");
      assert.throws(() => buildEngineConfig(cfg, l), (e: any) => e.reason === "privacy-acknowledgment-mismatch");
    });
  }
  it("admits a keyless local HTTP reranker but refuses malformed references, protocols and missing remote endpoints", () => {
    const cfg = defaults() as any;
    cfg.engine.reranker = { provider: "remote", baseUrl: "http://localhost:8080", protocol: "tei" };
    cfg.privacy.localOnly = true;
    assert.equal((buildEngineConfig(cfg, l) as any).reranker.protocol, "tei");
    cfg.privacy.localOnly = false; // Validate malformed details independently of the shared-engine privacy preflight.
    for (const patch of [{ apiKeyRef: "invalid ref", apiKeyEnv: "K" }, { protocol: "unsupported" }, { baseUrl: undefined }]) {
      cfg.engine.reranker = { provider: "remote", baseUrl: "http://localhost:8080", protocol: "tei", ...patch };
      assert.throws(() => buildEngineConfig(cfg, l), (e: any) => e.reason === "engine-provider-config-incomplete");
    }
  });
  it("preflight checks the selected HTTP reranker endpoint and engine LLM apiKeyRef", async () => {
    const cfg = defaults() as any;
    cfg.engine.reranker = { provider: "remote", baseUrl: "http://localhost:8080", protocol: "tei" };
    cfg.engine.merging = { apiKeyRef: "models/llm" };
    cfg.privacy.localOnly = true;
    assert.throws(() => buildEngineConfig(cfg, l), (e: any) => e.reason === "local-only");
    delete cfg.engine.merging;
    const seen: string[] = [];
    await checkEngineEgress(buildEngineConfig(cfg, l), { decide: async url => { seen.push(url); return { allowed: true, host: "localhost", port: 8080, address: "127.0.0.1", family: 4 }; } });
    assert.deepEqual(seen, ["http://localhost:8080"]);
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
  // A chosen local model brings its own default width: E5's 384 is only the default of E5 itself.
  it("a chosen local embedding model without dimensions keeps the engine's width for that model", () => {
    const cfg = defaults() as any; cfg.engine.embedding = { local: { model: "google/embeddinggemma-2" } };
    const e = buildEngineConfig(cfg, l) as any;
    assert.equal(e.embedding.local.model, "google/embeddinggemma-2");
    assert.equal(e.embedding.local.dimensions, undefined);
    assert.equal(e.embedding.local.cacheDir, "/h/.plur1bus/models");
  });
  // The engine loads a pinned non-commercial embedding only with modelPreparation.acceptNonCommercialLicense.
  describe("non-commercial embedding licence", () => {
    const nc = (embedding: Record<string, unknown>, licence: Record<string, unknown>) => {
      const cfg = defaults() as any; cfg.engine.embedding = embedding; cfg.embedding = { ...cfg.embedding, ...licence };
      return buildEngineConfig(cfg, l) as any;
    };
    const jinaV5 = { provider: "local-transformers", local: { model: "jinaai/jina-embeddings-v5-text-nano-retrieval", dimensions: 768 } };
    it("passes the owner's acceptance to the engine with the active model's preparation profile", () => {
      assert.deepEqual(nc(jinaV5, { useClass: "research", acceptedNcLicence: true }).modelPreparation, { profile: "jina-v5-nano-768", acceptNonCommercialLicense: true });
      assert.deepEqual(nc({ local: { model: "jinaai/jina-embeddings-v3" } }, { useClass: "general", acceptedNcLicence: true }).modelPreparation, { profile: "jina-v3-multilingual-1024", acceptNonCommercialLicense: true });
    });
    it("gives no acceptance without the owner's acceptance or for the commercial use class", () => {
      assert.equal(nc(jinaV5, { useClass: "general", acceptedNcLicence: false }).modelPreparation, undefined);
      assert.equal(nc(jinaV5, { useClass: "commercial", acceptedNcLicence: true }).modelPreparation, undefined);
    });
    it("a permissive model never carries an acceptance, and an explicit engine.modelPreparation passes through unchanged", () => {
      assert.equal(nc({ local: { model: "google/embeddinggemma-2", dimensions: 768 } }, { useClass: "general", acceptedNcLicence: true }).modelPreparation, undefined);
      const cfg = defaults() as any; cfg.engine.embedding = jinaV5; cfg.embedding = { useClass: "general", acceptedNcLicence: true };
      cfg.engine.modelPreparation = { profile: "embeddinggemma-2-768" };
      assert.deepEqual((buildEngineConfig(cfg, l) as any).modelPreparation, { profile: "embeddinggemma-2-768" });
    });
  });
});
