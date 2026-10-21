// Audit round C (agent c15): regression tests for defects found in the shared pipeline.
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { createEmbeddingAdapter, createRerankAdapter } from "../src/registry.ts";
import { resolveEmbeddingSettings, ConfigError } from "../src/config.ts";
import { AdapterError, errorSummary } from "../src/errors.ts";
import { identityHash } from "../src/identity.ts";
import { postJson } from "../src/http.ts";
import { fixtureFetch } from "./helpers/fixture-fetch.ts";
import { kit } from "./helpers/adapter-kit.ts";

const SECRET = "Zq7-opaque-credential-value-0123456789";
const embedCfg = { provider: "tei", model: "m", dimensions: 2, baseURL: "http://127.0.0.1:8080" } as const;
const ok2 = { status: 200, json: [[3, 4], [0, 5]] };

test("a sparse texts array is invalid_request and never sends a prefixed 'undefined'", async () => {
  const { deps, requests } = kit(ok2);
  const a = createEmbeddingAdapter({ ...embedCfg, queryPrefix: "query: " }, deps);
  // eslint-disable-next-line no-sparse-arrays
  await assert.rejects(a.embed(new Array<string>(2), { inputType: "query" }), (e: unknown) => e instanceof AdapterError && e.kind === "invalid_request");
  assert.equal(requests.length, 0);
});

test("a sparse docs array is invalid_request for rerank", async () => {
  const { deps, requests } = kit({ status: 200, json: [] });
  const a = createRerankAdapter({ provider: "tei", baseURL: "http://127.0.0.1:8080" }, deps);
  await assert.rejects(a.rerank("q", new Array<string>(2)), (e: unknown) => e instanceof AdapterError && e.kind === "invalid_request");
  assert.equal(requests.length, 0);
});

test("errorSummary redacts before truncating, so a secret on the cut line leaves no fragment", () => {
  const e = new Error(`${"y ".repeat(92)}${SECRET}`);
  const out = errorSummary(e, [SECRET]);
  assert.equal(out.includes(SECRET.slice(0, 8)), false, out);
});

test("an error-body snippet redacts before cutting at 200 characters", async () => {
  const body = `${"y ".repeat(90)}${SECRET} trailing`;
  const { fetch } = fixtureFetch({ status: 401, text: body });
  const err = await postJson(
    { provider: "t", url: "https://h.test/x", headers: {}, body: {}, timeoutMs: 1000, maxResponseBytes: 1 << 20, secrets: [SECRET] },
    { fetch },
  ).catch((e: unknown) => e as AdapterError);
  assert.ok(err instanceof AdapterError);
  assert.equal(err.message.includes(SECRET.slice(0, 8)), false, err.message);
});

test("an error-body snippet carries no control characters", async () => {
  const { fetch } = fixtureFetch({ status: 500, text: "bad\u001b[31m red\u0000 \u0007x" });
  const err = await postJson(
    { provider: "t", url: "https://h.test/x", headers: {}, body: {}, timeoutMs: 1000, maxResponseBytes: 1 << 20, secrets: [] },
    { fetch },
  ).catch((e: unknown) => e as AdapterError);
  assert.ok(err instanceof AdapterError);
  assert.equal(/[\u0000-\u001f\u007f]/.test(err.message), false);
});

test("openrouter: changing the pinned upstream changes the identity even when a revision is set", () => {
  const base = { provider: "openrouter", model: "m", dimensions: 2, secretName: "k" } as const;
  const idOf = (pinnedUpstream: string) =>
    identityHash(createEmbeddingAdapter({ ...base, revision: "r1", pinnedUpstream }, kit(ok2).deps).identity());
  assert.notEqual(idOf("openai"), idOf("deepinfra"));
});

test("openrouter: identity without a revision keeps the documented upstream:<name> spelling", () => {
  const a = createEmbeddingAdapter({ provider: "openrouter", model: "m", dimensions: 2, secretName: "k", pinnedUpstream: "openai" }, kit(ok2).deps);
  assert.equal(a.identity().revision, "upstream:openai");
});

test("a zero vector is a bad response even when normalisation is off", async () => {
  const { deps } = kit({ status: 200, json: [[0, 0], [0, 5]] });
  const a = createEmbeddingAdapter({ ...embedCfg, normalize: false }, deps);
  await assert.rejects(a.embed(["a", "b"], { inputType: "document" }), (e: unknown) => e instanceof AdapterError && e.kind === "bad_response");
});

test("a secret is never configured for cleartext transport to a non-loopback host", () => {
  const base = { provider: "tei", model: "m", dimensions: 2, secretName: "k" } as const;
  assert.throws(() => resolveEmbeddingSettings({ ...base, baseURL: "http://nas.lan:8080" }), (e: unknown) => e instanceof ConfigError && e.issues.some((i) => i.path === "embedding.secretName"));
  assert.doesNotThrow(() => resolveEmbeddingSettings({ ...base, baseURL: "https://nas.lan:8080" }));
  assert.doesNotThrow(() => resolveEmbeddingSettings({ ...base, baseURL: "http://127.0.0.1:8080" }));
  assert.doesNotThrow(() => resolveEmbeddingSettings({ ...base, baseURL: "http://[::1]:8080" }));
});

const CLOUD_EMBED = [
  { provider: "openai", model: "m", dimensions: 2, secretName: "k" },
  { provider: "google", model: "m", dimensions: 2, secretName: "k" },
  { provider: "cohere", model: "m", dimensions: 2, secretName: "k" },
  { provider: "jina", model: "m", dimensions: 2, secretName: "k" },
  { provider: "voyage", model: "m", dimensions: 2, secretName: "k" },
  { provider: "openrouter", model: "m", dimensions: 2, secretName: "k", pinnedUpstream: "openai" },
  { provider: "openai-compatible", model: "m", dimensions: 2, baseURL: "https://api.together.example/v1" },
] as const;
const CLOUD_RERANK = [
  { provider: "cohere", model: "m", secretName: "k" },
  { provider: "jina", model: "m", secretName: "k" },
  { provider: "voyage", model: "m", secretName: "k" },
] as const;
const on = { localOnly: () => true };

test("privacy.localOnly: every cloud embedding and rerank provider is refused at construction, before any request or secret lookup", () => {
  let secretReads = 0;
  const { deps, requests } = kit(ok2, { policy: on, getSecret: () => { secretReads++; return "s"; } });
  for (const cfg of CLOUD_EMBED) {
    assert.throws(() => createEmbeddingAdapter(cfg, deps), (e: unknown) => e instanceof ConfigError && e.issues.some((i) => i.path === "embedding.baseURL" && i.message.includes("privacy.localOnly")), cfg.provider);
  }
  for (const cfg of CLOUD_RERANK) {
    assert.throws(() => createRerankAdapter(cfg, deps), (e: unknown) => e instanceof ConfigError && e.issues.some((i) => i.path === "rerank.baseURL" && i.message.includes("privacy.localOnly")), cfg.provider);
  }
  assert.equal(requests.length, 0);
  assert.equal(secretReads, 0);
});

test("privacy.localOnly: loopback and listed endpoints keep working; an unlisted LAN host is refused", async () => {
  const policy = { localOnly: () => true, localEndpoints: () => ["https://nas.lan:8443"] };
  const { deps, requests } = kit(ok2, { policy });
  const ollama = createEmbeddingAdapter({ provider: "ollama", model: "m", dimensions: 2 }, kit({ status: 200, json: { embeddings: [[3, 4], [0, 5]] } }, { policy }).deps);
  assert.equal(ollama.id, "ollama:m");
  const tei = createEmbeddingAdapter(embedCfg, deps);
  assert.equal((await tei.embed(["a", "b"], { inputType: "document" })).length, 2);
  assert.equal(requests.length, 1);
  assert.doesNotThrow(() => createEmbeddingAdapter({ provider: "tei", model: "m", dimensions: 2, baseURL: "https://nas.lan:8443/x" }, deps));
  assert.doesNotThrow(() => createRerankAdapter({ provider: "tei", baseURL: "https://nas.lan:8443" }, deps));
  assert.throws(() => createEmbeddingAdapter({ provider: "tei", model: "m", dimensions: 2, baseURL: "https://nas.lan:9999" }, deps), ConfigError);
  assert.throws(() => createEmbeddingAdapter({ provider: "tei", model: "m", dimensions: 2, baseURL: "http://192.168.1.20:8080" }, deps), ConfigError);
});

test("privacy.localOnly: without a policy, or with the switch off, cloud providers still build (owner decision: cloud works)", () => {
  const { deps } = kit(ok2);
  for (const cfg of CLOUD_EMBED) assert.doesNotThrow(() => createEmbeddingAdapter(cfg, deps), cfg.provider);
  for (const cfg of CLOUD_RERANK) assert.doesNotThrow(() => createRerankAdapter(cfg, deps), cfg.provider);
  const off = kit(ok2, { policy: { localOnly: () => false } }).deps;
  for (const cfg of CLOUD_EMBED) assert.doesNotThrow(() => createEmbeddingAdapter(cfg, off), cfg.provider);
});

test("privacy.localOnly: a switch turned on after construction stops the adapter before any request", async () => {
  let pinned = false;
  const { deps, requests } = kit(ok2, { policy: { localOnly: () => pinned } });
  const cloud = createEmbeddingAdapter(CLOUD_EMBED[0], deps);
  const reranker = createRerankAdapter(CLOUD_RERANK[0], kit({ status: 200, json: { results: [] } }, { policy: { localOnly: () => pinned } }).deps);
  pinned = true;
  await assert.rejects(cloud.embed(["a", "b"], { inputType: "document" }), (e: unknown) => e instanceof AdapterError && e.kind === "invalid_request" && e.message.includes("privacy.localOnly"));
  await assert.rejects(reranker.rerank("q", ["a"]), (e: unknown) => e instanceof AdapterError && e.message.includes("privacy.localOnly"));
  assert.equal(requests.length, 0);
});

test("privacy.localOnly: a switch that throws or answers anything but false is on (fail-closed)", () => {
  for (const localOnly of [() => { throw new Error("config unreadable"); }, () => undefined as unknown as boolean, () => "no" as unknown as boolean]) {
    const { deps } = kit(ok2, { policy: { localOnly } });
    assert.throws(() => createEmbeddingAdapter(CLOUD_EMBED[0], deps), ConfigError);
    assert.doesNotThrow(() => createEmbeddingAdapter(embedCfg, deps));
  }
  const broken = kit(ok2, { policy: { localOnly: () => true, localEndpoints: () => { throw new Error("x"); } } }).deps;
  assert.throws(() => createEmbeddingAdapter({ provider: "tei", model: "m", dimensions: 2, baseURL: "https://nas.lan:8443" }, broken), ConfigError);
});
test("config refuses a batch budget smaller than the per-input limit, explicit or inherited from the provider defaults", () => {
  const refused = () => (e: unknown) => e instanceof ConfigError && e.issues.some((i) => i.path === "embedding.maxBatchTokens" && i.message.includes("maxInputTokens"));
  assert.throws(() => resolveEmbeddingSettings({ ...embedCfg, maxInputTokens: 512, maxBatchTokens: 256 }), refused());
  assert.throws(() => resolveEmbeddingSettings({ ...embedCfg, maxBatchTokens: 100 }), refused()); // tei default maxInputTokens is 512
  assert.throws(() => resolveEmbeddingSettings({ provider: "voyage", model: "m", dimensions: 2, secretName: "k", maxInputTokens: 200_000 }), refused()); // voyage default batch budget is 100000
});

test("config accepts maxBatchTokens equal to or above maxInputTokens, and every provider default still resolves", () => {
  assert.equal(resolveEmbeddingSettings({ ...embedCfg, maxInputTokens: 512, maxBatchTokens: 512 }).maxBatchTokens, 512);
  assert.equal(resolveEmbeddingSettings({ ...embedCfg, maxInputTokens: 100, maxBatchTokens: 5000 }).maxBatchTokens, 5000);
  assert.equal(resolveEmbeddingSettings(embedCfg).maxBatchTokens, undefined); // no batch budget: nothing to compare
  assert.equal(resolveEmbeddingSettings({ ...embedCfg, maxInputTokens: 99_999 }).maxInputTokens, 99_999);
  for (const [provider, extra] of [["openai", { secretName: "k" }], ["voyage", { secretName: "k" }]] as const) {
    const r = resolveEmbeddingSettings({ provider, model: "m", dimensions: 2, ...extra });
    assert.ok(r.maxBatchTokens! >= r.maxInputTokens, provider);
  }
});
test("a zero vector is a bad response with normalisation on as well, and the docs say so (always, not 'when normalising')", async () => {
  const { deps } = kit({ status: 200, json: [[0, 0], [0, 5]] });
  const a = createEmbeddingAdapter({ ...embedCfg, normalize: true }, deps);
  await assert.rejects(a.embed(["a", "b"], { inputType: "document" }), (e: unknown) => e instanceof AdapterError && e.kind === "bad_response" && e.message.includes("zero vector"));
  const docs = await readFile(new URL("../../../docs/embedding-adapters.md", import.meta.url), "utf8");
  assert.match(docs, /zero vectors always rejected as `bad_response`/);
  assert.doesNotMatch(docs, /when normali[sz]ing/i);
});
