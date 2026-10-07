// H10: the tool-call roundtrip per wire format, on recorded (synthetic) fixtures: the model asks for two tools, the caller
// answers with the results, the model gives the final answer. This is the provider-level half of M2 acceptance 3 (the
// end-to-end run through `plur1bus chat` is a follow-up). It checks both directions: what the adapter makes of the
// model's tool calls, and what it puts on the wire when the results come back.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createAnthropicAdapter, createResponsesAdapter } from "../src/index.ts";
import type { ChatMessage, ChatRequest, ChatStreamEvent, ChatResult, ToolDefinition } from "../src/index.ts";
import { split, sseHeaders, startStub, writeAll } from "./helpers/stub.ts";

const T = { timeout: 20_000 };
const fx = (name: string) => readFileSync(new URL(`./contract/fixtures/${name}`, import.meta.url));
const TOOLS: ToolDefinition[] = [
  { name: "get_weather", description: "weather", parameters: { type: "object", properties: { city: { type: "string" }, units: { type: "string" } } } },
  { name: "get_time", description: "time", parameters: { type: "object", properties: { tz: { type: "string" } } } },
];
const FIRST: ChatMessage = { role: "user", content: "Weather in Berlin and the time there?" };

interface Wire {
  name: string;
  adapter(baseUrl: string): { stream(req: ChatRequest): AsyncGenerator<ChatStreamEvent, void, void>; complete(req: ChatRequest): Promise<ChatResult> };
  files: { tools: string; text: string };
  /** The wire form of the second request's conversation, parsed from the body the stub received. */
  conversation(body: Record<string, unknown>): unknown;
  expected: unknown;
}

const WEATHER_ARGS = "{\"city\":\"Berlin\",\"units\":\"metric\"}";
const TIME_ARGS = "{\"tz\":\"Europe/Berlin\"}";

const WIRES: Wire[] = [
  {
    name: "anthropic_messages", files: { tools: "anthropic.tools.sse", text: "anthropic.text.sse" },
    adapter: (baseUrl) => createAnthropicAdapter({ baseUrl, credentials: { apiKey: () => "sk-ant-roundtrip-0000000000" } }),
    conversation: (b) => b["messages"],
    expected: [
      { role: "user", content: [{ type: "text", text: FIRST.content }] },
      { role: "assistant", content: [
        { type: "tool_use", id: "call_weather_0", name: "get_weather", input: { city: "Berlin", units: "metric" } },
        { type: "tool_use", id: "call_time_1", name: "get_time", input: { tz: "Europe/Berlin" } },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "call_weather_0", content: "18C, cloudy" },
        { type: "tool_result", tool_use_id: "call_time_1", content: "14:05" },
      ] },
    ],
  },
  {
    name: "codex_responses", files: { tools: "responses.tools.sse", text: "responses.text.sse" },
    adapter: (baseUrl) => createResponsesAdapter({ baseUrl, credentials: { authorization: () => "Bearer sk-roundtrip-0000000000" } }),
    conversation: (b) => b["input"],
    expected: [
      { type: "message", role: "user", content: [{ type: "input_text", text: FIRST.content }] },
      { type: "function_call", call_id: "call_weather_0", name: "get_weather", arguments: WEATHER_ARGS },
      { type: "function_call", call_id: "call_time_1", name: "get_time", arguments: TIME_ARGS },
      { type: "function_call_output", call_id: "call_weather_0", output: "18C, cloudy" },
      { type: "function_call_output", call_id: "call_time_1", output: "14:05" },
    ],
  },
];

for (const w of WIRES) {
  test(`${w.name}: tool call -> tool_result -> final answer`, T, async () => {
    const replies = [fx(w.files.tools), fx(w.files.text)];
    const stub = await startStub(async (_q, res) => {
      sseHeaders(res);
      await writeAll(res, split(replies[stub.requests.length - 1]!, [61, 5, 173, 11]));
      res.end();
    });
    try {
      const a = w.adapter(stub.baseUrl);
      const turn1: ChatRequest = { model: "roundtrip-model", messages: [FIRST], tools: TOOLS };
      let first: ChatResult | undefined;
      const seen: string[] = [];
      for await (const ev of a.stream(turn1)) { seen.push(ev.type); if (ev.type === "done") first = ev.result; }
      assert.ok(first);
      assert.equal(first.finishReason, "tool_calls");
      assert.deepEqual(first.toolCalls.map((c) => [c.id, c.name, c.argumentsRaw]), [["call_weather_0", "get_weather", WEATHER_ARGS], ["call_time_1", "get_time", TIME_ARGS]]);
      assert.deepEqual(first.toolCalls.map((c) => c.arguments), [{ city: "Berlin", units: "metric" }, { tz: "Europe/Berlin" }]);
      assert.equal(seen.filter((t) => t === "tool_call_start").length, 2);

      // The caller runs the tools and hands the results back, exactly as an agent loop would.
      const results = new Map([["get_weather", "18C, cloudy"], ["get_time", "14:05"]]);
      const turn2: ChatRequest = {
        ...turn1,
        messages: [
          FIRST,
          { role: "assistant", content: null, toolCalls: first.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.argumentsRaw })) },
          ...first.toolCalls.map((c): ChatMessage => ({ role: "tool", toolCallId: c.id, content: results.get(c.name)! })),
        ],
      };
      const final = await a.stream(turn2);
      let text = "", last: ChatResult | undefined;
      for await (const ev of final) { if (ev.type === "text_delta") text += ev.text; if (ev.type === "done") last = ev.result; }
      assert.equal(text, "Hello, world");
      assert.equal(last?.finishReason, "stop");
      assert.deepEqual(last?.toolCalls, []);

      assert.equal(stub.requests.length, 2);
      assert.deepEqual(w.conversation(JSON.parse(stub.requests[1]!.body)), w.expected);
      // the first request advertised both tools, the second still does (the model may call again)
      for (const r of stub.requests) assert.equal((JSON.parse(r.body).tools as unknown[]).length, 2);
    } finally { await stub.close(); }
  });

  test(`${w.name}: a tool result without its call, or a call without its result, is refused before any I/O`, T, async () => {
    const stub = await startStub((_q, res) => { res.writeHead(500); res.end(); });
    try {
      const a = w.adapter(stub.baseUrl);
      const call = { id: "c1", name: "get_time", arguments: "{}" };
      const orphanResult: ChatRequest = { model: "m", messages: [FIRST, { role: "tool", toolCallId: "c1", content: "x" }] };
      const unanswered: ChatRequest = { model: "m", messages: [FIRST, { role: "assistant", toolCalls: [call] }, { role: "user", content: "and?" }] };
      for (const req of [orphanResult, unanswered]) {
        const e = await a.complete(req).then(() => undefined, (x: unknown) => x);
        assert.ok(e instanceof Error && (e as { kind?: string }).kind === "invalid_request", String(e));
      }
      assert.equal(stub.requests.length, 0);
    } finally { await stub.close(); }
  });
}
