import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, EMBEDDING_PROVIDERS, RERANK_PROVIDERS, resolveEmbeddingSettings, resolveRerankSettings } from "../src/config.ts";
import { DEFAULT_RETRY_POLICY } from "../src/retry.ts";

function issues(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ConfigError, String(e));
    return e.issues.map((i) => `${i.path}: ${i.message}`);
  }
  assert.fail("expected a ConfigError");
}

const openai = { provider: "openai", model: "text-embedding-3-small", dimensions: 1536, secretName: "openai.key" };

test("a minimal openai config resolves with the documented defaults", () => {
  const s = resolveEmbeddingSettings(openai);
  assert.equal(s.baseURL, "https://api.openai.com/v1");
  assert.equal(s.path, "/embeddings");
  assert.equal(s.normalize, true);
  assert.equal(s.timeoutMs, 15_000);
  assert.equal(s.sendDimensions, true);
  assert.equal(s.maxInputTokens, 8192);
  assert.equal(s.secretName, "openai.key");
  assert.deepEqual(s.retry, DEFAULT_RETRY_POLICY);
  assert.equal("revision" in s, false);
});

test("every embedding provider has a usable default set", () => {
  const needsBase = new Set(["openai-compatible", "vllm", "llamacpp", "omlx", "tei", "mtplx"]);
  const needsSecret = new Set(["openai", "google", "cohere", "jina", "voyage", "openrouter"]);
  for (const provider of EMBEDDING_PROVIDERS) {
    const raw: Record<string, unknown> = { provider, model: "m", dimensions: 8 };
    if (needsBase.has(provider)) raw["baseURL"] = "http://127.0.0.1:8080";
    if (needsSecret.has(provider)) raw["secretName"] = "k";
    if (provider === "openrouter") raw["pinnedUpstream"] = "openai";
    const s = resolveEmbeddingSettings(raw);
    assert.ok(s.baseURL.startsWith("http"), provider);
    assert.ok(s.path.startsWith("/"), provider);
    assert.ok(s.maxBatch >= 1 && s.maxInputTokens >= 1, provider);
  }
  assert.equal(resolveEmbeddingSettings({ provider: "ollama", model: "m", dimensions: 8 }).baseURL, "http://127.0.0.1:11434");
  assert.equal(resolveEmbeddingSettings({ provider: "tei", model: "m", dimensions: 8, baseURL: "http://h:8080/" }).baseURL, "http://h:8080");
});

test("an unknown provider is named with its path and the valid choices", () => {
  const [first] = issues(() => resolveEmbeddingSettings({ ...openai, provider: "acme" }));
  assert.match(first!, /^embedding\.provider: unknown provider "acme"/);
  assert.match(first!, /openai/);
  assert.match(first!, /tei/);
});

test("providers that cannot work without a baseURL say so", () => {
  for (const provider of ["openai-compatible", "vllm", "llamacpp", "omlx", "tei", "mtplx"]) {
    assert.deepEqual(issues(() => resolveEmbeddingSettings({ provider, model: "m", dimensions: 8 })), [`embedding.baseURL: required for provider "${provider}"`]);
  }
});

test("cloud providers require a secret name; local ones may go without", () => {
  for (const provider of ["openai", "google", "cohere", "jina", "voyage"]) {
    assert.deepEqual(issues(() => resolveEmbeddingSettings({ provider, model: "m", dimensions: 8 })), [`embedding.secretName: required for provider "${provider}"`]);
  }
  assert.doesNotThrow(() => resolveEmbeddingSettings({ provider: "ollama", model: "m", dimensions: 8 }));
});

test("openrouter must pin its upstream, because the identity is the pinned upstream", () => {
  assert.deepEqual(issues(() => resolveEmbeddingSettings({ provider: "openrouter", model: "openai/text-embedding-3-small", dimensions: 8, secretName: "k" })), ['embedding.pinnedUpstream: required for provider "openrouter" (the vector space is defined by the upstream model)']);
  assert.equal(resolveEmbeddingSettings({ provider: "openrouter", model: "m", dimensions: 8, secretName: "k", pinnedUpstream: "openai" }).pinnedUpstream, "openai");
});

test("field validation reports the path of each bad value", () => {
  assert.match(issues(() => resolveEmbeddingSettings({ ...openai, dimensions: 0 }))[0]!, /^embedding\.dimensions: must be a positive integer/);
  assert.match(issues(() => resolveEmbeddingSettings({ ...openai, dimensions: "1536" }))[0]!, /^embedding\.dimensions: /);
  assert.match(issues(() => resolveEmbeddingSettings({ ...openai, dimensions: 1.5 }))[0]!, /^embedding\.dimensions: /);
  assert.match(issues(() => resolveEmbeddingSettings({ ...openai, model: "" }))[0]!, /^embedding\.model: /);
  assert.match(issues(() => resolveEmbeddingSettings({ ...openai, normalize: "yes" }))[0]!, /^embedding\.normalize: must be a boolean/);
  assert.match(issues(() => resolveEmbeddingSettings({ ...openai, maxBatch: 0 }))[0]!, /^embedding\.maxBatch: /);
  assert.match(issues(() => resolveEmbeddingSettings({ ...openai, timeoutMs: 5 }))[0]!, /^embedding\.timeoutMs: /);
  assert.match(issues(() => resolveEmbeddingSettings({ ...openai, secretName: "" }))[0]!, /^embedding\.secretName: /);
  assert.match(issues(() => resolveEmbeddingSettings({ ...openai, secretName: "a\nb" }))[0]!, /^embedding\.secretName: /);
});

test("baseURL must be a plain http(s) origin and may never carry credentials", () => {
  for (const [value, pattern] of [
    ["ftp://host", /http or https/],
    ["not a url", /not a valid URL/],
    ["https://user:pw@host.example", /credentials/],
    ["https://host.example/v1?key=abc", /query/],
    ["https://host.example/v1#frag", /fragment/],
  ] as const) {
    const [first] = issues(() => resolveEmbeddingSettings({ ...openai, baseURL: value }));
    assert.match(first!, /^embedding\.baseURL: /);
    assert.match(first!, pattern);
    assert.equal(first!.includes("pw"), false, "the offending credential is never echoed");
  }
  assert.equal(resolveEmbeddingSettings({ ...openai, baseURL: "https://proxy.example/openai/v1/" }).baseURL, "https://proxy.example/openai/v1");
});

test("a misspelled option is an error, not silently ignored", () => {
  assert.deepEqual(issues(() => resolveEmbeddingSettings({ ...openai, baseUrl: "https://x.example" })), ['embedding.baseUrl: unknown option']);
});

test("issues are aggregated and the root path can be renamed", () => {
  const found = issues(() => resolveEmbeddingSettings({ provider: "tei", dimensions: -1 }, "memory.embedding"));
  assert.deepEqual(found.map((f) => f.split(":")[0]), ["memory.embedding.model", "memory.embedding.dimensions", "memory.embedding.baseURL"]);
});

test("a non-object config is rejected at the root path", () => {
  assert.deepEqual(issues(() => resolveEmbeddingSettings(null)), ["embedding: must be an object"]);
  assert.deepEqual(issues(() => resolveEmbeddingSettings("openai", "x.y")), ["x.y: must be an object"]);
});

test("retry overrides are validated and merged", () => {
  assert.equal(resolveEmbeddingSettings({ ...openai, retry: { maxAttempts: 1 } }).retry.maxAttempts, 1);
  assert.match(issues(() => resolveEmbeddingSettings({ ...openai, retry: { maxAttempts: 0 } }))[0]!, /^embedding\.retry\.maxAttempts: /);
  assert.match(issues(() => resolveEmbeddingSettings({ ...openai, retry: { baseDelayMs: 5000, maxDelayMs: 100 } }))[0]!, /^embedding\.retry\.baseDelayMs: .*maxDelayMs/);
  assert.match(issues(() => resolveEmbeddingSettings({ ...openai, retry: { nope: 1 } }))[0]!, /^embedding\.retry\.nope: unknown option/);
});

test("ConfigError is an Error that lists every issue in its message", () => {
  try {
    resolveEmbeddingSettings({ provider: "tei", dimensions: -1 });
    assert.fail();
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    assert.ok(e instanceof Error);
    assert.equal(e.name, "ConfigError");
    assert.match(e.message, /embedding\.model/);
    assert.match(e.message, /embedding\.baseURL/);
  }
});

test("rerank defaults per provider", () => {
  const cohere = resolveRerankSettings({ provider: "cohere", model: "rerank-v3.5", secretName: "k" });
  assert.equal(cohere.baseURL, "https://api.cohere.com");
  assert.equal(cohere.path, "/v2/rerank");
  assert.equal(cohere.timeoutMs, 5000);
  assert.equal(cohere.maxDocs, 1000);
  assert.equal(cohere.splitOversized, false);
  const tei = resolveRerankSettings({ provider: "tei", baseURL: "http://nas:8080" });
  assert.equal(tei.path, "/rerank");
  assert.equal(tei.maxDocs, 32);
  assert.equal(tei.splitOversized, true);
  for (const provider of RERANK_PROVIDERS) {
    const raw: Record<string, unknown> = { provider, model: "m", secretName: "k", baseURL: "http://127.0.0.1:1" };
    assert.doesNotThrow(() => resolveRerankSettings(raw), provider);
  }
});

test("rerank requirements: model for hosted and vLLM/oMLX, baseURL for self-hosted, path only where servers differ", () => {
  assert.deepEqual(issues(() => resolveRerankSettings({ provider: "cohere", secretName: "k" })), ['rerank.model: required for provider "cohere"']);
  assert.deepEqual(issues(() => resolveRerankSettings({ provider: "vllm", baseURL: "http://h:8000" })), ['rerank.model: required for provider "vllm"']);
  assert.deepEqual(issues(() => resolveRerankSettings({ provider: "omlx", baseURL: "http://h:8000" })), ['rerank.model: required for provider "omlx"']);
  assert.deepEqual(issues(() => resolveRerankSettings({ provider: "tei" })), ['rerank.baseURL: required for provider "tei"']);
  assert.deepEqual(issues(() => resolveRerankSettings({ provider: "jina", model: "m" })), ['rerank.secretName: required for provider "jina"']);
  assert.equal(resolveRerankSettings({ provider: "llamacpp", baseURL: "http://h:8080", path: "/rerank" }).path, "/rerank");
  assert.equal(resolveRerankSettings({ provider: "vllm", model: "m", baseURL: "http://h:8000" }).path, "/v1/rerank");
  assert.match(issues(() => resolveRerankSettings({ provider: "vllm", model: "m", baseURL: "http://h:8000", path: "/other" }))[0]!, /^rerank\.path: must be one of/);
  assert.match(issues(() => resolveRerankSettings({ provider: "cohere", model: "m", secretName: "k", path: "/v1/rerank" }))[0]!, /^rerank\.path: not configurable for provider "cohere"/);
  assert.match(issues(() => resolveRerankSettings({ provider: "nope" }))[0]!, /^rerank\.provider: unknown provider "nope"/);
});
