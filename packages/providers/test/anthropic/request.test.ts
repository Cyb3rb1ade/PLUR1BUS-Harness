import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError } from "../../src/index.ts";
import { buildAnthropicBody } from "../../src/anthropic/request.ts";
import type { AnthropicRequest } from "../../src/anthropic/types.ts";

const OPTS = { stream: false, defaultMaxTokens: 4096 };
const one = (messages: AnthropicRequest["messages"], extra: Partial<AnthropicRequest> = {}): AnthropicRequest => ({ model: "claude-synthetic", messages, ...extra });
const build = (req: AnthropicRequest, o: Partial<Parameters<typeof buildAnthropicBody>[1]> = {}) => buildAnthropicBody(req, { ...OPTS, ...o });
const refuses = (req: AnthropicRequest, re: RegExp) =>
  assert.throws(() => build(req), (e: unknown) => e instanceof ProviderError && e.kind === "invalid_request" && re.test(e.message), String(re));

test("minimal request: fixed key order, max_tokens always present, stream flag last", () => {
  const b = build(one([{ role: "user", content: "hi" }]));
  assert.deepEqual(b, { model: "claude-synthetic", max_tokens: 4096, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], stream: false });
  assert.deepEqual(Object.keys(b), ["model", "max_tokens", "messages", "stream"]);
  assert.equal(build(one([{ role: "user", content: "hi" }]), { stream: true })["stream"], true);
  assert.equal(JSON.stringify(build(one([{ role: "user", content: "hi" }]))), JSON.stringify(build(one([{ role: "user", content: "hi" }]))), "same request, same bytes");
});

test("max_tokens: the request's value wins over the adapter default", () => {
  assert.equal(build(one([{ role: "user", content: "x" }], { maxTokens: 77 }))["max_tokens"], 77);
  assert.equal(build(one([{ role: "user", content: "x" }]), { defaultMaxTokens: 123 })["max_tokens"], 123);
});

test("system and developer messages are hoisted, in order, into top-level system blocks; empty ones are dropped", () => {
  const b = build(one([
    { role: "system", content: "S1" }, { role: "user", content: "u" }, { role: "developer", content: "D1" }, { role: "system", content: "" },
  ]));
  assert.deepEqual(b["system"], [{ type: "text", text: "S1" }, { type: "text", text: "D1" }]);
  assert.deepEqual(b["messages"], [{ role: "user", content: [{ type: "text", text: "u" }] }]);
  assert.deepEqual(Object.keys(b), ["model", "max_tokens", "system", "messages", "stream"]);
  assert.equal("system" in build(one([{ role: "user", content: "u" }])), false);
});

test("consecutive messages of the same role are merged; tool results come first in their user turn", () => {
  const b = build(one([
    { role: "user", content: "a" },
    { role: "user", content: "b" },
    { role: "assistant", content: "t1" },
    { role: "assistant", content: "t2", toolCalls: [{ id: "toolu_1", name: "f", arguments: "{\"x\":1}" }, { id: "toolu_2", name: "g", arguments: "{}" }] },
    { role: "user", content: "note" },
    { role: "tool", toolCallId: "toolu_1", content: "r1" },
    { role: "tool", toolCallId: "toolu_2", content: "r2" },
    { role: "user", content: "thanks" },
  ]));
  assert.deepEqual(b["messages"], [
    { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
    { role: "assistant", content: [
      { type: "text", text: "t1" }, { type: "text", text: "t2" },
      { type: "tool_use", id: "toolu_1", name: "f", input: { x: 1 } }, { type: "tool_use", id: "toolu_2", name: "g", input: {} },
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_1", content: "r1" }, { type: "tool_result", tool_use_id: "toolu_2", content: "r2" },
      { type: "text", text: "note" }, { type: "text", text: "thanks" },
    ] },
  ]);
});

test("a tool result with empty content omits the content field", () => {
  const b = build(one([
    { role: "user", content: "go" },
    { role: "assistant", toolCalls: [{ id: "toolu_1", name: "f", arguments: "{}" }] },
    { role: "tool", toolCallId: "toolu_1", content: "" },
  ]));
  assert.deepEqual((b["messages"] as { content: unknown }[])[2]!.content, [{ type: "tool_result", tool_use_id: "toolu_1" }]);
});

test("images: data URLs become base64 sources, http(s) URLs url sources; anything else is refused", () => {
  const b = build(one([{ role: "user", content: [
    { type: "text", text: "see" },
    { type: "image_url", url: "data:image/png;base64,AAEC" },
    { type: "image_url", url: "https://example.invalid/a.jpg", detail: "high" },
  ] }]));
  assert.deepEqual((b["messages"] as { content: unknown }[])[0]!.content, [
    { type: "text", text: "see" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAEC" } },
    { type: "image", source: { type: "url", url: "https://example.invalid/a.jpg" } },
  ]);
  refuses(one([{ role: "user", content: [{ type: "image_url", url: "file:///etc/passwd" }] }]), /image/);
  refuses(one([{ role: "user", content: [{ type: "image_url", url: "data:text/html;base64,AAEC" }] }]), /image/);
});

test("tools: input_schema (default object), strict passthrough, caller key order kept", () => {
  const b = build(one([{ role: "user", content: "x" }], { tools: [
    { name: "a", description: "A", parameters: { type: "object", properties: { z: { type: "string" }, a: { type: "string" } } } },
    { name: "b" },
    { name: "c", strict: true, parameters: { type: "object" } },
  ] }));
  assert.deepEqual(b["tools"], [
    { name: "a", description: "A", input_schema: { type: "object", properties: { z: { type: "string" }, a: { type: "string" } } } },
    { name: "b", input_schema: { type: "object" } },
    { name: "c", input_schema: { type: "object" }, strict: true },
  ]);
  assert.deepEqual(Object.keys(((b["tools"] as Record<string, unknown>[])[0]!["input_schema"] as { properties: object }).properties), ["z", "a"]);
});

test("tool_choice mapping, and parallelToolCalls:false as disable_parallel_tool_use", () => {
  const tools = [{ name: "f" }];
  const tc = (extra: Partial<AnthropicRequest>) => build(one([{ role: "user", content: "x" }], { tools, ...extra }))["tool_choice"];
  assert.equal(tc({}), undefined);
  assert.deepEqual(tc({ toolChoice: "auto" }), { type: "auto" });
  assert.deepEqual(tc({ toolChoice: "required" }), { type: "any" });
  assert.deepEqual(tc({ toolChoice: { name: "f" } }), { type: "tool", name: "f" });
  assert.deepEqual(tc({ toolChoice: "none" }), { type: "none" });
  assert.deepEqual(tc({ parallelToolCalls: false }), { type: "auto", disable_parallel_tool_use: true });
  assert.deepEqual(tc({ toolChoice: "required", parallelToolCalls: false }), { type: "any", disable_parallel_tool_use: true });
  assert.deepEqual(tc({ toolChoice: { name: "f" }, parallelToolCalls: false }), { type: "tool", name: "f", disable_parallel_tool_use: true });
  assert.deepEqual(tc({ toolChoice: "none", parallelToolCalls: false }), { type: "none" });
  assert.equal(tc({ parallelToolCalls: true }), undefined);
});

test("sampling and stop: temperature, top_p, stop_sequences, in a fixed order after tool_choice", () => {
  const b = build(one([{ role: "user", content: "x" }], { temperature: 0.5, topP: 0.9, stop: ["END", "STOP"], tools: [{ name: "f" }], toolChoice: "auto" }));
  assert.deepEqual(Object.keys(b), ["model", "max_tokens", "messages", "tools", "tool_choice", "temperature", "top_p", "stop_sequences", "stream"]);
  assert.deepEqual(b["stop_sequences"], ["END", "STOP"]);
});

test("cache_control markers: request option, adapter default, ttl, request overrides adapter, {} switches off", () => {
  const req = (cache?: object): AnthropicRequest => one(
    [{ role: "system", content: "S1" }, { role: "system", content: "S2" }, { role: "user", content: "u1" }, { role: "user", content: "u2" }],
    { tools: [{ name: "a" }, { name: "b" }], ...(cache === undefined ? {} : { providerOptions: { anthropic: { cache } } }) },
  );
  const none = build(req());
  assert.equal(JSON.stringify(none).includes("cache_control"), false);
  const all = build(req({ tools: true, system: true, messages: true }));
  assert.deepEqual((all["tools"] as Record<string, unknown>[]).map((t) => "cache_control" in t), [false, true]);
  assert.deepEqual((all["system"] as Record<string, unknown>[]).map((t) => t["cache_control"]), [undefined, { type: "ephemeral" }]);
  const lastUser = (all["messages"] as { content: Record<string, unknown>[] }[])[0]!.content;
  assert.deepEqual(lastUser.map((b2) => b2["cache_control"]), [undefined, { type: "ephemeral" }]);
  const hour = build(req({ system: true, ttl: "1h" }));
  assert.deepEqual((hour["system"] as Record<string, unknown>[])[1]!["cache_control"], { type: "ephemeral", ttl: "1h" });
  const dflt = build(req(), { cache: { system: true } });
  assert.deepEqual((dflt["system"] as Record<string, unknown>[])[1]!["cache_control"], { type: "ephemeral" });
  assert.equal(JSON.stringify(build(req({ tools: true }), { cache: { system: true } })).includes("\"system\":[{\"type\":\"text\",\"text\":\"S1\"},{\"type\":\"text\",\"text\":\"S2\",\"cache_control\""), false, "the request's cache replaces the default");
  assert.equal(JSON.stringify(build(req({}), { cache: { system: true } })).includes("cache_control"), false, "{} switches caching off");
  const noSystem = build(one([{ role: "user", content: "u" }]), { cache: { system: true, tools: true } });
  assert.equal(JSON.stringify(noSystem).includes("cache_control"), false, "a flag for an absent part is a no-op");
});

test("assistant tool-call arguments must be a JSON object; they are sent parsed", () => {
  const msgs = (args: string): AnthropicRequest["messages"] => [
    { role: "user", content: "go" }, { role: "assistant", toolCalls: [{ id: "toolu_1", name: "f", arguments: args }] }, { role: "tool", toolCallId: "toolu_1", content: "r" },
  ];
  assert.doesNotThrow(() => build(one(msgs("{\"a\":[1,2]}"))));
  refuses(one(msgs("not json")), /arguments/);
  refuses(one(msgs("[1]")), /arguments/);
  refuses(one(msgs("\"s\"")), /arguments/);
});

test("fail closed: first turn must be a user turn, tool results must answer the call right before them", () => {
  refuses(one([{ role: "system", content: "S" }]), /user/);
  refuses(one([{ role: "assistant", content: "hi" }]), /user/);
  refuses(one([{ role: "user", content: "go" }, { role: "tool", toolCallId: "toolu_x", content: "r" }]), /tool_result|tool result/);
  refuses(one([
    { role: "user", content: "go" }, { role: "assistant", toolCalls: [{ id: "toolu_1", name: "f", arguments: "{}" }] }, { role: "user", content: "no result" },
  ]), /toolu_1/);
  refuses(one([
    { role: "user", content: "go" }, { role: "assistant", toolCalls: [{ id: "toolu_1", name: "f", arguments: "{}" }] },
  ]), /toolu_1/);
  refuses(one([
    { role: "user", content: "go" }, { role: "assistant", toolCalls: [{ id: "toolu_1", name: "f", arguments: "{}" }] },
    { role: "tool", toolCallId: "toolu_1", content: "a" }, { role: "tool", toolCallId: "toolu_ghost", content: "b" },
  ]), /toolu_ghost/);
  refuses(one([{ role: "user", content: "" }]), /empty/);
  refuses(one([{ role: "user", content: "go" }, { role: "assistant", content: "" }]), /empty|content/);
});

test("fail closed: what Anthropic cannot express is refused before any I/O", () => {
  refuses(one([{ role: "user", content: "x" }], { temperature: 1.5 }), /temperature/);
  refuses(one([{ role: "user", content: "x" }], { responseFormat: { type: "json_object" } }), /responseFormat/);
  refuses(one([{ role: "user", content: "x" }], { responseFormat: { type: "json_schema", name: "n", schema: {} } }), /responseFormat/);
  assert.doesNotThrow(() => build(one([{ role: "user", content: "x" }], { responseFormat: { type: "text" }, temperature: 1 })));
  // the shared checks of the neutral request still apply
  refuses(one([], {}), /messages/);
  refuses(one([{ role: "user", content: "x" }], { toolChoice: "auto" }), /tools/);
  refuses(one([{ role: "user", content: "x" }], { tools: [{ name: "bad name" }] }), /tool name/);
});

test("tool-call ids from other adapters are rewritten to the Anthropic id alphabet, consistently; a collision is refused", () => {
  const history = (a: string, b: string): AnthropicRequest["messages"] => [
    { role: "user", content: "go" },
    { role: "assistant", toolCalls: [{ id: a, name: "f", arguments: "{}" }, { id: b, name: "f", arguments: "{}" }] },
    { role: "tool", toolCallId: a, content: "r1" }, { role: "tool", toolCallId: b, content: "r2" },
  ];
  const b = build(one(history("call_0~c2ln-AB+/=", "call_1")));
  const msgs = b["messages"] as { content: Record<string, unknown>[] }[];
  assert.deepEqual(msgs[1]!.content.map((x) => x["id"]), ["call_0_c2ln-AB___", "call_1"]);
  assert.deepEqual(msgs[2]!.content.map((x) => x["tool_use_id"]), ["call_0_c2ln-AB___", "call_1"]);
  refuses(one(history("a~b", "a+b")), /collide/);
});
