import assert from "node:assert/strict";
import { test } from "node:test";
import { createResponsesAdapter, ProviderError } from "../../src/index.ts";
import type { ChatStreamEvent, ResponsesConfig, ResponsesRequest } from "../../src/index.ts";
import { sseHeaders, startStub } from "../helpers/stub.ts";
import type { Handler, Stub } from "../helpers/stub.ts";

const T = { timeout: 15_000 };
const TOKEN = "sk-synthetic-CLIENTTEST-0000000000";
const AUTH = `Bearer ${TOKEN}`;
const REQ: ResponsesRequest = { model: "gpt-synthetic", messages: [{ role: "user", content: "hi" }] };

const frame = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const STREAM_OK = [
  frame("response.created", { response: { id: "resp_1", model: "gpt-synthetic" } }),
  frame("response.output_item.added", { output_index: 0, item: { type: "message", id: "msg_1" } }),
  frame("response.output_text.delta", { output_index: 0, content_index: 0, delta: "Hello" }),
  frame("response.output_item.done", { output_index: 0, item: { type: "message", id: "msg_1" } }),
  frame("response.completed", { response: { id: "resp_1", model: "gpt-synthetic", status: "completed", usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 } } }),
].join("");
const RESPONSE_OK = { id: "resp_1", object: "response", status: "completed", model: "gpt-synthetic", output: [{ type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "Hello" }] }], usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 } };

const sseOk: Handler = (_q, res) => { sseHeaders(res); res.end(STREAM_OK); };
const jsonOk: Handler = (_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(RESPONSE_OK)); };

async function withStub<R>(handler: Handler, fn: (stub: Stub) => Promise<R>): Promise<R> {
  const stub = await startStub(handler);
  try { return await fn(stub); } finally { await stub.close(); }
}
const make = (stub: Stub, over: Partial<ResponsesConfig> = {}) => createResponsesAdapter({ baseUrl: stub.baseUrl, credentials: { authorization: () => AUTH }, ...over });
const drain = async (gen: AsyncGenerator<ChatStreamEvent, void, void>) => { const out: ChatStreamEvent[] = []; for await (const e of gen) out.push(e); return out; };
const fails = (p: Promise<unknown>) => p.then(() => undefined, (x: unknown) => x);

test("request: POST {base}/responses with the Authorization header, JSON in, SSE accepted; the token is only in its header", T, async () => {
  await withStub(sseOk, async (stub) => {
    await drain(make(stub, { headers: { "openai-beta": "responses=v1" } }).stream({ ...REQ, maxTokens: 99 }));
    const r = stub.requests[0]!;
    assert.equal(r.method, "POST");
    assert.equal(r.url, "/v1/responses");
    assert.equal(r.headers["authorization"], AUTH);
    assert.equal(r.headers["openai-beta"], "responses=v1");
    assert.equal(r.headers["accept"], "text/event-stream");
    const b = JSON.parse(r.body);
    assert.deepEqual([b.model, b.stream, b.store, b.max_output_tokens], ["gpt-synthetic", true, false, 99]);
    assert.deepEqual(b.input, [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }]);
    assert.equal(`${r.url}${r.body}`.includes(TOKEN), false);
  });
});

test("non-stream: stream:false, accept json, same ChatResult as the stream path", T, async () => {
  const viaJson = await withStub(jsonOk, async (stub) => {
    const result = await make(stub).complete(REQ);
    const r = stub.requests[0]!;
    assert.equal(r.headers["accept"], "application/json");
    assert.equal(JSON.parse(r.body).stream, false);
    return result;
  });
  const viaSse = await withStub(sseOk, async (stub) => {
    const done = (await drain(make(stub).stream(REQ))).at(-1) as Extract<ChatStreamEvent, { type: "done" }>;
    assert.equal(done.type, "done");
    return done.result;
  });
  assert.deepEqual(viaJson, viaSse);
  assert.equal(viaJson.text, "Hello");
  assert.deepEqual(viaJson.usage, { inputTokens: 12, outputTokens: 7, totalTokens: 19 });
});

test("event order of a successful stream: content, finish, usage, done", T, async () => {
  await withStub(sseOk, async (stub) => {
    assert.deepEqual((await drain(make(stub).stream(REQ))).map((e) => e.type), ["text_delta", "finish", "usage", "done"]);
  });
});

test("reasoning options: the adapter default, overridden by the request's providerOptions", T, async () => {
  await withStub(jsonOk, async (stub) => {
    const a = make(stub, { reasoningEffort: "low", reasoningSummary: "auto" });
    await a.complete(REQ);
    await a.complete({ ...REQ, providerOptions: { responses: { reasoningEffort: "high", store: true } } });
    const [first, second] = stub.requests.map((r) => JSON.parse(r.body));
    assert.deepEqual(first.reasoning, { effort: "low", summary: "auto" });
    assert.equal(first.store, false);
    assert.deepEqual(second.reasoning, { effort: "high", summary: "auto" });
    assert.equal(second.store, true);
  });
});

test("chatgpt_plan: complete() streams on the wire and returns the collected result; store is forced off; instructions are required", T, async () => {
  await withStub(sseOk, async (stub) => {
    const a = make(stub, { profile: "chatgpt_plan", headers: { "chatgpt-account-id": "acct_synthetic_000000" } });
    const req: ResponsesRequest = { ...REQ, messages: [{ role: "system", content: "Be brief." }, ...REQ.messages] };
    const result = await a.complete(req);
    assert.equal(result.text, "Hello");
    const r = stub.requests[0]!;
    assert.equal(r.headers["accept"], "text/event-stream");
    assert.equal(r.headers["chatgpt-account-id"], "acct_synthetic_000000");
    const b = JSON.parse(r.body);
    assert.deepEqual([b.stream, b.store, b.instructions], [true, false, "Be brief."]);
    const e = await fails(a.complete(REQ));
    assert.ok(e instanceof ProviderError && e.kind === "invalid_request");
    const t = await fails(a.complete({ ...req, temperature: 0.2 }));
    assert.ok(t instanceof ProviderError && t.kind === "invalid_request");
    assert.equal(stub.requests.length, 1, "refused before any I/O");
  });
});

test("the Authorization value is read on every call (a rotated token is picked up)", T, async () => {
  await withStub(jsonOk, async (stub) => {
    let current = "Bearer sk-first-0000000000";
    const a = make(stub, { credentials: { authorization: () => current } });
    await a.complete(REQ);
    current = "Bearer sk-second-000000000";
    await a.complete(REQ);
    assert.deepEqual(stub.requests.map((r) => r.headers["authorization"]), ["Bearer sk-first-0000000000", "Bearer sk-second-000000000"]);
  });
});

test("an unusable Authorization value and a failing credentials provider are auth errors before any request; no value means no header", T, async () => {
  await withStub(jsonOk, async (stub) => {
    const cases: [string, ResponsesConfig["credentials"]][] = [
      ["empty", { authorization: () => "" }], ["newline", { authorization: () => `${AUTH}\n` }],
      ["throws", { authorization: () => { throw new Error("vault locked"); } }], ["rejects", { authorization: () => Promise.reject(new Error("vault locked")) }],
    ];
    for (const [label, credentials] of cases) {
      const e = await fails(createResponsesAdapter({ baseUrl: stub.baseUrl, credentials }).complete(REQ));
      assert.ok(e instanceof ProviderError && e.kind === "auth" && !e.retryable, label);
    }
    assert.equal(stub.requests.length, 0);
    await createResponsesAdapter({ baseUrl: stub.baseUrl, credentials: { authorization: () => undefined } }).complete(REQ);
    assert.equal(stub.requests[0]!.headers["authorization"], undefined);
  });
});

test("plain http to a non-loopback host is refused before any I/O; https and loopback are fine", T, async () => {
  const never = (async () => { throw new Error("fetch must not be called"); }) as unknown as typeof fetch;
  const e = await fails(createResponsesAdapter({ baseUrl: "http://203.0.113.9:8080/v1", credentials: { authorization: () => AUTH }, fetch: never }).complete(REQ));
  assert.ok(e instanceof ProviderError && e.kind === "invalid_request");
  assert.equal(String((e as Error).message).includes(TOKEN), false);
  let url = "";
  const seen = (async (u: URL) => { url = String(u); return new Response(JSON.stringify(RESPONSE_OK), { headers: { "content-type": "application/json" } }); }) as unknown as typeof fetch;
  await createResponsesAdapter({ credentials: { authorization: () => AUTH }, fetch: seen }).complete(REQ);
  assert.equal(url, "https://api.openai.com/v1/responses");
  await createResponsesAdapter({ baseUrl: "http://203.0.113.9:8080/v1", credentials: { authorization: () => AUTH }, allowInsecureHttp: true, fetch: seen }).complete(REQ);
  assert.equal(url, "http://203.0.113.9:8080/v1/responses");
});

test("configuration is validated at construction", () => {
  const ok = { credentials: { authorization: () => AUTH } };
  for (const bad of [
    { baseUrl: "not a url" }, { baseUrl: "ftp://x/v1" }, { baseUrl: `https://user:${TOKEN}@x.invalid/v1` }, { baseUrl: `https://x.invalid/v1?key=${TOKEN}` }, { baseUrl: `https://x.invalid/v1#${TOKEN}` },
    { headers: { Authorization: AUTH } }, { headers: { cookie: "a=b" } }, { headers: { "x-a": "v\r\nx-b: w" } },
    { profile: "other" }, { profile: "chatgpt_plan", store: true },
  ]) assert.throws(() => createResponsesAdapter({ ...ok, ...bad } as ResponsesConfig), (e: unknown) => e instanceof TypeError && !String(e.message).includes(TOKEN), JSON.stringify(bad));
});

test("a request the wire cannot express is refused before any I/O", T, async () => {
  await withStub(jsonOk, async (stub) => {
    const e = await fails(make(stub).complete({ ...REQ, stop: ["x"] }));
    assert.ok(e instanceof ProviderError && e.kind === "invalid_request");
    const s = await fails(drain(make(stub).stream({ ...REQ, messages: [{ role: "tool", toolCallId: "c", content: "x" }] })));
    assert.ok(s instanceof ProviderError && s.kind === "invalid_request");
    assert.equal(stub.requests.length, 0);
  });
});

test("HTTP errors carry status, code, reset headers; the token never appears", T, async () => {
  const body = (m: string) => JSON.stringify({ error: { message: m, type: "requests", code: "rate_limit_exceeded" } });
  await withStub((_q, res) => { res.writeHead(429, { "content-type": "application/json", "x-ratelimit-reset-requests": "6m0s" }); res.end(body(`slow down, token ${TOKEN}`)); }, async (stub) => {
    for (const run of [() => make(stub).complete(REQ), () => drain(make(stub).stream(REQ))]) {
      const e = await fails(run());
      assert.ok(e instanceof ProviderError);
      assert.equal(e.kind, "rate_limit");
      assert.equal(e.retryAfterMs, 360_000);
      assert.equal(e.code, "rate_limit_exceeded");
      assert.equal(JSON.stringify([e.message, e.providerMessage]).includes(TOKEN), false);
      assert.match(e.providerMessage ?? "", /\[redacted\]/);
    }
  });
});

test("a 200 JSON error body on a stream request is classified; any other JSON or content type is a protocol error", T, async () => {
  const run = (handler: Handler) => withStub(handler, (stub) => fails(drain(make(stub).stream(REQ))));
  const e1 = await run((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: "server_is_overloaded", message: "Overloaded" } })); });
  assert.ok(e1 instanceof ProviderError && e1.kind === "overloaded");
  const e2 = await run((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(RESPONSE_OK)); });
  assert.ok(e2 instanceof ProviderError && e2.code === "protocol");
  const e3 = await run((_q, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>"); });
  assert.ok(e3 instanceof ProviderError && e3.code === "protocol");
  const e4 = await run((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{not json"); });
  assert.ok(e4 instanceof ProviderError && e4.code === "protocol");
});

test("non-stream bodies that are not a finished response fail closed", T, async () => {
  for (const body of ["{not json", JSON.stringify({ error: { code: "server_error", message: "x" } }), JSON.stringify({ status: "in_progress", output: [] }), "[]"]) {
    await withStub((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(body); }, async (stub) => {
      const e = await fails(make(stub).complete(REQ));
      assert.ok(e instanceof ProviderError && (e.code === "protocol" || e.kind === "overloaded"), body);
    });
  }
});

test("a stream that stays open after response.completed still completes; [DONE] and keep-alives are ignored", T, async () => {
  await withStub((_q, res) => { sseHeaders(res); res.write(`: keep-alive\n\ndata: [DONE]\n\n${STREAM_OK}`); /* never ends */ }, async (stub) => {
    const events = await drain(make(stub).stream(REQ));
    assert.equal(events.at(-1)?.type, "done");
  });
});

test("an SSE event cut off before its blank line is dropped, so a stream missing response.completed is truncated", T, async () => {
  await withStub((_q, res) => { sseHeaders(res); res.end(STREAM_OK.replace(/\n\n$/, "")); }, async (stub) => {
    const e = await fails(drain(make(stub).stream(REQ)));
    assert.ok(e instanceof ProviderError && e.code === "protocol" && /response\.completed/.test(e.message));
    assert.equal((e as ProviderError).partial?.text, "Hello");
  });
});

test("response.failed inside a 200 stream is classified and carries what had arrived", T, async () => {
  const sse = STREAM_OK.replace(/event: response\.completed[\s\S]*$/, "") + frame("response.failed", { response: { status: "failed", error: { code: "server_is_overloaded", message: "busy" } } });
  await withStub((_q, res) => { sseHeaders(res); res.end(sse); }, async (stub) => {
    const e = await fails(drain(make(stub).stream(REQ)));
    assert.ok(e instanceof ProviderError && e.kind === "overloaded" && e.retryable);
    assert.equal(e.partial?.text, "Hello");
  });
});

test("tool-argument repair hook configured on the adapter is used for broken arguments", T, async () => {
  const sse = [
    frame("response.created", { response: { id: "r", model: "x" } }),
    frame("response.output_item.added", { output_index: 0, item: { type: "function_call", call_id: "call_1", name: "f", arguments: "" } }),
    frame("response.function_call_arguments.delta", { output_index: 0, delta: "{\"a\":" }),
    frame("response.output_item.done", { output_index: 0, item: { type: "function_call" } }),
    frame("response.completed", { response: { status: "completed" } }),
  ].join("");
  await withStub((_q, res) => { sseHeaders(res); res.end(sse); }, async (stub) => {
    const a = make(stub, { repair: { repair: () => ({ arguments: { a: 1 } }) } });
    const done = (await drain(a.stream({ ...REQ, tools: [{ name: "f" }] }))).at(-1) as Extract<ChatStreamEvent, { type: "done" }>;
    assert.deepEqual(done.result.toolCalls[0], { id: "call_1", name: "f", argumentsRaw: "{\"a\":1}", arguments: { a: 1 }, repaired: true });
  });
});

test("timeouts: a server that never answers ends with a timeout error, not a hang", T, async () => {
  await withStub(() => new Promise<void>(() => { /* never answers */ }), async (stub) => {
    const e = await fails(make(stub, { timeouts: { headersMs: 100, idleMs: 100, totalMs: 300 } }).complete(REQ));
    assert.ok(e instanceof ProviderError && e.kind === "timeout" && e.retryable);
  });
});
