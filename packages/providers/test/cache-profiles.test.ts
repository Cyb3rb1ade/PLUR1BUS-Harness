import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CACHE_PROFILE_TABLE, cacheRouteForUrl, checkAgainstSchema, findCacheProfile, loadCacheProfileTable, normalizeModelRef } from "../src/cache-profiles.ts";

const raw = (): Record<string, unknown> => JSON.parse(readFileSync(new URL("../schema/cache-profiles.json", import.meta.url), "utf8")) as Record<string, unknown>;
const rowsOf = (t: Record<string, unknown>) => t.rows as Record<string, unknown>[];

describe("cache profile table (schema/cache-profiles.json)", () => {
  it("loads, and every row carries a source, a verification date and a status", () => {
    assert.ok(CACHE_PROFILE_TABLE.rows.length > 30);
    for (const r of CACHE_PROFILE_TABLE.rows) {
      assert.ok(r.source.length > 0, r.id);
      assert.match(r.verified, /^\d{4}-\d{2}-\d{2}$/, r.id);
      assert.ok(["verified", "unverified", "conflict"].includes(r.status), r.id);
    }
  });

  it("refuses a table that breaks the schema or the rules the schema cannot express", () => {
    const missing = raw(); delete (rowsOf(missing)[0] as Record<string, unknown>).source;
    assert.throws(() => loadCacheProfileTable(missing), /missing source/);
    const extra = raw(); (rowsOf(extra)[0] as Record<string, unknown>).cost = 1;
    assert.throws(() => loadCacheProfileTable(extra), /unknown key cost/);
    const ttl = raw(); ((rowsOf(ttl)[0] as { ttls: Record<string, unknown>[] }).ttls[0]!).ttl = "2h";
    assert.throws(() => loadCacheProfileTable(ttl), /"2h" is not one of/);
    const dup = raw(); rowsOf(dup).push({ ...rowsOf(dup)[0]! });
    assert.throws(() => loadCacheProfileTable(dup), /duplicate row id/);
    const bad = raw(); (rowsOf(bad)[0] as Record<string, unknown>).match = "(";
    assert.throws(() => loadCacheProfileTable(bad), /invalid match pattern/);
    const implicit = raw(); (rowsOf(implicit)[0] as Record<string, unknown>).mechanism = "implicit";
    assert.throws(() => loadCacheProfileTable(implicit), /only explicit rows have breakpoints/);
  });

  it("the schema checker covers types, enums, required keys and $ref", () => {
    const schema = { $defs: { n: { type: "integer", minimum: 1 } }, type: "object", additionalProperties: false, required: ["a"], properties: { a: { $ref: "#/$defs/n" }, b: { enum: ["x"] } } };
    assert.equal(checkAgainstSchema({ a: 2, b: "x" }, schema, schema), undefined);
    assert.match(checkAgainstSchema({ a: 0 }, schema, schema)!, /\$\.a: below 1/);
    assert.match(checkAgainstSchema({ a: 1.5 }, schema, schema)!, /expected integer/);
    assert.match(checkAgainstSchema({ b: "x" }, schema, schema)!, /missing a/);
    assert.match(checkAgainstSchema({ a: 1, b: "y" }, schema, schema)!, /not one of/);
  });
});

describe("normalizeModelRef", () => {
  it("strips OpenRouter slugs and their variant suffixes, and records the gateway", () => {
    assert.deepEqual(normalizeModelRef("Anthropic/Claude-Opus-4.5"), { id: "claude-opus-4-5", gateway: "openrouter" });
    assert.deepEqual(normalizeModelRef("~anthropic/claude-sonnet-5.5"), { id: "claude-sonnet-5-5", gateway: "openrouter" });
    assert.deepEqual(normalizeModelRef("x-ai/grok-4.7"), { id: "grok-4-7", gateway: "openrouter" });
    assert.deepEqual(normalizeModelRef("moonshotai/kimi-k3"), { id: "kimi-k3", gateway: "openrouter" });
    assert.deepEqual(normalizeModelRef("deepseek/deepseek-chat:free"), { id: "deepseek-chat", gateway: "openrouter" });
    assert.deepEqual(normalizeModelRef("some-vendor/mystery-1"), { id: "some-vendor/mystery-1" }, "an unknown prefix is kept");
  });
  it("recognises Bedrock and Google model ids as platforms", () => {
    assert.deepEqual(normalizeModelRef("us.anthropic.claude-opus-4-7-v1:0"), { id: "claude-opus-4-7", platform: "bedrock" });
    assert.deepEqual(normalizeModelRef("global.anthropic.claude-sonnet-4-5-20250929-v1:0"), { id: "claude-sonnet-4-5-20250929", platform: "bedrock" });
    assert.deepEqual(normalizeModelRef("anthropic.claude-haiku-4-5"), { id: "claude-haiku-4-5", platform: "bedrock" });
    assert.deepEqual(normalizeModelRef("claude-opus-4-1@20250805"), { id: "claude-opus-4-1", platform: "google-managed" });
  });
  it("applies the table's served-model aliases", () => {
    assert.equal(normalizeModelRef("gemini-3.5-flash").id, "gemini-3-6-flash");
    assert.equal(normalizeModelRef("gemini-3.7-flash").id, "gemini-3-8-flash");
    assert.equal(normalizeModelRef("gemini-3-pro-preview").id, "gemini-3-1-pro-preview");
    assert.equal(normalizeModelRef("gemini-3.6-flash").id, "gemini-3-6-flash");
  });
});

describe("findCacheProfile", () => {
  const rowId = (model: string, route?: Parameters<typeof findCacheProfile>[1]) => findCacheProfile(model, route).row?.id;
  it("resolves every provider class to its row", () => {
    assert.equal(rowId("claude-sonnet-5-5"), "anthropic.sonnet-5-5");
    assert.equal(rowId("gpt-6.1-sol"), "openai.gpt-6");
    assert.equal(rowId("gpt-5.7-mini"), "openai.gpt-5-6-plus");
    assert.equal(rowId("gpt-4.1"), "openai.implicit");
    assert.equal(rowId("grok-4.7"), "xai.grok");
    assert.equal(rowId("kimi-k3.1-pro-highspeed"), "moonshot.kimi-k3");
    assert.equal(rowId("kimi-k2-instruct"), "moonshot.kimi-k2");
    assert.equal(rowId("deepseek-v4.1-flash"), "deepseek.all");
    assert.equal(rowId("qwen3.8-max"), "alibaba.qwen");
    assert.equal(rowId("glm-5.3"), "zai.glm");
    assert.equal(rowId("mistral-large-4"), "mistral.all");
    assert.equal(rowId("mystery-model"), undefined);
  });
  it("a platform row wins on its platform only (Opus 4.7: 4,096 on Bedrock, 2,048 first-party)", () => {
    const bedrock = findCacheProfile("us.anthropic.claude-opus-4-7-v1:0");
    assert.deepEqual([bedrock.platform, bedrock.row?.id, bedrock.row?.minTokens], ["bedrock", "anthropic.bedrock.opus-4-7", 4096]);
    assert.equal(findCacheProfile("claude-opus-4-7").row?.minTokens, 2048);
    assert.equal(findCacheProfile("claude-opus-4-7", { platform: "google-managed" }).row?.minTokens, 2048);
  });
  it("Vertex floors differ from the Developer API's", () => {
    assert.equal(findCacheProfile("gemini-3.8-flash", { platform: "vertex" }).row?.minTokens, 6144);
    assert.equal(findCacheProfile("gemini-3.8-flash").row?.minTokens, 4096);
    assert.equal(findCacheProfile("gemini-2.5-pro", { platform: "vertex" }).row?.minTokens, 2048);
  });
  it("a local route takes the local row whatever the model id", () => {
    assert.equal(rowId("qwen3:8b", { local: true }), "local.kv-prefix");
    assert.equal(rowId("claude-opus-5", { local: true }), "local.kv-prefix");
  });
  it("the route's gateway wins over the slug's", () => {
    assert.equal(findCacheProfile("anthropic/claude-opus-5").gateway, "openrouter");
    assert.equal(findCacheProfile("claude-opus-5", { gateway: "openrouter" }).gateway, "openrouter");
    assert.equal(findCacheProfile("claude-opus-5").gateway, "direct");
  });
  it("OpenAI 12h is offered on the Responses wire only and its row is marked as conflicting", () => {
    const row = findCacheProfile("gpt-5.6").row!;
    assert.deepEqual(row.ttls.map((t) => [t.ttl, t.wires ?? "any"]), [["30m", "any"], ["12h", ["codex_responses"]]]);
    assert.equal(row.status, "conflict");
  });
});

describe("cacheRouteForUrl", () => {
  it("maps a base URL host to a gateway, a platform or a provider's own API", () => {
    assert.deepEqual(cacheRouteForUrl("https://openrouter.ai/api/v1"), { gateway: "openrouter" });
    assert.deepEqual(cacheRouteForUrl("https://api.openai.com/v1"), { vendor: "openai" });
    assert.deepEqual(cacheRouteForUrl("https://chatgpt.com/backend-api/codex"), { platform: "chatgpt-plan", vendor: "openai" });
    assert.deepEqual(cacheRouteForUrl("https://api.anthropic.com/v1"), { vendor: "anthropic" });
    assert.deepEqual(cacheRouteForUrl("https://bedrock-runtime.us-east-1.amazonaws.com"), { platform: "bedrock" });
    assert.deepEqual(cacheRouteForUrl("https://europe-west4-aiplatform.googleapis.com/v1"), { platform: "vertex" });
    assert.deepEqual(cacheRouteForUrl("https://api.x.ai/v1"), { vendor: "xai" });
    assert.deepEqual(cacheRouteForUrl("https://api.moonshot.ai/v1"), { vendor: "moonshot" });
    assert.deepEqual(cacheRouteForUrl("https://dashscope-intl.aliyuncs.com/compatible-mode/v1"), { vendor: "alibaba" });
    assert.deepEqual(cacheRouteForUrl("https://api.mistral.ai/v1"), { vendor: "mistral" });
  });
  it("an unknown host, a look-alike host or a bad URL is a route with nothing known", () => {
    assert.deepEqual(cacheRouteForUrl("https://llm.example.com/v1"), {});
    assert.deepEqual(cacheRouteForUrl("https://api.openai.com.evil.example/v1"), {});
    assert.deepEqual(cacheRouteForUrl("https://notopenrouter.ai/v1"), {});
    assert.deepEqual(cacheRouteForUrl("not a url"), {});
  });
  it("Claude on Vertex resolves to its Anthropic row", () => {
    assert.equal(findCacheProfile("claude-sonnet-4-5", cacheRouteForUrl("https://us-east5-aiplatform.googleapis.com")).row?.id, "anthropic.sonnet-4-5-4-6");
  });
});
