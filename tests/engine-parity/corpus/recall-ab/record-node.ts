import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { flatTargetProvider } from "../../../../packages/core/test/helpers/flat-embedder.ts";
import { verifyNodeInstall } from "../../lib/node-side.ts";
import { PARITY_TIMEZONE, PIN } from "../../lib/scenario.ts";
import corpus from "./corpus.json" with { type: "json" };

// Use the pinned Node recall pipeline directly so the recording retains the returned card IDs and scores.
// A fixed clock, synthetic cards, and disabled reranking isolate the score stages being compared in RE-D11.
const mode = process.argv[2];
assert.ok(mode === "flat" || mode === "e5", "pass flat or e5");
process.env.TZ = PARITY_TIMEZONE;
const root = verifyNodeInstall();
const fromEngine = (path: string) => import(pathToFileURL(join(root, path)).href);
const [{ runRecallPipeline }, { MemoryDB }] = await Promise.all([
  fromEngine("lib/recall-pipeline.js"),
  fromEngine("engine/store/memory-db.js"),
]);

const dimensions = 384;
const model = "intfloat/multilingual-e5-small";
async function realEmbedder() {
  const cacheDir = process.env.PLUR1BUS_MODELS_CACHE;
  assert.ok(cacheDir && isAbsolute(cacheDir), "set PLUR1BUS_MODELS_CACHE to a prepared local E5 cache");
  const [{ LocalTransformersEmbeddingProvider }, { importTransformersBehindSharpProbe }, catalogue] = await Promise.all([
    fromEngine("lib/providers/embedding-local-transformers.js"),
    fromEngine("lib/native/sharp-unavailable.js"),
    fromEngine("lib/providers/local-model-artifacts.js"),
  ]);
  const profile = catalogue.pinnedLocalModelProfile(model);
  const validated = await catalogue.validatePinnedModelArtifacts(profile, cacheDir);
  assert.ok(validated.ok, "the prepared cache must contain the pinned E5 artifacts");
  const transformers = await importTransformersBehindSharpProbe({});
  transformers.env.allowRemoteModels = false;
  // Transformers.js discovers tokenizer support before consulting the requested revision.
  // Expose the verified revision's tokenizer metadata at an unversioned local path for that lookup.
  const metadataRoot = mkdtempSync(join(tmpdir(), "p1b-recall-ab-metadata-"));
  try {
    const metadata = join(metadataRoot, model);
    mkdirSync(metadata, { recursive: true });
    copyFileSync(join(cacheDir, model, profile.revision, "tokenizer_config.json"), join(metadata, "tokenizer_config.json"));
    transformers.env.localModelPath = metadataRoot;
    const provider = new LocalTransformersEmbeddingProvider({ model, dimensions, cacheDir,
      embeddingCacheEnabled: false, loadTransformers: async () => transformers,
      ensureModelArtifacts: async () => { /* The pinned files were checked above. */ } });
    return {
      embedPassage: (text: string) => provider.embedPassage(text),
      embedQuery: (text: string) => provider.embedQuery(text),
      async shutdown() {
        try { await provider.shutdown(); }
        finally { rmSync(metadataRoot, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    rmSync(metadataRoot, { recursive: true, force: true });
    throw error;
  }
}

const embeddings = mode === "flat" ? flatTargetProvider({ fingerprint: { dimensions } }) : await realEmbedder();
const ids = new Map(corpus.cards.map(({ id }, index) => [
  `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, id,
]));
assert.equal(new Set(ids.values()).size, ids.size, "card IDs are unique");
assert.equal(new Set(corpus.queries.map(query => query.id)).size, corpus.queries.length, "query IDs are unique");
const known = new Set(ids.values());
for (const query of corpus.queries) assert.ok(query.expectedIds.every(id => known.has(id)), query.id);
const now = Date.parse(corpus.now);
const memoryCtx = { agentId: "a1", workspaceId: "", workspaceIdentity: "", userPrincipal: "" };
const logger = { info() {}, warn() {}, error() {}, debug() {} };

async function record() {
  const directory = mkdtempSync(join(tmpdir(), "p1b-recall-ab-"));
  const db = new MemoryDB(directory, dimensions);
  try {
    await db.init();
    const uuidByLabel = new Map([...ids].map(([uuid, label]) => [label, uuid]));
    for (const [index, card] of corpus.cards.entries()) {
      await db.store({ id: uuidByLabel.get(card.id), text: card.text, vector: await embeddings.embedPassage(card.text),
        agentId: "a1", storedBy: "a1", scope: "agent-private", ownerUserId: "", workspaceId: "", workspaceKey: "",
        status: "active", epistemicStatus: "observed", category: "general", memoryStrength: 1, importance: 0.5,
        validFrom: 0, validUntil: 0, createdAt: now - 86_400_000 - index * 60_000 });
    }
    const queries = [];
    for (const query of corpus.queries) {
      const result = await runRecallPipeline({ query: query.text, dbTable: db.table, embeddings, workspaceDir: null,
        topN: corpus.cards.length, candidateTopK: 40, candidateHardLimit: 100, recallMinScore: 0.3, canonicalEnabled: false,
        associativeEnabled: false, deferFinalCap: true, now, memoryCtx, logger, reranker: null, readOnly: true });
      const hits = result.memories.map(({ entry, score }: { entry: { id: string }; score: number }) => {
        const id = ids.get(entry.id);
        assert.ok(id && Number.isFinite(score), `unexpected recall hit for ${query.id}`);
        return { id, score: Number(score.toFixed(6)) };
      });
      queries.push({ id: query.id, hits });
    }
    return queries;
  } finally {
    try { await db.shutdown(); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  }
}

try {
  const first = await record();
  assert.deepEqual(await record(), first, "two fresh stores must reproduce result order and scores");
  process.stdout.write(`${JSON.stringify({ schema: "recall-ab.node-baseline/1", pin: PIN, profile: mode === "flat" ? "flat" : model, queries: first }, null, 2)}\n`);
} finally {
  await embeddings.shutdown();
}
