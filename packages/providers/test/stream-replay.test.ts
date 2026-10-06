// Acceptance (milestones M2 criterion 3, chat_completions part): one streamed turn with tool calls, served from a
// hand-made fixture by a local stub and replayed to an identical result, however the bytes are chunked.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import { createChatCompletionsAdapter } from "../src/index.ts";
import type { ChatRequest, ChatStreamEvent } from "../src/index.ts";
import { credentials, split, sseHeaders, startStub, writeAll } from "./helpers/stub.ts";

const T = { timeout: 20_000 };
const here = (f: string) => new URL(`./fixtures/${f}`, import.meta.url);
const FIXTURE = readFileSync(here("stream-tool-call.sse"));
const GOLDEN = here("stream-tool-call.golden.json");

const request: ChatRequest = {
  model: "synthetic-model-1",
  messages: [{ role: "user", content: "Weather in Zürich and the time there?" }],
  tools: [
    { name: "get_weather", description: "weather", parameters: { type: "object", properties: { city: { type: "string" }, unit: { type: "string" } }, required: ["city"] } },
    { name: "get_time", parameters: { type: "object", properties: { tz: { type: "string" } } } },
  ],
  toolChoice: "auto",
  maxTokens: 128,
  temperature: 0,
};

async function replay(pieces: Buffer[], gapMs = 0) {
  const stub = await startStub(async (_req, res) => { sseHeaders(res); await writeAll(res, pieces, gapMs); res.end(); });
  try {
    const adapter = createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: credentials() });
    const events: ChatStreamEvent[] = [];
    for await (const e of adapter.stream(request)) events.push(e);
    return { events, stub: stub.requests };
  } finally { await stub.close(); }
}

const lastResult = (events: ChatStreamEvent[]) => {
  const d = events.at(-1);
  assert.equal(d?.type, "done");
  return (d as Extract<ChatStreamEvent, { type: "done" }>).result;
};

test("the tool-call turn is assembled as the fixture says", T, async () => {
  const { events, stub } = await replay([FIXTURE]);
  const r = lastResult(events);
  assert.equal(r.text, "Let me check the weather in Zürich 🌤 and the time.");
  assert.equal(r.finishReason, "tool_calls");
  assert.deepEqual(r.toolCalls, [
    { id: "call_synthetic_0001", name: "get_weather", argumentsRaw: "{\"city\":\"Zürich\",\"unit\":\"c\"}", arguments: { city: "Zürich", unit: "c" } },
    { id: "call_synthetic_0002", name: "get_time", argumentsRaw: "{\"tz\":\"Europe/Zurich\"}", arguments: { tz: "Europe/Zurich" } },
  ]);
  assert.deepEqual(r.usage, { inputTokens: 57, outputTokens: 41, totalTokens: 98, cachedInputTokens: 32, reasoningTokens: 0 });
  assert.deepEqual(r.meta, { id: "chatcmpl-synthetic-0001", model: "synthetic-model-1", systemFingerprint: "fp_synthetic" });

  // Tool-call deltas arrive incrementally, in order, before the finish event.
  const kinds = events.map((e) => e.type);
  assert.deepEqual(kinds, [
    "text_delta", "text_delta", "tool_call_start", "tool_call_delta", "tool_call_delta", "tool_call_start", "tool_call_delta", "tool_call_delta",
    "finish", "usage", "done",
  ]);
  assert.deepEqual(events.filter((e) => e.type === "tool_call_delta").filter((e) => e.index === 0).map((e) => e.argumentsDelta), ["{\"city\":", "\"Zürich\"", ",\"unit\":\"c\"}"]);

  // The request on the wire.
  const rec = stub[0]!;
  assert.equal(rec.method, "POST");
  assert.equal(rec.url, "/v1/chat/completions");
  assert.equal(rec.headers["authorization"], "Bearer synthetic-secret-token-123");
  assert.equal(rec.headers["accept"], "text/event-stream");
  const body = JSON.parse(rec.body);
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.tools.length, 2);
});

test("replay is byte-stable: every chunking, CRLF framing and a second run give the identical result and events", T, async () => {
  const base = await replay([FIXTURE]);
  const canon = JSON.stringify(base.events);
  const crlf = Buffer.from(FIXTURE.toString("utf8").replaceAll("\n", "\r\n"), "utf8");
  const variants: [string, Buffer[]][] = [
    ["again, whole", [FIXTURE]],
    ["1 byte at a time", split(FIXTURE, [1])],
    ["odd sizes", split(FIXTURE, [3, 17, 1, 250])],
    ["crlf, 7 bytes", split(crlf, [7])],
  ];
  for (const [name, pieces] of variants) {
    const run = await replay(pieces);
    assert.equal(JSON.stringify(run.events), canon, name);
  }
});

test("the result equals the committed golden file", T, async () => {
  const { events } = await replay([FIXTURE]);
  const got = JSON.stringify(lastResult(events), null, 2) + "\n";
  if (process.env["UPDATE_GOLDEN"] === "1" && !existsSync(GOLDEN)) writeFileSync(GOLDEN, got);
  assert.equal(got, readFileSync(GOLDEN, "utf8"));
});

test("a slow trickle with gaps replays the same", T, async () => {
  const base = await replay([FIXTURE]);
  const slow = await replay(split(FIXTURE, [400]), 5);
  assert.equal(JSON.stringify(slow.events), JSON.stringify(base.events));
});
