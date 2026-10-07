import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError } from "../../src/index.ts";
import { hold, split, startStub, until } from "../helpers/stub.ts";
import { MODEL, T, adapterFor, basic, candidate, collect, geminiError, json, KEY, sse, usage } from "./helpers.ts";

test("streams text, reasoning and the final usage; request shape and key header", T, async () => {
  const stub = await startStub((_q, res) => sse(res, [
    { ...candidate([{ text: "Let me think. ", thought: true }]), responseId: "resp-1", modelVersion: "gemini-synthetic-flash-001", ...usage({ promptTokenCount: 7 }) },
    candidate([{ text: "Hel" }]),
    { ...candidate([{ text: "lo" }], "STOP"), ...usage({ promptTokenCount: 7, candidatesTokenCount: 2, thoughtsTokenCount: 4, cachedContentTokenCount: 3, totalTokenCount: 13 }) },
  ]));
  try {
    const { adapter } = adapterFor(stub);
    const events = await collect(adapter.stream({ ...basic, messages: [{ role: "system", content: "be brief" }, ...basic.messages] }));
    assert.deepEqual(events.map((e) => e.type), ["reasoning_delta", "text_delta", "text_delta", "finish", "usage", "done"]);
    const done = events.at(-1);
    assert.equal(done?.type, "done");
    if (done?.type !== "done") return;
    assert.deepEqual(done.result, {
      text: "Hello", reasoning: "Let me think. ", toolCalls: [], finishReason: "stop", rawFinishReason: "STOP",
      usage: { inputTokens: 7, outputTokens: 6, totalTokens: 13, cachedInputTokens: 3, reasoningTokens: 4 },
      meta: { id: "resp-1", model: "gemini-synthetic-flash-001" },
    });
    const r = stub.requests[0]!;
    assert.equal(r.method, "POST");
    assert.equal(r.url, `/v1/models/${MODEL}:streamGenerateContent?alt=sse`);
    assert.equal(r.headers["x-goog-api-key"], KEY);
    assert.equal(r.headers["accept"], "text/event-stream");
    assert.equal(r.headers["authorization"], undefined);
    const sent = JSON.parse(r.body);
    assert.deepEqual(sent.systemInstruction, { parts: [{ text: "be brief" }] });
    assert.deepEqual(sent.contents, [{ role: "user", parts: [{ text: "hi" }] }]);
  } finally { await stub.close(); }
});

test("survives arbitrary chunk boundaries (bytes split inside events and UTF-8 sequences)", T, async () => {
  const body = [candidate([{ text: "Grüße " }]), candidate([{ text: "日本" }], "STOP")].map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join("");
  const stub = await startStub(async (_q, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const p of split(Buffer.from(body), [1, 2, 3, 5, 8])) await new Promise<void>((ok) => res.write(p, () => ok()));
    res.end();
  });
  try {
    const events = await collect(adapterFor(stub).adapter.stream(basic));
    const done = events.at(-1);
    assert.equal(done?.type === "done" && done.result.text, "Grüße 日本");
  } finally { await stub.close(); }
});

test("a stream that ends without a finishReason is truncated: protocol error with the partial text", T, async () => {
  const stub = await startStub((_q, res) => sse(res, [candidate([{ text: "half an ans" }])]));
  try {
    await assert.rejects(collect(adapterFor(stub).adapter.stream(basic)), (e: unknown) => {
      assert.ok(e instanceof ProviderError);
      assert.equal(e.kind, "protocol");
      assert.equal(e.partial?.text, "half an ans");
      return true;
    });
  } finally { await stub.close(); }
});

test("content after finishReason, a second candidate, an unknown part kind and bad JSON are protocol errors", T, async () => {
  const cases: unknown[][] = [
    [candidate([{ text: "a" }], "STOP"), candidate([{ text: "late" }])],
    [{ candidates: [{ index: 0, content: { parts: [] } }, { index: 1, content: { parts: [] } }] }],
    [candidate([{ executableCode: { language: "PYTHON", code: "1" } }], "STOP")],
    [{ nothing: true }],
  ];
  for (const chunks of cases) {
    const stub = await startStub((_q, res) => sse(res, chunks));
    try {
      await assert.rejects(collect(adapterFor(stub).adapter.stream(basic)), (e: unknown) => e instanceof ProviderError && e.kind === "protocol");
    } finally { await stub.close(); }
  }
  const stub = await startStub((_q, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end("data: {not json\r\n\r\n"); });
  try {
    await assert.rejects(collect(adapterFor(stub).adapter.stream(basic)), (e: unknown) => e instanceof ProviderError && e.kind === "protocol");
  } finally { await stub.close(); }
});

test("an error object delivered inside the stream is classified by its gRPC status", T, async () => {
  const stub = await startStub((_q, res) => sse(res, [candidate([{ text: "x" }]), geminiError(503, "UNAVAILABLE", "The model is overloaded.")]));
  try {
    await assert.rejects(collect(adapterFor(stub).adapter.stream(basic)), (e: unknown) => {
      assert.ok(e instanceof ProviderError);
      assert.equal(e.kind, "server");
      assert.equal(e.retryable, true);
      assert.equal(e.partial?.text, "x");
      return true;
    });
  } finally { await stub.close(); }
});

test("a 200 JSON body on the stream path: an error object is classified, anything else is a protocol error", T, async () => {
  let stub = await startStub((_q, res) => json(res, [geminiError(429, "RESOURCE_EXHAUSTED", "slow down")]));
  try {
    await assert.rejects(collect(adapterFor(stub).adapter.stream(basic)), (e: unknown) => e instanceof ProviderError && e.kind === "rate_limit");
  } finally { await stub.close(); }
  stub = await startStub((_q, res) => json(res, [candidate([{ text: "x" }], "STOP")]));
  try {
    await assert.rejects(collect(adapterFor(stub).adapter.stream(basic)), (e: unknown) => e instanceof ProviderError && e.kind === "protocol");
  } finally { await stub.close(); }
});

test("leaving the loop early or aborting cancels the request and frees the socket", T, async () => {
  let closed = 0;
  const stub = await startStub(async (q, res) => {
    q.socket.on("close", () => { closed++; });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify(candidate([{ text: "first" }]))}\r\n\r\n`);
    await hold(res);
  });
  try {
    const { adapter } = adapterFor(stub);
    for await (const e of adapter.stream(basic)) { if (e.type === "text_delta") break; }
    assert.ok(await until(() => closed === 1), "connection closed after break");
    const ac = new AbortController();
    const it = adapter.stream(basic, { signal: ac.signal });
    await it.next();
    ac.abort();
    await assert.rejects(it.next(), (e: unknown) => e instanceof ProviderError && e.kind === "aborted");
    assert.ok(await until(() => closed === 2), "connection closed after abort");
  } finally { await stub.close(); }
});

test("idle timeout while streaming is a timeout error carrying the partial", { timeout: 15_000 }, async () => {
  const stub = await startStub(async (_q, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify(candidate([{ text: "partial" }]))}\r\n\r\n`);
    await hold(res);
  });
  try {
    const { adapter } = adapterFor(stub, { timeouts: { idleMs: 150 } });
    await assert.rejects(collect(adapter.stream(basic)), (e: unknown) => {
      assert.ok(e instanceof ProviderError);
      assert.equal(e.kind, "timeout");
      assert.equal(e.timeoutPhase, "idle");
      assert.equal(e.partial?.text, "partial");
      return true;
    });
  } finally { await stub.close(); }
});
