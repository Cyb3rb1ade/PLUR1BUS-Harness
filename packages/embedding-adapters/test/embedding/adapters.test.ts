import { test } from "node:test";
import assert from "node:assert/strict";
import { createEmbeddingAdapter } from "../../src/registry.ts";
import type { EmbeddingConfig } from "../../src/config.ts";
import { AdapterError } from "../../src/errors.ts";
import { fromFixture } from "../helpers/fixture-fetch.ts";
import { FAKE_SECRET, kit } from "../helpers/adapter-kit.ts";

const unit = (v: number[]) => { const n = Math.hypot(...v); return v.map((x) => x / n); };
const expected = [unit([3, 4, 0, 0]), unit([0, 0, 5, 12])];
const close = (got: Float32Array[], want: number[][]) => {
  assert.equal(got.length, want.length);
  got.forEach((g, i) => want[i]!.forEach((w, j) => assert.ok(Math.abs(g[j]! - w) < 1e-6, `vector ${i}[${j}]`)));
};
const isKind = (kind: string) => (e: unknown) => e instanceof AdapterError && e.kind === kind;

test("openai: request shape, bearer auth, index re-ordering, L2 normalisation", async () => {
  const { deps, requests } = kit(fromFixture("openai/success.json"));
  const a = createEmbeddingAdapter({ provider: "openai", model: "text-embedding-3-small", dimensions: 4, secretName: "k" }, deps);
  const out = await a.embed(["a", "b"], { inputType: "document" });
  close(out, expected);
  const r = requests[0]!;
  assert.equal(r.url, "https://api.openai.com/v1/embeddings");
  assert.equal(r.method, "POST");
  assert.equal(r.headers["authorization"], `Bearer ${FAKE_SECRET}`);
  assert.deepEqual(r.body, { model: "text-embedding-3-small", input: ["a", "b"], encoding_format: "float", dimensions: 4 });
  assert.equal(r.redirect, "manual");
  assert.equal(a.id, "openai:text-embedding-3-small");
});

test("openai-compatible flavours post to their own baseURL without dimensions and without auth when no secret is set", async () => {
  for (const provider of ["openai-compatible", "vllm", "llamacpp", "omlx"] as const) {
    const { deps, requests } = kit(fromFixture("openai/success.json"));
    const a = createEmbeddingAdapter({ provider, model: "m", dimensions: 4, baseURL: "http://127.0.0.1:8000/v1" }, deps);
    close(await a.embed(["a", "b"], { inputType: "query" }), expected);
    assert.equal(requests[0]!.url, "http://127.0.0.1:8000/v1/embeddings", provider);
    assert.equal("dimensions" in requests[0]!.body, false, provider);
    assert.equal(requests[0]!.headers["authorization"], undefined, provider);
  }
});

test("openrouter pins the upstream, forbids fallbacks and carries it in the identity", async () => {
  const { deps, requests } = kit(fromFixture("openrouter/success.json"));
  const a = createEmbeddingAdapter({ provider: "openrouter", model: "openai/text-embedding-3-small", dimensions: 4, secretName: "k", pinnedUpstream: "openai" }, deps);
  close(await a.embed(["a", "b"], { inputType: "document" }), expected);
  assert.deepEqual(requests[0]!.body.provider, { order: ["openai"], allow_fallbacks: false });
  assert.equal(a.identity().revision, "upstream:openai");
});

test("google: batch endpoint, header auth, task types, positional order", async () => {
  const { deps, requests } = kit(fromFixture("google/batch-success.json"));
  const a = createEmbeddingAdapter({ provider: "google", model: "models/gemini-embedding-001", dimensions: 4, secretName: "k" }, deps);
  close(await a.embed(["a", "b"], { inputType: "query" }), expected);
  const r = requests[0]!;
  assert.equal(r.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents");
  assert.equal(r.headers["x-goog-api-key"], FAKE_SECRET);
  assert.equal(r.headers["authorization"], undefined);
  assert.equal(r.body.requests[0].taskType, "RETRIEVAL_QUERY");
  assert.equal(r.body.requests[0].model, "models/gemini-embedding-001");
  assert.equal(r.body.requests[1].outputDimensionality, 4);
  assert.equal(r.url.includes(FAKE_SECRET), false, "the key never travels in the URL");
});

test("google: a single text uses embedContent", async () => {
  const { deps, requests } = kit(fromFixture("google/single-success.json"));
  const a = createEmbeddingAdapter({ provider: "google", model: "gemini-embedding-001", dimensions: 4, secretName: "k" }, deps);
  close(await a.embed(["a"], { inputType: "document" }), [expected[0]!]);
  assert.match(requests[0]!.url, /:embedContent$/);
  assert.equal(requests[0]!.body.taskType, "RETRIEVAL_DOCUMENT");
});

test("cohere: v2 embed with input_type and float embeddings", async () => {
  const { deps, requests } = kit(fromFixture("cohere/success.json"));
  const a = createEmbeddingAdapter({ provider: "cohere", model: "embed-v4.0", dimensions: 4, secretName: "k" }, deps);
  close(await a.embed(["a", "b"], { inputType: "query" }), expected);
  assert.equal(requests[0]!.url, "https://api.cohere.com/v2/embed");
  assert.deepEqual(requests[0]!.body, { model: "embed-v4.0", texts: ["a", "b"], input_type: "search_query", embedding_types: ["float"] });
});

test("jina: task selects the asymmetric adapter", async () => {
  const { deps, requests } = kit(fromFixture("jina/success.json"));
  const a = createEmbeddingAdapter({ provider: "jina", model: "jina-embeddings-v3", dimensions: 4, secretName: "k" }, deps);
  close(await a.embed(["a", "b"], { inputType: "document" }), expected);
  assert.equal(requests[0]!.url, "https://api.jina.ai/v1/embeddings");
  assert.equal(requests[0]!.body.task, "retrieval.passage");
  assert.equal(requests[0]!.body.dimensions, 4);
});

test("voyage: input_type and output_dimension", async () => {
  const { deps, requests } = kit(fromFixture("voyage/success.json"));
  const a = createEmbeddingAdapter({ provider: "voyage", model: "voyage-3", dimensions: 4, secretName: "k" }, deps);
  close(await a.embed(["a", "b"], { inputType: "query" }), expected);
  assert.equal(requests[0]!.url, "https://api.voyageai.com/v1/embeddings");
  assert.equal(requests[0]!.body.input_type, "query");
  assert.equal(requests[0]!.body.output_dimension, 4);
});

test("ollama: /api/embed without auth and with truncation refused", async () => {
  const { deps, requests } = kit(fromFixture("ollama/success.json"));
  const a = createEmbeddingAdapter({ provider: "ollama", model: "nomic-embed-text", dimensions: 4 }, deps);
  close(await a.embed(["a", "b"], { inputType: "document" }), expected);
  assert.equal(requests[0]!.url, "http://127.0.0.1:11434/api/embed");
  assert.deepEqual(requests[0]!.body, { model: "nomic-embed-text", input: ["a", "b"], truncate: false });
  assert.equal(requests[0]!.headers["authorization"], undefined);
});

test("tei: /embed with a root array response and client-side prefixes", async () => {
  const cfg: EmbeddingConfig = { provider: "tei", model: "e5", dimensions: 4, baseURL: "http://nas:8080", queryPrefix: "query: ", passagePrefix: "passage: " };
  const q = kit(fromFixture("tei/success.json"));
  close(await createEmbeddingAdapter(cfg, q.deps).embed(["a", "b"], { inputType: "query" }), expected);
  assert.equal(q.requests[0]!.url, "http://nas:8080/embed");
  assert.deepEqual(q.requests[0]!.body.inputs, ["query: a", "query: b"]);
  const d = kit(fromFixture("tei/success.json"));
  await createEmbeddingAdapter(cfg, d.deps).embed(["a", "b"], { inputType: "document" });
  assert.deepEqual(d.requests[0]!.body.inputs, ["passage: a", "passage: b"]);
});

test("normalize:false returns the vectors as the server sent them", async () => {
  const { deps } = kit(fromFixture("tei/success.json"));
  const a = createEmbeddingAdapter({ provider: "tei", model: "m", dimensions: 4, baseURL: "http://nas:8080", normalize: false }, deps);
  const [first] = await a.embed(["a", "b"], { inputType: "query" });
  assert.deepEqual(Array.from(first!), [3, 4, 0, 0]);
  assert.equal(a.identity().normalize, false);
});

test("batches are split by maxBatch and the order of the results is stable", async () => {
  const { deps, requests } = kit((req) => ({
    status: 200,
    json: { data: (req.body.input as string[]).map((t, i) => ({ index: i, embedding: [Number(t), 1, 0, 0] })).reverse() },
  }));
  const a = createEmbeddingAdapter({ provider: "openai", model: "m", dimensions: 4, secretName: "k", maxBatch: 2, normalize: false }, deps);
  const out = await a.embed(["1", "2", "3", "4", "5"], { inputType: "document" });
  assert.deepEqual(requests.map((r) => r.body.input.length), [2, 2, 1]);
  assert.deepEqual(out.map((v) => v[0]), [1, 2, 3, 4, 5]);
});

test("empty input makes no request; bad arguments are invalid_request", async () => {
  const { deps, requests } = kit({ status: 500 });
  const a = createEmbeddingAdapter({ provider: "tei", model: "m", dimensions: 4, baseURL: "http://nas:8080" }, deps);
  assert.deepEqual(await a.embed([], { inputType: "query" }), []);
  await assert.rejects(a.embed(["a"], { inputType: "nope" as never }), isKind("invalid_request"));
  await assert.rejects(a.embed([1 as never], { inputType: "query" }), isKind("invalid_request"));
  assert.equal(requests.length, 0);
});

test("a missing secret fails as auth before any network call", async () => {
  const { deps, requests } = kit(fromFixture("openai/success.json"));
  const a = createEmbeddingAdapter({ provider: "openai", model: "m", dimensions: 4, secretName: "missing" }, deps);
  await assert.rejects(a.embed(["a"], { inputType: "query" }), isKind("auth"));
  assert.equal(requests.length, 0);
});

test("a throwing getSecret is auth, and its message cannot leak", async () => {
  const { deps } = kit({ status: 200 }, { getSecret: () => { throw new Error("vault down " + FAKE_SECRET); } });
  const a = createEmbeddingAdapter({ provider: "openai", model: "m", dimensions: 4, secretName: "k" }, deps);
  await assert.rejects(a.embed(["a"], { inputType: "query" }), (e: unknown) => isKind("auth")(e) && !(e as Error).message.includes(FAKE_SECRET));
});

test("createEmbeddingAdapter requires an injected getSecret and reports bad config with paths", () => {
  assert.throws(() => createEmbeddingAdapter({ provider: "tei", model: "m", dimensions: 4, baseURL: "http://h" }, {} as never), /getSecret/);
  assert.throws(() => createEmbeddingAdapter({ provider: "tei", model: "m", dimensions: 4 } as EmbeddingConfig, kit({ status: 200 }).deps), /embedding\.baseURL: required for provider "tei"/);
});

test("identity() is frozen and identical across calls", () => {
  const a = createEmbeddingAdapter({ provider: "openai", model: "m", dimensions: 4, secretName: "k" }, kit({ status: 200 }).deps);
  assert.equal(a.identity(), a.identity());
  assert.ok(Object.isFrozen(a.identity()));
});

test("mtplx: OpenAI shape on /v1/embeddings, dimensions sent for Matryoshka truncation, no auth", async () => {
  const { deps, requests } = kit(fromFixture("mtplx/embeddings-success.json"));
  const a = createEmbeddingAdapter({ provider: "mtplx", model: "Qwen3-Embedding-8B-4bit-DWQ", dimensions: 4, baseURL: "http://127.0.0.1:8000" }, deps);
  close(await a.embed(["a", "b"], { inputType: "document" }), expected);
  const r = requests[0]!;
  assert.equal(r.url, "http://127.0.0.1:8000/v1/embeddings");
  assert.deepEqual(r.body, { model: "Qwen3-Embedding-8B-4bit-DWQ", input: ["a", "b"], encoding_format: "float", dimensions: 4 });
  assert.equal(r.headers["authorization"], undefined);
});

test("mtplx: a dimensions-beyond-native 400 is invalid_request and is not retried", async () => {
  const { deps, requests } = kit(fromFixture("mtplx/embeddings-dimensions-too-large.json"));
  const a = createEmbeddingAdapter({ provider: "mtplx", model: "m", dimensions: 8192, baseURL: "http://127.0.0.1:8000" }, deps);
  await assert.rejects(a.embed(["a"], { inputType: "document" }), isKind("invalid_request"));
  assert.equal(requests.length, 1);
});
