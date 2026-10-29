/** The supervised foreign-store route must prove the actual copied vectors before changing the target model. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NANO } from "./fixtures.ts";
import { treeDigest } from "./tree.ts";
import { foreignStoreFixture as fixture } from "./source-store-fixture.ts";

it("source model changes contain only pinned model controls and preserve the original target choice", async () => {
  const module = await import("../../src/import/source-store-transfer.ts").catch(() => undefined);
  assert.equal(typeof module?.sourceStoreConfig, "function");
  const f = await fixture();
  assert.deepEqual(f.source.view.stores?.[0]?.sourceModelCandidate, { model: NANO, dimensions: 768,
    revision: "ac5d898c8d382b17167c33e5c8af644a3519b47d", licence: "CC-BY-NC-4.0", nonCommercial: true });
  const next = module!.sourceStoreConfig(f.config, f.candidate);
  assert.equal((next.engine.embedding as { local: { model: string } }).local.model, NANO);
  assert.equal(next.engine.reembedding, undefined);
  assert.equal(module!.currentStoreTarget(f.config, f.home), "intfloat/multilingual-e5-small");
  assert.deepEqual(module!.sourceStoreChanges(f.config, f.candidate).map(change => change.key),
    ["engine.embedding", "engine.reembedding", "engine.modelPreparation"]);
  assert.equal(JSON.parse(readFileSync(join(f.home, "config.json"), "utf8")).engine.embedding, undefined);
  const configured = { ...f.config, engine: { ...f.config.engine,
    baseDbPathOverride: join(f.home, "state", "live-store"), neo: { enabled: true, statePath: join(f.home, "state", "live-neo") } } };
  const probe = module!.isolatedSourceProbeConfig(configured, f.candidate, f.home);
  assert.equal(probe.engine.baseDbPathOverride, undefined);
  assert.deepEqual(probe.engine.neo, { enabled: false });
  assert.equal((probe.engine.embedding as { local: { cacheDir: string } }).local.cacheDir, join(f.home, "models"));
});

it("the actual source-configured Engine sample proves copied legacy vectors without mutating the live target", async () => {
  const module = await import("../../src/import/source-store-transfer.ts").catch(() => undefined);
  assert.equal(typeof module?.probeSourceStoreTransfer, "function");
  for (const hot of [0, 1]) {
    const f = await fixture(hot);
    const before = treeDigest(join(f.home, "state"));
    const embeddings = (width: number) => {
      const one = async () => Array.from({ length: width }, (_, i) => i === 0 ? 1 : 0);
      return { embed: one, embedQuery: one, embedPassage: one,
        embedBatch: async (texts: string[]) => Promise.all(texts.map(one)), shutdown: async () => {} };
    };
    const run = () => module!.probeSourceStoreTransfer({ home: f.home, source: f.source, candidate: f.candidate,
      config: f.config, testInternals: { embeddings, reranker: null } });
    if (hot === 0) await run();
    else await assert.rejects(run(), { reason: "source-store-probe-failed" });
    assert.equal(treeDigest(join(f.home, "state")), before, "only private scratch copies may be opened by the candidate model");
  }
});
