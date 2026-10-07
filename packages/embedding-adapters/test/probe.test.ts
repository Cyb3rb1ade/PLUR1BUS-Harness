import { test } from "node:test";
import assert from "node:assert/strict";
import { probe, PROBE_TEXTS } from "../src/probe.ts";
import { AdapterError } from "../src/errors.ts";
import { identityHash } from "../src/identity.ts";
import { createEmbeddingAdapter } from "../src/registry.ts";
import type { EmbeddingAdapter, EmbeddingIdentity } from "../src/types.ts";
import { kit } from "./helpers/adapter-kit.ts";

const identity: EmbeddingIdentity = { provider: "fake", model: "m", dimensions: 3, normalize: true, maxBatch: 8, maxInputTokens: 512 };
const unit = (v: number[]) => { const n = Math.hypot(...v); return Float32Array.from(v.map((x) => x / n)); };
// Related texts (0,1,2) point the same way, the unrelated one (3) elsewhere, the query close to the related ones.
const GOOD = [unit([1, 0.1, 0]), unit([1, 0.2, 0]), unit([1, 0.15, 0.05]), unit([0, 0.2, 1]), unit([1, 0.1, 0.02])];

function fake(vectors: (texts: readonly string[]) => Float32Array[], id = identity): EmbeddingAdapter {
  return { id: "fake:m", identity: () => id, embed: async (texts) => vectors(texts) };
}
const byText = (all: Float32Array[]) => (texts: readonly string[]) => texts.map((t) => all[PROBE_TEXTS.indexOf(t)]!);

test("a healthy adapter passes every check and the result is assignable to core's targetProbe", async () => {
  const out = await probe(fake(byText(GOOD)));
  assert.equal(out.ok, true, out.error);
  assert.equal(out.error, undefined);
  const asCore: { ok: boolean; error?: string } = out;
  assert.equal(asCore.ok, true);
  assert.equal(out.identityId, identityHash(identity));
  assert.deepEqual(out.fingerprint, { provider: "fake", model: "m", dimensions: 3, normalize: true });
  assert.deepEqual(out.checks.map((c) => c.name), ["count", "dimensions", "finite", "non-degenerate", "normalisation", "similarity"]);
});

test("wrong dimension, NaN, zero vectors, bad normalisation and no semantic signal are each reported", async () => {
  const wrongDim = await probe(fake(byText(GOOD.map((v) => v.slice(0, 2)))));
  assert.equal(wrongDim.ok, false);
  assert.match(wrongDim.error!, /dimensions/);

  const nan = await probe(fake(byText(GOOD.map((v, i) => (i === 1 ? Float32Array.from([NaN, 0, 0]) : v)))));
  assert.match(nan.error!, /finite/);

  const zero = await probe(fake(byText(GOOD.map((v, i) => (i === 2 ? new Float32Array(3) : v)))));
  assert.match(zero.error!, /non-degenerate/);

  const unnormalised = await probe(fake(byText(GOOD.map((v) => v.map((x) => x * 3)))));
  assert.match(unnormalised.error!, /normalisation/);
  const notClaimed = await probe(fake(byText(GOOD.map((v) => v.map((x) => x * 3))), { ...identity, normalize: false }));
  assert.equal(notClaimed.ok, true, "an adapter that does not claim normalisation is not held to it");

  const noSignal = await probe(fake(byText(GOOD.map(() => unit([1, 1, 1])))));
  assert.match(noSignal.error!, /similarity/);
});

test("wrong vector count is reported without comparing anything", async () => {
  const out = await probe(fake(() => [unit([1, 0, 0])]));
  assert.equal(out.ok, false);
  assert.match(out.error!, /count/);
});

test("adapter errors become a failed probe, never a throw; unexpected errors too", async () => {
  const auth: EmbeddingAdapter = { id: "x", identity: () => identity, embed: async () => { throw new AdapterError("auth", "secret \"k\" is not available"); } };
  const a = await probe(auth);
  assert.equal(a.ok, false);
  assert.match(a.error!, /^auth: /);
  const boom: EmbeddingAdapter = { id: "x", identity: () => identity, embed: async () => { throw new Error("kaput sk-AAAAAAAAAAAAAAAAAAAAAAAA"); } };
  const b = await probe(boom);
  assert.equal(b.ok, false);
  assert.equal(b.error!.includes("sk-AAAA"), false);
});

test("a reference run is compared by cosine", async () => {
  const adapter = fake(byText(GOOD));
  assert.equal((await probe(adapter, { reference: GOOD })).ok, true);
  const drifted = await probe(adapter, { reference: GOOD.map((v) => unit([v[2]!, v[0]!, v[1]!])) });
  assert.equal(drifted.ok, false);
  assert.match(drifted.error!, /reference/);
});

test("probe works through a real adapter on fixture traffic", async () => {
  const vectors = new Map<string, number[]>(PROBE_TEXTS.map((t, i) => [t, [...GOOD[i]!]]));
  const { deps } = kit((req) => ({ status: 200, json: (req.body.inputs as string[]).map((t) => vectors.get(t)) }));
  const a = createEmbeddingAdapter({ provider: "tei", model: "m", dimensions: 3, baseURL: "http://nas:8080" }, deps);
  const out = await probe(a);
  assert.equal(out.ok, true, out.error);
});

test("identity stability through the factory: same config, same hash; model or dimension change, different hash (G6)", () => {
  const { deps } = kit({ status: 200 });
  const make = (over: Record<string, unknown> = {}) => createEmbeddingAdapter({ provider: "openai", model: "text-embedding-3-small", dimensions: 1536, secretName: "k", ...over } as never, deps);
  const h = (a: EmbeddingAdapter) => identityHash(a.identity());
  assert.equal(h(make()), h(make()));
  assert.equal(h(make()), h(make({ secretName: "other", timeoutMs: 99_999, maxBatch: 3 })), "operational settings are not identity");
  assert.notEqual(h(make()), h(make({ model: "text-embedding-3-large" })));
  assert.notEqual(h(make()), h(make({ dimensions: 512 })));
  assert.notEqual(h(make()), h(make({ queryPrefix: "q: " })));
});
