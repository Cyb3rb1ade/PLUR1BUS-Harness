/** D122 AF1: local-model policy is enforced before any Unix I/O; the fake server exercises the real wire adapter. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createChatCompletionsAdapter, createLocalChatAdapter, createUnixFetch, NO_AUTH, ProviderError,
} from "../../src/index.ts";
import type { ChatRequest, ChatResult, ChatStreamEvent, LocalAdapterEndpoint } from "../../src/index.ts";
import { startFakeFmServe } from "../fixtures/fake-fm-serve.ts";
import type { FakeFmOptions, FakeFmServe } from "../fixtures/fake-fm-serve.ts";

const T = { timeout: 15_000 };
const POSIX = { ...T, skip: process.platform === "win32" && "D122: native Unix socket tests require POSIX" };
const ENDPOINT = { state: "ok" as const, baseUrl: "http://apple-fm.invalid/v1", socket: "managed:apple-fm" as const };
const REQUEST: ChatRequest = { model: "system", messages: [{ role: "user", content: "synthetic greeting" }] };

function adapter(fm: FakeFmServe, extra = {}) {
  return createLocalChatAdapter(ENDPOINT, createChatCompletionsAdapter, extra, {
    unix: { socket: fm.socket, guard: { verify: () => ({ ok: true }) } },
  });
}

async function drain(events: AsyncGenerator<ChatStreamEvent>): Promise<ChatResult | undefined> {
  let result: ChatResult | undefined;
  for await (const event of events) if (event.type === "done") result = event.result;
  return result;
}

test("Unix local adapter uses NO_AUTH, the fixed origin and max_completion_tokens", POSIX, async () => {
  const fm = await startFakeFmServe();
  try {
    let credentials;
    const local = createLocalChatAdapter(ENDPOINT, (config) => {
      credentials = config.credentials;
      return createChatCompletionsAdapter(config);
    }, undefined, { unix: { socket: fm.socket, guard: { verify: () => ({ ok: true }) } } });
    assert.equal(credentials, NO_AUTH);
    const result = await local.complete({ ...REQUEST, maxTokens: 8 });
    assert.equal(result.text, "Hallo");
    assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 3, totalTokens: 15 });
    const sent = JSON.parse(fm.requests[0]!.body);
    assert.equal(sent.stream, false);
    assert.equal(sent.max_completion_tokens, 8);
    assert.equal(sent.max_tokens, undefined);
    for (const header of ["authorization", "proxy-authorization", "cookie"]) {
      assert.equal(fm.requests[0]?.headers[header], undefined);
    }
  } finally {
    await fm.close();
  }
});

test("Unix local adapter refuses pcc and unknown ids on both APIs with zero bytes or guard calls", POSIX, async () => {
  const fm = await startFakeFmServe();
  let verifies = 0;
  try {
    const local = createLocalChatAdapter(ENDPOINT, createChatCompletionsAdapter, undefined, {
      unix: { socket: fm.socket, guard: { verify: () => {
        verifies++;
        return { ok: true };
      } } },
    });
    for (const model of ["pcc", "custom", "System", "system ", "apple-fm/system"]) {
      for (const call of [
        () => local.complete({ ...REQUEST, model }), () => drain(local.stream({ ...REQUEST, model })),
      ]) {
        await assert.rejects(call(), (error: unknown) =>
          error instanceof ProviderError && error.kind === "invalid_request" && error.code === "model_not_allowed"
          && error.retryable === false);
      }
    }
    assert.equal(verifies, 0);
    assert.equal(fm.requests.length, 0);
    assert.equal(fm.connections(), 0);
  } finally {
    await fm.close();
  }
});

test("Unix local adapter refuses images and every reasoning directive before guard or connection", POSIX, async () => {
  const fm = await startFakeFmServe();
  try {
    const local = adapter(fm);
    const requests: ChatRequest[] = [
      { ...REQUEST, messages: [{ role: "user", content: [
        { type: "image_url", url: "https://synthetic.invalid/image" },
      ] }] },
      { ...REQUEST, reasoning: { vendorParam: "reasoning_effort", value: "low" } },
      { ...REQUEST, reasoning: { vendorParam: "chat_template_kwargs.enable_thinking", value: false } },
    ];
    for (const request of requests) {
      for (const call of [() => local.complete(request), () => drain(local.stream(request))]) {
        await assert.rejects(call(), (error: unknown) =>
          error instanceof ProviderError && error.kind === "invalid_request" && !error.retryable);
      }
    }
    assert.equal(fm.requests.length, 0);
  } finally {
    await fm.close();
  }
});

test("Unix adapter refuses credentials, auth headers, caller fetches and paths in a profile", POSIX, async () => {
  const fm = await startFakeFmServe();
  try {
    for (const extra of [
      { credentials: NO_AUTH }, { headers: new Headers({ Authorization: "synthetic" }) },
      { headers: { Cookie: "synthetic" } }, { fetch: globalThis.fetch }, { socket: fm.socket.path },
    ]) assert.throws(() => adapter(fm, extra), TypeError);
    const bad = { ...ENDPOINT, socket: fm.socket.path } as unknown as LocalAdapterEndpoint;
    assert.throws(() => createLocalChatAdapter(bad, createChatCompletionsAdapter,
      undefined, { unix: { socket: fm.socket, guard: { verify: () => ({ ok: true }) } } }), TypeError);
    assert.throws(() => createLocalChatAdapter({ ...ENDPOINT, baseUrl: "http://127.0.0.1/v1" },
      createChatCompletionsAdapter, undefined,
      { unix: { socket: fm.socket, guard: { verify: () => ({ ok: true }) } } }), TypeError);
    assert.equal(fm.requests.length, 0);
  } finally {
    await fm.close();
  }
});

test("Unix SSE streaming keeps content-finish-usage-done ordering and complete returns the same result", POSIX, async () => {
  const fm = await startFakeFmServe();
  try {
    const local = adapter(fm);
    const events: ChatStreamEvent[] = [];
    for await (const event of local.stream(REQUEST)) events.push(event);
    assert.deepEqual(events.map((event) => event.type), ["text_delta", "finish", "usage", "done"]);
    const done = events.at(-1);
    assert.ok(done?.type === "done");
    assert.deepEqual(await local.complete(REQUEST), done.result);
    assert.deepEqual(JSON.parse(fm.requests[0]!.body).stream_options, { include_usage: true });
  } finally {
    await fm.close();
  }
});

test("Unix tool schemas, forced choice and parallel_tool_calls round-trip without rewriting", POSIX, async () => {
  const fm = await startFakeFmServe({ mode: "tools" });
  try {
    const request: ChatRequest = {
      ...REQUEST, tools: [{
        name: "weather", parameters: { type: "object", properties: { city: { type: "string" } } },
      }],
      toolChoice: { name: "weather" }, parallelToolCalls: true,
    };
    const result = await adapter(fm).complete(request);
    assert.equal(result.finishReason, "tool_calls");
    assert.deepEqual(result.toolCalls, [{
      id: "weather-1", name: "weather", argumentsRaw: "{\"city\":\"Bern\"}", arguments: { city: "Bern" },
    }]);
    const sent = JSON.parse(fm.requests[0]!.body);
    assert.deepEqual(sent.tools[0].function.parameters, {
      type: "object", properties: { city: { type: "string" } },
    });
    assert.deepEqual(sent.tool_choice, { type: "function", function: { name: "weather" } });
    assert.equal(sent.parallel_tool_calls, true);
  } finally {
    await fm.close();
  }
});

test("Unix json_schema output is returned as text and missing usage remains absent", POSIX, async () => {
  const fm = await startFakeFmServe({ mode: "schema", usage: false });
  try {
    const result = await adapter(fm).complete({ ...REQUEST, responseFormat: {
      type: "json_schema", name: "category", strict: true,
      schema: { type: "object", properties: { category: { enum: ["reminder", "other"] } } },
    } });
    assert.equal(result.text, "{\"category\":\"reminder\"}");
    assert.equal(result.usage, undefined);
    assert.deepEqual(JSON.parse(fm.requests[0]!.body).response_format, {
      type: "json_schema", json_schema: { name: "category", strict: true,
        schema: { type: "object", properties: { category: { enum: ["reminder", "other"] } } } },
    });
  } finally {
    await fm.close();
  }
});

test("Unix adapter maps the native HTTP 500 transcript overflow to a non-retryable context_overflow", POSIX, async () => {
  const fm = await startFakeFmServe({ mode: "overflow" });
  try {
    const local = adapter(fm);
    for (const call of [() => local.complete(REQUEST), () => drain(local.stream(REQUEST))]) {
      await assert.rejects(call(), (error: unknown) =>
        error instanceof ProviderError && error.kind === "invalid_request" && error.code === "context_overflow"
        && error.status === 500 && error.retryable === false);
    }
  } finally {
    await fm.close();
  }
});

test("Unix adapter honours optional DONE tolerance only after finish", POSIX, async () => {
  const options: FakeFmOptions = { format: "always-sse", missingDone: true, missingFinish: false };
  const fm = await startFakeFmServe(options);
  try {
    assert.equal((await adapter(fm, { allowMissingDone: true }).complete(REQUEST)).text, "Hallo");
    await assert.rejects(adapter(fm).complete(REQUEST), (error: unknown) =>
      error instanceof ProviderError && error.code === "protocol");
    options.missingFinish = true;
    await assert.rejects(adapter(fm, { allowMissingDone: true }).complete(REQUEST), (error: unknown) =>
      error instanceof ProviderError && error.code === "protocol");
  } finally {
    await fm.close();
  }
});

test("Unix disconnect is non-retryable network/unavailable with received partial content", POSIX, async () => {
  const fm = await startFakeFmServe({ mode: "hang" });
  try {
    const stream = adapter(fm).stream(REQUEST);
    assert.deepEqual((await stream.next()).value, { type: "text_delta", text: "Hallo" });
    fm.disconnect();
    await assert.rejects(stream.next(), (error: unknown) =>
      error instanceof ProviderError && error.kind === "network" && error.code === "unavailable"
      && error.partial?.text === "Hallo" && error.retryable === false);
  } finally {
    await fm.close();
  }
});

test("leaving a Unix stream early closes its socket", POSIX, async () => {
  const fm = await startFakeFmServe({ mode: "hang" });
  try {
    for await (const event of adapter(fm).stream(REQUEST)) {
      assert.equal(event.type, "text_delta");
      break;
    }
    await fm.waitForDisconnect();
  } finally {
    await fm.close();
  }
});

test("Unix adapter caps inference concurrency at one and releases capacity after cancellation", POSIX, async () => {
  const options = { mode: "hang-headers" as "hang-headers" | "text" };
  const fm = await startFakeFmServe(options);
  const controller = new AbortController();
  try {
    const local = adapter(fm);
    const first = local.complete(REQUEST, { signal: controller.signal });
    const cancelled = assert.rejects(first, (error: unknown) =>
      error instanceof ProviderError && error.kind === "aborted");
    await fm.waitForRequests(1);
    await assert.rejects(local.complete(REQUEST), (error: unknown) =>
      error instanceof ProviderError && error.code === "busy" && !error.retryable);
    assert.equal(fm.requests.length, 1);
    controller.abort();
    await cancelled;
    options.mode = "text";
    assert.equal((await local.complete(REQUEST)).text, "Hallo");
  } finally {
    controller.abort();
    await fm.close();
  }
});

test("Unix adapter returns invalid_request for malformed neutral messages before connection", POSIX, async () => {
  const fm = await startFakeFmServe();
  try {
    await assert.rejects(adapter(fm).complete({ ...REQUEST, messages: null } as unknown as ChatRequest),
      (error: unknown) => error instanceof ProviderError && error.kind === "invalid_request");
    assert.equal(fm.requests.length, 0);
  } finally {
    await fm.close();
  }
});

test("Unix adapter does not retain an invalid auth header value in its construction error", POSIX, async () => {
  const fm = await startFakeFmServe();
  try {
    assert.throws(() => adapter(fm, { headers: { Authorization: "synthetic-private-marker\r\nheader" } }),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.doesNotMatch(String(error), /synthetic-private-marker/);
        assert.equal(error.cause, undefined);
        return true;
      });
    assert.equal(fm.requests.length, 0);
  } finally {
    await fm.close();
  }
});

test("Unix complete and stream apply the headers and idle deadlines and release capacity", POSIX, async () => {
  const options = { mode: "hang-headers" as "hang-headers" | "hang" | "text" };
  const fm = await startFakeFmServe(options);
  try {
    const local = adapter(fm);
    for (const mode of ["hang-headers", "hang"] as const) {
      options.mode = mode;
      // Only the bound being exercised can win, even if a shared runner is slow to deliver otherwise-valid headers.
      const timeouts = { headersMs: mode === "hang" ? 600_000 : 50, idleMs: 50 };
      for (const call of [() => local.complete(REQUEST, { timeouts }),
        () => drain(local.stream(REQUEST, { timeouts }))]) {
        await assert.rejects(call(), (error: unknown) => error instanceof ProviderError && error.kind === "timeout"
          && error.timeoutPhase === (mode === "hang" ? "idle" : "headers"));
        await fm.waitForDisconnect();
      }
    }
    options.mode = "text";
    assert.equal((await local.complete(REQUEST)).text, "Hallo");
  } finally {
    await fm.close();
  }
});

test("Unix adapter tolerates a synthetic immediate transcript error inside HTTP 200 SSE", POSIX, async () => {
  const fm = await startFakeFmServe({ handler: (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const error = {
      message: "The session's transcript exceeded the model's context size.", type: "server_error", code: "500",
    };
    response.end(`data: ${JSON.stringify({ error })}\n\n`);
  } });
  try {
    const local = adapter(fm);
    for (const call of [() => local.complete(REQUEST), () => drain(local.stream(REQUEST))]) {
      await assert.rejects(call(), (error: unknown) => error instanceof ProviderError
        && error.kind === "invalid_request" && error.code === "context_overflow" && !error.retryable);
    }
  } finally {
    await fm.close();
  }
});

test("Unix adapter preserves native overflow after an SSE role chunk without DONE and releases capacity", POSIX, async () => {
  const options: FakeFmOptions = { mode: "stream-overflow" };
  const fm = await startFakeFmServe(options);
  try {
    const local = adapter(fm);
    for (const call of [() => local.complete(REQUEST), () => drain(local.stream(REQUEST))]) {
      await assert.rejects(call(), (error: unknown) => error instanceof ProviderError
        && error.kind === "invalid_request" && error.code === "context_overflow" && !error.retryable);
    }
    assert.deepEqual(fm.requests.map(request => JSON.parse(request.body).stream), [false, true]);
    options.mode = "text";
    assert.equal((await local.complete(REQUEST)).text, "Hallo");
  } finally {
    await fm.close();
  }
});

for (const mode of ["text", "tools", "schema"] as const) {
  test(`native JSON and synthetic always-SSE complete preserve ${mode} and usage`, POSIX, async () => {
    for (const format of ["native", "always-sse"] as const) {
      const fm = await startFakeFmServe({ mode, format });
      try {
        const fetch = createUnixFetch(fm.socket, { guard: { verify: () => ({ ok: true }) } });
        const response = await fetch("http://apple-fm.invalid/v1/chat/completions", {
          method: "POST", body: JSON.stringify({ model: "system", stream: false }),
        });
        assert.match(response.headers.get("content-type") ?? "",
          format === "native" ? /^application\/json/ : /^text\/event-stream/);
        await response.text();
        const result = await adapter(fm).complete(REQUEST);
        assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 3, totalTokens: 15 });
        if (mode === "tools") {
          assert.equal(result.toolCalls[0]?.name, "weather");
          assert.deepEqual(result.toolCalls[0]?.arguments, { city: "Bern" });
          assert.equal(result.finishReason, "tool_calls");
        } else assert.equal(result.text, mode === "schema" ? "{\"category\":\"reminder\"}" : "Hallo");
        const omitted = await fetch("http://apple-fm.invalid/v1/chat/completions", {
          method: "POST", body: JSON.stringify({ model: "system" }),
        });
        assert.match(omitted.headers.get("content-type") ?? "", /^text\/event-stream/);
        assert.match(await omitted.text(), /\[DONE\]/);
      } finally {
        await fm.close();
      }
    }
  });
}
