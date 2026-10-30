/** Record the pinned Node engine's embedding contracts. Run from the repository root:
 * node --experimental-strip-types --conditions=source crates/plur1bus-engine/tests/fixtures/vectors/record.mjs --identity
 * node --experimental-strip-types --conditions=source crates/plur1bus-engine/tests/fixtures/vectors/record.mjs --catalogue
 * Model modes are added alongside the local ONNX providers. Never hand-edit the recordings.
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { recordModels } from "./model-recording.mjs";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(fixtureDir, "../../../../..");
const require = createRequire(join(repositoryRoot, "packages/core/package.json"));
const engineRoot = dirname(require.resolve("@cyb3rb1ade/plur1bus-memory/package.json"));
const importEngine = (file) => import(pathToFileURL(join(engineRoot, file)).href);
const nodeCommit = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
const corePackage = JSON.parse(await readFile(join(repositoryRoot, "packages/core/package.json"), "utf8"));
assert.ok(corePackage.dependencies["@cyb3rb1ade/plur1bus-memory"].endsWith(`#${nodeCommit}`),
  "recorder must be reviewed when the exact Node engine pin changes");
const write = (name, value) => writeFile(join(fixtureDir, name), `${JSON.stringify(value, null, 2)}\n`);

async function recordCatalogue() {
  const { pinnedLocalModelProfile } = await importEngine("lib/providers/local-model-artifacts.js");
  const profiles = [
    pinnedLocalModelProfile("intfloat/multilingual-e5-small"),
    pinnedLocalModelProfile("jinaai/jina-embeddings-v3"),
    pinnedLocalModelProfile("jinaai/jina-embeddings-v5-text-nano-retrieval"),
    pinnedLocalModelProfile("google/embeddinggemma-2"),
    pinnedLocalModelProfile("google/embeddinggemma-2", { dtype: "q4" }),
    pinnedLocalModelProfile("google/embeddinggemma-2", { dtype: "fp32" }),
    pinnedLocalModelProfile("jinaai/jina-reranker-v2-base-multilingual"),
    pinnedLocalModelProfile("woxpas-ai/bge-reranker-v2-m3-onnx"),
  ];
  assert.ok(profiles.every(Boolean), "pinned Node catalogue changed");
  await write("catalogue.json", { nodeCommit, profiles });
}

async function recordIdentity() {
  const [{ embeddingIdentity, identityId }, { normalizeEmbeddingConfig }, fingerprint, runtime, catalogue,
    { LocalTransformersEmbeddingProvider }, { OpenAIEmbeddingProvider }] = await Promise.all([
    importEngine("lib/providers/embedding-identity.js"),
    importEngine("lib/providers/config-normalize.js"),
    importEngine("lib/reembedding/fingerprint.js"),
    importEngine("lib/reembedding/runtime-config.js"),
    importEngine("lib/providers/local-model-artifacts.js"),
    importEngine("lib/providers/embedding-local-transformers.js"),
    importEngine("lib/providers/embedding-openai.js"),
  ]);
  const [{ defaults }, { buildEngineConfig }, { layout }] = await Promise.all([
    import(pathToFileURL(join(repositoryRoot, "packages/config-schema/src/index.ts")).href),
    import(pathToFileURL(join(repositoryRoot, "packages/core/src/engine-config.ts")).href),
    import(pathToFileURL(join(repositoryRoot, "packages/core/src/paths.ts")).href),
  ]);
  const local = buildEngineConfig(defaults(), layout("/fixture/home")).embedding;
  assert.equal(local.local.model, "intfloat/multilingual-e5-small");
  const cases = [];
  function add(name, raw, identityInput, fingerprintInput, artifacts) {
    const normalized = normalizeEmbeddingConfig(raw);
    const identity = embeddingIdentity(identityInput);
    const canonicalFingerprint = fingerprintInput
      ? fingerprint.normalizeEmbeddingFingerprint(fingerprintInput, artifacts ?? identity.artifacts)
      : runtime.embeddingFingerprintFromNormalizedConfig(normalized);
    cases.push({ name, raw, identityInput, identity, identityId: identityId(identityInput), normalized,
      fingerprint: canonicalFingerprint, fingerprintId: fingerprint.embeddingFingerprintId(canonicalFingerprint),
      ...(fingerprintInput ? { fingerprintInput, fingerprintArtifacts: artifacts ?? identity.artifacts } : {}) });
  }
  const normalized = normalizeEmbeddingConfig(local);
  const provider = new LocalTransformersEmbeddingProvider(normalized.local);
  add("harness-default-e5", local, provider.identity);
  const fixtureIdentity = JSON.parse(await readFile(join(fixtureDir, "../store-v1/identity.json"), "utf8"));
  add("re02-fixture-store", local, fixtureIdentity);
  const remoteRaw = { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 };
  const remoteNormalized = normalizeEmbeddingConfig(remoteRaw);
  const remote = new OpenAIEmbeddingProvider(remoteNormalized);
  add("openai-text-embedding-3-small", remoteRaw, remote.identity);
  const baseFingerprint = runtime.embeddingFingerprintFromNormalizedConfig(normalized);
  const { schemaVersion: _schema, artifacts: baseArtifacts, ...baseConfig } = baseFingerprint;
  const variants = [
    ["dtype", { dtype: "q8" }],
    ["prefix-scheme", { prefixScheme: "manual-prefix-v2" }],
    ["instruction", { instruction: "Suche ähnliche Erinnerungen. 🧠" }],
    ["token-cap", { tokenCap: 128 }],
    ["artifacts", { artifacts: [...fixtureIdentity.artifacts].reverse().map((artifact, index) => index === 0
      ? { ...artifact, sha256: "a".repeat(64) } : artifact) }],
  ];
  for (const [name, patch] of variants) {
    const { artifacts: changed, ...fields } = patch;
    add(name, local, { ...fixtureIdentity, ...patch }, { ...baseConfig, ...fields }, changed ?? baseArtifacts);
  }
  const minimal = { provider: "openai", model: "fixture-remote", dimension: 3 };
  add("undefined-defaults", remoteRaw, minimal,
    { provider: "openai", model: "fixture-remote", dimensions: 3 });
  add("null-identity-defaults", remoteRaw, { ...minimal, revision: null, normalization: null,
    prefixScheme: null, instruction: null, dtype: null, tokenCap: null, pooling: null, artifacts: null },
  { provider: "openai", model: "fixture-remote", dimensions: 3 });
  add("endpoint-and-credential-exclusion", { ...remoteRaw, baseUrl: "https://example.com/v1?token=removed#removed" },
    remote.identity, { provider: "openai", model: "text-embedding-3-small", dimensions: 1536,
      baseUrl: "https://user:password@example.com:443/v1?token=removed#removed", credentialGeneration: 7 });
  add("artifact-sort-orders", remoteRaw, { ...minimal, artifacts: [
    { path: "z.json", sha256: "b".repeat(64) }, { path: "A.json", sha256: "a".repeat(64) },
    { path: "a.json", sha256: "c".repeat(64) }, { path: "ä.json", sha256: "d".repeat(64) },
  ] }, { provider: "openai", model: "fixture-remote", dimensions: 3 });
  await write("identity-e5.json", { nodeCommit, cases });
  const gemmaCases = [];
  for (const dtype of [undefined, "q4", "fp32"]) {
    const raw = { provider: "local-transformers", local: { model: "google/embeddinggemma-2",
      cacheDir: "/fixture/home/models", ...(dtype ? { dtype } : {}) } };
    const value = normalizeEmbeddingConfig(raw);
    const instance = new LocalTransformersEmbeddingProvider(value.local);
    const identity = instance.identity;
    const canonicalFingerprint = runtime.embeddingFingerprintFromNormalizedConfig(value);
    gemmaCases.push({ name: `embeddinggemma-2-${dtype ?? "q8"}`, raw, identityInput: identity, identity,
      identityId: identityId(identity), normalized: value, fingerprint: canonicalFingerprint,
      fingerprintId: fingerprint.embeddingFingerprintId(canonicalFingerprint) });
    assert.equal(catalogue.pinnedLocalModelProfile(value.model, dtype ? { dtype } : {}).dtype, dtype ?? "q8");
  }
  await write("identity-embeddinggemma-2.json", { nodeCommit, cases: gemmaCases });
  const invalidFingerprints = [
    ["null-token-cap", { ...baseConfig, tokenCap: null }, baseArtifacts],
    ["null-instruction", { ...baseConfig, instruction: null }, baseArtifacts],
    ["moving-revision", { ...baseConfig, revision: "main" }, baseArtifacts],
    ["unknown-field", { ...baseConfig, extra: true }, baseArtifacts],
    ["duplicate-artifact", baseConfig, [baseArtifacts[0], baseArtifacts[0]]],
    ["unsafe-artifact-path", baseConfig, [{ path: "../model.onnx", sha256: "a".repeat(64) }]],
  ].map(([name, input, artifacts]) => {
    let error;
    try { fingerprint.normalizeEmbeddingFingerprint(input, artifacts); } catch (caught) { error = caught.message; }
    assert.equal(typeof error, "string", name);
    return { name, input, artifacts, error };
  });
  await write("fingerprint-invalid.json", { nodeCommit, cases: invalidFingerprints });
  const normalizationCases = [
    ["default-remote", { provider: "openai" }],
    ["selectable-openai-width-and-timeout", { ...remoteRaw, dimensions: "512", requestTimeoutMs: "1000.9" }],
    ["default-timeout-and-secret-reference", { ...remoteRaw, requestTimeoutMs: "invalid", apiKeyRef: " fixture:key " }],
    ["unknown-remote-explicit-width", { provider: "openai-compatible", model: "fixture/embedding", dimensions: 768,
      baseUrl: "http://127.0.0.1:8000/v1", embeddingCacheMaxEntries: null, cacheMaxEntries: 7,
      embeddingCacheTtlMs: 90, cacheTtlMs: 40, embeddingCacheEnabled: false, embeddingCacheScope: "agent" }],
    ["local-custom-fields", { provider: "local-transformers", local: { model: "intfloat/multilingual-e5-small",
      dimensions: "384", cacheDir: "/fixture/models", queryPrefix: "search: ", passagePrefix: "document: ", maxTokens: 256 },
      embeddingCacheMaxEntries: 8, embeddingCachePersist: true, embeddingCacheCoalesce: false }],
    ["local-null-token-cap", { provider: "local-transformers", local: { cacheDir: "/fixture/models", maxTokens: null } }],
    ["gemma-width-and-batch", { provider: "local-transformers", local: { model: "google/embeddinggemma-2",
      dimensions: 128, dtype: "q4", maxBatchSize: 16, cacheDir: "/fixture/models" } }],
    ["unknown-local-model", { provider: "local-transformers", local: { model: "fixture/custom", cacheDir: "/fixture/models" } }],
    ["fixed-e5-width", { provider: "local-transformers", local: { dimensions: 385, cacheDir: "/fixture/models" } }],
    ["unsupported-gemma-width", { provider: "local-transformers", local: { model: "google/embeddinggemma-2", dimensions: 129, cacheDir: "/fixture/models" } }],
    ["unpinned-local-dtype", { provider: "local-transformers", local: { dtype: "q8", cacheDir: "/fixture/models" } }],
    ["reranker-is-not-embedder", { provider: "local-transformers", local: { model: "woxpas-ai/bge-reranker-v2-m3-onnx", cacheDir: "/fixture/models" } }],
    ["oversized-openai-width", { ...remoteRaw, dimensions: 1537 }],
    ["null-local-dtype", { provider: "local-transformers", local: { dtype: null, cacheDir: "/fixture/models" } }],
    ["fractional-local-batch", { provider: "local-transformers", local: { maxBatchSize: 1.5, cacheDir: "/fixture/models" } }],
  ].map(([name, raw]) => {
    try { return { name, raw, normalized: normalizeEmbeddingConfig(raw) }; }
    catch (error) { return { name, raw, error: error.message }; }
  });
  await write("normalize.json", { nodeCommit, cases: normalizationCases });
}

const allowedModes = new Set(["--identity", "--catalogue", "--sentences", "--e5", "--gemma", "--bge", "--token-ids", "--jina"]);
let mode, outputDir;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  const argument = args[index];
  if (argument === "--output-dir") {
    if (outputDir !== undefined || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("--output-dir needs exactly one directory");
    outputDir = args[++index];
  } else if (allowedModes.has(argument) && mode === undefined) mode = argument;
  else throw new Error(`expected one recorder mode and optional --output-dir; unsupported argument: ${argument}`);
}
if (!mode) throw new Error(`expected exactly one recorder mode: ${[...allowedModes].join(", ")}`);
if ((mode === "--identity" || mode === "--catalogue") && outputDir !== undefined) throw new Error("--output-dir applies only to model/sentence recorder modes");
if (mode === "--identity") await recordIdentity();
else if (mode === "--catalogue") await recordCatalogue();
else await recordModels({ fixtureDir, repositoryRoot, engineRoot, importEngine, nodeCommit }, mode,
  { outputDir, explicitOutputDir: outputDir !== undefined });
