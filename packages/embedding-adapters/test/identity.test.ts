import { test } from "node:test";
import assert from "node:assert/strict";
import { identityHash, toFingerprint } from "../src/identity.ts";
import type { EmbeddingIdentity } from "../src/types.ts";

const base: EmbeddingIdentity = { provider: "openai", model: "text-embedding-3-small", dimensions: 1536, normalize: true, maxBatch: 256, maxInputTokens: 8192 };

test("the hash has a versioned, self-describing format", () => {
  assert.match(identityHash(base), /^adapter-identity:v1:sha256:[0-9a-f]{64}$/);
});

test("identical identities hash identically regardless of property order", () => {
  const reordered: EmbeddingIdentity = { maxInputTokens: 8192, normalize: true, dimensions: 1536, model: "text-embedding-3-small", maxBatch: 256, provider: "openai" };
  assert.equal(identityHash(base), identityHash(reordered));
  assert.equal(identityHash(base), identityHash({ ...base }));
});

test("anything that defines the vector space changes the hash", () => {
  const h = identityHash(base);
  const variants: Partial<EmbeddingIdentity>[] = [
    { model: "text-embedding-3-large" },
    { dimensions: 768 },
    { provider: "openai-compatible" },
    { revision: "2025-01-01" },
    { normalize: false },
    { maxInputTokens: 512 },
    { queryPrefix: "query: " },
    { passagePrefix: "passage: " },
  ];
  const seen = new Set<string>([h]);
  for (const v of variants) {
    const next = identityHash({ ...base, ...v });
    assert.notEqual(next, h, JSON.stringify(v));
    seen.add(next);
  }
  assert.equal(seen.size, variants.length + 1, "every variant is distinct from the others too");
});

test("operational settings do not change the hash", () => {
  assert.equal(identityHash({ ...base, maxBatch: 1 }), identityHash(base));
});

test("an absent optional field and an undefined one are the same identity", () => {
  assert.equal(identityHash({ ...base, revision: undefined } as unknown as EmbeddingIdentity), identityHash(base));
});

test("the fingerprint matches the shape core's embedding-migrate probe consumes", () => {
  const fp = toFingerprint({ ...base, revision: "r1", queryPrefix: "q: ", passagePrefix: "p: " }, "https://api.openai.com/v1");
  assert.deepEqual(fp, { provider: "openai", model: "text-embedding-3-small", dimensions: 1536, normalize: true, revision: "r1", endpoint: "https://api.openai.com/v1", queryPrefix: "q: ", passagePrefix: "p: " });
  assert.deepEqual(Object.keys(toFingerprint(base)).sort(), ["dimensions", "model", "normalize", "provider"]);
});
