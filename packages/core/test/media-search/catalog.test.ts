/** Fixed MM-3a catalog describes support without claiming media artifacts are installed. */
import { it } from "node:test";
import assert from "node:assert/strict";
import * as validation from "../../src/media-search/validate.ts";
import type { MediaProviderCatalog } from "../../src/media-search/validate.ts";
import { defaults } from "@plur1bus/config-schema";

it("provides the Apache local EmbeddingGemma 2 catalog and refuses unknown models", () => {
  assert.ok("productionMediaProviderCatalog" in validation, "production catalog exists");
  const catalog = validation.productionMediaProviderCatalog as MediaProviderCatalog;
  for (const provider of ["local", "local-transformers", "egemma2"]) {
    const model = catalog.lookup(provider, "google/embeddinggemma-2");
    assert.deepEqual(model, {
      local: true, capabilities: { text: true, image: true, video: true, audio: true },
      licence: { id: "Apache-2.0", nonCommercial: false }, dimensions: [128, 256, 512, 768],
    });
  }
  assert.equal(catalog.lookup("cloud", "google/embeddinggemma-2"), undefined);
  assert.equal(catalog.lookup("local", "unknown"), undefined);
  assert.equal(catalog.lookup("local", "constructor"), undefined);
  assert.equal(catalog.lookup("local", "__proto__"), undefined);
});

it("validates the complete effective global and agent media config and awaits availability", async () => {
  assert.ok("validateMediaChanges" in validation, "config-save validator exists");
  const check = validation.validateMediaChanges as (
    current: ReturnType<typeof defaults>, changes: { key: string; value: unknown }[],
    context?: Partial<validation.MediaValidationContext>,
  ) => Promise<void>;
  const cfg = defaults(), before = structuredClone(cfg);
  let checked = 0;
  await assert.rejects(check(cfg, [{ key: "memory.mediaEmbedding.dimensions", value: 256 }], {
    available: async () => { checked++; await Promise.resolve(); return false; },
  }), (e: unknown) => (e as { error?: string }).error === "E_MEDIA_UNAVAILABLE");
  assert.equal(checked, 1);
  assert.deepEqual(cfg, before);
  await check(cfg, [{ key: "agents.main.memory.mediaEmbedding.audio.segmentSec", value: 15 }]);
  await assert.rejects(check(cfg, [{ key: "agents.main.memory.mediaEmbedding.model", value: "unknown" }]));
  await assert.rejects(check(cfg, [{ key: "memory", value: { mediaEmbedding: { enabled: true, model: "unknown" } } }]));
  await assert.rejects(check(cfg, [{ key: "agents.main", value: null }]),
    (e: unknown) => (e as { error?: string }).error === "E_CONFIG_INVALID");
  const disabled = defaults();
  disabled.memory.mediaEmbedding.enabled = false;
  disabled.agents.main = { memory: { mediaEmbedding: { enabled: true, model: "unknown" } } };
  await assert.rejects(check(disabled, [{ key: "memory.mediaEmbedding.dimensions", value: 512 }]));
  const existingRemote = defaults();
  existingRemote.memory.mediaEmbedding.provider = "cloud";
  existingRemote.memory.mediaEmbedding.privacyAck = {
    provider: "cloud", acknowledgedAt: "2026-11-01T00:00:00Z", by: "owner",
  };
  await check(existingRemote, [{ key: "agents.main.displayName", value: "Main" }]);
});

it("uses defaults only for unsupported legacy local runtime fields and preserves stored selections", async () => {
  assert.ok("mediaConfigForLoad" in validation);
  const fallback = (validation as typeof validation & {
    mediaConfigForLoad<T extends validation.MediaEmbeddingConfig>(config: T): T;
  }).mediaConfigForLoad;
  const cfg = defaults().memory.mediaEmbedding;
  cfg.model = "legacy-local-model";
  cfg.dimensions = 129;
  cfg.audio.segmentSec = 15;
  const before = structuredClone(cfg), result = fallback(cfg);
  assert.equal(result.model, defaults().memory.mediaEmbedding.model);
  assert.equal(result.dimensions, defaults().memory.mediaEmbedding.dimensions);
  assert.equal(result.audio.segmentSec, 15);
  assert.deepEqual(cfg, before);
  assert.equal(fallback(result), result, "supported selections are untouched");
  const remote = { ...cfg, provider: "old-cloud-provider" };
  assert.equal(fallback(remote), remote, "never activate a remote legacy provider as a local model");
  const inactive = { ...cfg, enabled: false };
  assert.equal(fallback(inactive), inactive);
  const current = defaults();
  Object.assign(current.memory.mediaEmbedding, before);
  await validation.validateMediaChanges(current, [{ key: "core.logLevel", value: "debug" }]);
  await assert.rejects(validation.validateMediaChanges(current, [{ key: "memory.mediaEmbedding.audio.segmentSec", value: 15 }]));
});
