import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRequestBody, ProviderError } from "../src/index.ts";
import type { ChatRequest } from "../src/index.ts";

const T = { timeout: 10_000 };
const opts = { stream: true, maxTokensField: "max_tokens" as const, includeUsage: true };

const full: ChatRequest = {
  model: "synthetic-model-1",
  messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image_url", url: "https://example.invalid/a.png", detail: "low" }] },
    { role: "assistant", content: null, toolCalls: [{ id: "call_1", name: "get_weather", arguments: "{\"city\":\"Bern\"}" }] },
    { role: "tool", toolCallId: "call_1", content: "sunny" },
  ],
  tools: [{ name: "get_weather", description: "weather", parameters: { type: "object", properties: { city: { type: "string" } } }, strict: true }],
  toolChoice: { name: "get_weather" },
  parallelToolCalls: false,
  maxTokens: 256,
  temperature: 0.2,
  topP: 0.9,
  stop: ["END"],
  responseFormat: { type: "json_schema", name: "out", schema: { type: "object" }, strict: true },
};

test("body maps every field to its wire spelling, in a fixed key order", T, () => {
  const body = buildRequestBody(full, opts);
  assert.deepEqual(Object.keys(body), [
    "model", "messages", "tools", "tool_choice", "parallel_tool_calls", "max_tokens", "temperature", "top_p", "stop", "response_format", "stream", "stream_options",
  ]);
  assert.deepEqual(body["messages"], [
    { role: "system", content: "be brief" },
    { role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image_url", image_url: { url: "https://example.invalid/a.png", detail: "low" } }] },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Bern\"}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "sunny" },
  ]);
  assert.deepEqual(body["tools"], [{ type: "function", function: { name: "get_weather", description: "weather", parameters: { type: "object", properties: { city: { type: "string" } } }, strict: true } }]);
  assert.deepEqual(body["tool_choice"], { type: "function", function: { name: "get_weather" } });
  assert.deepEqual(body["response_format"], { type: "json_schema", json_schema: { name: "out", schema: { type: "object" }, strict: true } });
  assert.deepEqual(body["stream_options"], { include_usage: true });
});

test("the same request serialises to the same bytes", T, () => {
  assert.equal(JSON.stringify(buildRequestBody(full, opts)), JSON.stringify(buildRequestBody(structuredClone(full), opts)));
});

test("non-stream bodies have stream:false and no stream_options; the max-tokens field is configurable", T, () => {
  const body = buildRequestBody(full, { stream: false, maxTokensField: "max_completion_tokens", includeUsage: true });
  assert.equal(body["stream"], false);
  assert.equal("stream_options" in body, false);
  assert.equal(body["max_completion_tokens"], 256);
  assert.equal("max_tokens" in body, false);
  assert.equal("stream_options" in buildRequestBody(full, { ...opts, includeUsage: false }), false);
});

test("optional fields are omitted, not sent as null", T, () => {
  const body = buildRequestBody({ model: "m", messages: [{ role: "user", content: "x" }] }, { ...opts, stream: false });
  assert.deepEqual(Object.keys(body), ["model", "messages", "stream"]);
});

test("invalid requests are refused before any I/O with a bad_request error", T, () => {
  const m = [{ role: "user" as const, content: "x" }];
  const cases: [string, ChatRequest][] = [
    ["empty model", { model: " ", messages: m }],
    ["no messages", { model: "m", messages: [] }],
    ["bad tool name", { model: "m", messages: m, tools: [{ name: "has space" }] }],
    ["duplicate tool", { model: "m", messages: m, tools: [{ name: "a" }, { name: "a" }] }],
    ["toolChoice without tools", { model: "m", messages: m, toolChoice: "auto" }],
    ["toolChoice names an undeclared tool", { model: "m", messages: m, tools: [{ name: "a" }], toolChoice: { name: "b" } }],
    ["maxTokens 0", { model: "m", messages: m, maxTokens: 0 }],
    ["temperature 3", { model: "m", messages: m, temperature: 3 }],
    ["temperature NaN", { model: "m", messages: m, temperature: Number.NaN }],
    ["topP 0", { model: "m", messages: m, topP: 0 }],
    ["five stops", { model: "m", messages: m, stop: ["a", "b", "c", "d", "e"] }],
    ["tool message without id", { model: "m", messages: [{ role: "tool", toolCallId: "", content: "x" }] }],
    ["assistant without content or calls", { model: "m", messages: [{ role: "assistant" }] }],
    ["schema format without a name", { model: "m", messages: m, responseFormat: { type: "json_schema", name: "", schema: {} } }],
  ];
  for (const [name, req] of cases) {
    assert.throws(() => buildRequestBody(req, opts), (e) => e instanceof ProviderError && e.kind === "invalid_request", name);
  }
});
