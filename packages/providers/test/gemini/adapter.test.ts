// The Gemini adapter against a local fake server: streaming, tool-call roundtrip, safety blocks, 429 and friends.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError } from "../../src/index.ts";
import type { ChatResult, ChatStreamEvent } from "../../src/index.ts";
import { split, startStub, until, writeAll } from "../helpers/stub.ts";
import { adapterFor, cand, KEY, part, req, sendJson, sendSse, sse, usageMeta, weatherTool } from "./helpers.ts";

const T = { timeout: 15_000 };

async function collect(it: AsyncGenerator<ChatStreamEvent, void, void>): Promise<{ events: ChatStreamEvent[]; result: ChatResult }> {
  const events: ChatStreamEvent[] = [];
  let result: ChatResult | undefined;
  for await (const e of it) { events.push(e); if (e.type === "done") result = e.result; }
  assert.ok(result, "stream ended without done");
  return { events, result };
}
const failure = async (p: Promise<unknown>): Promise<ProviderError> => {
  try { await p; } catch (e) { assert.ok(e instanceof ProviderError, String(e)); return e; }
  throw new assert.AssertionError({ message: "expected a ProviderError" });
};

const textTurn = [
  { ...cand([part("Hel")]), responseId: "resp-1", modelVersion: "gemini-test-1-001" },
  { ...cand([part("lo ü")]), usageMetadata: { promptTokenCount: 11, totalTokenCount: 11 } },
  { ...cand([part("!")], "STOP"), usageMetadata: { ...usageMeta, cachedContentTokenCount: 4, thoughtsTokenCount: 3, totalTokenCount: 19 } },
];

test("stream: text deltas across arbitrary byte splits, usage, finish, meta; key only in the header", T, async () => {
  const stub = await startStub(async (_q, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    await writeAll(res, split(Buffer.from(sse(...textTurn), "utf8"), [1, 3, 7, 2, 40]));
    res.end();
  });
  try {
    const { events, result } = await collect(adapterFor(stub.baseUrl).stream({ ...req, messages: [{ role: "system", content: "S" }, ...req.messages] }));
    assert.deepEqual(events.filter((e) => e.type === "text_delta").map((e) => e.type === "text_delta" && e.text), ["Hel", "lo ü", "!"]);
    assert.deepEqual(events.slice(-3).map((e) => e.type), ["finish", "usage", "done"]);
    assert.deepEqual(result, {
      text: "Hello ü!", toolCalls: [], finishReason: "stop", rawFinishReason: "STOP",
      usage: { inputTokens: 11, outputTokens: 8, totalTokens: 19, cachedInputTokens: 4, reasoningTokens: 3 },
      meta: { id: "resp-1", model: "gemini-test-1-001" },
    });
    const r = stub.requests[0]!;
    assert.equal(r.method, "POST");
    assert.equal(r.url, "/v1/models/gemini-test-1:streamGenerateContent?alt=sse");
    assert.equal(r.headers["x-goog-api-key"], KEY);
    assert.equal(r.headers["authorization"], undefined);
    assert.deepEqual(JSON.parse(r.body).systemInstruction, { parts: [{ text: "S" }] });
  } finally { await stub.close(); }
});

test("complete: same turn gives the same result as the stream", T, async () => {
  const stub = await startStub((_q, res, rec) => {
    if (rec.url?.includes(":streamGenerateContent")) return sendSse(res, sse(...textTurn));
    sendJson(res, { ...cand([part("Hello ü!")], "STOP"), responseId: "resp-1", modelVersion: "gemini-test-1-001", usageMetadata: (textTurn[2] as { usageMetadata: object }).usageMetadata });
  });
  try {
    const a = adapterFor(stub.baseUrl);
    const viaStream = (await collect(a.stream(req))).result;
    const direct = await a.complete(req);
    assert.deepEqual(direct, viaStream);
    assert.equal(stub.requests[1]!.url, "/v1/models/gemini-test-1:generateContent");
  } finally { await stub.close(); }
});

test("tool-call roundtrip: call without id, signature echoed, response mapped by name", T, async () => {
  const stub = await startStub((_q, res, rec) => {
    const body = JSON.parse(rec.body);
    if (body.contents.length === 1) {
      return sendSse(res, sse(
        cand([{ functionCall: { name: "get_weather", args: { city: "Bern" } }, thoughtSignature: "sig-opaque-1" }]),
        { ...cand([], "STOP"), usageMetadata: usageMeta },
      ));
    }
    const turn = { ...cand([part("It is 12 degrees.")], "STOP"), usageMetadata: usageMeta };
    if (rec.url?.includes(":streamGenerateContent")) sendSse(res, sse(turn)); else sendJson(res, turn);
  });
  try {
    const a = adapterFor(stub.baseUrl);
    const first = await collect(a.stream({ ...req, tools: [weatherTool] }));
    assert.deepEqual(first.events.filter((e) => e.type.startsWith("tool_call")), [
      { type: "tool_call_start", index: 0, id: "gemini-call-0", name: "get_weather" },
      { type: "tool_call_delta", index: 0, argumentsDelta: "{\"city\":\"Bern\"}" },
    ]);
    assert.equal(first.result.finishReason, "tool_calls");
    const call = first.result.toolCalls[0]!;
    assert.deepEqual(call, { id: "gemini-call-0", name: "get_weather", argumentsRaw: "{\"city\":\"Bern\"}", arguments: { city: "Bern" }, thoughtSignature: "sig-opaque-1" });

    const second = await a.complete({
      ...req, tools: [weatherTool],
      messages: [...req.messages,
        { role: "assistant", toolCalls: [{ id: call.id, name: call.name, arguments: call.argumentsRaw, thoughtSignature: call.thoughtSignature! }] },
        { role: "tool", toolCallId: call.id, content: "{\"temp\":12}" }],
    });
    assert.equal(second.text, "It is 12 degrees.");
    assert.deepEqual(JSON.parse(stub.requests[1]!.body).contents.slice(1), [
      { role: "model", parts: [{ functionCall: { name: "get_weather", args: { city: "Bern" } }, thoughtSignature: "sig-opaque-1" }] },
      { role: "user", parts: [{ functionResponse: { name: "get_weather", response: { temp: 12 } } }] },
    ]);
    const done = await collect(a.stream({
      ...req, tools: [weatherTool],
      messages: [...req.messages, { role: "assistant", toolCalls: [{ id: call.id, name: call.name, arguments: call.argumentsRaw }] }, { role: "tool", toolCallId: call.id, content: "sunny" }],
    }));
    assert.equal(done.result.text, "It is 12 degrees.");
  } finally { await stub.close(); }
});

test("a provider-supplied functionCall id is kept and echoed", T, async () => {
  const stub = await startStub((_q, res) => sendJson(res, { ...cand([{ functionCall: { id: "fc-77", name: "get_weather", args: {} } }], "STOP") }));
  try {
    const r = await adapterFor(stub.baseUrl).complete({ ...req, tools: [weatherTool] });
    assert.equal(r.toolCalls[0]!.id, "fc-77");
    assert.deepEqual(r.toolCalls[0]!.arguments, {});
  } finally { await stub.close(); }
});

test("safety: a blocked prompt is a typed content_filter error on both paths", T, async () => {
  const blocked = { promptFeedback: { blockReason: "PROHIBITED_CONTENT", blockReasonMessage: "not allowed", safetyRatings: [{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", probability: "HIGH", blocked: true }] }, usageMetadata: { promptTokenCount: 3, totalTokenCount: 3 } };
  const stub = await startStub((_q, res, rec) => (rec.url?.includes("stream") ? sendSse(res, sse(blocked)) : sendJson(res, blocked)));
  try {
    const a = adapterFor(stub.baseUrl);
    for (const e of [await failure(a.complete(req)), await failure(collect(a.stream(req)))]) {
      assert.equal(e.kind, "content_filter");
      assert.equal(e.code, "PROHIBITED_CONTENT");
      assert.equal(e.retryable, false);
      assert.match(e.providerMessage ?? "", /HARM_CATEGORY_DANGEROUS_CONTENT:HIGH/);
    }
  } finally { await stub.close(); }
});

test("safety: a candidate cut by SAFETY mid-stream is content_filter and keeps the partial text", T, async () => {
  const stub = await startStub((_q, res) => sendSse(res, sse(cand([part("Start of an ans")]), cand([], "SAFETY"))));
  try {
    const e = await failure(collect(adapterFor(stub.baseUrl).stream(req)));
    assert.equal(e.kind, "content_filter");
    assert.equal(e.code, "SAFETY");
    assert.equal(e.partial?.text, "Start of an ans");
  } finally { await stub.close(); }
});

test("429: rate_limit, retryDelay from RetryInfo, Retry-After header wins, retryable", T, async () => {
  const body = { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "7.5s" }] } };
  const stub = await startStub((_q, res, rec) => sendJson(res, body, 429, rec.headers["x-case"] === "header" ? { "retry-after": "3" } : {}));
  try {
    const a = adapterFor(stub.baseUrl, { headers: { "x-case": "plain" } });
    const e = await failure(a.complete(req));
    assert.equal(e.kind, "rate_limit");
    assert.equal(e.status, 429);
    assert.equal(e.retryAfterMs, 7500);
    assert.equal(e.retryable, true);
    assert.equal(e.providerType, "RESOURCE_EXHAUSTED");
    const e2 = await failure(adapterFor(stub.baseUrl, { headers: { "x-case": "header" } }).complete(req));
    assert.equal(e2.retryAfterMs, 3000);
    const e3 = await failure(collect(a.stream(req)));
    assert.equal(e3.kind, "rate_limit");
  } finally { await stub.close(); }
});

test("other HTTP errors: invalid key is auth, oversized prompt is context_length, 503 is server, 404 is bad_request", T, async () => {
  const cases: [number, object, string][] = [
    [400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key." } }, "auth"],
    [400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "The input token count (2000000) exceeds the maximum number of tokens allowed (1048576)." } }, "context_length"],
    [400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "Unknown field" } }, "bad_request"],
    [403, { error: { code: 403, status: "PERMISSION_DENIED", message: "denied" } }, "auth"],
    [404, { error: { code: 404, status: "NOT_FOUND", message: "models/x is not found" } }, "bad_request"],
    [503, { error: { code: 503, status: "UNAVAILABLE", message: "overloaded" } }, "server"],
  ];
  let i = 0;
  const stub = await startStub((_q, res) => { const [s, b] = cases[i++]!; sendJson(res, b, s); });
  try {
    for (const [status, , kind] of cases) {
      const e = await failure(adapterFor(stub.baseUrl).complete(req));
      assert.equal(e.kind, kind, `HTTP ${status}`);
      assert.equal(e.status, status);
    }
  } finally { await stub.close(); }
});

test("an error object inside a 200 stream is classified; a stream that ends without finishReason is protocol", T, async () => {
  let mode = 0;
  const stub = await startStub((_q, res) => {
    if (mode++ === 0) return sendSse(res, sse(cand([part("a")]), { error: { code: 503, status: "UNAVAILABLE", message: "try later" } }));
    sendSse(res, sse(cand([part("cut off")])));
  });
  try {
    const a = adapterFor(stub.baseUrl);
    const e1 = await failure(collect(a.stream(req)));
    assert.equal(e1.kind, "server");
    assert.equal(e1.partial?.text, "a");
    const e2 = await failure(collect(a.stream(req)));
    assert.equal(e2.kind, "protocol");
    assert.match(e2.message, /finishReason/);
    assert.equal(e2.partial?.text, "cut off");
  } finally { await stub.close(); }
});

test("malformed responses fail closed: unknown part, second candidate, content after finish, bad usage", T, async () => {
  const bodies: object[] = [
    cand([{ inlineData: { mimeType: "image/png", data: "AA==" } }], "STOP"),
    { candidates: [{ index: 0, content: { parts: [part("a")] }, finishReason: "STOP" }, { index: 1, content: { parts: [part("b")] } }] },
    { ...cand([part("a")], "STOP"), usageMetadata: { promptTokenCount: -1 } },
    cand([{ functionCall: { args: {} } }], "STOP"),
    cand([], "MALFORMED_FUNCTION_CALL"),
    {},
  ];
  let i = 0;
  const stub = await startStub((_q, res) => sendJson(res, bodies[i++]));
  try {
    for (let n = 0; n < bodies.length; n++) assert.equal((await failure(adapterFor(stub.baseUrl).complete(req))).kind, "protocol", `body ${n}`);
  } finally { await stub.close(); }
  const stub2 = await startStub((_q, res) => sendSse(res, sse(cand([part("a")], "STOP"), cand([part("more")]))));
  try { assert.equal((await failure(collect(adapterFor(stub2.baseUrl).stream(req)))).kind, "protocol"); } finally { await stub2.close(); }
});

test("MAX_TOKENS is finishReason length; an unknown finishReason is other", T, async () => {
  let i = 0;
  const stub = await startStub((_q, res) => sendJson(res, cand([part("x")], i++ === 0 ? "MAX_TOKENS" : "SOMETHING_NEW")));
  try {
    const a = adapterFor(stub.baseUrl);
    assert.equal((await a.complete(req)).finishReason, "length");
    const r = await a.complete(req);
    assert.deepEqual([r.finishReason, r.rawFinishReason], ["other", "SOMETHING_NEW"]);
  } finally { await stub.close(); }
});

test("leaving the stream early cancels the request", T, async () => {
  const stub = await startStub((_q, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(sse(cand([part("first")]))); });
  try {
    for await (const e of adapterFor(stub.baseUrl).stream(req)) if (e.type === "text_delta") break;
    assert.ok(await until(() => stub.openSockets() === 0), "socket still open");
  } finally { await stub.close(); }
});

test("thinking parts become reasoning, not text", T, async () => {
  const stub = await startStub((_q, res) => sendJson(res, cand([part("pondering", { thought: true }), part("answer")], "STOP")));
  try {
    const r = await adapterFor(stub.baseUrl).complete(req);
    assert.deepEqual([r.text, r.reasoning], ["answer", "pondering"]);
  } finally { await stub.close(); }
});
