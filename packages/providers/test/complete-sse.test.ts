/** D122 AF1: complete() follows the response media type and shares the streaming parser's limits and errors. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createChatCompletionsAdapter, ProviderError } from "../src/index.ts";
import { basicRequest, credentials, startStub } from "./helpers/stub.ts";

const T = { timeout: 15_000 };
const frame = (value: object) => `data: ${JSON.stringify(value)}\n\n`;
const TEXT = frame({
  id: "synthetic-fm", model: "system", choices: [{ index: 0, delta: { content: "Hallo" }, finish_reason: null }],
});
const FINISH = frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
const USAGE = frame({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } });
const DONE = "data: [DONE]\n\n";

test("complete accepts SSE despite stream:false and returns text, usage and metadata", T, async () => {
  const stub = await startStub((_req, res) => {
    res.writeHead(200, { "content-type": "Text/Event-Stream; charset=utf-8" });
    res.end(TEXT + FINISH + USAGE + DONE);
  });
  try {
    const adapter = createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: credentials() });
    assert.deepEqual(await adapter.complete(basicRequest), {
      text: "Hallo", toolCalls: [], finishReason: "stop", rawFinishReason: "stop",
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
      meta: { id: "synthetic-fm", model: "system" },
    });
    assert.equal(JSON.parse(stub.requests[0]!.body).stream, false);
    assert.equal(stub.requests.length, 1, "content-type handling must not submit a second request");
  } finally {
    await stub.close();
  }
});

test("complete assembles and repairs tool arguments received as SSE", T, async () => {
  const stub = await startStub((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      frame({ choices: [{ index: 0, delta: { tool_calls: [{
        index: 0, id: "c1", function: { name: "weather", arguments: "{'city':" },
      }] }, finish_reason: null }] })
      + frame({ choices: [{ index: 0, delta: { tool_calls: [{
        index: 0, function: { arguments: "'Bern'}" },
      }] }, finish_reason: "tool_calls" }] })
      + DONE,
    );
  });
  try {
    const adapter = createChatCompletionsAdapter({
      baseUrl: stub.baseUrl, credentials: credentials(),
      repair: { repair: ({ call }) => ({ argumentsRaw: call.argumentsRaw.replaceAll("'", "\"") }) },
    });
    const result = await adapter.complete({ ...basicRequest, tools: [{ name: "weather" }] });
    assert.equal(result.finishReason, "tool_calls");
    assert.deepEqual(result.toolCalls, [{
      id: "c1", name: "weather", argumentsRaw: "{\"city\":\"Bern\"}", arguments: { city: "Bern" }, repaired: true,
    }]);
    assert.equal(result.usage, undefined);
  } finally {
    await stub.close();
  }
});

test("complete treats a truncated SSE response as a protocol error with partial content", T, async () => {
  const stub = await startStub((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(TEXT);
  });
  try {
    const adapter = createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: credentials() });
    await assert.rejects(adapter.complete(basicRequest), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "protocol");
      assert.equal(error.partial?.text, "Hallo");
      return true;
    });
  } finally {
    await stub.close();
  }
});

test("complete applies allowMissingDone only after an SSE finish reason", T, async () => {
  const stub = await startStub((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(TEXT + FINISH);
  });
  try {
    const adapter = createChatCompletionsAdapter({
      baseUrl: stub.baseUrl, credentials: credentials(), allowMissingDone: true,
    });
    assert.equal((await adapter.complete(basicRequest)).text, "Hallo");
  } finally {
    await stub.close();
  }
});

test("complete classifies provider errors sent inside a 200 SSE response", T, async () => {
  const stub = await startStub((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: {\"error\":{\"type\":\"server_error\",\"message\":\"synthetic failure\"}}\n\n");
  });
  try {
    const adapter = createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: credentials() });
    await assert.rejects(adapter.complete(basicRequest), (error: unknown) =>
      error instanceof ProviderError && error.kind === "overloaded" && error.providerType === "server_error");
  } finally {
    await stub.close();
  }
});
