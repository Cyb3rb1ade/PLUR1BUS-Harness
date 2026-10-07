import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError, parseGeminiUsage } from "../../src/index.ts";
import { startStub } from "./../helpers/stub.ts";
import { MODEL, T, adapterFor, basic, candidate, collect, json, sse, usage } from "./helpers.ts";

const body = {
  ...candidate([{ text: "Hello " }, { text: "there" }], "STOP"), responseId: "resp-9", modelVersion: "m-1",
  ...usage({ promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 }),
};

test("generateContent: result, usage and URL", T, async () => {
  const stub = await startStub((_q, res) => json(res, body));
  try {
    const r = await adapterFor(stub).adapter.complete(basic);
    assert.deepEqual(r, {
      text: "Hello there", toolCalls: [], finishReason: "stop", rawFinishReason: "STOP",
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 }, meta: { id: "resp-9", model: "m-1" },
    });
    assert.equal(stub.requests[0]!.url, `/v1/models/${MODEL}:generateContent`);
    assert.equal(stub.requests[0]!.headers["accept"], "application/json");
  } finally { await stub.close(); }
});

test("stream and non-stream give the same result for the same turn", T, async () => {
  const parts = [{ text: "think", thought: true }, { text: "hello" }, { functionCall: { name: "f", args: { a: 1 } }, thoughtSignature: "c2ln" }];
  const u = usage({ promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 2, totalTokenCount: 16 });
  const whole = { ...candidate(parts, "STOP"), responseId: "r", modelVersion: "m", ...u };
  const stub = await startStub((q, res) => (q.url?.includes("streamGenerateContent")
    ? sse(res, [{ ...candidate([parts[0]!]), responseId: "r", modelVersion: "m" }, candidate([parts[1]!]), { ...candidate([parts[2]!], "STOP"), ...u }])
    : json(res, whole)));
  try {
    const { adapter } = adapterFor(stub);
    const a = await adapter.complete({ ...basic, tools: [{ name: "f" }] });
    const events = await collect(adapter.stream({ ...basic, tools: [{ name: "f" }] }));
    const done = events.at(-1);
    assert.equal(done?.type, "done");
    assert.deepEqual(done?.type === "done" && done.result, a);
  } finally { await stub.close(); }
});

test("finish reasons: MAX_TOKENS is length, STOP with a call is tool_calls, unknown is other with the raw value", T, async () => {
  const run = async (b: object) => {
    const stub = await startStub((_q, res) => json(res, b));
    try { return await adapterFor(stub).adapter.complete({ ...basic, tools: [{ name: "f" }] }); } finally { await stub.close(); }
  };
  assert.equal((await run(candidate([{ text: "cut" }], "MAX_TOKENS"))).finishReason, "length");
  assert.equal((await run(candidate([{ functionCall: { name: "f" } }], "STOP"))).finishReason, "tool_calls");
  const o = await run(candidate([{ text: "x" }], "LANGUAGE"));
  assert.equal(o.finishReason, "other");
  assert.equal(o.rawFinishReason, "LANGUAGE");
});

test("a response without a finishReason, with a non-JSON body or oversized is a protocol error", T, async () => {
  for (const send of [
    (res: import("node:http").ServerResponse) => json(res, candidate([{ text: "x" }])),
    (res: import("node:http").ServerResponse) => { res.writeHead(200, { "content-type": "application/json" }); res.end("not json"); },
  ]) {
    const stub = await startStub((_q, res) => send(res));
    try { await assert.rejects(adapterFor(stub).adapter.complete(basic), (e: unknown) => e instanceof ProviderError && e.kind === "unknown"); } finally { await stub.close(); }
  }
  const stub = await startStub((_q, res) => json(res, body));
  try {
    await assert.rejects(adapterFor(stub, { limits: { maxBodyBytes: 20 } }).adapter.complete(basic), (e: unknown) => e instanceof ProviderError && e.kind === "unknown");
  } finally { await stub.close(); }
});

test("usageMetadata mapping: thoughts count as output, tool-use prompt as input, absent counts are zero", () => {
  assert.deepEqual(parseGeminiUsage({ promptTokenCount: 100, toolUsePromptTokenCount: 20, candidatesTokenCount: 30, thoughtsTokenCount: 50, cachedContentTokenCount: 64, totalTokenCount: 200 }),
    { inputTokens: 120, outputTokens: 80, totalTokens: 200, cachedInputTokens: 64, reasoningTokens: 50 });
  assert.deepEqual(parseGeminiUsage({ promptTokenCount: 4 }), { inputTokens: 4, outputTokens: 0, totalTokens: 4 });
  assert.deepEqual(parseGeminiUsage({ promptTokenCount: 4, candidatesTokenCount: 1 }), { inputTokens: 4, outputTokens: 1, totalTokens: 5 });
  for (const bad of [{ promptTokenCount: -1 }, { promptTokenCount: 1.5 }, { promptTokenCount: "7" }, [], null]) {
    assert.throws(() => parseGeminiUsage(bad), (e: unknown) => e instanceof ProviderError && e.kind === "unknown");
  }
});

test("a stream chunk with a bad usageMetadata number fails closed", T, async () => {
  const stub = await startStub((_q, res) => sse(res, [{ ...candidate([{ text: "x" }], "STOP"), ...usage({ promptTokenCount: -3 }) }]));
  try { await assert.rejects(collect(adapterFor(stub).adapter.stream(basic)), (e: unknown) => e instanceof ProviderError && e.kind === "unknown"); } finally { await stub.close(); }
});
