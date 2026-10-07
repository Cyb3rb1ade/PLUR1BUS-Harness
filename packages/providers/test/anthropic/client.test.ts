import assert from "node:assert/strict";
import { test } from "node:test";
import { createAnthropicAdapter, secretStoreKey, ProviderError } from "../../src/index.ts";
import type { AnthropicConfig, AnthropicRequest, ChatStreamEvent } from "../../src/index.ts";
import { sseHeaders, startStub } from "../helpers/stub.ts";
import type { Handler, Stub } from "../helpers/stub.ts";

const T = { timeout: 15_000 };
const KEY = "sk-ant-synthetic-CLIENTTEST-0000000000";
const REQ: AnthropicRequest = { model: "claude-synthetic", messages: [{ role: "user", content: "hi" }] };

const frame = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const STREAM_OK = [
  frame("message_start", { message: { id: "msg_1", model: "claude-synthetic", usage: { input_tokens: 12, output_tokens: 1 } } }),
  frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
  frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hello" } }),
  frame("content_block_stop", { index: 0 }),
  frame("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }),
  frame("message_stop", {}),
].join("");
const MESSAGE_OK = { id: "msg_1", type: "message", role: "assistant", model: "claude-synthetic", content: [{ type: "text", text: "Hello" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 12, output_tokens: 7 } };

const sseOk: Handler = (_q, res) => { sseHeaders(res); res.end(STREAM_OK); };
const jsonOk: Handler = (_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(MESSAGE_OK)); };

async function withStub<R>(handler: Handler, fn: (stub: Stub) => Promise<R>): Promise<R> {
  const stub = await startStub(handler);
  try { return await fn(stub); } finally { await stub.close(); }
}
const make = (stub: Stub, over: Partial<AnthropicConfig> = {}) => createAnthropicAdapter({ baseUrl: stub.baseUrl, credentials: { apiKey: () => KEY }, ...over });
const drain = async (gen: AsyncGenerator<ChatStreamEvent, void, void>) => { const out: ChatStreamEvent[] = []; for await (const e of gen) out.push(e); return out; };

test("request: POST {base}/messages with x-api-key, anthropic-version, JSON in, SSE accepted; the key is only in its header", T, async () => {
  await withStub(sseOk, async (stub) => {
    await drain(make(stub, { headers: { "anthropic-beta": "prompt-caching-2024-07-31" } }).stream({ ...REQ, maxTokens: 99 }));
    const r = stub.requests[0]!;
    assert.equal(r.method, "POST");
    assert.equal(r.url, "/v1/messages");
    assert.equal(r.headers["x-api-key"], KEY);
    assert.equal(r.headers["anthropic-version"], "2023-06-01");
    assert.equal(r.headers["anthropic-beta"], "prompt-caching-2024-07-31");
    assert.equal(r.headers["content-type"], "application/json");
    assert.equal(r.headers["accept"], "text/event-stream");
    assert.equal(r.headers["authorization"], undefined);
    assert.deepEqual(JSON.parse(r.body), { model: "claude-synthetic", max_tokens: 99, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], stream: true });
    assert.equal(`${r.url}${r.body}`.includes(KEY), false);
  });
});

test("non-stream: stream:false, accept json, same ChatResult as the stream path", T, async () => {
  const viaJson = await withStub(jsonOk, async (stub) => {
    const result = await make(stub, { version: "2099-01-01", defaultMaxTokens: 321 }).complete(REQ);
    const r = stub.requests[0]!;
    assert.equal(r.headers["accept"], "application/json");
    assert.equal(r.headers["anthropic-version"], "2099-01-01");
    assert.deepEqual(JSON.parse(r.body), { model: "claude-synthetic", max_tokens: 321, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], stream: false });
    return result;
  });
  const viaSse = await withStub(sseOk, async (stub) => {
    const events = await drain(make(stub).stream(REQ));
    const done = events.at(-1)!;
    assert.equal(done.type, "done");
    return (done as Extract<ChatStreamEvent, { type: "done" }>).result;
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

test("the adapter-level cache default and the request-level override reach the wire", T, async () => {
  await withStub(jsonOk, async (stub) => {
    const a = make(stub, { cache: { system: true, ttl: "1h" } });
    const req: AnthropicRequest = { ...REQ, messages: [{ role: "system", content: "S" }, ...REQ.messages] };
    await a.complete(req);
    await a.complete({ ...req, providerOptions: { anthropic: { cache: {} } } });
    await a.complete({ ...req, providerOptions: { anthropic: { cache: { messages: true } } } });
    const sys = (i: number) => (JSON.parse(stub.requests[i]!.body) as { system: object[] }).system;
    assert.deepEqual(sys(0), [{ type: "text", text: "S", cache_control: { type: "ephemeral", ttl: "1h" } }]);
    assert.deepEqual(sys(1), [{ type: "text", text: "S" }]);
    assert.deepEqual(sys(2), [{ type: "text", text: "S" }]);
    assert.equal(JSON.stringify(JSON.parse(stub.requests[2]!.body)).includes("cache_control"), true);
  });
});

test("the key is read from the store on every call (a rotated key is picked up), via secretStoreKey", T, async () => {
  await withStub(jsonOk, async (stub) => {
    let current = "sk-ant-first-0000000000";
    const store = { get: async (ref: string) => (ref === "anthropic:main" ? current : undefined) };
    const a = createAnthropicAdapter({ baseUrl: stub.baseUrl, credentials: secretStoreKey(store, "anthropic:main") });
    await a.complete(REQ);
    current = "sk-ant-second-000000000";
    await a.complete(REQ);
    assert.deepEqual(stub.requests.map((r) => r.headers["x-api-key"]), ["sk-ant-first-0000000000", "sk-ant-second-000000000"]);
  });
});

test("no key, an unusable key and a failing credentials provider are auth errors before any request", T, async () => {
  await withStub(jsonOk, async (stub) => {
    const cases: [string, AnthropicConfig["credentials"]][] = [
      ["missing", { apiKey: () => undefined }], ["empty", { apiKey: () => "" }], ["whitespace", { apiKey: () => "sk ant" }],
      ["newline", { apiKey: () => `${KEY}\n` }], ["throws", { apiKey: () => { throw new Error("vault locked"); } }], ["rejects", { apiKey: () => Promise.reject(new Error("vault locked")) }],
    ];
    for (const [label, credentials] of cases) {
      const e = await createAnthropicAdapter({ baseUrl: stub.baseUrl, credentials }).complete(REQ).then(() => undefined, (x: unknown) => x);
      assert.ok(e instanceof ProviderError && e.kind === "auth" && !e.retryable, label);
    }
    assert.equal(stub.requests.length, 0);
  });
});

test("plain http to a non-loopback host is refused before any I/O; https and loopback are fine", T, async () => {
  const never = (async () => { throw new Error("fetch must not be called"); }) as unknown as typeof fetch;
  const e = await createAnthropicAdapter({ baseUrl: "http://203.0.113.9:8080/v1", credentials: { apiKey: () => KEY }, fetch: never }).complete(REQ).then(() => undefined, (x: unknown) => x);
  assert.ok(e instanceof ProviderError && e.kind === "invalid_request");
  assert.equal(String((e as Error).message).includes(KEY), false);
  let url = "";
  const seen = (async (u: URL) => { url = String(u); return new Response(JSON.stringify(MESSAGE_OK), { headers: { "content-type": "application/json" } }); }) as unknown as typeof fetch;
  await createAnthropicAdapter({ credentials: { apiKey: () => KEY }, fetch: seen }).complete(REQ);
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  await createAnthropicAdapter({ baseUrl: "http://203.0.113.9:8080/v1", credentials: { apiKey: () => KEY }, allowInsecureHttp: true, fetch: seen }).complete(REQ);
  assert.equal(url, "http://203.0.113.9:8080/v1/messages");
});

test("configuration is validated at construction", () => {
  const ok = { credentials: { apiKey: () => KEY } };
  for (const bad of [
    { baseUrl: "not a url" }, { baseUrl: "ftp://x/v1" }, { baseUrl: `https://user:${KEY}@x.invalid/v1` }, { baseUrl: `https://x.invalid/v1?key=${KEY}` }, { baseUrl: `https://x.invalid/v1#${KEY}` },
    { headers: { "x-api-key": KEY } }, { headers: { "Anthropic-Version": "2023-06-01" } }, { headers: { authorization: "Bearer x" } }, { headers: { cookie: "a=b" } }, { headers: { "x-a": "v\r\nx-b: w" } },
    { version: "" }, { version: "2023 06" }, { defaultMaxTokens: 0 }, { defaultMaxTokens: 1.5 },
  ]) assert.throws(() => createAnthropicAdapter({ ...ok, ...bad } as AnthropicConfig), (e: unknown) => e instanceof TypeError && !String(e.message).includes(KEY), JSON.stringify(bad));
});

test("a request the wire cannot express is refused before any I/O", T, async () => {
  await withStub(jsonOk, async (stub) => {
    const e = await make(stub).complete({ ...REQ, messages: [{ role: "assistant", content: "x" }] }).then(() => undefined, (x: unknown) => x);
    assert.ok(e instanceof ProviderError && e.kind === "invalid_request");
    const s = await drain(make(stub).stream({ ...REQ, temperature: 2 })).then(() => undefined, (x: unknown) => x);
    assert.ok(s instanceof ProviderError && s.kind === "invalid_request");
    assert.equal(stub.requests.length, 0);
  });
});

test("HTTP errors carry status, provider type, retry-after; the key never appears", T, async () => {
  const body = (m: string) => JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: m } });
  await withStub((_q, res) => { res.writeHead(429, { "content-type": "application/json", "retry-after": "7" }); res.end(body(`slow down, key ${KEY}`)); }, async (stub) => {
    for (const run of [() => make(stub).complete(REQ), () => drain(make(stub).stream(REQ))]) {
      const e = await run().then(() => undefined, (x: unknown) => x);
      assert.ok(e instanceof ProviderError);
      assert.equal(e.kind, "rate_limit");
      assert.equal(e.retryAfterMs, 7_000);
      assert.equal(e.providerType, "rate_limit_error");
      assert.equal(JSON.stringify([e.message, e.providerMessage]).includes(KEY), false);
      assert.match(e.providerMessage ?? "", /\[redacted\]/);
    }
  });
});

test("a 200 JSON error body on a stream request is classified; any other JSON or content type is a protocol error", T, async () => {
  const run = (handler: Handler) => withStub(handler, (stub) => drain(make(stub).stream(REQ)).then(() => undefined, (x: unknown) => x));
  const e1 = await run((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })); });
  assert.ok(e1 instanceof ProviderError && e1.kind === "overloaded");
  const e2 = await run((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(MESSAGE_OK)); });
  assert.ok(e2 instanceof ProviderError && e2.code === "protocol");
  const e3 = await run((_q, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>"); });
  assert.ok(e3 instanceof ProviderError && e3.code === "protocol");
  const e4 = await run((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{not json"); });
  assert.ok(e4 instanceof ProviderError && e4.code === "protocol");
});

test("non-stream bodies that are not a message fail closed", T, async () => {
  for (const body of ["{not json", JSON.stringify({ type: "error", error: { type: "api_error", message: "x" } }), JSON.stringify({ type: "message", content: [], stop_reason: null }), "[]"]) {
    await withStub((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(body); }, async (stub) => {
      const e = await make(stub).complete(REQ).then(() => undefined, (x: unknown) => x);
      assert.ok(e instanceof ProviderError && (e.code === "protocol" || e.kind === "overloaded"), body);
    });
  }
});

test("a stream that stays open after message_stop still completes (the server's connection is not our concern)", T, async () => {
  await withStub((_q, res) => { sseHeaders(res); res.write(STREAM_OK); /* never ends */ }, async (stub) => {
    const events = await drain(make(stub).stream(REQ));
    assert.equal(events.at(-1)?.type, "done");
  });
});

test("an SSE event cut off before its blank line is dropped, so a stream missing message_stop is truncated", T, async () => {
  await withStub((_q, res) => { sseHeaders(res); res.end(STREAM_OK.replace(/event: message_stop\ndata: \{"type":"message_stop"\}\n\n$/, "event: message_stop\ndata: {\"type\":\"message_stop\"}")); }, async (stub) => {
    const e = await drain(make(stub).stream(REQ)).then(() => undefined, (x: unknown) => x);
    assert.ok(e instanceof ProviderError && e.code === "protocol" && /message_stop/.test(e.message));
    assert.equal((e as ProviderError).partial?.text, "Hello");
  });
});

test("tool-argument repair hook configured on the adapter is used for broken arguments", T, async () => {
  const sse = [
    frame("message_start", { message: { id: "m", model: "x", usage: {} } }),
    frame("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "f", input: {} } }),
    frame("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: "{\"a\":" } }),
    frame("content_block_stop", { index: 0 }),
    frame("message_delta", { delta: { stop_reason: "tool_use" }, usage: {} }),
    frame("message_stop", {}),
  ].join("");
  await withStub((_q, res) => { sseHeaders(res); res.end(sse); }, async (stub) => {
    const a = make(stub, { repair: { repair: () => ({ arguments: { a: 1 } }) } });
    const done = (await drain(a.stream({ ...REQ, tools: [{ name: "f" }] }))).at(-1) as Extract<ChatStreamEvent, { type: "done" }>;
    assert.deepEqual(done.result.toolCalls[0], { id: "toolu_1", name: "f", argumentsRaw: "{\"a\":1}", arguments: { a: 1 }, repaired: true });
  });
});

test("timeouts: a server that never answers ends with a timeout error, not a hang", T, async () => {
  await withStub(() => new Promise<void>(() => { /* never answers */ }), async (stub) => {
    const e = await make(stub, { timeouts: { headersMs: 100, idleMs: 100, totalMs: 300 } }).complete(REQ).then(() => undefined, (x: unknown) => x);
    assert.ok(e instanceof ProviderError && e.kind === "timeout" && e.retryable);
  });
});
