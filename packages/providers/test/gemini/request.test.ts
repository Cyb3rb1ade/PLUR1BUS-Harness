import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError, buildGeminiBody } from "../../src/index.ts";
import type { ChatRequest } from "../../src/index.ts";
import { MODEL } from "./helpers.ts";

const one = (messages: ChatRequest["messages"], extra: Partial<ChatRequest> = {}): ChatRequest => ({ model: MODEL, messages, ...extra });
const refuses = (req: ChatRequest, re: RegExp) => assert.throws(() => buildGeminiBody(req), (e: unknown) => e instanceof ProviderError && e.kind === "bad_request" && re.test(e.message));

test("system and developer messages are hoisted, in order, into one systemInstruction", () => {
  const b = buildGeminiBody(one([
    { role: "system", content: "S1" }, { role: "user", content: "u" }, { role: "developer", content: "D1" },
  ]));
  assert.deepEqual(b["systemInstruction"], { parts: [{ text: "S1" }, { text: "D1" }] });
  assert.deepEqual(b["contents"], [{ role: "user", parts: [{ text: "u" }] }]);
  assert.deepEqual(Object.keys(b), ["systemInstruction", "contents"]);
});

test("a request of system messages only is refused; the model never appears in the body", () => {
  refuses(one([{ role: "system", content: "S" }]), /non-system/);
  assert.equal("model" in buildGeminiBody(one([{ role: "user", content: "x" }])), false);
});

test("roles, tool calls, grouped tool results", () => {
  const b = buildGeminiBody(one([
    { role: "user", content: "weather in Bern and Zurich?" },
    { role: "assistant", content: "checking", toolCalls: [
      { id: "call_0", name: "get_weather", arguments: "{\"city\":\"Bern\"}" },
      { id: "call_1~c2ln-AB+/=", name: "get_weather", arguments: "{\"city\":\"Zurich\"}" },
    ] },
    { role: "tool", toolCallId: "call_0", content: "{\"temp\":3}" },
    { role: "tool", toolCallId: "call_1~c2ln-AB+/=", content: "sunny" },
    { role: "user", content: "thanks" },
  ]));
  assert.deepEqual(b["contents"], [
    { role: "user", parts: [{ text: "weather in Bern and Zurich?" }] },
    { role: "model", parts: [
      { text: "checking" },
      { functionCall: { name: "get_weather", args: { city: "Bern" } } },
      { functionCall: { name: "get_weather", args: { city: "Zurich" } }, thoughtSignature: "c2ln-AB+/=" },
    ] },
    { role: "user", parts: [
      { functionResponse: { name: "get_weather", response: { temp: 3 } } },
      { functionResponse: { name: "get_weather", response: { result: "sunny" } } },
    ] },
    { role: "user", parts: [{ text: "thanks" }] },
  ]);
});

test("a tool message must answer an earlier call; bad tool arguments and bad signatures are refused", () => {
  refuses(one([{ role: "user", content: "x" }, { role: "tool", toolCallId: "call_9", content: "r" }]), /no earlier assistant/);
  for (const args of ["{", "[1]", "\"s\""]) {
    refuses(one([{ role: "user", content: "x" }, { role: "assistant", toolCalls: [{ id: "call_0", name: "f", arguments: args }] }]), /JSON|object/);
  }
  refuses(one([{ role: "user", content: "x" }, { role: "assistant", toolCalls: [{ id: "call_0~bad sig!", name: "f", arguments: "{}" }] }]), /signature/);
});

test("tools become functionDeclarations with parametersJsonSchema; toolChoice becomes toolConfig", () => {
  const tools = [{ name: "a", description: "d", parameters: { type: "object", properties: { x: { type: "integer" } } } }, { name: "b" }];
  const base = [{ role: "user" as const, content: "x" }];
  const b = buildGeminiBody(one(base, { tools }));
  assert.deepEqual(b["tools"], [{ functionDeclarations: [
    { name: "a", description: "d", parametersJsonSchema: { type: "object", properties: { x: { type: "integer" } } } }, { name: "b" },
  ] }]);
  assert.equal("toolConfig" in b, false);
  assert.deepEqual(buildGeminiBody(one(base, { tools, toolChoice: "auto" }))["toolConfig"], { functionCallingConfig: { mode: "AUTO" } });
  assert.deepEqual(buildGeminiBody(one(base, { tools, toolChoice: "none" }))["toolConfig"], { functionCallingConfig: { mode: "NONE" } });
  assert.deepEqual(buildGeminiBody(one(base, { tools, toolChoice: "required" }))["toolConfig"], { functionCallingConfig: { mode: "ANY" } });
  assert.deepEqual(buildGeminiBody(one(base, { tools, toolChoice: { name: "b" } }))["toolConfig"], { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["b"] } });
  refuses(one(base, { tools, parallelToolCalls: false }), /parallelToolCalls/);
  assert.doesNotThrow(() => buildGeminiBody(one(base, { tools, parallelToolCalls: true })));
});

test("generationConfig: limits, stop, JSON mode and schema", () => {
  const base = [{ role: "user" as const, content: "x" }];
  assert.equal("generationConfig" in buildGeminiBody(one(base)), false);
  assert.deepEqual(buildGeminiBody(one(base, { maxTokens: 50, temperature: 0.5, topP: 0.9, stop: ["END"], responseFormat: { type: "json_object" } }))["generationConfig"],
    { maxOutputTokens: 50, temperature: 0.5, topP: 0.9, stopSequences: ["END"], responseMimeType: "application/json" });
  assert.deepEqual(buildGeminiBody(one(base, { responseFormat: { type: "json_schema", name: "n", schema: { type: "object" } } }))["generationConfig"],
    { responseMimeType: "application/json", responseJsonSchema: { type: "object" } });
});

test("images: base64 data URLs go inline; remote URLs are refused (no fetching on the user's behalf)", () => {
  const ok = buildGeminiBody(one([{ role: "user", content: [{ type: "text", text: "what?" }, { type: "image_url", url: "data:image/png;base64,iVBORw0KGgo=" }] }]));
  assert.deepEqual(ok["contents"], [{ role: "user", parts: [{ text: "what?" }, { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } }] }]);
  refuses(one([{ role: "user", content: [{ type: "image_url", url: "https://example.invalid/a.png" }] }]), /data: URLs/);
  refuses(one([{ role: "user", content: [{ type: "image_url", url: "data:text/html;base64,AAAA" }] }]), /data: URLs/);
});

test("model names: models/ prefix accepted at the URL layer, path tricks refused", () => {
  for (const model of ["gemini-2.5-flash", "models/gemini-2.5-flash", "gemini-3.0-pro-preview"]) assert.doesNotThrow(() => buildGeminiBody(one([{ role: "user", content: "x" }], { model })));
  // buildGeminiBody does not see the model; the adapter does (see auth.test.ts). The shared validation still refuses blanks.
  refuses({ model: " ", messages: [{ role: "user", content: "x" }] }, /model/);
});

test("same request, same bytes", () => {
  const r = one([{ role: "system", content: "s" }, { role: "user", content: "u" }], { tools: [{ name: "t", parameters: { type: "object" } }], temperature: 1 });
  assert.equal(JSON.stringify(buildGeminiBody(r)), JSON.stringify(buildGeminiBody(structuredClone(r))));
});
