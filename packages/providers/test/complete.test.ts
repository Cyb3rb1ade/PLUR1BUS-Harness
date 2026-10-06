// The non-stream path, usage, and the tool-argument repair hook (interface only; D97 supplies the real one).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createChatCompletionsAdapter } from "../src/index.ts";
import type { ChatRequest, ToolArgumentRepair, ToolArgumentRepairInput } from "../src/index.ts";
import { basicRequest, credentials, sseHeaders, startStub } from "./helpers/stub.ts";

const T = { timeout: 15_000 };
const tools: NonNullable<ChatRequest["tools"]> = [{ name: "get_weather", parameters: { type: "object" } }];

const completion = (message: object, finish = "tool_calls") => JSON.stringify({
  id: "chatcmpl-synthetic-4", object: "chat.completion", model: "synthetic-model-1", system_fingerprint: "fp_synthetic",
  choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

async function run(body: string, repair?: ToolArgumentRepair) {
  const stub = await startStub((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(body); });
  try {
    const a = createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: credentials(), ...(repair ? { repair } : {}) });
    return { result: await a.complete({ ...basicRequest, tools }), sent: JSON.parse(stub.requests[0]!.body) };
  } finally { await stub.close(); }
}

test("non-stream: text, tool calls, usage, meta and the request body", T, async () => {
  const { result, sent } = await run(completion({ content: null, tool_calls: [{ id: "call_synthetic_7", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Bern\"}" } }] }));
  assert.equal(sent.stream, false);
  assert.equal("stream_options" in sent, false);
  assert.deepEqual(result, {
    text: "", toolCalls: [{ id: "call_synthetic_7", name: "get_weather", argumentsRaw: "{\"city\":\"Bern\"}", arguments: { city: "Bern" } }],
    finishReason: "tool_calls", rawFinishReason: "tool_calls", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    meta: { id: "chatcmpl-synthetic-4", model: "synthetic-model-1", systemFingerprint: "fp_synthetic" },
  });
});

test("non-stream and stream give the same result for the same turn", T, async () => {
  const message = { content: "hello", tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: "{\"a\":1}" } }] };
  const { result } = await run(completion(message));
  const stub = await startStub((_q, res) => {
    sseHeaders(res);
    const c = (d: object, f: string | null = null) => `data: ${JSON.stringify({ id: "chatcmpl-synthetic-4", model: "synthetic-model-1", system_fingerprint: "fp_synthetic", choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
    res.write(c({ role: "assistant", content: "hel" })); res.write(c({ content: "lo", tool_calls: [{ index: 0, id: "c1", function: { name: "get_weather", arguments: "{\"a\"" } }] }));
    res.write(c({ tool_calls: [{ index: 0, function: { arguments: ":1}" } }] })); res.write(c({}, "tool_calls"));
    res.write("data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5,\"total_tokens\":15}}\n\ndata: [DONE]\n\n");
    res.end();
  });
  try {
    let streamed;
    for await (const e of createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: credentials() }).stream({ ...basicRequest, tools })) if (e.type === "done") streamed = e.result;
    assert.deepEqual(streamed, result);
  } finally { await stub.close(); }
});

test("finish reasons: length, content_filter (a result, not an error), function_call, unknown", T, async () => {
  assert.equal((await run(completion({ content: "cut" }, "length"))).result.finishReason, "length");
  const f = (await run(completion({ content: "", refusal: "I can't help with that." }, "content_filter"))).result;
  assert.equal(f.finishReason, "content_filter");
  assert.equal(f.refusal, "I can't help with that.");
  assert.equal((await run(completion({ content: "x" }, "function_call"))).result.finishReason, "tool_calls");
  const o = (await run(completion({ content: "x" }, "weird"))).result;
  assert.equal(o.finishReason, "other");
  assert.equal(o.rawFinishReason, "weird");
});

test("reasoning_content is surfaced", T, async () => {
  assert.equal((await run(completion({ content: "a", reasoning_content: "because" }, "stop"))).result.reasoning, "because");
});

const brokenCall = (args: string) => completion({ content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: args } }] });

test("invalid tool arguments without a repair hook: the call carries argumentsError, the turn is not lost", T, async () => {
  for (const args of ["{\"city\":", "", "[1]", "\"s\""]) {
    const { result } = await run(brokenCall(args));
    const c = result.toolCalls[0]!;
    assert.equal(c.arguments, undefined, args);
    assert.equal(c.argumentsRaw, args);
    assert.ok(c.argumentsError, args);
  }
});

test("the repair hook is called once with the error and the tool definition; its fix is marked repaired", T, async () => {
  const calls: ToolArgumentRepairInput[] = [];
  const repair: ToolArgumentRepair = { repair: (i) => { calls.push(i); return { argumentsRaw: "{\"city\":\"Bern\"}" }; } };
  const { result } = await run(brokenCall("{\"city\":"), repair);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.call.name, "get_weather");
  assert.equal(calls[0]!.call.argumentsRaw, "{\"city\":");
  assert.match(calls[0]!.error, /not valid JSON/);
  assert.deepEqual(calls[0]!.tool, tools[0]);
  assert.deepEqual(result.toolCalls[0], { id: "c1", name: "get_weather", argumentsRaw: "{\"city\":\"Bern\"}", arguments: { city: "Bern" }, repaired: true });
});

test("the repair hook is not called for valid arguments, and a hook that fails, declines or returns garbage changes nothing", T, async () => {
  let n = 0;
  await run(brokenCall("{}"), { repair: () => { n++; return undefined; } });
  assert.equal(n, 0);
  for (const hook of [
    { repair: () => { throw new Error("hook bug"); } },
    { repair: () => undefined },
    { repair: () => ({ argumentsRaw: "still not json" }) },
    { repair: () => ({ arguments: [] as unknown as Record<string, never> }) },
  ] satisfies ToolArgumentRepair[]) {
    const c = (await run(brokenCall("{\"city\":"), hook)).result.toolCalls[0]!;
    assert.equal(c.arguments, undefined);
    assert.ok(c.argumentsError);
    assert.equal(c.repaired, undefined);
  }
});

test("the repair hook also runs on the stream path", T, async () => {
  const stub = await startStub((_q, res) => {
    sseHeaders(res);
    const c = (d: object, f: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
    res.write(c({ tool_calls: [{ index: 0, id: "c1", function: { name: "get_weather", arguments: "{'city': 'Bern'}" } }] }));
    res.write(c({}, "tool_calls")); res.write("data: [DONE]\n\n"); res.end();
  });
  try {
    const repair: ToolArgumentRepair = { repair: (i) => ({ argumentsRaw: i.call.argumentsRaw.replaceAll("'", "\"") }) };
    let result;
    for await (const e of createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: credentials(), repair }).stream({ ...basicRequest, tools })) if (e.type === "done") result = e.result;
    assert.deepEqual(result?.toolCalls[0]?.arguments, { city: "Bern" });
    assert.equal(result?.toolCalls[0]?.repaired, true);
  } finally { await stub.close(); }
});
