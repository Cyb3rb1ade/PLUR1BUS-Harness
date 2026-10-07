import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaults, validate, type HarnessConfig } from "@plur1bus/config-schema";
import { embeddingFingerprintId } from "@cyb3rb1ade/plur1bus-memory/lib/reembedding/fingerprint.js";
import { embeddingFingerprintFromNormalizedConfig } from "@cyb3rb1ade/plur1bus-memory/lib/reembedding/runtime-config.js";
import { normalizeEmbeddingConfig } from "@cyb3rb1ade/plur1bus-memory/lib/providers/config-normalize.js";
import { createConfigSwitchPort, targetSelection } from "../../src/embedding-migrate/switch.ts";
import { MigrationError } from "../../src/embedding-migrate/driver.ts";
import { layout } from "../../src/paths.ts";
import { buildEngineConfig } from "../../src/engine-config.ts";

const l = layout("/tmp/p1-switch-home");
const baseConfig = (): HarnessConfig => structuredClone(defaults()) as HarnessConfig;
/** The fingerprint the engine itself derives for a local-transformers embedding block (what it checks at start). */
function engineFingerprint(embedding: Record<string, unknown>) {
  const cfg = baseConfig(); (cfg.engine as Record<string, unknown>).embedding = embedding;
  const e = buildEngineConfig(cfg, l).embedding as Record<string, unknown>;
  const n = normalizeEmbeddingConfig(e);
  return embeddingFingerprintFromNormalizedConfig({ ...n, dimensions: n.dimensions });
}
const e5 = engineFingerprint({}) as never; // the harness default: pinned E5-small

function rig(over: { set?: (c: { key: string; value: unknown }[]) => Promise<void> | null; cfg?: HarnessConfig } = {}) {
  const sets: { key: string; value: unknown }[][] = [];
  const cfg = over.cfg ?? baseConfig();
  const port = createConfigSwitchPort({
    layout: l, config: { current: () => cfg, set: over.set ?? ((c) => { sets.push(c); return Promise.resolve(); }) },
  });
  return { port, sets };
}
const sel = (fingerprint: never, generation = "generation-m1") => ({ generation, fingerprint, fingerprintId: embeddingFingerprintId(fingerprint) });

describe("config switch port", () => {
  it("writes the embedding block and the generation selection in ONE config.set", async () => {
    const r = rig();
    await r.port.apply(sel(e5));
    assert.equal(r.sets.length, 1);
    assert.deepEqual(r.sets[0]!.map((c) => c.key), ["engine.embedding", "engine.reembedding"]);
    assert.deepEqual(r.sets[0]![1]!.value, { activeGeneration: "generation-m1", fingerprintId: embeddingFingerprintId(e5), dimensions: 384 });
    const emb = r.sets[0]![0]!.value as { provider: string; local: { model: string; revision: string; dimensions: number } };
    assert.equal(emb.provider, "local-transformers"); assert.equal(emb.local.model, "intfloat/multilingual-e5-small"); assert.equal(emb.local.dimensions, 384);
  });

  it("the written configuration makes the engine derive exactly the fingerprint id it will check at start", async () => {
    const r = rig();
    await r.port.apply(sel(e5));
    const written = r.sets[0]![0]!.value as Record<string, unknown>;
    assert.equal(embeddingFingerprintId(engineFingerprint(written) as never), embeddingFingerprintId(e5));
  });

  it("the resulting configuration is valid against the config schema (config.set would accept it)", async () => {
    const r = rig();
    await r.port.apply(sel(e5));
    const cfg = baseConfig();
    for (const c of r.sets[0]!) (cfg.engine as Record<string, unknown>)[c.key.replace("engine.", "")] = c.value;
    const v = validate(cfg);
    assert.ok(v.ok, v.ok ? "" : JSON.stringify(v.errors));
  });

  it("refuses a selection whose fingerprint id does not match what the engine would derive, writing nothing", async () => {
    const r = rig();
    await assert.rejects(r.port.apply({ ...sel(e5), fingerprintId: `embedding:v1:sha256:${"0".repeat(64)}` }), (e) => e instanceof MigrationError && e.code === "switch-unavailable" && /would not derive/.test(e.message));
    assert.deepEqual(r.sets, []);
  });

  it("refuses a provider the Harness does not run (engine-config forces local-transformers), writing nothing", async () => {
    const r = rig();
    const remote = { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 } as never;
    await assert.rejects(r.port.apply(sel(remote)), (e) => e instanceof MigrationError && e.code === "switch-unavailable" && /local-transformers/.test(e.message));
    assert.deepEqual(r.sets, []);
  });

  it("refuses when no supervisor owns config.json (set is null), writing nothing", async () => {
    const r = rig({ set: () => null });
    await assert.rejects(r.port.apply(sel(e5)), (e) => e instanceof MigrationError && e.code === "switch-unavailable" && /supervisor/.test(e.message));
  });

  it("a rejected config.set propagates unchanged; no second attempt, no partial write", async () => {
    let calls = 0;
    const r = rig({ set: () => { calls += 1; return Promise.reject(new Error("E_CONFIG_INVALID")); } });
    await assert.rejects(r.port.apply(sel(e5)), /E_CONFIG_INVALID/);
    assert.equal(calls, 1);
  });

  it("keeps the user's own embedding settings (cache dir, fallback) that the selection does not carry", async () => {
    const cfg = baseConfig(); (cfg.engine as Record<string, unknown>).embedding = { local: { cacheDir: "/models/x" }, fallback: { provider: "x" } };
    const r = rig({ cfg });
    await r.port.apply(sel(engineFingerprint({ local: { cacheDir: "/models/x" } }) as never));
    const emb = r.sets[0]![0]!.value as { local: { cacheDir?: string }; fallback?: unknown };
    assert.equal(emb.local.cacheDir, "/models/x"); assert.deepEqual(emb.fallback, { provider: "x" });
  });

  it("targetSelection maps a local fingerprint onto the engine's closed embedding config", () => {
    const s = targetSelection(sel(e5), {});
    assert.equal(s.embedding.provider, "local-transformers");
  });
});
