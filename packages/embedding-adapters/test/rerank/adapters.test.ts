import { test } from "node:test";
import assert from "node:assert/strict";
import { createRerankAdapter } from "../../src/registry.ts";
import type { RerankConfig } from "../../src/config.ts";
import { AdapterError } from "../../src/errors.ts";
import { RERANK_SHAPES, renderRerankMappingTable } from "../../src/rerank/shapes.ts";
import { fromFixture } from "../helpers/fixture-fetch.ts";
import { FAKE_SECRET, kit } from "../helpers/adapter-kit.ts";

const docs = ["alpha", "beta", "gamma"];
const isKind = (kind: string) => (e: unknown) => e instanceof AdapterError && e.kind === kind;
const expectedOrder = [{ index: 2, score: 0.91 }, { index: 0, score: 0.42 }, { index: 1, score: 0.05 }];

interface Case { name: string; config: RerankConfig; fixture: string; url: string; docsField: string; topField: string | undefined; auth: boolean }
const cases: Case[] = [
  { name: "cohere", config: { provider: "cohere", model: "rerank-v3.5", secretName: "k" }, fixture: "cohere-success", url: "https://api.cohere.com/v2/rerank", docsField: "documents", topField: "top_n", auth: true },
  { name: "voyage", config: { provider: "voyage", model: "rerank-2", secretName: "k" }, fixture: "voyage-success", url: "https://api.voyageai.com/v1/rerank", docsField: "documents", topField: "top_k", auth: true },
  { name: "jina", config: { provider: "jina", model: "jina-reranker-v2", secretName: "k" }, fixture: "jina-success", url: "https://api.jina.ai/v1/rerank", docsField: "documents", topField: "top_n", auth: true },
  { name: "tei", config: { provider: "tei", baseURL: "http://nas:8080" }, fixture: "tei-success", url: "http://nas:8080/rerank", docsField: "texts", topField: undefined, auth: false },
  { name: "vllm", config: { provider: "vllm", model: "bge", baseURL: "http://127.0.0.1:8000" }, fixture: "vllm-success", url: "http://127.0.0.1:8000/v1/rerank", docsField: "documents", topField: "top_n", auth: false },
  { name: "vllm /rerank", config: { provider: "vllm", model: "bge", baseURL: "http://127.0.0.1:8000", path: "/rerank" }, fixture: "vllm-success", url: "http://127.0.0.1:8000/rerank", docsField: "documents", topField: "top_n", auth: false },
  { name: "llamacpp", config: { provider: "llamacpp", baseURL: "http://127.0.0.1:8080" }, fixture: "llamacpp-success", url: "http://127.0.0.1:8080/v1/rerank", docsField: "documents", topField: "top_n", auth: false },
  { name: "llamacpp /rerank", config: { provider: "llamacpp", baseURL: "http://127.0.0.1:8080", path: "/rerank" }, fixture: "llamacpp-success", url: "http://127.0.0.1:8080/rerank", docsField: "documents", topField: "top_n", auth: false },
  { name: "mtplx", config: { provider: "mtplx", baseURL: "http://127.0.0.1:8000" }, fixture: "mtplx-success", url: "http://127.0.0.1:8000/v1/rerank", docsField: "documents", topField: "top_n", auth: false },
  { name: "omlx", config: { provider: "omlx", model: "m", baseURL: "http://127.0.0.1:8000" }, fixture: "omlx-success", url: "http://127.0.0.1:8000/v1/rerank", docsField: "documents", topField: "top_n", auth: false },
];

for (const c of cases) {
  test(`${c.name}: request shape and best-first result`, async () => {
    const { deps, requests } = kit(fromFixture(`rerank/${c.fixture}.json`));
    const a = createRerankAdapter(c.config, deps);
    assert.deepEqual(await a.rerank("q", docs), expectedOrder);
    const r = requests[0]!;
    assert.equal(r.url, c.url);
    assert.equal(r.body.query, "q");
    assert.deepEqual(r.body[c.docsField], docs);
    assert.equal(r.body[c.docsField === "texts" ? "documents" : "texts"], undefined);
    assert.equal("top_n" in r.body || "top_k" in r.body, false, "no limit unless asked");
    assert.equal(r.headers["authorization"], c.auth ? `Bearer ${FAKE_SECRET}` : undefined);
    assert.equal(r.redirect, "manual");
  });

  test(`${c.name}: topN is sent where the server has a field for it and always honoured`, async () => {
    const { deps, requests } = kit((_req) => {
      const cut = expectedOrder.slice(0, 2).map((r) => ({ ...r, [c.config.provider === "tei" ? "score" : "relevance_score"]: r.score }));
      return { status: 200, json: c.config.provider === "tei" ? cut.map(({ index, score }) => ({ index, score })) : { results: cut.map(({ index, score }) => ({ index, relevance_score: score })) } };
    });
    const a = createRerankAdapter(c.config, deps);
    const out = await a.rerank("q", docs, { topN: 2 });
    assert.deepEqual(out, expectedOrder.slice(0, 2));
    if (c.topField) assert.equal(requests[0]!.body[c.topField], 2);
    else assert.equal("top_n" in requests[0]!.body || "top_k" in requests[0]!.body, false);
  });
}

test("voyage truncation is refused and jina asks for no document echo", async () => {
  const v = kit(fromFixture("rerank/voyage-success.json"));
  await createRerankAdapter({ provider: "voyage", model: "m", secretName: "k" }, v.deps).rerank("q", docs);
  assert.equal(v.requests[0]!.body.truncation, false);
  const j = kit(fromFixture("rerank/jina-success.json"));
  await createRerankAdapter({ provider: "jina", model: "m", secretName: "k" }, j.deps).rerank("q", docs);
  assert.equal(j.requests[0]!.body.return_documents, false);
});

test("a server that ignores topN and returns everything still yields exactly topN, best first", async () => {
  const { deps } = kit(fromFixture("rerank/tei-success.json"));
  const a = createRerankAdapter({ provider: "tei", baseURL: "http://nas:8080" }, deps);
  assert.deepEqual(await a.rerank("q", docs, { topN: 1 }), [{ index: 2, score: 0.91 }]);
});

test("unknown response shapes are bad_response and name keys, never guesses", async () => {
  for (const [fixture, config] of [
    ["unknown-data-container", { provider: "cohere", model: "m", secretName: "k" }],
    ["unknown-score-key", { provider: "cohere", model: "m", secretName: "k" }],
    ["tei-wrapped", { provider: "tei", baseURL: "http://nas:8080" }],
    ["cohere-success", { provider: "tei", baseURL: "http://nas:8080" }],
    ["tei-success", { provider: "cohere", model: "m", secretName: "k" }],
  ] as const) {
    const { deps } = kit(fromFixture(`rerank/${fixture}.json`));
    await assert.rejects(createRerankAdapter(config as RerankConfig, deps).rerank("q", docs), isKind("bad_response"), `${fixture} on ${config.provider}`);
  }
  const { deps } = kit(fromFixture("rerank/unknown-data-container.json"));
  await assert.rejects(createRerankAdapter({ provider: "cohere", model: "m", secretName: "k" }, deps).rerank("q", docs), /keys|got data/);
});

test("duplicate and out-of-range indexes and short results are bad_response", async () => {
  for (const fixture of ["duplicate-index", "index-out-of-range", "short"]) {
    const { deps } = kit(fromFixture(`rerank/${fixture}.json`));
    await assert.rejects(createRerankAdapter({ provider: "cohere", model: "m", secretName: "k" }, deps).rerank("q", docs), isKind("bad_response"), fixture);
  }
});

test("NaN-like scores are bad_response", async () => {
  for (const score of [null, "0.5", 1e999]) {
    const { deps } = kit({ status: 200, json: { results: [{ index: 0, relevance_score: score }, { index: 1, relevance_score: 0.1 }, { index: 2, relevance_score: 0.2 }] } });
    // 1e999 is Infinity in JS source but serialises to null, so all three exercise the "no finite score" path.
    await assert.rejects(createRerankAdapter({ provider: "cohere", model: "m", secretName: "k" }, deps).rerank("q", docs), isKind("bad_response"));
  }
});

test("hosted listwise rerankers refuse to split; pairwise servers split and merge comparable scores", async () => {
  const many = Array.from({ length: 5 }, (_, i) => `d${i}`);
  const hosted = kit({ status: 200 });
  const cohere = createRerankAdapter({ provider: "cohere", model: "m", secretName: "k", maxDocs: 3 }, hosted.deps);
  await assert.rejects(cohere.rerank("q", many), isKind("too_large"));
  assert.equal(hosted.requests.length, 0);

  const { deps, requests } = kit((req) => ({
    status: 200,
    json: (req.body.texts as string[]).map((t, i) => ({ index: i, score: Number(t.slice(1)) / 10 })),
  }));
  const tei = createRerankAdapter({ provider: "tei", baseURL: "http://nas:8080", maxDocs: 2 }, deps);
  const out = await tei.rerank("q", many);
  assert.deepEqual(requests.map((r) => r.body.texts.length), [2, 2, 1]);
  assert.deepEqual(out.map((r) => r.index), [4, 3, 2, 1, 0]);
  assert.deepEqual(await tei.rerank("q", many, { topN: 2 }), [{ index: 4, score: 0.4 }, { index: 3, score: 0.3 }]);
});

test("argument validation and empty input", async () => {
  const { deps, requests } = kit({ status: 500 });
  const a = createRerankAdapter({ provider: "tei", baseURL: "http://nas:8080" }, deps);
  assert.deepEqual(await a.rerank("q", []), []);
  await assert.rejects(a.rerank("", docs), isKind("invalid_request"));
  await assert.rejects(a.rerank("q", [1 as never]), isKind("invalid_request"));
  await assert.rejects(a.rerank("q", docs, { topN: 0 }), isKind("invalid_request"));
  await assert.rejects(a.rerank("q", docs, { topN: 1.5 }), isKind("invalid_request"));
  assert.equal(requests.length, 0);
});

test("a missing secret is auth before any request", async () => {
  const { deps, requests } = kit(fromFixture("rerank/cohere-success.json"));
  const a = createRerankAdapter({ provider: "cohere", model: "m", secretName: "missing" }, deps);
  await assert.rejects(a.rerank("q", docs), isKind("auth"));
  assert.equal(requests.length, 0);
});

test("rerank retries once on a 503 by default and then succeeds", async () => {
  const { deps, requests } = kit([{ status: 503 }, fromFixture("rerank/cohere-success.json")]);
  const a = createRerankAdapter({ provider: "cohere", model: "m", secretName: "k" }, deps);
  assert.deepEqual(await a.rerank("q", docs), expectedOrder);
  assert.equal(requests.length, 2);
});

test("the mapping table covers every provider and renders as Markdown", () => {
  assert.deepEqual(Object.keys(RERANK_SHAPES).sort(), ["cohere", "jina", "llamacpp", "mtplx", "omlx", "tei", "vllm", "voyage"]);
  assert.deepEqual(Object.values(RERANK_SHAPES).filter((s) => s.status === "verified").map((s) => s.provider).sort(), ["cohere", "voyage"]);
  const md = renderRerankMappingTable({ tei: "ok" });
  assert.match(md, /^\| Provider \| Request \| Response \| Status \| Live result \|/);
  assert.match(md, /\| tei \| `\{query, texts\[\]\} ?|\| tei \|.*texts\[\]/);
  assert.match(md, /\| tei \|.*\| ok \|/);
  assert.match(md, /\| cohere \|.*\| verified \| not run \|/);
  assert.match(md, /\| mtplx \|.*\| source \| not run \|/);
  assert.deepEqual(Object.values(RERANK_SHAPES).filter((s) => s.status === "source").map((s) => s.provider), ["mtplx"]);
});
