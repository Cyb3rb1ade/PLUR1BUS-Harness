import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError } from "../../src/index.ts";
import { buildResponsesBody } from "../../src/responses/request.ts";
import type { ResponsesBuildOptions } from "../../src/responses/request.ts";
import type { ResponsesRequest } from "../../src/responses/types.ts";

const OPTS: ResponsesBuildOptions = { stream: false, profile: "openai", store: false };
const one = (messages: ResponsesRequest["messages"], extra: Partial<ResponsesRequest> = {}): ResponsesRequest => ({ model: "gpt-synthetic", messages, ...extra });
const build = (req: ResponsesRequest, o: Partial<ResponsesBuildOptions> = {}) => buildResponsesBody(req, { ...OPTS, ...o });
const refuses = (req: ResponsesRequest, re: RegExp, o: Partial<ResponsesBuildOptions> = {}) =>
  assert.throws(() => build(req, o), (e: unknown) => e instanceof ProviderError && e.kind === "invalid_request" && re.test(e.message), String(re));
const hi: ResponsesRequest["messages"] = [{ role: "user", content: "hi" }];

test("minimal request: input items, store false and stream last, fixed key order", () => {
  const b = build(one(hi));
  assert.deepEqual(b, { model: "gpt-synthetic", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }], store: false, stream: false });
  assert.deepEqual(Object.keys(b), ["model", "input", "store", "stream"]);
  assert.equal(build(one(hi), { stream: true })["stream"], true);
  assert.equal(JSON.stringify(build(one(hi))), JSON.stringify(build(one(hi))), "same request, same bytes");
});

test("system and developer messages are hoisted, in order, into instructions", () => {
  const b = build(one([{ role: "system", content: "S1" }, { role: "user", content: "u" }, { role: "developer", content: "D1" }, { role: "system", content: "" }]));
  assert.equal(b["instructions"], "S1\n\nD1");
  assert.deepEqual(b["input"], [{ type: "message", role: "user", content: [{ type: "input_text", text: "u" }] }]);
  assert.deepEqual(Object.keys(b), ["model", "instructions", "input", "store", "stream"]);
  assert.equal("instructions" in build(one(hi)), false);
  refuses(one([{ role: "system", content: "S" }]), /non-system/);
});

test("roles map to message, function_call and function_call_output items in conversation order", () => {
  const b = build(one([
    { role: "user", content: "weather in Bern and Zurich?" },
    { role: "assistant", content: "checking", toolCalls: [{ id: "call_0", name: "get_weather", arguments: "{\"city\":\"Bern\"}" }, { id: "call_1", name: "get_weather", arguments: "{\"city\":\"Zurich\"}" }] },
    { role: "tool", toolCallId: "call_0", content: "{\"temp\":3}" },
    { role: "tool", toolCallId: "call_1", content: "sunny" },
    { role: "assistant", content: "Bern 3, Zurich sunny" },
    { role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", url: "https://example.invalid/a.png", detail: "low" }, { type: "image_url", url: "data:image/png;base64,AAEC" }] },
  ]));
  assert.deepEqual(b["input"], [
    { type: "message", role: "user", content: [{ type: "input_text", text: "weather in Bern and Zurich?" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "checking" }] },
    { type: "function_call", call_id: "call_0", name: "get_weather", arguments: "{\"city\":\"Bern\"}" },
    { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{\"city\":\"Zurich\"}" },
    { type: "function_call_output", call_id: "call_0", output: "{\"temp\":3}" },
    { type: "function_call_output", call_id: "call_1", output: "sunny" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Bern 3, Zurich sunny" }] },
    { type: "message", role: "user", content: [
      { type: "input_text", text: "see" },
      { type: "input_image", image_url: "https://example.invalid/a.png", detail: "low" },
      { type: "input_image", image_url: "data:image/png;base64,AAEC" },
    ] },
  ]);
});

test("an assistant message with only tool calls has no message item; an empty assistant message is refused", () => {
  const b = build(one([{ role: "user", content: "go" }, { role: "assistant", toolCalls: [{ id: "call_0", name: "f", arguments: "{}" }] }, { role: "tool", toolCallId: "call_0", content: "r" }]));
  assert.deepEqual((b["input"] as { type: string }[]).map((i) => i.type), ["message", "function_call", "function_call_output"]);
  refuses(one([{ role: "user", content: "go" }, { role: "assistant", content: "" }]), /empty/);
});

test("tool-call ids longer than 64 characters (another adapter's) are replaced by a stable hash, consistently", () => {
  const long = `call_0~${"A".repeat(100)}`;
  const b = build(one([{ role: "user", content: "go" }, { role: "assistant", toolCalls: [{ id: long, name: "f", arguments: "{}" }] }, { role: "tool", toolCallId: long, content: "r" }]));
  const items = b["input"] as { call_id?: string }[];
  assert.match(items[1]!.call_id!, /^call_h_[0-9a-f]{32}$/);
  assert.equal(items[2]!.call_id, items[1]!.call_id);
  assert.equal((build(one([{ role: "user", content: "go" }, { role: "assistant", toolCalls: [{ id: long, name: "f", arguments: "{}" }] }, { role: "tool", toolCallId: long, content: "r" }])) as { input: { call_id?: string }[] }).input[1]!.call_id, items[1]!.call_id, "stable across calls");
  assert.equal((build(one([{ role: "user", content: "go" }, { role: "assistant", toolCalls: [{ id: "call_short", name: "f", arguments: "{}" }] }, { role: "tool", toolCallId: "call_short", content: "r" }])) as { input: { call_id?: string }[] }).input[1]!.call_id, "call_short");
});

test("tools: function items with explicit strict (the Responses API would otherwise default it to true), caller key order kept", () => {
  const b = build(one(hi, { tools: [
    { name: "a", description: "A", parameters: { type: "object", properties: { z: { type: "string" }, a: { type: "string" } } } },
    { name: "b" },
    { name: "c", strict: true, parameters: { type: "object", properties: {}, additionalProperties: false } },
  ] }));
  assert.deepEqual(b["tools"], [
    { type: "function", name: "a", description: "A", parameters: { type: "object", properties: { z: { type: "string" }, a: { type: "string" } } }, strict: false },
    { type: "function", name: "b", parameters: { type: "object", properties: {} }, strict: false },
    { type: "function", name: "c", parameters: { type: "object", properties: {}, additionalProperties: false }, strict: true },
  ]);
  assert.deepEqual(Object.keys(((b["tools"] as { parameters: { properties: object } }[])[0]!).parameters.properties), ["z", "a"]);
});

test("tool_choice, parallel_tool_calls, limits and sampling, in a fixed order", () => {
  const tools = [{ name: "f" }];
  const tc = (extra: Partial<ResponsesRequest>) => build(one(hi, { tools, ...extra }))["tool_choice"];
  assert.equal(tc({}), undefined);
  assert.equal(tc({ toolChoice: "auto" }), "auto");
  assert.equal(tc({ toolChoice: "none" }), "none");
  assert.equal(tc({ toolChoice: "required" }), "required");
  assert.deepEqual(tc({ toolChoice: { name: "f" } }), { type: "function", name: "f" });
  const b = build(one(hi, { tools, toolChoice: "auto", parallelToolCalls: false, maxTokens: 50, temperature: 0.5, topP: 0.9 }));
  assert.deepEqual(Object.keys(b), ["model", "input", "tools", "tool_choice", "parallel_tool_calls", "max_output_tokens", "temperature", "top_p", "store", "stream"]);
  assert.equal(b["parallel_tool_calls"], false);
  assert.equal(b["max_output_tokens"], 50);
});

test("reasoning effort and summary: request option wins over the adapter default; text.format from responseFormat", () => {
  assert.deepEqual(build(one(hi), { reasoningEffort: "low" })["reasoning"], { effort: "low" });
  assert.deepEqual(build(one(hi), { reasoningEffort: "low", reasoningSummary: "auto" })["reasoning"], { effort: "low", summary: "auto" });
  assert.deepEqual(build(one(hi, { providerOptions: { responses: { reasoningEffort: "high" } } }), { reasoningEffort: "low" })["reasoning"], { effort: "high" });
  assert.deepEqual(build(one(hi, { providerOptions: { responses: { reasoningSummary: "detailed" } } }))["reasoning"], { summary: "detailed" });
  assert.equal("reasoning" in build(one(hi)), false);
  assert.equal("text" in build(one(hi, { responseFormat: { type: "text" } })), false);
  assert.deepEqual(build(one(hi, { responseFormat: { type: "json_object" } }))["text"], { format: { type: "json_object" } });
  assert.deepEqual(build(one(hi, { responseFormat: { type: "json_schema", name: "out", schema: { type: "object" }, strict: true } }))["text"], { format: { type: "json_schema", name: "out", schema: { type: "object" }, strict: true } });
  refuses(one(hi, { providerOptions: { responses: { reasoningEffort: "extreme" as never } } }), /reasoningEffort/);
});

test("store: false by default, the adapter default and the request option may turn it on (openai profile)", () => {
  assert.equal(build(one(hi))["store"], false);
  assert.equal(build(one(hi), { store: true })["store"], true);
  assert.equal(build(one(hi, { providerOptions: { responses: { store: true } } }))["store"], true);
  assert.equal(build(one(hi, { providerOptions: { responses: { store: false } } }), { store: true })["store"], false);
});

test("the ChatGPT-plan profile forces store:false and stream:true and refuses what the backend does not take", () => {
  const plan = (req: ResponsesRequest, o: Partial<ResponsesBuildOptions> = {}) => build(req, { profile: "chatgpt_plan", ...o });
  const sys: ResponsesRequest["messages"] = [{ role: "system", content: "S" }, ...hi];
  const b = plan(one(sys), { stream: false, store: true });
  assert.equal(b["stream"], true, "stream is forced on");
  assert.equal(b["store"], false, "store is forced off");
  assert.equal(b["instructions"], "S");
  const allowed = plan(one(sys, { tools: [{ name: "f" }], toolChoice: "auto", parallelToolCalls: true, responseFormat: { type: "json_object" }, providerOptions: { responses: { reasoningEffort: "medium", reasoningSummary: "auto" } } }));
  assert.deepEqual(Object.keys(allowed), ["model", "instructions", "input", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "text", "store", "stream"]);
  for (const [label, extra] of [["maxTokens", { maxTokens: 10 }], ["temperature", { temperature: 0.2 }], ["topP", { topP: 0.5 }]] as const) {
    refuses(one(sys, extra), new RegExp(label), { profile: "chatgpt_plan" });
  }
  refuses(one(sys, { providerOptions: { responses: { store: true } } }), /store/, { profile: "chatgpt_plan" });
  refuses(one(hi), /instructions/, { profile: "chatgpt_plan" });
  // the same fields are fine on the plain profile
  assert.doesNotThrow(() => build(one(hi, { maxTokens: 10, temperature: 0.2, topP: 0.5 })));
});

test("fail closed: what the Responses API cannot express, and broken histories, are refused before any I/O", () => {
  refuses(one(hi, { stop: ["END"] }), /stop/);
  refuses(one([{ role: "user", content: "x" }], { toolChoice: "auto" }), /tools/);
  refuses(one([], {}), /messages/);
  refuses(one([{ role: "user", content: [{ type: "image_url", url: "file:///etc/passwd" }] }]), /image/);
  refuses(one([{ role: "user", content: "go" }, { role: "tool", toolCallId: "call_x", content: "r" }]), /call_x/);
  refuses(one([{ role: "user", content: "go" }, { role: "assistant", toolCalls: [{ id: "call_1", name: "f", arguments: "{}" }] }]), /call_1/);
  refuses(one([{ role: "user", content: "go" }, { role: "tool", toolCallId: "call_1", content: "r" }, { role: "assistant", toolCalls: [{ id: "call_1", name: "f", arguments: "{}" }] }]), /call_1/);
});
