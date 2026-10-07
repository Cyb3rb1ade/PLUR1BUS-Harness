import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError } from "../../src/index.ts";
import type { ChatResult, ChatStreamEvent, ToolArgumentRepair } from "../../src/index.ts";
import { AnthropicAccumulator, messageToEvents } from "../../src/anthropic/response.ts";

const SIG = new AbortController().signal;
const id = (x: string) => x;

const start = (usage: object = { input_tokens: 12, output_tokens: 1 }) => ({ type: "message_start", message: { id: "msg_synthetic_1", type: "message", role: "assistant", model: "claude-synthetic", content: [], stop_reason: null, usage } });
const blockStart = (index: number, block: object) => ({ type: "content_block_start", index, content_block: block });
const text = (index: number, t: string) => ({ type: "content_block_delta", index, delta: { type: "text_delta", text: t } });
const json = (index: number, p: string) => ({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: p } });
const think = (index: number, t: string) => ({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: t } });
const stop = (index: number) => ({ type: "content_block_stop", index });
const done = (reason: string | null = "end_turn", usage: object = { output_tokens: 7 }) => ({ type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage });
const end = { type: "message_stop" };
const textBlock = { type: "text", text: "" };
const toolBlock = (tid: string, name: string) => ({ type: "tool_use", id: tid, name, input: {} });

interface Run { events: ChatStreamEvent[]; result: ChatResult; acc: AnthropicAccumulator }
async function run(frames: unknown[], opts: { repair?: ToolArgumentRepair; max?: number } = {}): Promise<Run> {
  const acc = new AnthropicAccumulator(id, opts.max ?? 1_000_000);
  const events: ChatStreamEvent[] = [];
  for (const f of frames) events.push(...acc.push(f));
  return { events, result: await acc.finish(opts.repair, undefined, SIG), acc };
}
const failure = (frames: unknown[], re: RegExp, opts: { max?: number } = {}) => assert.rejects(run(frames, opts), (e: unknown) => e instanceof ProviderError && e.kind === "unknown" && e.code === "protocol" && re.test(e.message), String(re));
const types = (events: ChatStreamEvent[]) => events.map((e) => e.type);

test("text: deltas in order, finish only at message_stop, result agrees", async () => {
  const { events, result, acc } = await run([start(), blockStart(0, textBlock), { type: "ping" }, text(0, "Hel"), text(0, "lo, "), text(0, "world"), stop(0), done(), end]);
  assert.deepEqual(events, [
    { type: "text_delta", text: "Hel" }, { type: "text_delta", text: "lo, " }, { type: "text_delta", text: "world" },
    { type: "finish", finishReason: "stop", rawFinishReason: "end_turn" },
  ]);
  assert.equal(acc.finished, true);
  assert.equal(result.text, "Hello, world");
  assert.deepEqual(result.toolCalls, []);
  assert.deepEqual(result.meta, { id: "msg_synthetic_1", model: "claude-synthetic" });
  assert.equal(result.finishReason, "stop");
});

test("finish is not emitted before message_stop, so a cut after message_delta is still a failure", async () => {
  const acc = new AnthropicAccumulator(id, 1000);
  const seen: ChatStreamEvent[] = [];
  for (const f of [start(), blockStart(0, textBlock), text(0, "x"), stop(0), done()]) seen.push(...acc.push(f));
  assert.deepEqual(types(seen), ["text_delta"]);
  assert.equal(acc.finished, false);
  await assert.rejects(acc.finish(undefined, undefined, SIG), (e: unknown) => e instanceof ProviderError && e.code === "protocol" && /message_stop/.test(e.message));
});

test("tool calls: ordinal index (not block index), id and name from the start block, JSON assembled from fragments", async () => {
  const { events, result } = await run([
    start(), blockStart(0, textBlock), text(0, "checking"), stop(0),
    blockStart(1, toolBlock("toolu_w", "get_weather")), json(1, ""), json(1, "{\"ci"), json(1, "ty\":\"Ber"),
    blockStart(2, toolBlock("toolu_t", "get_time")), json(1, "lin\",\"units\""), json(2, "{\"tz\":"), json(1, ":\"metric\"}"), json(2, "\"Europe/Berlin\"}"),
    stop(1), stop(2), done("tool_use"), end,
  ]);
  assert.deepEqual(events.filter((e) => e.type === "tool_call_start"), [
    { type: "tool_call_start", index: 0, id: "toolu_w", name: "get_weather" }, { type: "tool_call_start", index: 1, id: "toolu_t", name: "get_time" },
  ]);
  const args = (i: number) => events.flatMap((e) => (e.type === "tool_call_delta" && e.index === i ? [e.argumentsDelta] : [])).join("");
  assert.equal(args(0), "{\"city\":\"Berlin\",\"units\":\"metric\"}");
  assert.equal(args(1), "{\"tz\":\"Europe/Berlin\"}");
  assert.equal(events.some((e) => e.type === "tool_call_delta" && e.argumentsDelta === ""), false, "empty fragments emit nothing");
  assert.deepEqual(result.toolCalls, [
    { id: "toolu_w", name: "get_weather", argumentsRaw: "{\"city\":\"Berlin\",\"units\":\"metric\"}", arguments: { city: "Berlin", units: "metric" } },
    { id: "toolu_t", name: "get_time", argumentsRaw: "{\"tz\":\"Europe/Berlin\"}", arguments: { tz: "Europe/Berlin" } },
  ]);
  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.text, "checking");
});

test("a tool without arguments (no or empty input_json_delta) is {}", async () => {
  const { result } = await run([start(), blockStart(0, toolBlock("toolu_1", "ping")), json(0, ""), stop(0), blockStart(1, toolBlock("toolu_2", "pong")), stop(1), done("tool_use"), end]);
  assert.deepEqual(result.toolCalls.map((c) => [c.argumentsRaw, c.arguments, c.argumentsError]), [["{}", {}, undefined], ["{}", {}, undefined]]);
});

test("broken tool arguments keep argumentsError; a repair hook may fix them, once", async () => {
  const frames = [start(), blockStart(0, toolBlock("toolu_1", "f")), json(0, "{\"a\":"), stop(0), done("tool_use"), end];
  const plain = await run(frames);
  assert.equal(plain.result.toolCalls[0]!.arguments, undefined);
  assert.match(plain.result.toolCalls[0]!.argumentsError ?? "", /not valid JSON/);
  let calls = 0;
  const repaired = await run(frames, { repair: { repair: ({ call }) => { calls++; assert.equal(call.name, "f"); return { argumentsRaw: "{\"a\":1}" }; } } });
  assert.equal(calls, 1);
  assert.deepEqual(repaired.result.toolCalls[0], { id: "toolu_1", name: "f", argumentsRaw: "{\"a\":1}", arguments: { a: 1 }, repaired: true });
});

test("thinking: deltas become reasoning, never text; signature and redacted blocks are dropped, not echoed", async () => {
  const { events, result } = await run([
    start(), blockStart(0, { type: "thinking", thinking: "" }), think(0, "Think "), think(0, "hard."),
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIGNATURE-BYTES" } }, stop(0),
    blockStart(1, { type: "redacted_thinking", data: "OPAQUE-BYTES" }), stop(1),
    blockStart(2, textBlock), text(2, "42"), stop(2), done(), end,
  ]);
  assert.deepEqual(events.filter((e) => e.type === "reasoning_delta"), [{ type: "reasoning_delta", text: "Think " }, { type: "reasoning_delta", text: "hard." }]);
  assert.equal(result.reasoning, "Think hard.");
  assert.equal(result.text, "42");
  assert.equal(JSON.stringify([events, result]).includes("SIGNATURE-BYTES") || JSON.stringify([events, result]).includes("OPAQUE-BYTES"), false);
});

test("forward compatibility: unknown event types, unknown block types and their deltas are ignored, never printed as text", async () => {
  const { events, result } = await run([
    start(), { type: "future_event", payload: "x" }, blockStart(0, { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} }),
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"q\":\"x\"}" } }, stop(0),
    blockStart(1, textBlock), text(1, "ok"), stop(1), done(), end,
  ]);
  assert.deepEqual(types(events), ["text_delta", "finish"]);
  assert.equal(result.text, "ok");
  assert.deepEqual(result.toolCalls, []);
});

test("stop_reason table: one place, raw value kept", async () => {
  const table: [string, string][] = [
    ["end_turn", "stop"], ["stop_sequence", "stop"], ["max_tokens", "length"], ["tool_use", "tool_calls"],
    ["refusal", "content_filter"], ["model_context_window_exceeded", "length"], ["pause_turn", "other"], ["something_new", "other"],
  ];
  for (const [raw, want] of table) {
    const { events, result } = await run([start(), done(raw), end]);
    assert.deepEqual(events.at(-1), { type: "finish", finishReason: want, rawFinishReason: raw }, raw);
    assert.equal(result.finishReason, want);
    assert.equal(result.rawFinishReason, raw);
  }
});

test("usage: message_start and message_delta merge (later wins); cache fields normalise; absent stays absent", async () => {
  const merged = await run([start({ input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 1 }), done("end_turn", { output_tokens: 9 }), end]);
  assert.deepEqual(merged.result.usage, { inputTokens: 150, outputTokens: 9, totalTokens: 159, cachedInputTokens: 40, cacheCreationInputTokens: 100 });
  const later = await run([start({ input_tokens: 10, output_tokens: 1 }), done("end_turn", { input_tokens: 11, output_tokens: 9 }), end]);
  assert.deepEqual(later.result.usage, { inputTokens: 11, outputTokens: 9, totalTokens: 20 });
  const tiers = await run([start({ input_tokens: 1, output_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 4 } }), done(), end]);
  assert.equal((tiers.result.usage as { cacheCreationInputTokens?: number }).cacheCreationInputTokens, 7);
  const none = await run([start({}), done("end_turn", {}), end]);
  assert.equal(none.result.usage, undefined);
  assert.equal(Object.hasOwn(none.result, "usage"), false);
  const outOnly = await run([{ type: "message_start", message: { id: "m", model: "x" } }, done("end_turn", { output_tokens: 5 }), end]);
  assert.deepEqual(outOnly.result.usage, { outputTokens: 5 });
  const zero = await run([start({ input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0 }), done("end_turn", {}), end]);
  assert.deepEqual(zero.result.usage, { inputTokens: 5, outputTokens: 0, totalTokens: 5, cachedInputTokens: 0 });
});

test("usage that is not a non-negative integer is a protocol error", async () => {
  for (const bad of [{ input_tokens: -1 }, { input_tokens: 1.5 }, { output_tokens: "7" }, { cache_read_input_tokens: null, input_tokens: Number.NaN }]) {
    await failure([start(bad), done(), end], /usage/);
  }
  await failure([start({ input_tokens: 1 }), done("end_turn", [] as unknown as object), end], /usage/);
});

test("protocol errors: every shape the adapter does not understand fails closed", async () => {
  await failure([blockStart(0, textBlock)], /message_start/);
  await failure([start(), start()], /message_start/);
  await failure(["x"], /object/);
  await failure([{}], /type/);
  await failure([start(), { type: "content_block_start", index: -1, content_block: textBlock }], /index/);
  await failure([start(), { type: "content_block_start", index: 0.5, content_block: textBlock }], /index/);
  await failure([start(), { type: "content_block_start", index: 0 }], /content_block/);
  await failure([start(), blockStart(0, textBlock), blockStart(0, textBlock)], /twice|again|already/);
  await failure([start(), text(0, "x")], /block 0/);
  await failure([start(), blockStart(0, textBlock), json(0, "{}")], /input_json_delta/);
  await failure([start(), blockStart(0, toolBlock("t", "f")), text(0, "x")], /text_delta/);
  await failure([start(), blockStart(0, textBlock), { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: 5 } }], /text/);
  await failure([start(), blockStart(0, textBlock), { type: "content_block_delta", index: 0, delta: { type: "brand_new_delta" } }], /delta/);
  await failure([start(), blockStart(0, { type: "tool_use", name: "f", input: {} })], /id/);
  await failure([start(), blockStart(0, { type: "tool_use", id: "t", input: {} })], /name/);
  await failure([start(), blockStart(0, toolBlock("t", "f")), blockStart(1, toolBlock("t", "g")), stop(0), stop(1), done("tool_use"), end], /duplicate/);
  await failure([start(), stop(0)], /block 0/);
  await failure([start(), blockStart(0, textBlock), stop(0), stop(0)], /block 0/);
  await failure([start(), done(), blockStart(0, textBlock)], /after/);
  await failure([start(), done(), text(0, "x")], /after/);
  await failure([start(), end], /stop_reason/);
  await failure([start(), done(null), end], /stop_reason/);
  await failure([start(), blockStart(0, textBlock), done(), end], /not closed|open/);
  await failure([start(), done(), end, blockStart(0, textBlock)], /after message_stop/);
  await failure([start(), { type: "message_delta", delta: { stop_reason: 5 } }], /stop_reason/);
  await failure([start(), done("end_turn"), done("max_tokens")], /conflict|twice|again/);
});

test("a ping after message_stop is harmless", async () => {
  const { result } = await run([start(), done(), end, { type: "ping" }]);
  assert.equal(result.finishReason, "stop");
});

test("tool arguments over the limit are refused", async () => {
  await failure([start(), blockStart(0, toolBlock("t", "f")), json(0, "{\"a\":\"xxxxxxxxxx"), json(0, "xxxxxxxxxxxxxxxx\"}")], /exceed/, { max: 20 });
});

test("an error event throws the classified ProviderError, with what had arrived as partial left to the client", () => {
  const acc = new AnthropicAccumulator(id, 1000);
  acc.push(start()); acc.push(blockStart(0, textBlock)); acc.push(text(0, "Hel"));
  assert.throws(() => acc.push({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), (e: unknown) => e instanceof ProviderError && e.kind === "overloaded" && e.retryable);
  assert.deepEqual(acc.snapshot(), { text: "Hel", toolCalls: [], usage: { inputTokens: 12, outputTokens: 1, totalTokens: 13 } });
});

test("snapshot: text, reasoning, unparsed tool arguments, usage so far", () => {
  const acc = new AnthropicAccumulator(id, 1000);
  for (const f of [start(), blockStart(0, { type: "thinking", thinking: "" }), think(0, "hm"), stop(0), blockStart(1, textBlock), text(1, "A"), stop(1), blockStart(2, toolBlock("toolu_1", "f")), json(2, "{\"a\":")]) acc.push(f);
  assert.deepEqual(acc.snapshot(), {
    text: "A", reasoning: "hm", toolCalls: [{ index: 0, id: "toolu_1", name: "f", argumentsRaw: "{\"a\":" }], usage: { inputTokens: 12, outputTokens: 1, totalTokens: 13 },
  });
});

test("the non-stream body is replayed through the same accumulator: same events, same result", async () => {
  const body = {
    id: "msg_synthetic_1", type: "message", role: "assistant", model: "claude-synthetic",
    content: [
      { type: "thinking", thinking: "Think hard.", signature: "S" }, { type: "redacted_thinking", data: "D" },
      { type: "text", text: "checking" }, { type: "tool_use", id: "toolu_w", name: "get_weather", input: { city: "Berlin" } },
    ],
    stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 3 },
  };
  const acc = new AnthropicAccumulator(id, 1000);
  const events: ChatStreamEvent[] = [];
  for (const f of messageToEvents(body)) events.push(...acc.push(f));
  const result = await acc.finish(undefined, undefined, SIG);
  assert.deepEqual(types(events), ["reasoning_delta", "text_delta", "tool_call_start", "tool_call_delta", "finish"]);
  assert.deepEqual(result, {
    text: "checking", reasoning: "Think hard.", finishReason: "tool_calls", rawFinishReason: "tool_use", meta: { id: "msg_synthetic_1", model: "claude-synthetic" },
    toolCalls: [{ id: "toolu_w", name: "get_weather", argumentsRaw: "{\"city\":\"Berlin\"}", arguments: { city: "Berlin" } }],
    usage: { inputTokens: 15, outputTokens: 7, totalTokens: 22, cachedInputTokens: 3 },
  });
});

test("the non-stream body is validated: an error body, a wrong shape, a missing stop_reason", () => {
  const replay = (b: unknown) => { const acc = new AnthropicAccumulator(id, 1000); for (const f of messageToEvents(b)) acc.push(f); };
  assert.throws(() => replay({ type: "error", error: { type: "overloaded_error", message: "x" } }), (e: unknown) => e instanceof ProviderError && e.kind === "overloaded");
  for (const b of [null, "x", {}, { type: "message" }, { type: "message", content: "x", stop_reason: "end_turn" }, { type: "message", content: [5], stop_reason: "end_turn" }, { type: "message", content: [], stop_reason: null }]) {
    assert.throws(() => replay(b), (e: unknown) => e instanceof ProviderError && e.kind === "unknown" && e.code === "protocol", JSON.stringify(b));
  }
});
