// The Memory step of the first-run wizard writes the models the engine then runs: the config.set changes of `changesFor`,
// applied the way the supervisor applies them, make buildEngineConfig build the engine with exactly the picked embedding model
// and reranker. Only models the pinned engine can load are offered, and a store with data never changes its embedding here.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaults, type HarnessConfig } from "@plur1bus/config-schema";
import { pinnedLocalModelProfile } from "@cyb3rb1ade/plur1bus-memory/lib/providers/local-model-artifacts.js";
import { normalizeEmbeddingConfig } from "@cyb3rb1ade/plur1bus-memory/lib/providers/config-normalize.js";
import { buildEngineConfig } from "../../src/engine-config.ts";
import { layout } from "../../src/paths.ts";
import { NC_MODELS } from "../../src/licences/memory.ts";
import { assertEmbeddingChangeAllowed, memoryModelStatus } from "../../src/embedding-migrate/selection.ts";
import { changesFor, initial, validate, type Answers } from "../../../web/src/pages/setup/model.ts";
import { MODEL_CHOICES, choicesOf } from "../../../web/src/pages/setup/licences.ts";

const l = layout("/h/.plur1bus");
type Change = { key: string; value: unknown };

/** config.set semantics: each dotted key replaces the value at its path, creating the objects on the way. */
function applyChanges(cfg: HarnessConfig, changes: Change[]): HarnessConfig {
  const out = structuredClone(cfg) as any;
  for (const { key, value } of changes) {
    const parts = key.split("."); let node = out;
    for (const p of parts.slice(0, -1)) node = node[p] = typeof node[p] === "object" && node[p] !== null ? node[p] : {};
    node[parts.at(-1)!] = structuredClone(value);
  }
  return out;
}
/** The Memory step on `cfg` with `holdsTables` and the person's picks; returns the engine config after its config.set. */
function wizard(cfg: HarnessConfig, holdsTables: boolean, picks: Partial<Answers>): { changes: Change[]; engine: any } {
  const running = buildEngineConfig(cfg, l);
  const answers: Answers = { ...initial().answers, ...picks, memoryModels: memoryModelStatus(running, cfg, holdsTables) };
  const changes = changesFor("memory", answers);
  assertEmbeddingChangeAllowed({ current: cfg, changes, layout: l, active: running, holdsTables: () => holdsTables });
  return { changes, engine: buildEngineConfig(applyChanges(cfg, changes), l) };
}
const engineKeys = (changes: Change[]) => changes.map((c) => c.key).filter((k) => k.startsWith("engine."));
const ncAccepted = { useClass: "research" as const, nc: { at: "2026-10-24T10:00:00.000Z", who: "owner" } };

describe("setup wizard Memory step → engine", () => {
  it("picking EmbeddingGemma 2 and the Jina reranker on a fresh store makes the engine run them", () => {
    const { engine } = wizard(defaults(), false, { embedding: "egemma2", rerank: "jina-rr-v2", ...ncAccepted });
    assert.equal(engine.embedding.provider, "local-transformers");
    assert.equal(engine.embedding.local.model, "google/embeddinggemma-2");
    assert.equal(engine.embedding.local.dimensions, 768);
    assert.equal(engine.reranker.provider, "local-transformers");
    assert.equal(engine.reranker.local.model, "jinaai/jina-reranker-v2-base-multilingual");
  });

  it("every offered embedding model and reranker reaches the engine as picked", () => {
    for (const emb of choicesOf("embedding")) for (const rer of choicesOf("rerank")) {
      const { engine } = wizard(defaults(), false, { embedding: emb.id, rerank: rer.id, ...ncAccepted });
      assert.equal(engine.embedding.local.model, emb.model, emb.id);
      assert.equal(engine.reranker.local.model, rer.model, rer.id);
    }
  });

  it("an accepted non-commercial embedding reaches the engine with the licence acceptance it needs to load", () => {
    const { changes, engine } = wizard(defaults(), false, { embedding: "jina-v5-nano", ...ncAccepted });
    assert.deepEqual(changes.filter((c) => c.key.startsWith("embedding.acceptedNcLicence")).map((c) => c.value), [true, "2026-10-24T10:00:00.000Z"]);
    assert.deepEqual(engine.modelPreparation, { profile: "jina-v5-nano-768", acceptNonCommercialLicense: true });
  });

  it("with nothing picked, a fresh store on the harness default gets EmbeddingGemma 2 (ADR-006 amendment 2026-10-08)", () => {
    const { engine } = wizard(defaults(), false, {});
    assert.equal(engine.embedding.local.model, "google/embeddinggemma-2");
    assert.equal(engine.reranker.local.model, "woxpas-ai/bge-reranker-v2-m3-onnx");
  });

  it("a store with data keeps its embedding model; the reranker still changes", () => {
    const { changes, engine } = wizard(defaults(), true, { embedding: "egemma2", rerank: "jina-rr-v2", ...ncAccepted });
    assert.deepEqual(engineKeys(changes), ["engine.reranker"]);
    assert.equal(engine.embedding.local.model, "intfloat/multilingual-e5-small");
    assert.equal(engine.reranker.local.model, "jinaai/jina-reranker-v2-base-multilingual");
  });

  it("an untouched step on an explicitly chosen model writes no engine change", () => {
    const cfg = defaults() as any; cfg.engine.embedding = { local: { model: "intfloat/multilingual-e5-small", dimensions: 384 } };
    assert.deepEqual(engineKeys(wizard(cfg, false, {}).changes), []);
  });

  it("a configured cloud embedding is kept unless a local model is picked", () => {
    const cfg = defaults() as any;
    cfg.engine.embedding = { provider: "openai", model: "text-embedding-3-large", dimensions: 3072, apiKeyEnv: "OPENAI_API_KEY" };
    cfg.memory = { ...cfg.memory, embedding: { privacyAck: { provider: "openai", acknowledgedAt: "2026-10-18T09:00:00Z", by: "owner" } } };
    assert.equal(wizard(cfg, false, {}).engine.embedding.model, "text-embedding-3-large");
    assert.equal(wizard(cfg, false, { embedding: "egemma2" }).engine.embedding.local.model, "google/embeddinggemma-2");
  });

  it("without the engine's answer the step writes no model at all", () => {
    const changes = changesFor("memory", { ...initial().answers, embedding: "egemma2", rerank: "jina-rr-v2", ...ncAccepted });
    assert.deepEqual(engineKeys(changes), []);
  });

  describe("a store with data embedded with a non-commercial model", () => {
    // Jina v3 runs with its licence accepted for research; the store holds data, so the model stays.
    const jina = (): HarnessConfig => {
      const cfg = defaults() as any;
      cfg.engine.embedding = { local: { model: "jinaai/jina-embeddings-v3", dimensions: 1024 } };
      cfg.embedding = { ...cfg.embedding, useClass: "research", acceptedNcLicence: true, acceptedNcLicenceAt: "2026-10-24T10:00:00.000Z" };
      return cfg;
    };
    it("keeps the licence acceptance the engine needs to load it, even without a fresh confirmation", () => {
      // A second pass in a browser that remembers the acceptance as written, with no new confirmation in this pass.
      const { changes, engine } = wizard(jina(), true, { useClass: "research", ncWritten: true });
      assert.ok(!changes.some((c) => c.key === "embedding.acceptedNcLicence"), JSON.stringify(changes));
      assert.equal(engine.embedding.local.model, "jinaai/jina-embeddings-v3");
      assert.equal(engine.modelPreparation?.acceptNonCommercialLicense, true);
    });
    it("refuses the commercial use class before anything is written", () => {
      const cfg = jina();
      const answers: Answers = { ...initial().answers, useClass: "commercial", memoryModels: memoryModelStatus(buildEngineConfig(cfg, l), cfg, true) };
      assert.equal(validate("memory", answers, true).useClass, "ncLocked");
      assert.equal(validate("memory", { ...answers, useClass: "research" }, true).useClass, undefined);
    });
  });
});

describe("setup wizard model table", () => {
  it("offers exactly models the pinned engine can load, with the engine's ids, revisions and widths", () => {
    for (const c of MODEL_CHOICES) {
      const profile = pinnedLocalModelProfile(c.model);
      assert.ok(profile, `${c.id}: ${c.model} is not pinned by the engine`);
      assert.equal(profile.role, c.kind === "embedding" ? "embedding" : "reranker", c.id);
      assert.equal(profile.revision, c.revision, c.id);
      if (c.kind === "embedding") assert.equal(c.dimensions, normalizeEmbeddingConfig({ provider: "local-transformers", local: { model: c.model } }).dimensions, c.id);
    }
  });
  it("marks exactly the models the licence gate treats as non-commercial", () => {
    assert.deepEqual(MODEL_CHOICES.filter((c) => c.nc).map((c) => c.model).sort(), NC_MODELS.filter((m) => m !== "jinaai/jina-embeddings-v5-text-nano").slice().sort());
  });
});
