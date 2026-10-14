// Audit round C (agent c15): regression tests for defects found in the shared pipeline.
import { test } from "node:test";
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

test.todo("KNOWN GAP: createEmbeddingAdapter still builds cloud providers (openai, google, cohere, jina, voyage, openrouter) with default cloud base URLs; the owner rule is schema and validation only, which needs a decision on removing wires, docs and fixtures");
test.todo("KNOWN GAP: an input over maxBatchTokens but within maxInputTokens is sent alone (documented, pinned by an existing test); config does not reject maxBatchTokens < maxInputTokens");
test.todo("KNOWN GAP: docs/embedding-adapters.md says zero vectors are rejected 'when normalising'; the code now rejects them always (docs are outside this package)");
