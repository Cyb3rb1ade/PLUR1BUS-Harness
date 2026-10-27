/**
 * Record validation and setup reference data from the exactly pinned Node engine.
 * From the repository root, after `pnpm test:prep`, with Node 24.21:
 *   node crates/plur1bus-engine/tests/fixtures/config/record.mjs
 *
 * The engine schema module only loads schema metadata. The startup validator is
 * validatePluginConfig from lib/setup/config-contract.js. Its first failure is
 * recorded with a relative diagnostic path; successful inputs remain raw rather
 * than being replaced with the validator's alias-normalized return value.
 * effective/ and setup/ separately record normalized/defaulted/profile outputs.
 * Never edit the JSON recordings by hand: change a scenario here and rerun.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(fixtureDir, "../../../../..");
const require = createRequire(join(repositoryRoot, "packages/core/package.json"));
const engineRoot = dirname(require.resolve("@cyb3rb1ade/plur1bus-memory/package.json"));
const importEngine = (file) => import(pathToFileURL(join(engineRoot, file)).href);
const [contract, profiles, { loadEngineConfigSchema }] = await Promise.all([
  importEngine("lib/setup/config-contract.js"),
  importEngine("lib/setup/feature-profiles.js"),
  importEngine("engine/config/engine-config-schema.js"),
]);
const { validatePluginConfig, resolveEffectiveConfig, manifestConfigDefaults } = contract;
const schema = loadEngineConfigSchema();
assert.equal(Object.keys(schema.properties).length, 57, "pinned engine schema key count changed");
assert.equal(Object.hasOwn(schema.properties, "groupReasoningFilter"), false);
assert.equal(Object.hasOwn(schema.properties.runtime.properties, "traceRegistrations"), false);
assert.equal(schema.properties.runtime.properties.deferPostTurnLlm.default, false);

// Discover the package's plugin manifest without embedding a host-specific name.
const manifestNames = (await readdir(engineRoot)).filter((name) => name.endsWith(".plugin.json"));
assert.equal(manifestNames.length, 1, "expected exactly one engine plugin manifest");
const manifest = JSON.parse(await readFile(join(engineRoot, manifestNames[0]), "utf8"));
assert.equal(Object.keys(manifest.configSchema.properties).length, 58);
assert.equal(manifest.configSchema.properties.runtime.properties.traceRegistrations.type, "boolean");
assert.equal(manifest.configSchema.properties.runtime.properties.traceRegistrations.default, false);
assert.equal(manifest.configSchema.properties.runtime.properties.deferPostTurnLlm.default, true);

// Approved schema/runtime differences: two accepted runtime-only keys, and the
// startup default for deferPostTurnLlm. Keep all other structural drift visible.
const metadata = new Set(["description", "readAt", "x-tier", "x-sensitive", "$schema", "$id", "x-contract"]);
function withoutMetadata(value) {
  if (Array.isArray(value)) return value.map(withoutMetadata);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !metadata.has(key))
      .map(([key, child]) => [key, withoutMetadata(child)]));
  }
  return value;
}
const engineStructure = withoutMetadata(schema);
const manifestStructure = withoutMetadata(manifest.configSchema);
delete manifestStructure.properties.groupReasoningFilter;
delete manifestStructure.properties.runtime.properties.traceRegistrations;
manifestStructure.properties.runtime.properties.deferPostTurnLlm.default = false;
assert.deepEqual(engineStructure, manifestStructure, "unreviewed config schema/manifest structural drift");

const fingerprint = `embedding:v1:sha256:${"a".repeat(64)}`;
const identity = {
  provider: "local-transformers", model: "fixture-model", revision: "fixture-revision",
  dimension: 384, normalization: "l2", prefixScheme: "none", instruction: "", dtype: "q8",
  artifacts: [{ path: "models/fixture.onnx", sha256: "b".repeat(64) }], tokenCap: null,
};
const review = { enabled: true, timezone: "Europe/Berlin", status: "pending_setup", applyMode: "manual" };
const validCases = [
  ["01-empty", {}],
  ["02-feature-booleans", { autoCapture: false, autoRecall: true, captureChunking: false }],
  ["03-namespaces", { namespaces: {
    activeWriteNamespace: "team_1", activeRecallNamespaces: ["team_1", "shared-2"],
    legacyReadOnlyNamespaces: ["archive"], crossNamespaceRecall: true,
  } }],
  ["04-reranker-without-provider", { reranker: {} }],
  ["05-reranker-remote", { reranker: {
    enabled: true, provider: "remote", protocol: "cohere", baseUrl: "https://fixture.invalid/rerank",
    maxDocuments: 1, maxRequestBytes: 1, maxResponseBytes: 1, fallbackProvider: "disabled",
  } }],
  ["06-recall-boundaries", { recall: {
    fullTextTopRecords: 0, fullTextMaxChars: 400, candidateTopK: 1,
    adaptiveBudget: { tokenBudgetPct: 0 }, semanticCompression: { tokenBudget: 1 },
    decisionTrace: { persist: false, visibleHints: false, maxCandidates: 1, maxTextPreviewChars: 0 },
  } }],
  ["07-capture-jev-boundaries", { captureChunkingJev: {
    apiKeyEnv: "FIXTURE_JEV_KEY", minConfidence: 1, timeoutMs: 30000,
  } }],
  ["08-local-embedding", { embedding: {
    provider: "local-transformers", dimensions: 1,
    local: { dimensions: 1, maxTokens: 32, maxBatchSize: 1, dtype: "q4" },
  } }],
  ["09-secret-env", { embedding: { apiKey: { source: "env", provider: "primary", id: "FIXTURE_API_KEY" } } }],
  ["10-secret-store", { embedding: { fallback: { apiKey: { source: "store", provider: "main-store", id: "FIXTURE_FALLBACK_KEY" } } } }],
  ["11-secret-file", { reranker: { apiKey: { source: "file", provider: "files", id: "/tokens/a~1b~0c" } } }],
  ["12-secret-exec", { merging: { apiKey: { source: "exec", provider: "command", id: "service:account/api-key#v1" } } }],
  ["13-timezones", { timezone: "UTC", styleDirective: { timezone: null }, afterthought: { timezone: "Europe/Berlin" } }],
  ["14-matching-review-aliases", { morningReview: review, obsidianBridge: { morningReview: review } }],
  ["15-legacy-review-alias", { eveningReview: { enabled: false, timezone: "UTC", status: "active" } }],
  ["16-group-reasoning-filter", { groupReasoningFilter: { enabled: true, prefixes: ["🧠", "<think>"] } }],
  ["17-model-preparation", { modelPreparation: { profile: "e5-multilingual-384", acceptNonCommercialLicense: false } }],
  ["18-reembedding", { reembedding: { activeGeneration: "generation-1", fingerprintId: fingerprint, dimensions: 384 } }],
  ["19-embedding-routes", { embedding: { routes: [{ agentId: "fixture-agent", namespace: "team_1", scope: "workspace", identity }] } }],
  ["20-runtime-trace-registrations", { runtime: { traceRegistrations: true } }],
  ["21-runtime-explicit-defer", { runtime: { deferPostTurnLlm: false } }],
  ["22-runtime-widened-numbers", { runtime: { recallTimeoutMs: -1, maxConcurrentRecall: 1.5, metricsDebounceMs: 0 } }],
  ["23-reaction-auto", { reactionNudge: { enabled: "auto" } }],
  ["24-ignored-property-names", { chatModels: { "invalid agent key": "fixture/model" },
    security: { allowedUserIds: ["fixture-user"], allowedChatIds: ["fixture-chat"] } }],
  ["25-emotion-temperament", { emotion: { moodInfluence: 0, temperaments: {
    fixture: { sensitivity: 0, decayMultiplier: 0, blendFactor: 1, moodInfluence: 1, baseline: { joy: 1, fear: 0 } },
  } } }],
  ["26-persona-boundaries", { personaVoice: { maxDirectiveChars: 200, maxBullets: 6, minDaysBetween: 0, minOutcomes: 1 } }],
  ["27-setup-metadata", { setupProfile: "custom", featuresConfirmedAt: "2026-10-15T12:00:00.000Z" }],
  ["28-secret-plaintext-and-reference", { embedding: { apiKey: "fixture-placeholder", apiKeyRef: "fixture/credential@v1" } }],
  ["29-compaction-boundaries", { runtime: { lancedbCompaction: {
    fragmentThreshold: 8, checkEveryWrites: 1, checkIntervalMs: 60000, timeoutMs: 10000,
  } } }],
  ["30-empty-and-null-timezones", { timezone: "", styleDirective: { timezone: null }, afterthought: { timezone: "" } }],
];
const invalidCases = [
  ["01-unknown-top-level", { fixtureUnknown: true }],
  ["02-wrong-boolean-type", { autoCapture: "true" }],
  ["03-recall-out-of-range", { recall: { candidateTopK: 101 } }],
  ["04-namespace-entry-shape", { namespaces: { activeRecallNamespaces: [{}] } }],
  ["05-reranker-provider-enum", { reranker: { provider: "fixture-unknown" } }],
  ["06-reranker-wrong-type", { reranker: [] }],
  ["07-recall-budget-type", { recall: { softBudgetMs: "fast" } }],
  ["08-capture-jev-inline-secret", { captureChunkingJev: { apiKey: "fixture-placeholder" } }],
  ["09-empty-recall-namespaces", { namespaces: { activeRecallNamespaces: [] } }],
  ["10-invalid-namespace-name", { namespaces: { activeWriteNamespace: "../escape" } }],
  ["11-embedding-dimensions", { embedding: { dimensions: 0 } }],
  ["12-route-missing-identity", { embedding: { routes: [{ agentId: "fixture-agent" }] } }],
  ["13-identity-missing-provider", { embedding: { routes: [{ identity: {} }] } }],
  ["14-empty-secret", { embedding: { apiKey: "" } }],
  ["15-secret-source-enum", { embedding: { apiKey: { source: "fixture-unknown", provider: "primary", id: "FIXTURE_KEY" } } }],
  ["16-secret-missing-provider", { embedding: { apiKey: { source: "env", id: "FIXTURE_KEY" } } }],
  ["17-secret-env-id", { embedding: { apiKey: { source: "env", provider: "primary", id: "lower_case" } } }],
  ["18-utf16-string-length", { healthWatch: { gatewayLogDir: "😀".repeat(257) } }],
  ["19-secret-file-relative-id", { embedding: { apiKey: { source: "file", provider: "files", id: "tokens/key" } } }],
  ["20-secret-file-escape", { embedding: { apiKey: { source: "file", provider: "files", id: "/tokens/~2" } } }],
  ["21-secret-exec-dot-segment", { merging: { apiKey: { source: "exec", provider: "command", id: "service/../key" } } }],
  ["22-secret-provider-pattern", { embedding: { apiKey: { source: "env", provider: "Primary", id: "FIXTURE_KEY" } } }],
  ["23-timezone-unknown", { timezone: "Mars/Olympus" }],
  ["24-nested-timezone-whitespace", { styleDirective: { timezone: "   " } }],
  ["25-review-alias-conflict", { morningReview: { enabled: true }, obsidianBridge: { morningReview: { enabled: false } } }],
  ["26-unsafe-property", JSON.parse('{"emotion":{"temperaments":{"__proto__":{}}}}')],
  ["27-runtime-trace-type", { runtime: { traceRegistrations: "yes" } }],
  ["28-group-prefix-empty", { groupReasoningFilter: { prefixes: [""] } }],
  ["29-decision-trace-const", { recall: { decisionTrace: { persist: true } } }],
  ["30-compaction-minimum", { runtime: { lancedbCompaction: { fragmentThreshold: 7 } } }],
];
assert.equal(validCases.length, 30);
assert.equal(invalidCases.length, 30);

function validationRecording(config) {
  const supplied = structuredClone(config);
  try {
    validatePluginConfig(supplied, { path: "" });
    assert.deepEqual(supplied, config, "Node validator mutated its raw input");
    return { config, valid: true, errors: [] };
  } catch (error) {
    if (error.code !== "INVALID_PLUGIN_CONFIG" || typeof error.configPath !== "string") throw error;
    assert.deepEqual(supplied, config, "Node validator mutated a rejected input");
    return { config, valid: false, errors: [error.configPath.replace(/^\./, "")] };
  }
}

const recordings = new Map();
for (const [folder, cases, expected] of [["valid", validCases, true], ["invalid", invalidCases, false]]) {
  for (const [name, config] of cases) {
    const recording = validationRecording(config);
    assert.equal(recording.valid, expected, `${folder}/${name}: pinned Node verdict contradicts scenario`);
    recordings.set(`${folder}/${name}.json`, recording);
  }
}

function reference(folder, name, operation, args, invoke) {
  const before = structuredClone(args);
  const output = invoke(...structuredClone(args));
  assert.deepEqual(args, before, `${operation} recording mutated scenario arguments`);
  recordings.set(`${folder}/${name}.json`, { operation, args, output });
}
function effective(name, config, operation = "resolveEffectiveConfig") {
  const args = operation === "manifestConfigDefaults" ? [] : [config, { path: "" }];
  const invoke = operation === "manifestConfigDefaults" ? manifestConfigDefaults : contract[operation];
  reference("effective", name, operation, args, invoke);
}
effective("empty", {});
effective("manifest-defaults", undefined, "manifestConfigDefaults");
effective("runtime-explicit", { runtime: { deferPostTurnLlm: false, traceRegistrations: true } });
effective("widened-runtime-values", validCases.find(([name]) => name === "22-runtime-widened-numbers")[1]);
effective("legacy-review-alias", { morningReview: review });
effective("validated-review-alias", { morningReview: review }, "validatePluginConfig");
effective("matching-review-aliases", { morningReview: review, obsidianBridge: { morningReview: review } }, "validatePluginConfig");
reference("effective", "schema-runtime-defaults", "engineSchemaRuntimeDefaults", [], () => ({
  deferPostTurnLlm: schema.properties.runtime.properties.deferPostTurnLlm.default,
}));
assert.equal(recordings.get("effective/empty.json").output.runtime.deferPostTurnLlm, true);
assert.equal(recordings.get("effective/empty.json").output.runtime.traceRegistrations, false);

const { PLUGIN_KEY } = profiles;
const fixedConfirmation = "2026-10-15T12:00:00.000Z";
const selection = { autoCapture: false, reranker: true, emotionT3: false, morningReview: false,
  embedding: { provider: "local-transformers", local: { dimensions: 384 } } };
const mixed = { autoCapture: false, autoRecall: true, reranker: { enabled: true },
  obsidianBridge: { enabled: true, requireVaultPathConfirmation: true,
    morningReview: { enabled: true, status: "pending_setup" },
    eveningReview: { enabled: false, status: "pending_setup" } } };
const setupCases = [
  ["safe-profile", "safeProfile", []],
  ["recommended-profile", "recommendedProfile", []],
  ["full-experience-defaults", "fullExperienceDefaults", []],
  ["custom-profile", "customProfileFromSelection", [selection]],
  ["custom-object-overrides", "customProfileFromSelection", [{ reranker: { enabled: true, timeoutMs: 7500 }, neo: false }]],
  ["core-features", "listCoreFeatures", []],
  ["missing-features", "detectMissingCoreFeatures", [mixed]],
  ["full-experience-policy", "applyFullExperiencePolicy", [{ autoCapture: false, morningReview: review }]],
  ["pending-unconfirmed", "detectPendingFeatures", [mixed]],
  ["pending-confirmed", "detectPendingFeatures", [mixed, { vaultConfirmed: true }]],
  ["apply-blocked", "isApplyBlocked", [mixed]],
  ["apply-unblocked", "isApplyBlocked", [{ obsidianBridge: { enabled: false } }, { vaultConfirmed: true }]],
  ["profile-diff", "describeProfileDiff", [mixed, { autoCapture: true, autoRecall: false, reranker: { enabled: true }, neo: { enabled: true } }]],
  ["summary", "summarizeFullExperienceStatus", [mixed]],
  ["render-status", "renderPlur1busStartStatus", [mixed, { vaultPath: "/fixture/vault", workspaceRoot: "/fixture/workspace", reviewRoot: "review" }]],
  ["normalize-compatibility", "normalizePluginEntryCompatibility", [{ enabled: false, config: {
    hooks: { fixtureHook: true }, morningReview: review, merging: { backupBeforeApply: false, auditLog: false },
  } }, { profileName: "recommended" }]],
];
for (const [name, operation, args] of setupCases) {
  reference("setup", name, operation, args, profiles[operation]);
}
for (const name of ["safe", "recommended", "custom"]) {
  const profile = name === "custom" ? profiles.customProfileFromSelection(selection) : profiles[`${name}Profile`]();
  const existing = { fixtureDocument: "retained", plugins: { entries: { [PLUGIN_KEY]: { enabled: false,
    config: { autoCapture: false, reranker: { enabled: true, timeoutMs: 1200 }, merging: { enabled: true },
      obsidianBridge: { allowWrite: true, semanticGraph: { mutateMemory: true } } },
  } } } };
  reference("setup", `apply-${name}`, "applyFeatureProfile", [existing, profile, {
    confirmedAt: fixedConfirmation, disabledFeatures: ["autoRecall", "unknown-feature"],
  }], profiles.applyFeatureProfile);
}
reference("setup", "dormant-events", "reportDormantFeature", [[
  { explicit: true, message: "explicit fixture" },
  { explicit: false, message: "implicit fixture" },
  { message: "unspecified fixture" }, { explicit: true, message: "" },
]], (reports) => {
  const events = [];
  const logger = { warn: (message) => events.push({ level: "warn", message }),
    info: (message) => events.push({ level: "info", message }) };
  for (const report of reports) profiles.reportDormantFeature(logger, report);
  return events;
});

// Intl also accepts legacy ICU names and ISO offsets beyond canonical IANA names.
// These fixed candidates retain those startup semantics without a runtime Node process.
const acceptedTimezoneAliases = ["ACT", "AET", "AGT", "ART", "AST", "BET", "BST", "CAT", "CNT", "CST", "CTT", "Canada/East-Saskatchewan", "EAT", "ECT", "IET", "IST", "JST", "MIT", "NET", "NST", "PLT", "PNT", "PRT", "PST", "SST", "SystemV/AST4", "SystemV/AST4ADT", "SystemV/CST6", "SystemV/CST6CDT", "SystemV/EST5", "SystemV/EST5EDT", "SystemV/HST10", "SystemV/MST7", "SystemV/MST7MDT", "SystemV/PST8", "SystemV/PST8PDT", "SystemV/YST9", "SystemV/YST9YDT", "US/Pacific-New", "VST", "UTC", "utc", "Etc/UTC", "europe/berlin", "US/Eastern", "EST", "MST", "HST", "+01", "+0100", "+01:00", "-23:59"];
const rejectedTimezones = ["+24:00", "+01:60", "+1", "+01:00:00", "GMT+1", "Mars/Olympus"];
const canonicalTimezones = Intl.supportedValuesOf("timeZone");
assert.equal(process.versions.node, "24.21.0", "record timezone references with the pinned Node version");
for (const timezone of [...canonicalTimezones, ...acceptedTimezoneAliases]) {
  assert.doesNotThrow(() => validatePluginConfig({ timezone }, { path: "" }), timezone);
}
for (const timezone of rejectedTimezones) {
  assert.throws(() => validatePluginConfig({ timezone }, { path: "" }), { configPath: ".timezone" }, timezone);
}
recordings.set("timezones/identifiers.json", {
  nodeVersion: process.versions.node, icuVersion: process.versions.icu, tzVersion: process.versions.tz,
  canonical: canonicalTimezones, acceptedAliases: acceptedTimezoneAliases, rejected: rejectedTimezones,
});

// Compute everything before writing, so a changed Node verdict leaves the old
// immutable recordings intact for investigation.
for (const folder of ["valid", "invalid", "effective", "setup", "timezones"]) {
  const expected = [...recordings.keys()].filter((name) => name.startsWith(`${folder}/`)).map((name) => name.split("/")[1]).sort();
  await mkdir(join(fixtureDir, folder), { recursive: true });
  const existing = (await readdir(join(fixtureDir, folder))).filter((name) => name.endsWith(".json")).sort();
  assert.equal(existing.some((name) => !expected.includes(name)), false, `unexpected stale JSON recording in ${folder}`);
}
for (const [name, recording] of recordings) {
  await writeFile(join(fixtureDir, name), `${JSON.stringify(recording, null, 2)}\n`);
}
console.log(`Recorded ${validCases.length} valid, ${invalidCases.length} invalid, 8 effective, 20 setup and 1 timezone references.`);
