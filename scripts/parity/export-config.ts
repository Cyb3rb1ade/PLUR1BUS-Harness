// Parity vectors (mode V) for the core's configuration modules (P4-11 task 4a): `structureErrors`/`validateConfig` (verdict,
// error list and warnings) over the config-schema fixtures and the hardening cases, `configurationWarnings` over custom
// schemas, the module disclosure policy over generated `modules/` directories, `buildEngineConfig`/`engineEmbedding`/
// `checkEngineConfigLicences`-relevant outputs, and `flattenPatch` with its refusals.
// `crates/plur1bus-core/src/config/vectors.rs` replays every case. Recorded, never edited by hand.
//
// Inputs are key-sorted before the TypeScript function runs, because a `serde_json::Map` is sorted and a JavaScript object
// keeps insertion order: both sides then see the same order and the error lists agree. A configuration with an own
// `__proto__` key cannot be an object literal, so a case may carry `text` (JSON) instead of `config`.
// Engine cases store the configuration as a list of `set` edits applied to `defaults()`, not as a copy of the defaults.
// A case with a `note` differs from the TypeScript output on purpose (see scripts/parity/README.md).
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-config.ts [--check]
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configurationWarnings, defaults, type ConfigSchemaNode } from "../../packages/config-schema/src/index.ts";
import { loadConfigDisclosurePolicy } from "../../packages/core/src/config-disclosure.ts";
import { structureErrors, validateConfig } from "../../packages/core/src/config-load.ts";
import { flattenPatch } from "../../packages/core/src/config-source.ts";
import { buildEngineConfig, engineEmbedding } from "../../packages/core/src/engine-config.ts";
import { layout } from "../../packages/core/src/paths.ts";
import { exporterMain } from "./lib.mjs";

const require = createRequire(new URL("../../packages/core/package.json", import.meta.url));
const HOME = "/h/.plur1bus";
const fixtureDir = new URL("../../packages/config-schema/fixtures/", import.meta.url);
const readFixture = (name: string): any[] => JSON.parse(readFileSync(new URL(name, fixtureDir), "utf8"));
const ACK = (provider: string, endpoint?: string) => ({ provider, acknowledgedAt: "2026-10-18T09:00:00Z", by: "fixture-owner", ...(endpoint === undefined ? {} : { endpoint }) });

function sortKeys(v: any): any {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v === null || typeof v !== "object") return v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
}
const unique = (list: { name: string }[]) => {
  const seen = new Set<string>();
  for (const { name } of list) { if (seen.has(name)) throw new Error(`duplicate case name ${name}`); seen.add(name); }
  return list;
};
const errorOf = (e: any) => ({ code: e?.error ?? "E_INTERNAL", reason: e?.reason ?? null, message: String(e?.message ?? e) });

// --- validate ---------------------------------------------------------------------------------------------------------------
function validateOutcome(input: unknown): Record<string, unknown> {
  const structure = structureErrors(input);
  const r: any = validateConfig(input);
  return r.ok ? { structure, ok: true, warnings: r.warnings ?? [] } : { structure, ok: false, errors: r.errors };
}
function buildValidate() {
  const cases: any[] = [];
  for (const file of ["cross-field-cases.json", "engine-path-cases.json", "format-cases.json"]) {
    // format-cases.json is large (a full defaults copy per case): every invalid case and each eighth valid one.
    const list = readFixture(file).filter((c, i) => file !== "format-cases.json" || c.valid === false || i % 8 === 0);
    for (const c of list) {
      const config = sortKeys(c.config);
      cases.push({ name: `${file}: ${c.name}`, config, ...validateOutcome(config) });
    }
  }
  const raw = (name: string, text: string, note?: string) => cases.push({ name, text, ...validateOutcome(JSON.parse(text)), ...(note ? { note } : {}) });
  raw("proto key in engine", `{"schemaVersion":1,"engine":{"__proto__":{"polluted":1}}}`);
  raw("proto key nested in a module array", `{"schemaVersion":1,"modules":{"m":{"enabled":true,"deep":[{"__proto__":{}}]}}}`);
  raw("empty object", `{}`);
  raw("loud log level", `{"schemaVersion":1,"core":{"logLevel":"loud"}}`);
  for (const bad of [{ approvals: { maxGrantDays: 366 } }, { breakglass: { reasonMinChars: 501, reasonMaxChars: 500 } }, { breakglass: { maxWindowMinutes: 1441 } }])
    raw(`security limit ${JSON.stringify(bad)}`, JSON.stringify(sortKeys({ schemaVersion: 1, ...bad })));
  const nested = (n: number) => `{"schemaVersion":1,"engine":{"x":${"[".repeat(n)}${"]".repeat(n)}}}`;
  raw("nesting 40 levels", nested(40));
  raw("nesting 70 levels", nested(70));
  const recall = (soft: number, hard: number) => { const c: any = defaults(); c.core.recall.softBudgetMs = soft; c.core.recall.hardBudgetMs = hard; return sortKeys(c); };
  for (const [s, h] of [[601, 600], [5000, 100], [600, 600], [50, 50_000]]) { const config = recall(s, h); cases.push({ name: `recall soft ${s} hard ${h}`, config, ...validateOutcome(config) }); }
  const local = (mutate: (c: any) => void) => { const c: any = defaults(); mutate(c); return sortKeys(c); };
  const extra: [string, any][] = [
    ["local-only with a cloud embedding", local((c) => { c.privacy = { localOnly: true }; c.engine.embedding = { provider: "openai", model: "m", dimensions: 8, apiKeyEnv: "FIXTURE_KEY" }; })],
    ["media privacy ack missing", local((c) => { c.memory.mediaEmbedding = { ...c.memory.mediaEmbedding, provider: "openai", model: "fixture-media" }; })],
    ["url userinfo in a sidecar url", local((c) => { c.sidecars = { demo: { url: "https://user:pw-marker-value@host.example/path" } }; })],
    ["url userinfo in the otlp endpoint", local((c) => { c.logs.otlp = { endpoint: "https://user:pw-marker-value@collector.example/v1" }; })],
  ];
  for (const [name, config] of extra) cases.push({ name, config, ...validateOutcome(config) });
  return unique(cases);
}

// --- warnings ---------------------------------------------------------------------------------------------------------------
function buildWarnings() {
  const refSchema: ConfigSchemaNode = { type: "object", properties: { ref: { type: "string", "x-secret-reference": true }, plain: { type: "string" } } } as any;
  const urlSchema = { type: "object", properties: { url: { type: "string", "x-url-credentials": true }, token: { type: "string", "x-sensitive": true } } } as any;
  const urlOnly = { type: "object", properties: { url: { type: "string", "x-url-credentials": true } } } as any;
  const items = { type: "object", properties: { list: { type: "array", items: urlSchema } } } as any;
  const cases: any[] = [];
  const add = (name: string, schema: unknown, value: unknown) => cases.push({ name, schema, value: sortKeys(value), warnings: configurationWarnings(sortKeys(value), schema as any) });
  add("reference ok", refSchema, { ref: "good-name", plain: "x" });
  add("reference looks like a pasted key", refSchema, { ref: "sk-pasted-marker-value" });
  add("reference with a space", refSchema, { ref: "has space" });
  add("reference empty is not judged", refSchema, { ref: "" });
  add("url userinfo with a sensitive sibling", urlSchema, { url: "https://u:pw-marker-value@h.example/p", token: "t" });
  add("url userinfo without a sibling", urlOnly, { url: "https://u:pw-marker-value@h.example/p" });
  add("url without userinfo", urlSchema, { url: "https://h.example/p" });
  add("url userinfo inside an array", items, { list: [{ url: "https://a@h.example" }, { url: "https://h.example" }] });
  add("more than 50 findings are cut", items, { list: Array.from({ length: 60 }, (_, i) => ({ url: `https://u${i}:pw@h.example` })) });
  add("non-object value", refSchema, "text");
  return unique(cases);
}

// --- disclosure ---------------------------------------------------------------------------------------------------------------
async function buildDisclosure() {
  const mod = (name: string, configSchema: unknown) => ({ name, manifest: { name, version: "0.1.0", apiVersion: "1", entry: "index.js", scope: "installation", priority: 500, configSchema } });
  const scenarios: { name: string; modules: any[]; config: any }[] = [
    { name: "reference-only behind a $ref", modules: [mod("fixture", { $defs: { name: { type: "string", "x-secret-reference": true } }, properties: { ordinary: { $ref: "#/$defs/name" } } })], config: { modules: { fixture: { enabled: false, ordinary: "sk-0f0f0f0f-aaaa-bbbb-cccc-123456789abc" } } } },
    { name: "reference-only behind allOf", modules: [mod("fixture", { allOf: [{ properties: { ordinary: { type: "string", "x-secret-reference": true } } }] })], config: { modules: { fixture: { enabled: false, ordinary: "sk-0f0f0f0f-aaaa-bbbb-cccc-123456789abc" } } } },
    { name: "isolated definitions", modules: ["alpha", "beta"].map((n) => mod(n, { type: "object", $defs: { shared: { type: "string", enum: [`${n}.primary`] } }, properties: { reference: { type: "string", "x-sensitive": true, "x-secret-reference": { $ref: "#/$defs/shared" } }, region: { type: "string" } } })),
      config: { modules: { alpha: { enabled: false, reference: "alpha.primary", region: "public-config-region", unknown: "sk-unknown-value-1234" }, beta: { enabled: false, reference: "beta.primary" }, absent: { enabled: false, ordinary: "sk-missing-value-5678" } } } },
    { name: "damaged json", modules: [{ name: "fixture", raw: "{" }], config: { modules: { fixture: { enabled: false, ordinary: "plain-ordinary-value-xyz" } } } },
    { name: "manifest without the required members", modules: [{ name: "fixture", raw: JSON.stringify({ name: "fixture" }) }], config: { modules: { fixture: { enabled: false, ordinary: "plain-ordinary-value-xyz" } } } },
    { name: "name differs from the directory", modules: [{ name: "fixture", raw: JSON.stringify(mod("other", { type: "object" }).manifest) }], config: { modules: { fixture: { enabled: false, ordinary: "plain-ordinary-value-xyz" } } } },
    { name: "typed public member", modules: [mod("fixture", { type: "object", properties: { ordinary: { type: "string" } } })], config: { modules: { fixture: { enabled: false, ordinary: "plain-ordinary-value-xyz" } } } },
    { name: "module without a schema", modules: [{ name: "fixture", manifest: { name: "fixture", version: "0.1.0", apiVersion: "1", entry: "index.js", scope: "installation", priority: 500 } }], config: { modules: { fixture: { enabled: true, ordinary: "plain-ordinary-value-xyz" } } } },
    { name: "url userinfo warning prefixed with the module", modules: [mod("fixture", { type: "object", properties: { url: { type: "string", "x-url-credentials": true } } })], config: { modules: { fixture: { enabled: true, url: "https://u:pw-marker-value@h.example/p" } } } },
    { name: "no modules directory", modules: [], config: { modules: { fixture: { enabled: true, token: "literal-value-123456" } } } },
    { name: "no modules configured", modules: [mod("fixture", { type: "object" })], config: {} },
  ];
  const cases: any[] = [];
  for (const s of scenarios) {
    const home = mkdtempSync(join(tmpdir(), "p1b-parity-config-"));
    try {
      for (const m of s.modules) {
        const dir = join(home, "modules", m.name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "module.json"), m.raw ?? JSON.stringify(m.manifest));
      }
      const config = sortKeys(s.config);
      const policy = await loadConfigDisclosurePolicy(home);
      cases.push({ name: s.name, modules: s.modules.map((m) => ({ name: m.name, text: m.raw ?? JSON.stringify(sortKeys(m.manifest)) })), config,
        values: [...policy.values(config)].sort(), warnings: policy.warnings(config) });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  return unique(cases);
}

// --- engine -------------------------------------------------------------------------------------------------------------------
const installedSchema = JSON.parse(readFileSync(pathToFileURL(require.resolve("@cyb3rb1ade/plur1bus-memory/engine/config/engine-config.schema.json")), "utf8"));
const isObject = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);
const schemaProjection = (full: any) => ({ properties: { ...(isObject(full?.properties?.media) ? { media: {} } : {}), neo: { properties: Object.fromEntries(Object.keys(full?.properties?.neo?.properties ?? {}).sort().map((k) => [k, {}])) } } });
const withNative = { properties: { neo: { properties: { maxRecords: {}, appendDedupeTailRecords: {}, retention: {} } }, media: {} } };

type Edit = [string[], unknown];
function applyEdits(edits: Edit[]): any {
  const c: any = defaults();
  for (const [path, value] of edits) { let at = c; for (const p of path.slice(0, -1)) at = at[p] ??= {}; at[path[path.length - 1]!] = value; }
  return c;
}
function buildEngine() {
  const l = layout(HOME);
  const projection = schemaProjection(installedSchema);
  const cases: any[] = [];
  const add = (name: string, edits: Edit[], schema: unknown = projection) => {
    const entry: any = { name, set: edits, schema };
    try {
      const cfg = applyEdits(edits);
      const built: any = buildEngineConfig(cfg, l, schema);
      entry.ok = true; entry.config = sortKeys(built); entry.embedding = sortKeys(engineEmbedding(cfg, l));
      // Facts the engine's catalogue contributes: the Rust side cannot import the pinned engine.
      entry.catalog = built.modelPreparation ? { model: built.embedding.local.model, dimensions: built.embedding.local.dimensions ?? null, nonCommercial: true, target: built.modelPreparation.profile } : null;
    } catch (e) { entry.ok = false; entry.error = errorOf(e); }
    cases.push(entry);
  };
  add("defaults", []);
  add("engine key passes through", [[["engine", "recallMinScore"], 0.42]]);
  add("forced keys cannot be overridden", [[["engine", "baseDbPath"], "/elsewhere"], [["engine", "autoCapture"], true], [["engine", "reranker"], { enabled: false }]]);
  add("baseDbPathOverride wins", [[["engine", "baseDbPathOverride"], "/tmp/db"]]);
  for (const blank of ["", "   ", " \n"]) add(`blank baseDbPathOverride ${JSON.stringify(blank)}`, [[["engine", "baseDbPathOverride"], blank]]);
  add("non-object sections", [[["engine", "embedding"], "abc"], [["engine", "reranker"], ["x"]], [["engine", "recall"], 7]]);
  add("chosen local model without dimensions", [[["engine", "embedding"], { local: { model: "Xenova/some-model" } }]]);
  add("local model with its own cacheDir", [[["engine", "embedding"], { local: { cacheDir: "/c" } }], [["engine", "reranker"], { local: { cacheDir: "/r" } }]]);
  for (const [n, schema] of [["installed projection", projection], ["declares the native keys and media", withNative], ["declares nothing", { properties: {} }]] as const)
    add(`neo native keys, schema ${n}`, [[["engine", "neo"], { maxRecords: 5, appendDedupeTailRecords: 2, retention: { days: 3 }, typo: 1 }]], schema);
  add("without engine.neo", [[["engine", "neo"], undefined]], { properties: {} });
  add("media only when declared", [], withNative);
  add("media enabled, local gemma", [[["memory", "mediaEmbedding", "enabled"], true]], withNative);
  const openai = { provider: "openai", model: "text-embedding-3-small", dimensions: 1536, apiKeyEnv: "OPENAI_API_KEY" };
  add("openai embedding", [[["engine", "embedding"], openai], [["memory", "embedding"], { privacyAck: ACK("openai") }]]);
  add("openai embedding without acknowledgment", [[["engine", "embedding"], openai]]);
  add("openai embedding with another provider's acknowledgment", [[["engine", "embedding"], openai], [["memory", "embedding"], { privacyAck: ACK("cohere") }]]);
  const router = { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "qwen/qwen3-embedding-8b", dimensions: 4096, apiKeyEnv: "OPENROUTER_API_KEY" };
  add("openrouter embedding", [[["engine", "embedding"], router], [["memory", "embedding"], { privacyAck: ACK("openrouter", router.baseUrl) }]]);
  add("embedding with a plaintext apiKey", [[["engine", "embedding"], { ...openai, apiKey: "plain-marker" }], [["memory", "embedding"], { privacyAck: ACK("openai") }]]);
  add("embedding fallback is refused", [[["engine", "embedding"], { ...openai, fallback: { provider: "local-transformers" } }], [["memory", "embedding"], { privacyAck: ACK("openai") }]]);
  add("embedding endpoint with credentials", [[["engine", "embedding"], { ...router, baseUrl: "https://u:p@openrouter.ai/api/v1" }], [["memory", "embedding"], { privacyAck: ACK("openrouter", "https://u:p@openrouter.ai/api/v1") }]]);
  add("loopback ollama needs no acknowledgment", [[["engine", "embedding"], { provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "nomic", dimensions: 768 }]]);
  add("cohere reranker", [[["engine", "reranker"], { provider: "cohere", model: "rerank-v3.5", apiKeyEnv: "COHERE_API_KEY", enabled: false }], [["memory", "reranker"], { privacyAck: ACK("cohere") }]]);
  add("cohere reranker without acknowledgment", [[["engine", "reranker"], { provider: "cohere", apiKeyEnv: "K" }]]);
  add("reranker provider without adapter", [[["engine", "reranker"], { provider: "mystery", apiKeyEnv: "K" }]]);
  add("local-only refuses a cloud embedding", [[["privacy", "localOnly"], true], [["engine", "embedding"], openai], [["memory", "embedding"], { privacyAck: ACK("openai") }]]);
  add("local-only keeps loopback", [[["privacy", "localOnly"], true], [["engine", "embedding"], { provider: "ollama", baseUrl: "http://localhost:11434", model: "nomic", dimensions: 768 }]]);
  add("local-only LAN server unless listed", [[["privacy", "localOnly"], true], [["engine", "embedding"], { provider: "ollama", baseUrl: "http://192.168.1.5:11434", model: "nomic", dimensions: 768 }], [["memory", "embedding"], { privacyAck: ACK("ollama", "http://192.168.1.5:11434") }]]);
  add("local-only LAN server listed", [[["privacy", "localOnly"], true], [["privacy", "localEndpoints"], ["http://192.168.1.5:11434"]], [["engine", "embedding"], { provider: "ollama", baseUrl: "http://192.168.1.5:11434", model: "nomic", dimensions: 768 }]]);
  add("local-only refuses an engine llm feature with a cloud transport", [[["privacy", "localOnly"], true], [["engine", "llm"], { provider: "openai", baseUrl: "https://api.example.com/v1" }]]);
  const nc = "jinaai/jina-embeddings-v3";
  add("non-commercial model accepted by the owner", [[["engine", "embedding"], { local: { model: nc } }], [["embedding"], { useClass: "research", acceptedNcLicence: true }]]);
  add("non-commercial model, commercial use class", [[["engine", "embedding"], { local: { model: nc } }], [["embedding"], { useClass: "commercial", acceptedNcLicence: true }]]);
  add("non-commercial model without the acceptance", [[["engine", "embedding"], { local: { model: nc } }]]);
  add("explicit modelPreparation stays", [[["engine", "embedding"], { local: { model: nc } }], [["embedding"], { useClass: "research", acceptedNcLicence: true }], [["engine", "modelPreparation"], { profile: "mine" }]]);
  return unique(cases);
}

// --- patch --------------------------------------------------------------------------------------------------------------------
function nest(depth: number): Record<string, unknown> { let v: unknown = 1; for (let i = 0; i < depth; i++) v = { a: v }; return v as Record<string, unknown>; }
function buildPatch() {
  const cases: any[] = [];
  const add = (name: string, prefix: string, patch: unknown, spec?: unknown) => {
    const input = spec === undefined ? sortKeys(patch) : patch;
    const real = spec === undefined ? sortKeys(patch) : nest((spec as any).nest);
    try { cases.push({ name, prefix, ...(spec === undefined ? { patch: input } : { nest: (spec as any).nest }), ok: true, changes: flattenPatch(prefix, real as any).map(({ key, value }) => ({ key, value })) }); }
    catch (e) { cases.push({ name, prefix, ...(spec === undefined ? { patch: input } : { nest: (spec as any).nest }), ok: false, error: String((e as Error).message) }); }
  };
  add("leaf keys", "engine", { recall: { x: 1 }, tags: ["a"] });
  add("scalars and null", "core", { a: null, b: true, c: "s", d: 1.5 });
  add("empty object yields nothing", "core", {});
  add("empty nested object yields nothing", "core", { a: {} });
  add("dotted key refused", "engine", { "a.b": 1 });
  add("empty key refused", "engine", { "": 1 });
  add("long key is cut in the message", "engine", { ["k.".repeat(40)]: 1 });
  add("nesting 31 levels", "p", {}, { nest: 31 });
  add("nesting 32 levels", "p", {}, { nest: 32 });
  add("nesting 33 levels", "p", {}, { nest: 33 });
  add("nesting 500 levels", "p", {}, { nest: 500 });
  return unique(cases);
}

export async function buildConfigVectors(): Promise<Record<string, unknown>> {
  return { validate: buildValidate(), warnings: buildWarnings(), disclosure: await buildDisclosure(), engine: buildEngine(), patch: buildPatch() };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await exporterMain({ area: "config", build: buildConfigVectors }));
}
