// W1: record the frozen providers on loopback. Replay the actual request bytes and event/result envelopes.
import { fileURLToPath } from "node:url";
import {
  createAnthropicAdapter, createChatCompletionsAdapter, createGeminiAdapter, createResponsesAdapter,
  ProviderError,
  type ChatRequest, type ToolArgumentRepair,
} from "../../packages/providers/src/index.ts";
import { startStub, writeAll } from "../../packages/providers/test/helpers/stub.ts";
import { exporterMain } from "./lib.mjs";

const wires = ["chat_completions", "anthropic_messages", "codex_responses", "gemini"] as const;
type Wire = typeof wires[number];
type Mode = "stream" | "complete";
type Options = { allowMissingDone: boolean; repair?: boolean };
type Reply = { status: number; headers: Record<string, string>; chunks: Buffer[] };

const credential = "fixture-credential";
const creds = { apiKey: () => credential, authorization: () => `Bearer ${credential}` };
const input: ChatRequest = {
  model: "fixture-model",
  messages: [{ role: "system", content: "Answer briefly." }, { role: "user", content: "Grüße 👋" }],
  maxTokens: 64,
  temperature: 0,
};

function make(wire: Wire, baseUrl: string, options: Options) {
  const repair: ToolArgumentRepair | undefined = options.repair ? {
    repair: ({ tool }) => tool?.name === "inspect" ? { arguments: { fixed: true } } : undefined,
  } : undefined;
  const config = { baseUrl, credentials: creds, repair };
  switch (wire) {
    case "chat_completions": return createChatCompletionsAdapter({ ...config, allowMissingDone: options.allowMissingDone });
    case "anthropic_messages": return createAnthropicAdapter(config);
    case "codex_responses": return createResponsesAdapter(config);
    case "gemini": return createGeminiAdapter(config);
  }
}

function errorShape(error: unknown) {
  if (!(error instanceof ProviderError)) throw error;
  return {
    kind: error.kind, code: error.code, message: error.message, status: error.status,
    retryable: error.retryable, partial: error.partial,
    providerType: error.providerType, providerMessage: error.providerMessage,
    retryAfterMs: error.retryAfterMs, timeoutPhase: error.timeoutPhase, contentFiltered: error.contentFiltered,
  };
}

async function record(wire: Wire, name: string, mode: Mode, response: Reply, options: Options = { allowMissingDone: false }, requestInput = input) {
  const stub = await startStub(async (_request, reply) => {
    reply.writeHead(response.status, response.headers);
    await writeAll(reply, response.chunks);
    reply.end();
  });
  try {
    const adapter = make(wire, stub.baseUrl, options);
    const events = [];
    let result;
    let error;
    try {
      if (mode === "stream") {
        for await (const event of adapter.stream(requestInput)) events.push(event);
      } else result = await adapter.complete(requestInput);
    } catch (caught) { error = errorShape(caught); }
    const request = stub.requests[0];
    if (stub.requests.length !== 1 || !request || request.body.includes(credential)) {
      throw new Error(`${name}: expected one credential-free request body`);
    }
    const names = ["accept", "content-type", "anthropic-version", "authorization", "x-api-key", "x-goog-api-key"];
    const headers = Object.fromEntries(names.flatMap((key) => {
      const value = request.headers[key];
      if (typeof value !== "string") return [];
      return [[key, value.replace(credential, "[REDACTED:secret]")]];
    }));
    return {
      name, mode, requestJson: JSON.stringify(requestInput), options,
      request: { method: request.method, path: request.url, headers, bodyText: request.body },
      response: { status: response.status, headers: response.headers, chunksBase64: response.chunks.map(c => c.toString("base64")) },
      expected: { events, result, error },
    };
  } finally {
    await stub.close();
  }
}

function checkBodylessConstructor(status: 204 | 205): { throws: string } {
  try {
    // Isolate the conversion. Do not invoke the core's asynchronous transport.
    new Response(new ReadableStream<Uint8Array>(), { status });
  } catch (error) {
    if (error instanceof TypeError) return { throws: error.name };
    throw error;
  }
  throw new Error("Node accepted a stream for a bodyless status");
}

async function bodyless(wire: Wire) {
  const exchanges = [];
  const media = [
    { name: "json", headers: { "content-type": "application/json" } },
    { name: "sse", headers: { "content-type": "text/event-stream" } },
    { name: "untyped", headers: {} },
  ];
  for (const { name, headers } of media) {
    for (const mode of ["complete", "stream"] as const) {
      const reference = await record(wire, `${mode}-${name}-empty-200`, mode, { status: 200, headers, chunks: [] });
      if (!reference.expected.error) throw new Error("the empty reference response must fail");
      exchanges.push(reference);
      for (const status of [204, 205, 304] as const) {
        exchanges.push({
          ...reference,
          name: `${mode}-${name}-empty-${status}`,
          response: { status, headers },
          "expected-divergence": "P4D-40",
          ...(status === 304 ? {} : { typescriptConstructor: checkBodylessConstructor(status) }),
        });
      }
    }
  }
  return exchanges;
}

const rich: ChatRequest = {
  ...input,
  messages: [
    ...input.messages,
    { role: "assistant", toolCalls: [{ id: "call_fixture", name: "inspect", arguments: '{"z":1,"a":2}' }] },
    { role: "tool", toolCallId: "call_fixture", content: '{"found":true}' },
    { role: "user", content: [{ type: "text", text: "Check the image." }, { type: "image_url", url: "data:image/png;base64,AAEC" }] },
  ],
  tools: [{ name: "inspect", description: "Inspect an example", parameters: {
    type: "object", properties: { z: { type: "integer" }, a: { type: "integer" } }, required: ["z", "a"],
  } }],
  toolChoice: "auto",
  parallelToolCalls: true,
};

const chatCall = { id: "call_fixture", type: "function", function: { name: "inspect", arguments: '{"z":1}' } };
const chatUsage = { prompt_tokens: 9, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } };
const chatFrames = [
  { id: "recorded-chat", model: "fixture-model", choices: [{ index: 0, delta: { content: "Grüße", reasoning_content: "Think." } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: chatCall.id, function: { name: "inspect", arguments: '{"z":' } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 9 } },
  { choices: [], usage: chatUsage },
];

const rule = { id: "recorded-anthropic", model: "fixture-model", type: "message", usage: { input_tokens: 6, cache_read_input_tokens: 3, output_tokens: 4 } };
const anthTool = { type: "tool_use", id: "call_fixture", name: "inspect", input: { z: 1 } };
const anthFrames = [
  { type: "message_start", message: rule },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Grüße" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { ...anthTool, input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"z":' } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "1}" } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
  { type: "message_stop" },
];

const responseMeta = { id: "recorded-responses", model: "fixture-model" };
const responseUsage = { input_tokens: 9, output_tokens: 4, input_tokens_details: { cached_tokens: 3 } };
const responseTool = { type: "function_call", call_id: "call_fixture", name: "inspect", arguments: '{"z":1}' };
const responseFrames = [
  { type: "response.created", response: responseMeta },
  { type: "response.output_item.added", output_index: 0, item: { type: "message" } },
  { type: "response.output_text.delta", output_index: 0, delta: "Grüße" },
  { type: "response.output_item.done", output_index: 0, item: {} },
  { type: "response.output_item.added", output_index: 1, item: { ...responseTool, arguments: "" } },
  { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"z":' },
  { type: "response.function_call_arguments.delta", output_index: 1, delta: "1}" },
  { type: "response.function_call_arguments.done", output_index: 1, arguments: '{"z":1}' },
  { type: "response.output_item.done", output_index: 1, item: responseTool },
  { type: "response.completed", response: { ...responseMeta, usage: responseUsage } },
];

const geminiMeta = { responseId: "recorded-gemini", modelVersion: "fixture-model" };
const geminiUsage = { promptTokenCount: 9, candidatesTokenCount: 3, thoughtsTokenCount: 1, cachedContentTokenCount: 3 };
const geminiParts = [{ text: "Think.", thought: true }, { text: "Grüße" }, { functionCall: { name: "inspect", args: { z: 1 } }, thoughtSignature: "AAEC" }];
const geminiFrames = [
  { ...geminiMeta, candidates: [{ content: { parts: geminiParts.slice(0, 2) } }] },
  { candidates: [{ content: { parts: geminiParts.slice(2) }, finishReason: "STOP" }] },
  { usageMetadata: geminiUsage },
];

const jsonReplies: Record<Wire, unknown> = {
  chat_completions: { id: "recorded-chat", model: "fixture-model", choices: [{ message: { content: "Grüße", reasoning_content: "Think.", tool_calls: [chatCall] }, finish_reason: "tool_calls" }], usage: chatUsage },
  anthropic_messages: { ...rule, content: [{ type: "text", text: "Grüße" }, anthTool], stop_reason: "tool_use" },
  codex_responses: { ...responseMeta, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Grüße" }] }, responseTool], usage: responseUsage },
  gemini: { ...geminiMeta, candidates: [{ content: { parts: geminiParts }, finishReason: "STOP" }], usageMetadata: geminiUsage },
};
const streamReplies: Record<Wire, object[]> = { chat_completions: chatFrames, anthropic_messages: anthFrames, codex_responses: responseFrames, gemini: geminiFrames };

function sse(frames: object[], done: boolean): Reply {
  const text = frames.map(frame => `data: ${JSON.stringify(frame)}\r\n\r\n`).join("") + (done ? "data: [DONE]\r\n\r\n" : "");
  const bytes = Buffer.from(text);
  const split = bytes.indexOf(Buffer.from("ü")) + 1;
  const chunks = split > 0 ? [bytes.subarray(0, split), bytes.subarray(split)] : [bytes];
  return { status: 200, headers: { "content-type": "text/event-stream" }, chunks };
}

async function protocol(wire: Wire) {
  const frames = streamReplies[wire];
  const complete = await record(wire, "complete", "complete", {
    status: 200, headers: { "content-type": "application/json" }, chunks: [Buffer.from(JSON.stringify(jsonReplies[wire]))],
  }, undefined, rich);
  const stream = await record(wire, "stream-tools-and-usage", "stream", sse(frames, wire === "chat_completions"), undefined, rich);
  if (!complete.expected.result || stream.expected.events.at(-1)?.type !== "done") throw new Error(`${wire}: valid fixture failed`);
  const truncated = await record(wire, "stream-premature-eof", "stream", sse(frames.slice(0, 1), false), undefined, rich);
  if (!truncated.expected.error) throw new Error(`${wire}: truncated fixture succeeded`);
  const failure = wire === "gemini" ? { error: { message: "Fixture throttled.", status: "RESOURCE_EXHAUSTED", code: 429 } }
    : { error: { message: "Fixture throttled.", type: "rate_limit_error", code: "rate_limit_exceeded" } };
  const throttled = await record(wire, "http-rate-limit-and-retry", "stream", {
    status: 429, headers: { "content-type": "application/json", "retry-after": "2" }, chunks: [Buffer.from(JSON.stringify(failure))],
  });
  const streamFailure = wire === "anthropic_messages" || wire === "codex_responses" ? { type: "error", ...failure } : failure;
  const vendorError = await record(wire, "stream-vendor-error", "stream", sse([streamFailure], false));
  const cases = [complete, stream, truncated, throttled, vendorError];
  if (wire === "chat_completions") {
    cases.push(await record(wire, "stream-missing-done-strict", "stream", sse(frames, false)));
    cases.push(await record(wire, "stream-missing-done-allowed", "stream", sse(frames, false), { allowMissingDone: true }));
    const damaged = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: chatCall.id, function: { name: "inspect", arguments: "{" } }] }, finish_reason: "tool_calls" }] },
    ];
    cases.push(await record(wire, "stream-repaired-tool-arguments", "stream", sse(damaged, true),
      { allowMissingDone: false, repair: true }, rich));

  }
  return cases;
}

export async function buildProviderFixtures() {
  const fixtures: Record<string, unknown> = {};
  for (const wire of wires) {
    const base = { schema: "plur1bus.parity-wire/1", source: "packages/providers/src/index.ts", exporter: "scripts/parity/export-providers.ts", transport: "http", wire };
    const area = wire.replaceAll("_", "-");
    fixtures[`${area}-bodyless`] = { ...base, exchanges: await bodyless(wire) };
    fixtures[`${area}-protocol`] = { ...base, exchanges: await protocol(wire) };
  }
  return fixtures;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await exporterMain({ area: "providers", build: buildProviderFixtures }));
}
