import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError, buildGeminiBody } from "../../src/index.ts";
import type { ChatRequest } from "../../src/index.ts";
import { MODEL } from "./helpers.ts";

const one = (messages: ChatRequest["messages"], extra: Partial<ChatRequest> = {}): ChatRequest => ({ model: MODEL, messages, ...extra });
const refuses = (req: ChatRequest, re: RegExp) => assert.throws(() => buildGeminiBody(req), (e: unknown) => e instanceof ProviderError && e.kind === "invalid_request" && re.test(e.message));

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

test("system prompt: several system/developer messages keep their order, one part each", () => {
  const b = buildGeminiBody(one([
    { role: "system", content: "S1" }, { role: "developer", content: "D1" }, { role: "system", content: "S2\nline two" }, { role: "user", content: "u" },
  ]));
  assert.deepEqual(b["systemInstruction"], { parts: [{ text: "S1" }, { text: "D1" }, { text: "S2\nline two" }] });
  assert.deepEqual(b["contents"], [{ role: "user", parts: [{ text: "u" }] }]);
});

test("system prompt: a system message in the middle of the conversation is hoisted, order kept, contents untouched", () => {
  const b = buildGeminiBody(one([
    { role: "system", content: "first" },
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
    { role: "system", content: "middle" },
    { role: "user", content: "u2" },
    { role: "developer", content: "last" },
  ]));
  assert.deepEqual(b["systemInstruction"], { parts: [{ text: "first" }, { text: "middle" }, { text: "last" }] });
  assert.deepEqual(b["contents"], [
    { role: "user", parts: [{ text: "u1" }] }, { role: "model", parts: [{ text: "a1" }] }, { role: "user", parts: [{ text: "u2" }] },
  ]);
});

test("RULING system prompt: empty and whitespace-only messages are dropped (Gemini rejects empty text parts); other text is untouched", () => {
  const b = buildGeminiBody(one([
    { role: "system", content: "" }, { role: "developer", content: " \n\t " }, { role: "system", content: "  keep \n" }, { role: "user", content: "u" },
  ]));
  assert.deepEqual(b["systemInstruction"], { parts: [{ text: "  keep \n" }] });
  // nothing left: no systemInstruction key at all, never an empty parts list
  const none = buildGeminiBody(one([{ role: "system", content: "" }, { role: "developer", content: "   " }, { role: "user", content: "u" }]));
  assert.equal("systemInstruction" in none, false);
  assert.deepEqual(Object.keys(none), ["contents"]);
  // the user's own empty text is not the adapter's business and is not touched
  assert.deepEqual(buildGeminiBody(one([{ role: "user", content: "" }]))["contents"], [{ role: "user", parts: [{ text: "" }] }]);
});

test("system prompt: only system/developer messages (even empty ones) are refused", () => {
  refuses(one([{ role: "system", content: "S" }, { role: "developer", content: "D" }]), /non-system/);
  refuses(one([{ role: "system", content: "  " }]), /non-system/);
});

test("system prompt: the developer role is treated exactly like system", () => {
  const dev = buildGeminiBody(one([{ role: "developer", content: "rules" }, { role: "user", content: "u" }]));
  const sys = buildGeminiBody(one([{ role: "system", content: "rules" }, { role: "user", content: "u" }]));
  assert.equal(JSON.stringify(dev), JSON.stringify(sys));
});

test("system prompt: unusual unicode round-trips untouched", () => {
  const text = "  Ünï cödé ​‮ rtl 🚀 \u{1F468}‍\u{1F469}‍\u{1F467} \u0000 é ﻿ end\r\n  ";
  const b = buildGeminiBody(one([{ role: "system", content: text }, { role: "user", content: "u" }]));
  const parts = (b["systemInstruction"] as { parts: { text: string }[] }).parts;
  assert.equal(parts[0]!.text, text);
  assert.equal((JSON.parse(JSON.stringify(b)) as { systemInstruction: { parts: { text: string }[] } }).systemInstruction.parts[0]!.text, text);
  // a lone surrogate is passed on as given (JSON.stringify later escapes it); the adapter does not "repair" text
  assert.equal(((buildGeminiBody(one([{ role: "system", content: "a\ud800b" }, { role: "user", content: "u" }]))["systemInstruction"]) as { parts: { text: string }[] }).parts[0]!.text, "a\ud800b");
});

test("tools + systemInstruction + toolConfig + generationConfig: the documented fixed key order", () => {
  const b = buildGeminiBody(one([{ role: "system", content: "s" }, { role: "user", content: "u" }], {
    maxTokens: 5, toolChoice: "auto", tools: [{ name: "t", description: "d", parameters: { type: "object", properties: { x: { type: "string" } } } }],
  }));
  assert.deepEqual(Object.keys(b), ["systemInstruction", "contents", "tools", "toolConfig", "generationConfig"]);
  assert.deepEqual(Object.keys(((b["tools"] as { functionDeclarations: object[] }[])[0]!.functionDeclarations[0])!), ["name", "description", "parametersJsonSchema"]);
});

test("tool schemas: reduced where safe, caller key order kept, tool without parameters stays without parametersJsonSchema", () => {
  const parameters = {
    $schema: "http://json-schema.org/draft-07/schema#",
    $defs: { city: { type: "string", description: "A city", default: "Bern" } },
    type: "object",
    properties: { from: { $ref: "#/$defs/city" }, mode: { const: "fast" }, pick: { oneOf: [{ type: "string" }, { type: "integer" }] } },
    required: ["from"],
    additionalProperties: false,
  };
  const before = structuredClone(parameters);
  const b = buildGeminiBody(one([{ role: "user", content: "x" }], { tools: [{ name: "a", parameters }, { name: "b" }] }));
  assert.equal(JSON.stringify(b["tools"]), JSON.stringify([{ functionDeclarations: [
    { name: "a", parametersJsonSchema: {
      type: "object",
      properties: { from: { type: "string", description: "A city" }, mode: { enum: ["fast"] }, pick: { anyOf: [{ type: "string" }, { type: "integer" }] } },
      required: ["from"],
      additionalProperties: false,
    } },
    { name: "b" },
  ] }]));
  assert.deepEqual(parameters, before);
});

test("tool schemas: an unsupported schema is refused naming the tool index, name and path", () => {
  const base = [{ role: "user" as const, content: "x" }];
  const ok = { name: "fine", parameters: { type: "object" } };
  refuses(one(base, { tools: [ok, { name: "search", parameters: { type: "object", properties: { q: { patternProperties: {} } } } }] }),
    /^tools\[1\] "search": parameters\.properties\.q\.patternProperties is not supported by Gemini$/);
  refuses(one(base, { tools: [{ name: "search", parameters: { type: "object", properties: { q: { $ref: "https://example.invalid/x.json" } } } }] }),
    /^tools\[0\] "search": parameters\.properties\.q\.\$ref "https:\/\/example\.invalid\/x\.json" is not supported by Gemini/);
  // refusal is by ProviderError of kind invalid_request, unprefixed
  assert.throws(() => buildGeminiBody(one(base, { tools: [{ name: "t", parameters: { not: {} } }] })), (e: unknown) => e instanceof ProviderError && e.kind === "invalid_request" && e.message === "tools[0] \"t\": parameters.not is not supported by Gemini");
});
