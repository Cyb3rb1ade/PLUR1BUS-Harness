// G8: the same failure scenarios against every embedding and rerank adapter, on synthetic fixtures only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEmbeddingAdapter, createRerankAdapter } from "../src/registry.ts";
import type { EmbeddingConfig, RerankConfig } from "../src/config.ts";
import { AdapterError } from "../src/errors.ts";
import { fromFixture, type Step, type StepSource } from "./helpers/fixture-fetch.ts";
import { FAKE_SECRET, kit } from "./helpers/adapter-kit.ts";

type Run = (source: StepSource, extra?: Parameters<typeof kit>[1], signal?: AbortSignal) => Promise<{ call: () => Promise<unknown>; requests: ReturnType<typeof kit>["requests"]; sleeps: number[] }>;

interface Subject { name: string; success: Step; make: Run; hasSecret: boolean; retryAfter: { header: string; ms: number } }

const secretCfg = { secretName: "k" };
const embeddingSubjects: Array<[string, EmbeddingConfig, Step]> = [
  ["openai", { provider: "openai", model: "m", dimensions: 4, ...secretCfg }, fromFixture("openai/success.json")],
  ["openai-compatible", { provider: "openai-compatible", model: "m", dimensions: 4, baseURL: "http://127.0.0.1:8000/v1" }, fromFixture("openai/success.json")],
  ["openrouter", { provider: "openrouter", model: "m", dimensions: 4, pinnedUpstream: "openai", ...secretCfg }, fromFixture("openrouter/success.json")],
  ["google", { provider: "google", model: "gemini-embedding-001", dimensions: 4, ...secretCfg }, fromFixture("google/batch-success.json")],
  ["cohere", { provider: "cohere", model: "m", dimensions: 4, ...secretCfg }, fromFixture("cohere/success.json")],
  ["jina", { provider: "jina", model: "m", dimensions: 4, ...secretCfg }, fromFixture("jina/success.json")],
  ["voyage", { provider: "voyage", model: "m", dimensions: 4, ...secretCfg }, fromFixture("voyage/success.json")],
  ["ollama", { provider: "ollama", model: "m", dimensions: 4 }, fromFixture("ollama/success.json")],
  ["tei", { provider: "tei", model: "m", dimensions: 4, baseURL: "http://nas:8080" }, fromFixture("tei/success.json")],
  ["mtplx", { provider: "mtplx", model: "m", dimensions: 4, baseURL: "http://127.0.0.1:8000" }, fromFixture("mtplx/embeddings-success.json")],
];
const rerankSubjects: Array<[string, RerankConfig, Step]> = [
  ["cohere", { provider: "cohere", model: "m", ...secretCfg }, fromFixture("rerank/cohere-success.json")],
  ["voyage", { provider: "voyage", model: "m", ...secretCfg }, fromFixture("rerank/voyage-success.json")],
  ["jina", { provider: "jina", model: "m", ...secretCfg }, fromFixture("rerank/jina-success.json")],
  ["tei", { provider: "tei", baseURL: "http://nas:8080" }, fromFixture("rerank/tei-success.json")],
  ["vllm", { provider: "vllm", model: "m", baseURL: "http://127.0.0.1:8000" }, fromFixture("rerank/vllm-success.json")],
  ["llamacpp", { provider: "llamacpp", baseURL: "http://127.0.0.1:8080" }, fromFixture("rerank/llamacpp-success.json")],
  ["mtplx", { provider: "mtplx", baseURL: "http://127.0.0.1:8000" }, fromFixture("rerank/mtplx-success.json")],
  ["omlx", { provider: "omlx", model: "m", baseURL: "http://127.0.0.1:8000" }, fromFixture("rerank/omlx-success.json")],
];

const subjects: Subject[] = [
  ...embeddingSubjects.map(([name, config, success]): Subject => ({
    name: `embed/${name}`,
    success,
    hasSecret: config.secretName !== undefined,
    retryAfter: { header: "2", ms: 2000 },
    make: async (source, extra, signal) => {
      const k = kit(source, extra);
      const a = createEmbeddingAdapter(config, k.deps);
      return { call: () => a.embed(["a", "b"], { inputType: "document", ...(signal ? { signal } : {}) }), requests: k.requests, sleeps: k.sleeps };
    },
  })),
  ...rerankSubjects.map(([name, config, success]): Subject => ({
    name: `rerank/${name}`,
    success,
    hasSecret: config.secretName !== undefined,
    // The rerank policy caps Retry-After at 1 s: a recall-path call is not worth waiting longer for.
    retryAfter: { header: "1", ms: 1000 },
    make: async (source, extra, signal) => {
      const k = kit(source, extra);
      const a = createRerankAdapter(config, k.deps);
      return { call: () => a.rerank("q", ["a", "b", "c"], signal ? { signal } : {}), requests: k.requests, sleeps: k.sleeps };
    },
  })),
];

const kindOf = (kind: string) => (e: unknown) => e instanceof AdapterError && e.kind === kind;
const err = async (p: Promise<unknown>): Promise<AdapterError> => {
  try { await p; } catch (e) { assert.ok(e instanceof AdapterError, String(e)); return e; }
  assert.fail("expected a rejection");
};

for (const s of subjects) {
  test(`${s.name}: success`, async () => {
    const { call, requests } = await s.make(s.success);
    const out = await call();
    assert.ok(Array.isArray(out) && out.length > 0);
    assert.equal(requests.length, 1);
  });

  test(`${s.name}: 429 with Retry-After is waited out once, then succeeds`, async () => {
    const { call, requests, sleeps } = await s.make([{ status: 429, headers: { "retry-after": s.retryAfter.header } }, s.success]);
    await call();
    assert.equal(requests.length, 2);
    assert.deepEqual(sleeps, [s.retryAfter.ms]);
  });

  test(`${s.name}: a Retry-After beyond the cap is handed back as rate_limit with retryAfterMs, not slept`, async () => {
    const { call, sleeps } = await s.make({ status: 429, headers: { "retry-after": "3600" } });
    const e = await err(call());
    assert.equal(e.kind, "rate_limit");
    assert.equal(e.retryAfterMs, 3_600_000);
    assert.deepEqual(sleeps, []);
  });

  test(`${s.name}: 401 is auth, not retried, and the echoed key never reaches the error`, async () => {
    const { call, requests } = await s.make({ status: 401, json: { error: { message: `Incorrect API key provided: sk-FAKEFAKEFAKEFAKE1234 and ${FAKE_SECRET}` } } });
    const e = await err(call());
    assert.equal(e.kind, "auth");
    assert.equal(requests.length, 1);
    for (const text of [e.message, JSON.stringify(e), String(e.stack)]) {
      assert.equal(text.includes("sk-FAKEFAKE"), false);
      // Only a secret the adapter actually resolved can be scrubbed; local servers without one have none.
      if (s.hasSecret) assert.equal(text.includes(FAKE_SECRET), false);
    }
  });

  test(`${s.name}: 413 is too_large`, async () => {
    const { call } = await s.make({ status: 413, text: "payload too large" });
    await assert.rejects(call(), kindOf("too_large"));
  });

  test(`${s.name}: a 5xx is retried and ends as overloaded`, async () => {
    const { call, requests } = await s.make({ status: 503 });
    await assert.rejects(call(), kindOf("overloaded"));
    assert.ok(requests.length >= 2);
  });

  test(`${s.name}: a network failure is retried and ends as network`, async () => {
    const { call, requests } = await s.make({ throws: "ECONNRESET" });
    await assert.rejects(call(), kindOf("network"));
    assert.ok(requests.length >= 2);
  });

  test(`${s.name}: a response that never comes times out`, async () => {
    const k = kit({ hang: true });
    const config = s.name.startsWith("embed/")
      ? { ...embeddingSubjects.find(([n]) => `embed/${n}` === s.name)![1], timeoutMs: 100, retry: { maxAttempts: 1 } }
      : { ...rerankSubjects.find(([n]) => `rerank/${n}` === s.name)![1], timeoutMs: 100, retry: { maxAttempts: 1 } };
    const call = s.name.startsWith("embed/")
      ? () => createEmbeddingAdapter(config as EmbeddingConfig, k.deps).embed(["a"], { inputType: "query" })
      : () => createRerankAdapter(config as RerankConfig, k.deps).rerank("q", ["a"]);
    await assert.rejects(call(), kindOf("timeout"));
  });

  test(`${s.name}: abort stops the call and is aborted, not network`, async () => {
    const ac = new AbortController();
    const { call } = await s.make({ hang: true }, {}, ac.signal);
    const pending = call();
    setTimeout(() => ac.abort(), 10);
    await assert.rejects(pending, kindOf("aborted"));
    const pre = new AbortController();
    pre.abort();
    const again = await s.make(s.success, {}, pre.signal);
    await assert.rejects(again.call(), kindOf("aborted"));
    assert.equal(again.requests.length, 0, "an already-aborted signal sends nothing");
  });

  test(`${s.name}: any redirect is refused, the credential is never replayed`, async () => {
    const { call, requests } = await s.make({ status: 307, headers: { location: "https://evil.example/steal" } });
    const e = await err(call());
    assert.equal(e.kind, "bad_response");
    assert.equal(requests.length, 1, "the redirect target is never contacted");
    assert.equal(e.message.includes(FAKE_SECRET), false);
  });

  test(`${s.name}: an oversized response body is bad_response`, async () => {
    const { call } = await s.make({ endless: true });
    await assert.rejects(call(), (e: unknown) => e instanceof AdapterError && (e.kind === "bad_response" || e.kind === "timeout"));
  });

  test(`${s.name}: garbage and empty bodies are bad_response`, async () => {
    for (const step of [{ status: 200, text: "<html>proxy login</html>" }, { status: 200, text: "" }, { status: 200, json: { unexpected: true } }, { status: 200, json: null }] as Step[]) {
      const { call } = await s.make(step);
      await assert.rejects(call(), kindOf("bad_response"));
    }
  });
}

// Vector-level failures only apply to embedding adapters.
const poison = (value: unknown): Step => ({ status: 200, text: JSON.stringify({ data: [{ index: 0, embedding: [value, 0, 0, 1] }, { index: 1, embedding: [1, 0, 0, 0] }] }).replace('"__INF__"', "1e999") });

test("embeddings: wrong dimension, short batch, NaN/null/string/overflow components are bad_response", async () => {
  const cfg: EmbeddingConfig = { provider: "openai", model: "m", dimensions: 4, secretName: "k" };
  const cases: Step[] = [
    { status: 200, json: { data: [{ index: 0, embedding: [1, 0, 0] }, { index: 1, embedding: [1, 0, 0] }] } },
    { status: 200, json: { data: [{ index: 0, embedding: [1, 0, 0, 0] }] } },
    poison(null),
    poison("0.5"),
    { status: 200, text: '{"data":[{"index":0,"embedding":[1e999,0,0,0]},{"index":1,"embedding":[1,0,0,0]}]}' },
    { status: 200, text: '{"data":[{"index":0,"embedding":[1e39,0,0,0]},{"index":1,"embedding":[1,0,0,0]}]}' },
    { status: 200, json: { data: [{ index: 0, embedding: [0, 0, 0, 0] }, { index: 1, embedding: [1, 0, 0, 0] }] } },
    { status: 200, json: { data: [{ index: 0, embedding: [1, 0, 0, 0] }, { index: 0, embedding: [1, 0, 0, 0] }] } },
  ];
  for (const step of cases) {
    const k = kit(step);
    const e = await err(createEmbeddingAdapter(cfg, k.deps).embed(["a", "b"], { inputType: "document" }));
    assert.equal(e.kind, "bad_response", JSON.stringify(step).slice(0, 80));
    assert.equal(e.retryable, false);
  }
});

test("embeddings: an over-long input is too_large before any request; a context-length 400 is too_large", async () => {
  const k = kit({ status: 200 });
  const a = createEmbeddingAdapter({ provider: "tei", model: "m", dimensions: 4, baseURL: "http://nas:8080", maxInputTokens: 10 }, k.deps);
  await assert.rejects(a.embed(["x".repeat(400)], { inputType: "document" }), kindOf("too_large"));
  assert.equal(k.requests.length, 0);
  const k2 = kit(fromFixture("openai/too-large.json"));
  await assert.rejects(createEmbeddingAdapter({ provider: "openai", model: "m", dimensions: 4, secretName: "k" }, k2.deps).embed(["a"], { inputType: "document" }), kindOf("too_large"));
  assert.equal(k2.requests.length, 1, "too_large is not retried");
});

test("embeddings: fixture 401 for every provider maps to auth", async () => {
  for (const [name, config] of embeddingSubjects.filter(([n]) => !["openai-compatible", "openrouter", "mtplx"].includes(n))) {
    const fixture = name === "openai" ? "openai/unauthorized.json" : `${name}/unauthorized.json`;
    const k = kit(fromFixture(fixture));
    await assert.rejects(createEmbeddingAdapter(config, k.deps).embed(["a", "b"], { inputType: "document" }), kindOf("auth"), name);
  }
});

test("a fixture 429 carries Retry-After through to the retry decision", async () => {
  const k = kit([fromFixture("openai/rate-limited.json"), fromFixture("openai/success.json")]);
  const out = await createEmbeddingAdapter({ provider: "openai", model: "m", dimensions: 4, secretName: "k" }, k.deps).embed(["a", "b"], { inputType: "document" });
  assert.equal(out.length, 2);
  assert.deepEqual(k.sleeps, [2000]);
});
