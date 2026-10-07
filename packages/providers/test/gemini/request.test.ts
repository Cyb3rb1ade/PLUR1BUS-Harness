import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGeminiBody, ProviderError } from "../../src/index.ts";
import type { ChatRequest } from "../../src/index.ts";
import { req, weatherTool } from "./helpers.ts";

const T = { timeout: 15_000 };
const refused = (r: ChatRequest) => assert.throws(() => buildGeminiBody(r), (e: unknown) => e instanceof ProviderError && e.kind === "bad_request");

test("system and developer messages become one systemInstruction; user text and generationConfig", T, () => {
  const body = buildGeminiBody({
    model: "models/gemini-test-1", maxTokens: 64, temperature: 0.5, topP: 0.9, stop: ["END"], responseFormat: { type: "json_object" },
    messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }, { role: "developer", content: "No emoji." }],
  });
  assert.deepEqual(body, {
    systemInstruction: { parts: [{ text: "Be brief.\n\nNo emoji." }] },
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    generationConfig: { maxOutputTokens: 64, temperature: 0.5, topP: 0.9, stopSequences: ["END"], responseMimeType: "application/json" },
  });
  assert.deepEqual(Object.keys(body), ["systemInstruction", "contents", "generationConfig"]);
});

test("tools, toolChoice and json_schema map to functionDeclarations, functionCallingConfig and responseJsonSchema", T, () => {
  const schema = { type: "object", properties: { a: { type: "number" } } };
  const base = { ...req, tools: [weatherTool], responseFormat: { type: "json_schema" as const, name: "x", schema } };
  const b = buildGeminiBody({ ...base, toolChoice: { name: "get_weather" } }) as Record<string, any>;
  assert.deepEqual(b["tools"], [{ functionDeclarations: [{ name: "get_weather", description: "Weather", parametersJsonSchema: weatherTool.parameters }] }]);
  assert.deepEqual(b["toolConfig"], { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["get_weather"] } });
  assert.deepEqual(b["generationConfig"], { responseMimeType: "application/json", responseJsonSchema: schema });
  for (const [c, mode] of [["auto", "AUTO"], ["none", "NONE"], ["required", "ANY"]] as const) {
    assert.deepEqual((buildGeminiBody({ ...base, toolChoice: c }) as Record<string, any>)["toolConfig"], { functionCallingConfig: { mode } });
  }
});

test("tool-call roundtrip: functionCall with signature, merged functionResponses, synthetic ids not echoed", T, () => {
  const body = buildGeminiBody({
    model: "gemini-test-1", tools: [weatherTool],
    messages: [
      { role: "user", content: "weather in Bern and Zug?" },
      { role: "assistant", content: "Checking.", toolCalls: [
        { id: "gemini-call-0", name: "get_weather", arguments: "{\"city\":\"Bern\"}", thoughtSignature: "sig-A" },
        { id: "call-given-1", name: "get_weather", arguments: "{\"city\":\"Zug\"}" },
      ] },
      { role: "tool", toolCallId: "gemini-call-0", content: "{\"temp\":12}" },
      { role: "tool", toolCallId: "call-given-1", content: "sunny" },
    ],
  }) as Record<string, any>;
  assert.deepEqual(body["contents"], [
    { role: "user", parts: [{ text: "weather in Bern and Zug?" }] },
    { role: "model", parts: [
      { text: "Checking." },
      { functionCall: { name: "get_weather", args: { city: "Bern" } }, thoughtSignature: "sig-A" },
      { functionCall: { name: "get_weather", args: { city: "Zug" }, id: "call-given-1" } },
    ] },
    { role: "user", parts: [
      { functionResponse: { name: "get_weather", response: { temp: 12 } } },
      { functionResponse: { name: "get_weather", response: { result: "sunny" }, id: "call-given-1" } },
    ] },
  ]);
});

test("images: only base64 data: URLs go inline", T, () => {
  const ok = buildGeminiBody({ ...req, messages: [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", url: "data:image/png;base64,iVBORw0KGgo=" }] }] }) as Record<string, any>;
  assert.deepEqual(ok["contents"][0].parts, [{ text: "see" }, { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } }]);
  refused({ ...req, messages: [{ role: "user", content: [{ type: "image_url", url: "https://example.invalid/a.png" }] }] });
});

test("fail closed: bad model ids, orphan tool result, parallelToolCalls:false, only-system, odd tool names", T, () => {
  for (const model of ["../x", "a/b", "m?key=1", "m:generateContent", ""]) refused({ ...req, model });
  refused({ ...req, messages: [{ role: "user", content: "x" }, { role: "tool", toolCallId: "nope", content: "{}" }] });
  refused({ ...req, tools: [weatherTool], parallelToolCalls: false });
  refused({ ...req, messages: [{ role: "system", content: "only" }] });
  refused({ ...req, tools: [{ name: "1bad" }] });
  refused({ ...req, messages: [{ role: "assistant", toolCalls: [{ id: "c", name: "get_weather", arguments: "[1]" }] }] });
});

test("same request, same bytes", T, () => {
  const r: ChatRequest = { ...req, tools: [weatherTool], temperature: 0.2 };
  assert.equal(JSON.stringify(buildGeminiBody(r)), JSON.stringify(buildGeminiBody(structuredClone(r))));
});
