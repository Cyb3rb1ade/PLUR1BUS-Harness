// Inputs are synthetic configuration/receipt metadata. Expected results execute Core's actual startup rules.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readConfigFile, ConfigInvalid } from "../../src/config-load.ts";
import { buildEngineConfig, checkEngineConfigLicences } from "../../src/engine-config.ts";
import { memoryModel, NC_MODELS } from "../../src/licences/memory.ts";
import { layout } from "../../src/paths.ts";

const require = createRequire(import.meta.url);
// Invoke validation only; createEngine would construct stores/providers and is deliberately not used.
const { validatePluginConfig } = await import(pathToFileURL(require.resolve("@cyb3rb1ade/plur1bus-memory/lib/setup/config-contract.js")).href);
export const ENGINE_CONFIG_VECTOR_FILE = new URL("../../../../tests/engine-parity/config/startup.json", import.meta.url);
const HOME = "${HOME}";
type Input = Record<string, any>;
interface Receipt { who?: unknown; at?: unknown; licence?: unknown; model?: unknown; revision?: unknown; source?: unknown }
interface VectorInput { name: string; config?: Input; rawConfig?: string; configDirectory?: boolean; ledger?: { kind: "rows" | "corrupt" | "missing-table" | "unrelated-table" | "directory"; rows?: Receipt[] } }
type Outcome = { ok: true; config: unknown; graceMs: number } | { ok: false; code: string; reason: string | null };
const ACK = (provider: string, endpoint?: string): Input => ({ provider, acknowledgedAt: "2026-10-18T09:00:00Z", by: "fixture-owner", ...(endpoint === undefined ? {} : { endpoint }) });
const remote = (embedding: Input = {}, ack: Input | null = ACK("openai")): Input => ({ schemaVersion: 1, engine: { embedding: { provider: "openai", model: "fixture-model", dimensions: 8, apiKeyEnv: "FIXTURE_KEY", ...embedding } }, memory: { embedding: ack === null ? {} : { privacyAck: ack } } });
const local = (local: Input): Input => ({ schemaVersion: 1, engine: { embedding: { local } } });
const ncModel = "jinaai/jina-embeddings-v3";
const conditional = (): Input => ({ ...local({ model: ncModel }), embedding: { useClass: "research", acceptedNcLicence: true } });
const receipt = (patch: Receipt = {}): Receipt => ({ who: "fixture-owner", at: "2026-10-18T09:00:00Z", source: "memory", ...memoryModel(ncModel), ...patch });

export function engineConfigVectorInputs(): VectorInput[] {
  const inputs: VectorInput[] = [
    { name: "missing-config" }, { name: "default-config", config: { schemaVersion: 1 } },
    { name: "integer-float-grace", rawConfig: '{"schemaVersion":1,"supervisor":{"graceMs":17000.0}}' },
    { name: "host-owned-paths-and-budgets", config: { schemaVersion: 1, core: { recall: { softBudgetMs: 123, hardBudgetMs: 456, capChars: 1789 } }, supervisor: { graceMs: 17000 }, engine: { implementation: "rust", baseDbPath: "/ignored", baseDbPathOverride: "  ", autoRecall: true, autoCapture: true, media: { enabled: true }, recall: { softBudgetMs: 999, globalInjectMaxChars: 999, fullTextMaxChars: 2000, decisionTrace: { enabled: false } } } } },
    { name: "absolute-database-override", config: { schemaVersion: 1, engine: { baseDbPathOverride: `${HOME}/explicit-db` } } },
    { name: "local-cache-override", config: local({ cacheDir: `${HOME}/explicit-models` }) },
    { name: "selected-local-model-does-not-inherit-e5-width", config: local({ model: "google/embeddinggemma-2" }) },
    { name: "disabled-reranker-still-host-enabled", config: { schemaVersion: 1, engine: { reranker: { enabled: false } } } },
    { name: "non-object-engine-sections", config: { schemaVersion: 1, engine: { embedding: "ignored", reranker: [], recall: { decisionTrace: "ignored" } } } },
    { name: "config-path-is-directory", configDirectory: true },
    { name: "invalid-json", rawConfig: "{private-fixture-invalid" },
    { name: "invalid-harness-budget", config: { schemaVersion: 1, core: { recall: { softBudgetMs: 700, hardBudgetMs: 600 } } } },
    { name: "invalid-engine-option", config: { schemaVersion: 1, engine: { recall: { unknownFixtureKey: true } } } },
    { name: "memory-embedding-is-privacy-metadata", config: { schemaVersion: 1, memory: { embedding: { provider: "remote" } } } },
    { name: "prototype-key-is-refused", rawConfig: '{"schemaVersion":1,"engine":{"__proto__":{"fixture":true}}}' },
    { name: "openai-default-endpoint", config: remote() },
    { name: "openai-secret-reference", config: remote({ apiKeyEnv: undefined, apiKeyRef: "models/fixture" }) },
    { name: "remote-local-settings-removed", config: remote({ local: { model: "ignored" } }) },
    { name: "missing-privacy-ack", config: remote({}, null) },
    { name: "wrong-provider-privacy-ack", config: remote({}, ACK("different")) },
    { name: "wrong-endpoint-privacy-ack", config: remote({}, ACK("openai", "https://other.invalid/v1")) },
    { name: "blank-actor-privacy-ack", config: remote({}, { ...ACK("openai"), by: "   " }) },
    { name: "inline-secret-refused", config: remote({ apiKey: "fixture-inline-secret" }) },
    { name: "missing-model", config: remote({ model: undefined }) },
    { name: "missing-dimensions", config: remote({ dimensions: undefined }) },
    { name: "fractional-dimensions", config: remote({ dimensions: 3.5 }) },
    { name: "missing-key-reference", config: remote({ apiKeyEnv: undefined }) },
    { name: "wrong-url-spelling", config: remote({ baseURL: "https://fixture.invalid/v1" }) },
    { name: "credential-in-url", config: remote({ baseUrl: "https://fixture:fixture@example.invalid/v1" }) },
    { name: "remote-fallback-refused", config: remote({ fallback: { model: "another-space" } }) },
    { name: "null-remote-fallback", config: remote({ fallback: null }) },
    { name: "cloud-refused-by-installation", config: { ...remote(), privacy: { localOnly: true } } },
    { name: "cloud-refused-by-any-agent", config: { ...remote(), agents: { fixture: { privacy: { localOnly: true } } } } },
    { name: "agent-cannot-lift-shared-installation-policy", config: { ...remote(), privacy: { localOnly: true }, agents: { fixture: { privacy: { localOnly: false } } } } },
    { name: "engine-feature-cloud-refused", config: { schemaVersion: 1, privacy: { localOnly: true }, engine: { merging: { baseUrl: "https://llm.invalid/v1", model: "fixture" } } } },
    { name: "engine-feature-key-without-endpoint-refused", config: { schemaVersion: 1, privacy: { localOnly: true }, engine: { merging: { apiKeyEnv: "FIXTURE_KEY", model: "fixture" } } } },
    { name: "engine-feature-loopback-allowed", config: { schemaVersion: 1, privacy: { localOnly: true }, engine: { merging: { baseUrl: "http://localhost:8080/v1", model: "fixture" } } } },
    { name: "invalid-provider-id", config: remote({ provider: "private provider" }) },
    { name: "empty-ledger-with-default-model", config: { schemaVersion: 1 }, ledger: { kind: "rows" } },
    { name: "corrupt-license-ledger", config: { schemaVersion: 1 }, ledger: { kind: "corrupt" } },
    { name: "missing-license-ledger-table", config: { schemaVersion: 1 }, ledger: { kind: "missing-table" } },
    { name: "ledger-path-is-directory", config: { schemaVersion: 1 }, ledger: { kind: "directory" } },
    { name: "ledger-missing-receipt-columns-is-irrelevant-with-default-model", config: { schemaVersion: 1 }, ledger: { kind: "unrelated-table" } },
    { name: "ledger-missing-receipt-columns-does-not-grant-license", config: conditional(), ledger: { kind: "unrelated-table" } },
    { name: "conditional-model-missing-receipt", config: conditional() },
    { name: "conditional-model-exact-receipt", config: conditional(), ledger: { kind: "rows", rows: [receipt()] } },
    { name: "conditional-model-supported-preparation-width", config: { ...conditional(), engine: { embedding: { local: { model: ncModel, dimensions: 32 } } } }, ledger: { kind: "rows", rows: [receipt()] } },
    { name: "conditional-model-unlisted-preparation-width", config: { ...conditional(), engine: { embedding: { local: { model: ncModel, dimensions: 33 } } } }, ledger: { kind: "rows", rows: [receipt()] } },
    { name: "conditional-model-wrong-model", config: conditional(), ledger: { kind: "rows", rows: [receipt({ model: "fixture-other-model" })] } },
    { name: "conditional-model-wrong-license", config: conditional(), ledger: { kind: "rows", rows: [receipt({ licence: "fixture-other-license" })] } },
    { name: "conditional-model-wrong-revision", config: conditional(), ledger: { kind: "rows", rows: [receipt({ revision: "fixture-other-revision" })] } },
    { name: "conditional-model-configured-wrong-revision", config: { ...conditional(), engine: { embedding: { local: { model: ncModel, revision: "fixture-other-revision" } } } }, ledger: { kind: "rows", rows: [receipt()] } },
    { name: "receipt-time-and-actor-have-no-expiry-rule", config: conditional(), ledger: { kind: "rows", rows: [receipt({ who: "", at: "invalid-old-fixture-time", source: "voice" })] } },
    { name: "irrelevant-null-receipt", config: conditional(), ledger: { kind: "rows", rows: [receipt({ model: null, licence: null, revision: null }), receipt()] } },
    { name: "null-receipt-does-not-grant-license", config: conditional(), ledger: { kind: "rows", rows: [receipt({ revision: null })] } },
    { name: "non-string-receipt-does-not-grant-license", config: conditional(), ledger: { kind: "rows", rows: [receipt({ revision: 123 })] } },
    { name: "conditional-model-alias-refused", config: local({ model: "jinaai/jina-embeddings-v5-text-nano" }) },
    { name: "conditional-model-no-automatic-license-acceptance", config: { ...conditional(), embedding: { useClass: "general", acceptedNcLicence: false } }, ledger: { kind: "rows", rows: [receipt()] } },
    { name: "commercial-class-no-automatic-license-acceptance", config: { ...conditional(), embedding: { useClass: "commercial", acceptedNcLicence: true } }, ledger: { kind: "rows", rows: [receipt()] } },
    { name: "explicit-model-preparation-is-preserved", config: { ...conditional(), engine: { ...conditional().engine, modelPreparation: { profile: "e5-multilingual-384" } } }, ledger: { kind: "rows", rows: [receipt()] } },
  ];
  // A change to Core's conditional-model list automatically adds a Rust witness.
  for (const model of NC_MODELS) inputs.push({ name: `conditional-license-list:${model}`, config: local({ model }) });
  for (const at of ["2026-01-01T00:00:00Z", "2026-01-01T00:00:00z", "2026-01-01t00:00:00Z", "2026-01-01T00:00:00+00", "2026-01-01T00:00:00+0000", "2026-01-01T00:00:00.123456+00:00", "2026-10-18T23:59:60Z"])
    inputs.push({ name: `ack-time:${at}`, config: remote({}, { ...ACK("openai"), acknowledgedAt: at }) });
  for (const endpoint of ["http://localhost:8080/v1", "http://127.2.3.4:8080/v1", "http://[::1]:8080/v1", "http://192.168.1.20:8080/v1"]) {
    const cfg = remote({ baseUrl: endpoint }, null); cfg.privacy = { localOnly: true };
    inputs.push({ name: `local-endpoint:${endpoint}`, config: cfg });
  }
  for (const listed of ["http://192.168.1.20:8080", "http://192.168.1.20:8081"]) {
    const endpoint = "http://192.168.1.20:8080/v1";
    inputs.push({ name: `listed-origin:${listed}`, config: { ...remote({ baseUrl: endpoint }, ACK("openai", endpoint)), privacy: { localOnly: true, localEndpoints: [listed] } } });
  }
  for (const provider of ["openrouter", "cohere", "jina", "gemini", "tei"]) {
    const endpoint = "https://embedding.fixture.invalid/v1";
    inputs.push({ name: `embedding-provider:${provider}`, config: remote({ provider, baseUrl: endpoint }, ACK(provider, endpoint)) });
  }
  for (const provider of ["cohere", "jina", "voyage", "remote", "unsupported"]) {
    const endpoint = "https://rerank.fixture.invalid/v1";
    inputs.push({ name: `reranker-provider:${provider}`, config: { schemaVersion: 1, engine: { reranker: { provider, baseUrl: endpoint, protocol: "tei", model: "fixture", apiKeyRef: "models/fixture" } }, memory: { reranker: { privacyAck: ACK(provider, endpoint) } } } });
  }
  for (const provider of ["jina", "voyage"]) inputs.push({ name: `reranker-default-${provider}`, config: { schemaVersion: 1, engine: { reranker: { provider, apiKeyEnv: "FIXTURE_KEY" } }, memory: { reranker: { privacyAck: ACK(provider) } } } });
  inputs.push({ name: "reranker-preset-ack-binds-provider-alone", config: { schemaVersion: 1, engine: { reranker: { provider: "cohere", apiKeyEnv: "FIXTURE_KEY" } }, memory: { reranker: { privacyAck: ACK("cohere", "https://api.cohere.com/v2/rerank") } } } });
  inputs.push({ name: "reranker-default-cohere", config: { schemaVersion: 1, engine: { reranker: { provider: "cohere", apiKeyEnv: "FIXTURE_KEY" } }, memory: { reranker: { privacyAck: ACK("cohere") } } } },
    { name: "reranker-needs-own-ack", config: { ...remote(), engine: { ...remote().engine, reranker: { provider: "cohere", apiKeyEnv: "FIXTURE_KEY" } } } },
    { name: "keyless-local-reranker", config: { schemaVersion: 1, privacy: { localOnly: true }, engine: { reranker: { provider: "remote", baseUrl: "http://localhost:8080", protocol: "tei" } } } },
    { name: "reranker-cloud-local-only", config: { schemaVersion: 1, privacy: { localOnly: true }, engine: { reranker: { provider: "cohere", apiKeyEnv: "FIXTURE_KEY" } }, memory: { reranker: { privacyAck: ACK("cohere") } } } });
  // Serialize once: fixtures and both runners see JSON inputs, never undefined or typed-array JS objects.
  return JSON.parse(JSON.stringify(inputs)) as VectorInput[];
}

function substitute(value: unknown, home: string): any {
  if (typeof value === "string") return value.replaceAll(HOME, home);
  if (Array.isArray(value)) return value.map(v => substitute(v, home));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, substitute(v, home)]));
  return value;
}
function normalizePaths(value: unknown, home: string): unknown {
  if (typeof value === "string" && value.startsWith(home)) return HOME + value.slice(home.length).replaceAll("\\", "/");
  if (Array.isArray(value)) return value.map(v => normalizePaths(v, home));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, normalizePaths(v, home)]));
  return value;
}
function snapshot(root: string): string {
  const walk = (path: string): unknown => !existsSync(path) ? null : Object.fromEntries(readdirSync(path, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).map(entry => [entry.name, entry.isDirectory() ? walk(join(path, entry.name)) : createHash("sha256").update(readFileSync(join(path, entry.name))).digest("hex")]));
  return JSON.stringify(walk(root));
}
function errorOutcome(error: unknown, stage: string): Outcome {
  const e = error as { error?: string; reason?: string; errors?: string[] };
  if (error instanceof ConfigInvalid) {
    const policy = e.errors?.map(text => /^(local-only(?:-shared-engine)?):/.exec(text)?.[1]).find(Boolean);
    return policy ? { ok: false, code: "E_DENIED", reason: policy } : { ok: false, code: "E_CONFIG_INVALID", reason: null };
  }
  if (e.error) return { ok: false, code: e.error, reason: e.reason ?? null };
  return { ok: false, code: "E_CONFIG_INVALID", reason: stage === "licences" ? "licence-ledger" : null };
}
export function evaluateEngineConfigVector(input: VectorInput): Outcome {
  const root = mkdtempSync(join(tmpdir(), "p1b-config-parity-")), home = join(root, "home");
  try {
    if (input.configDirectory) mkdirSync(join(home, "config.json"), { recursive: true });
    if (input.config !== undefined || input.rawConfig !== undefined) {
      mkdirSync(home); writeFileSync(join(home, "config.json"), input.rawConfig ?? JSON.stringify(substitute(input.config, home)));
    }
    if (input.ledger) {
      mkdirSync(join(home, "state"), { recursive: true }); const path = join(home, "state/model-licences.sqlite");
      if (input.ledger.kind === "directory") mkdirSync(path);
      else if (input.ledger.kind === "corrupt") writeFileSync(path, "fixture-corrupt-ledger");
      else {
        const db = new DatabaseSync(path);
        try {
          if (input.ledger.kind === "unrelated-table") db.exec("CREATE TABLE model_licences(unrelated)");
          if (input.ledger.kind === "rows") {
            db.exec("CREATE TABLE model_licences(who, at, licence, model, revision, source)");
            for (const row of input.ledger.rows ?? []) db.prepare("INSERT INTO model_licences VALUES(?,?,?,?,?,?)").run(...["who","at","licence","model","revision","source"].map(key => (row as Input)[key] ?? null));
          }
        } finally { db.close(); }
      }
    }
    const before = snapshot(root); let stage = "harness"; let result: Outcome;
    try {
      const cfg = readConfigFile(join(home, "config.json")); stage = "projection";
      const projected = buildEngineConfig(cfg, layout(home)); stage = "licences";
      checkEngineConfigLicences(projected, layout(home)); stage = "engine";
      result = { ok: true, config: normalizePaths(validatePluginConfig(projected), home), graceMs: cfg.supervisor.graceMs };
    } catch (error) { result = errorOutcome(error, stage); }
    assert.equal(snapshot(root), before, `${input.name}: Core's read-only configuration path wrote files`);
    return result;
  } finally { rmSync(root, { recursive: true, force: true }); }
}
export function renderEngineConfigVectors(): string {
  const cases = engineConfigVectorInputs().map(input => ({ ...input, expected: evaluateEngineConfigVector(input) }));
  assert.equal(new Set(cases.map(c => c.name)).size, cases.length);
  return JSON.stringify({ version: 1, source: "packages/core/src/engine-config.ts", cases }, null, 2) + "\n";
}
export function checkEngineConfigVectors(path = ENGINE_CONFIG_VECTOR_FILE): void {
  assert.equal(readFileSync(path, "utf8"), renderEngineConfigVectors(), "startup config vectors stale: run pnpm --filter @plur1bus/core gen");
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.includes("--check")) checkEngineConfigVectors();
  else { mkdirSync(dirname(fileURLToPath(ENGINE_CONFIG_VECTOR_FILE)), { recursive: true }); writeFileSync(ENGINE_CONFIG_VECTOR_FILE, renderEngineConfigVectors()); }
}
