// Reasoning control in the model catalog: provider-API hints from the scan, the curated table as fallback, unknown as
// "none", and the fit to the profile's wire. Fixtures only; the fake endpoints are loopback stubs, never a provider.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createPinnedClient } from "../../src/discovery/http.ts";
import { SCANNERS } from "../../src/discovery/scanners/index.ts";
import { loadReasoningTable, resolveReasoning, fitToWire } from "../../src/discovery/reasoning.ts";
import { reconcile } from "../../src/discovery/reconcile.ts";
import { loadMetadataTable } from "../../src/discovery/metadata.ts";
import { validateCatalog } from "../../src/discovery/catalog-store.ts";
import { emptyCatalog } from "../../src/discovery/types.ts";
import { startFakeEndpoint } from "../helpers/fake-endpoint.ts";
import type { FakeEndpoint, FakeReply, FakeRequest } from "../helpers/fake-endpoint.ts";

const opened: FakeEndpoint[] = [];
async function fake(h: (r: FakeRequest) => FakeReply): Promise<FakeEndpoint> { const f = await startFakeEndpoint(h); opened.push(f); return f; }
after(async () => { await Promise.all(opened.map((f) => f.close())); });
const table = loadReasoningTable();

describe("scan hints", () => {
  it("OpenRouter: supported_parameters with and without reasoning", async () => {
    const f = await fake(() => ({ json: { data: [
      { id: "vendor-a/thinker", supported_parameters: ["tools", "reasoning", "include_reasoning"] },
      { id: "vendor-b/plain", supported_parameters: ["tools"] },
      { id: "vendor-c/silent" },
    ] } }));
    const res = await SCANNERS["openai-models"]({ id: "or", discovery: "openai-models", baseUrl: `${f.origin}/v1` }, createPinnedClient({ baseUrl: `${f.origin}/v1`, lease: null, userAgent: "t" }));
    assert.deepEqual(res.entries.map((e) => e.reasoning), [{ supported: true, style: "openrouter" }, { supported: false, style: "openrouter" }, undefined]);
  });

  it("Gemini: model metadata `thinking`; a malformed hint is silence, not a failed scan", async () => {
    const f = await fake(() => ({ json: { models: [
      { name: "models/gemini-2.5-flash", thinking: true, supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-2.0-flash", thinking: false },
      { name: "models/gemini-odd", thinking: "yes" },
    ] } }));
    const res = await SCANNERS["google-models"]({ id: "g", discovery: "google-models", baseUrl: `${f.origin}/v1beta` }, createPinnedClient({ baseUrl: `${f.origin}/v1beta`, lease: null, userAgent: "t" }));
    assert.deepEqual(res.entries.map((e) => e.reasoning), [{ supported: true, style: "gemini" }, { supported: false, style: "gemini" }, undefined]);
  });

  it("Ollama: capabilities list with `thinking`", async () => {
    const f = await fake(() => ({ json: { models: [
      { name: "qwen3:8b", capabilities: ["completion", "tools", "thinking"] },
      { name: "llama3.2:3b", capabilities: ["completion"] },
      { name: "old:latest" },
    ] } }));
    const res = await SCANNERS["ollama-tags"]({ id: "o", discovery: "ollama-tags", baseUrl: f.origin }, createPinnedClient({ baseUrl: f.origin, lease: null, userAgent: "t" }));
    assert.deepEqual(res.entries.map((e) => e.reasoning), [{ supported: true, style: "ollama" }, { supported: false, style: "ollama" }, undefined]);
  });

  it("reconcile stores the hint in api; the catalog validator accepts it and refuses a malformed one", () => {
    const r = reconcile({ catalog: emptyCatalog("t"), provider: "or", raw: [{ id: "vendor-a/thinker", reasoning: { supported: true, style: "openrouter" } }], now: "2026-10-18T00:00:00.000Z", table: loadMetadataTable(), roles: {} });
    assert.deepEqual(r.catalog.models[0]!.api?.reasoning, { supported: true, style: "openrouter" });
    assert.equal(validateCatalog(r.catalog).ok, true);
    const broken = structuredClone(r.catalog) as unknown as { models: { api: { reasoning: unknown } }[] };
    broken.models[0]!.api.reasoning = { supported: "yes", style: "openrouter" };
    assert.equal(validateCatalog(broken).ok, false);
  });
});

describe("resolution per provider", () => {
  it("OpenAI (table): o-series effort, gpt-5 adds minimal, gpt-5.1 starts at off=none, gpt-5.2 adds xhigh", () => {
    assert.deepEqual(resolveReasoning({ vendor: "openai", id: "o3-mini" }, table), { kind: "effort", levels: ["low", "medium", "high"], default: "medium", vendorParam: "reasoning_effort", source: "table" });
    assert.deepEqual(resolveReasoning({ vendor: "openai", id: "gpt-5" }, table).levels, ["minimal", "low", "medium", "high"]);
    const g51 = resolveReasoning({ vendor: "openai", id: "gpt-5.1" }, table);
    assert.deepEqual([g51.levels, g51.values], [["off", "low", "medium", "high"], { off: "none" }]);
    assert.deepEqual(resolveReasoning({ vendor: "openai", id: "gpt-5.2" }, table).levels, ["off", "low", "medium", "high", "xhigh"]);
    assert.equal(resolveReasoning({ vendor: "openai", id: "gpt-4.1" }, table).kind, "none");
  });

  it("Anthropic (table): extended thinking as a token budget; other Claude models take no setting", () => {
    const d = resolveReasoning({ vendor: "anthropic", id: "claude-sonnet-4-5-20250929" }, table);
    assert.deepEqual([d.kind, d.vendorParam, d.budget, d.levels[0]], ["budget", "thinking.budget_tokens", { min: 1024, max: 32000, default: 8192 }, "off"]);
    assert.equal(resolveReasoning({ vendor: "anthropic", id: "claude-3-7-sonnet-20250219" }, table).kind, "budget");
    assert.deepEqual(resolveReasoning({ vendor: "anthropic", id: "claude-3-5-haiku-20241022" }, table), { kind: "none", levels: [], source: "table" });
  });

  it("Gemini: the API decides whether, the table how (2.5 budget, 3 level); API without a table rule gets a safe budget", () => {
    assert.equal(resolveReasoning({ vendor: "google", id: "gemini-2.5-pro", api: { supported: true, style: "gemini" } }, table).source, "api");
    assert.equal(resolveReasoning({ vendor: "google", id: "gemini-2.5-pro", api: { supported: true, style: "gemini" } }, table).vendorParam, "thinkingConfig.thinkingBudget");
    assert.deepEqual(resolveReasoning({ vendor: "google", id: "gemini-3-pro-preview" }, table).levels, ["low", "high"]);
    assert.deepEqual(resolveReasoning({ vendor: "google", id: "gemini-9-ultra", api: { supported: true, style: "gemini" } }, table).levels, ["low", "medium", "high"]);
    assert.deepEqual(resolveReasoning({ vendor: "google", id: "gemini-2.5-flash", api: { supported: false, style: "gemini" } }, table), { kind: "none", levels: [], source: "api" });
  });

  it("OpenRouter (API): its unified reasoning.effort; xAI and Qwen/DeepSeek from the table; Ollama from capabilities", () => {
    assert.deepEqual(resolveReasoning({ vendor: "openrouter", id: "x/y", api: { supported: true, style: "openrouter" } }, table), { kind: "effort", levels: ["minimal", "low", "medium", "high"], vendorParam: "reasoning.effort", source: "api" });
    assert.deepEqual(resolveReasoning({ vendor: "xai", id: "grok-3-mini" }, table).levels, ["low", "high"]);
    assert.equal(resolveReasoning({ vendor: "xai", id: "grok-4" }, table).kind, "none");
    assert.equal(resolveReasoning({ vendor: "openai", id: "qwen3-32b" }, table).vendorParam, "chat_template_kwargs.enable_thinking");
    assert.equal(resolveReasoning({ vendor: "deepseek", id: "deepseek-reasoner" }, table).kind, "none");
    assert.deepEqual(resolveReasoning({ vendor: "ollama", id: "gpt-oss:20b" }, table).levels, ["low", "medium", "high"]);
    const q = resolveReasoning({ vendor: "ollama", id: "mystery:7b", api: { supported: true, style: "ollama" } }, table);
    assert.deepEqual([q.kind, q.values], ["toggle", { off: "none", medium: "medium" }]);
  });

  it("unknown model: none with the reasoning-unknown hint", () => {
    assert.deepEqual(resolveReasoning({ vendor: "openai", id: "my-finetune" }, table), { kind: "none", levels: [], source: "unknown", note: "reasoning-unknown" });
  });
});

describe("wire fit and table validation", () => {
  it("Responses spells effort reasoning.effort; a parameter the wire cannot write degrades to none", () => {
    const d = resolveReasoning({ vendor: "openai", id: "gpt-5" }, table);
    assert.equal(fitToWire(d, "openai-responses").vendorParam, "reasoning.effort");
    assert.equal(fitToWire(d, "openai-chat").vendorParam, "reasoning_effort");
    assert.deepEqual(fitToWire(d, "anthropic"), { kind: "none", levels: [], source: "table", note: "reasoning-wire-unsupported" });
  });

  it("the shipped table is valid; broken rules are listed, never half-loaded", () => {
    assert.match(table.revision, /^\d{4}-\d{2}-\d{2}\.\d+$/);
    assert.throws(() => loadReasoningTable({ schema: "plur1bus.reasoning-metadata/1", revision: "x", vendors: { generic: [
      { pattern: "^(a+)+$", kind: "effort", levels: ["low"], vendorParam: "reasoning_effort" },
      { pattern: "^b$", kind: "effort", levels: ["high", "low"], vendorParam: "reasoning_effort" },
      { pattern: "^c$", kind: "budget", levels: ["low"], vendorParam: "thinking.budget_tokens" },
      { pattern: "^d$", kind: "effort", levels: ["low"], vendorParam: "magic" },
    ] } }), (e: Error) => /RE2-safe/.test(e.message) && /scale order/.test(e.message) && /budget needs/.test(e.message) && /vendorParam/.test(e.message));
  });
});
