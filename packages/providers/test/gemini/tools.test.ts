import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError } from "../../src/index.ts";
import type { ChatMessage, ChatRequest } from "../../src/index.ts";
import { startStub } from "../helpers/stub.ts";
import { T, adapterFor, basic, candidate, collect, json, sse, usage } from "./helpers.ts";

const tools: NonNullable<ChatRequest["tools"]> = [{ name: "get_weather", description: "Weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }];

test("tool-call roundtrip: functionCall out (stream), functionResponse back, final answer; signature replayed", T, async () => {
  const stub = await startStub((_q, res, rec) => {
    const sent = JSON.parse(rec.body);
    const second = sent.contents.length > 1;
    if (!second) {
      sse(res, [
        candidate([{ text: "Checking. " }]),
        { ...candidate([{ functionCall: { name: "get_weather", args: { city: "Bern" } }, thoughtSignature: "c2lnLTE=" }, { functionCall: { name: "get_weather", args: { city: "Zurich" } } }], "STOP"), ...usage({ promptTokenCount: 20, candidatesTokenCount: 9, totalTokenCount: 29 }) },
      ]);
    } else {
      sse(res, [{ ...candidate([{ text: "Bern 3C, Zurich 5C." }], "STOP"), ...usage({ promptTokenCount: 60, candidatesTokenCount: 8, totalTokenCount: 68 }) }]);
    }
  });
  try {
    const { adapter } = adapterFor(stub);
    const messages: ChatMessage[] = [{ role: "user", content: "Weather in Bern and Zurich?" }];
    const first = await collect(adapter.stream({ model: basic.model, messages, tools }));
    const types = first.map((e) => e.type);
    assert.deepEqual(types, ["text_delta", "tool_call_start", "tool_call_delta", "tool_call_start", "tool_call_delta", "finish", "usage", "done"]);
    const start = first.find((e) => e.type === "tool_call_start");
    assert.deepEqual(start, { type: "tool_call_start", index: 0, id: "call_0~c2lnLTE=", name: "get_weather" });
    const done1 = first.at(-1);
    assert.ok(done1?.type === "done");
    if (done1?.type !== "done") return;
    assert.equal(done1.result.finishReason, "tool_calls");
    assert.equal(done1.result.rawFinishReason, "STOP");
    assert.deepEqual(done1.result.toolCalls, [
      { id: "call_0~c2lnLTE=", name: "get_weather", argumentsRaw: "{\"city\":\"Bern\"}", arguments: { city: "Bern" } },
      { id: "call_1", name: "get_weather", argumentsRaw: "{\"city\":\"Zurich\"}", arguments: { city: "Zurich" } },
    ]);

    messages.push({ role: "assistant", content: done1.result.text, toolCalls: done1.result.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.argumentsRaw })) });
    for (const c of done1.result.toolCalls) messages.push({ role: "tool", toolCallId: c.id, content: JSON.stringify({ temp: c.arguments?.["city"] === "Bern" ? 3 : 5 }) });
    const events = await collect(adapter.stream({ model: basic.model, messages, tools }));
    const done2 = events.at(-1);
    assert.ok(done2?.type === "done");
    assert.equal(done2?.type === "done" && done2.result.text, "Bern 3C, Zurich 5C.");

    const replay = JSON.parse(stub.requests.at(-1)!.body);
    assert.deepEqual(replay.contents.slice(1), [
      { role: "model", parts: [
        { text: "Checking. " },
        { functionCall: { name: "get_weather", args: { city: "Bern" } }, thoughtSignature: "c2lnLTE=" },
        { functionCall: { name: "get_weather", args: { city: "Zurich" } } },
      ] },
      { role: "user", parts: [
        { functionResponse: { name: "get_weather", response: { temp: 3 } } },
        { functionResponse: { name: "get_weather", response: { temp: 5 } } },
      ] },
    ]);
    assert.deepEqual(replay.tools, [{ functionDeclarations: [{ name: "get_weather", description: "Weather", parametersJsonSchema: tools[0]!.parameters }] }]);
  } finally { await stub.close(); }
});

test("non-stream tool call: arguments parsed, args default to {} when Gemini omits them", T, async () => {
  const stub = await startStub((_q, res) => json(res, candidate([{ functionCall: { name: "get_weather", args: { city: "Bern" } } }, { functionCall: { name: "get_weather" } }], "STOP")));
  try {
    const r = await adapterFor(stub).adapter.complete({ ...basic, tools });
    assert.deepEqual(r.toolCalls.map((c) => c.arguments), [{ city: "Bern" }, {}]);
    assert.deepEqual(r.toolCalls.map((c) => c.argumentsRaw), ["{\"city\":\"Bern\"}", "{}"]);
  } finally { await stub.close(); }
});

test("a malformed functionCall, oversized arguments and MALFORMED_FUNCTION_CALL fail closed", T, async () => {
  const send = async (b: object, cfg = {}) => {
    const stub = await startStub((_q, res) => json(res, b));
    try { return await adapterFor(stub, cfg).adapter.complete({ ...basic, tools }); } finally { await stub.close(); }
  };
  await assert.rejects(send(candidate([{ functionCall: { args: {} } }], "STOP")), (e: unknown) => e instanceof ProviderError && e.kind === "unknown");
  await assert.rejects(send(candidate([{ functionCall: { name: "f", args: [1] } }], "STOP")), (e: unknown) => e instanceof ProviderError && e.kind === "unknown");
  await assert.rejects(send(candidate([{ functionCall: { name: "f", args: { big: "x".repeat(200) } } }], "STOP"), { limits: { maxToolArgumentBytes: 100 } }), (e: unknown) => e instanceof ProviderError && e.kind === "unknown");
  await assert.rejects(send(candidate([], "MALFORMED_FUNCTION_CALL")), (e: unknown) => e instanceof ProviderError && e.kind === "unknown" && e.retryable);
});
