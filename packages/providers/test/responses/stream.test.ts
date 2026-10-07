import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError } from "../../src/index.ts";
import type { ChatResult, ChatStreamEvent, ToolArgumentRepair } from "../../src/index.ts";
import { ResponsesAccumulator, responseToEvents } from "../../src/responses/response.ts";

const SIG = new AbortController().signal;
const id = (x: string) => x;

const created = { type: "response.created", response: { id: "resp_synthetic_1", model: "gpt-synthetic", status: "in_progress", output: [] } };
const itemAdded = (i: number, item: object) => ({ type: "response.output_item.added", output_index: i, item });
const itemDone = (i: number, item: object = {}) => ({ type: "response.output_item.done", output_index: i, item });
const msgItem = { type: "message", id: "msg_1", role: "assistant", content: [] };
const text = (i: number, d: string) => ({ type: "response.output_text.delta", output_index: i, content_index: 0, delta: d });
const fnItem = (callId: string, name: string) => ({ type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: "" });
const args = (i: number, d: string) => ({ type: "response.function_call_arguments.delta", output_index: i, delta: d });
const argsDone = (i: number, a: string) => ({ type: "response.function_call_arguments.done", output_index: i, arguments: a });
const completed = (usage: object | string | null = { input_tokens: 12, output_tokens: 7, total_tokens: 19 }, extra: object = {}) =>
  ({ type: "response.completed", response: { id: "resp_synthetic_1", model: "gpt-synthetic", status: "completed", ...(usage === null ? {} : { usage }), ...extra } });

interface Run { events: ChatStreamEvent[]; result: ChatResult; acc: ResponsesAccumulator }
async function run(frames: unknown[], opts: { repair?: ToolArgumentRepair; max?: number } = {}): Promise<Run> {
  const acc = new ResponsesAccumulator(id, opts.max ?? 1_000_000);
  const events: ChatStreamEvent[] = [];
  for (const f of frames) events.push(...acc.push(f));
  return { events, result: await acc.finish(opts.repair, undefined, SIG), acc };
}
const failure = (frames: unknown[], re: RegExp, opts: { max?: number } = {}) => assert.rejects(run(frames, opts), (e: unknown) => e instanceof ProviderError && e.kind === "unknown" && e.code === "protocol" && re.test(e.message), String(re));
const types = (events: ChatStreamEvent[]) => events.map((e) => e.type);

test("text: deltas in order, finish only at response.completed, result agrees", async () => {
  const { events, result, acc } = await run([created, itemAdded(0, msgItem), text(0, "Hel"), text(0, "lo, "), text(0, "world"), itemDone(0), completed()]);
  assert.deepEqual(events, [
    { type: "text_delta", text: "Hel" }, { type: "text_delta", text: "lo, " }, { type: "text_delta", text: "world" },
    { type: "finish", finishReason: "stop", rawFinishReason: "completed" },
  ]);
  assert.equal(acc.finished, true);
  assert.equal(result.text, "Hello, world");
  assert.deepEqual(result.toolCalls, []);
  assert.deepEqual(result.meta, { id: "resp_synthetic_1", model: "gpt-synthetic" });
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 7, totalTokens: 19 });
});

test("a cut before the terminal event is not finished", async () => {
  const acc = new ResponsesAccumulator(id, 1000);
  const seen: ChatStreamEvent[] = [];
  for (const f of [created, itemAdded(0, msgItem), text(0, "x"), itemDone(0)]) seen.push(...acc.push(f));
  assert.deepEqual(types(seen), ["text_delta"]);
  assert.equal(acc.finished, false);
  await assert.rejects(acc.finish(undefined, undefined, SIG), (e: unknown) => e instanceof ProviderError && e.code === "protocol" && /response\.completed/.test(e.message));
  assert.deepEqual(acc.snapshot().text, "x");
});

test("tool calls: ordinal index, call_id (not the item id) is the id, arguments assembled from fragments", async () => {
  const { events, result } = await run([
    created, itemAdded(0, msgItem), text(0, "checking"), itemDone(0),
    itemAdded(1, fnItem("call_w", "get_weather")), args(1, ""), args(1, "{\"ci"), args(1, "ty\":\"Berlin\"}"),
    itemAdded(2, fnItem("call_t", "get_time")), args(2, "{\"tz\":"), args(1, ""), args(2, "\"Europe/Berlin\"}"),
    argsDone(1, "{\"city\":\"Berlin\"}"), itemDone(1), argsDone(2, "{\"tz\":\"Europe/Berlin\"}"), itemDone(2), completed(),
  ]);
  assert.deepEqual(events.filter((e) => e.type === "tool_call_start"), [
    { type: "tool_call_start", index: 0, id: "call_w", name: "get_weather" }, { type: "tool_call_start", index: 1, id: "call_t", name: "get_time" },
  ]);
  const a = (i: number) => events.flatMap((e) => (e.type === "tool_call_delta" && e.index === i ? [e.argumentsDelta] : [])).join("");
  assert.equal(a(0), "{\"city\":\"Berlin\"}");
  assert.equal(a(1), "{\"tz\":\"Europe/Berlin\"}");
  assert.equal(events.some((e) => e.type === "tool_call_delta" && e.argumentsDelta === ""), false);
  assert.equal(result.finishReason, "tool_calls");
  assert.deepEqual(result.toolCalls, [
    { id: "call_w", name: "get_weather", argumentsRaw: "{\"city\":\"Berlin\"}", arguments: { city: "Berlin" } },
    { id: "call_t", name: "get_time", argumentsRaw: "{\"tz\":\"Europe/Berlin\"}", arguments: { tz: "Europe/Berlin" } },
  ]);
});

test("a function_call item that arrives whole in output_item.done (no deltas) is a complete call", async () => {
  const { events, result } = await run([created, itemAdded(0, fnItem("call_x", "f")), itemDone(0, { ...fnItem("call_x", "f"), arguments: "{\"a\":1}" }), completed()]);
  assert.equal(events.filter((e) => e.type === "tool_call_delta").map((e) => (e as { argumentsDelta: string }).argumentsDelta).join(""), "{\"a\":1}");
  assert.deepEqual(result.toolCalls[0]?.arguments, { a: 1 });
});

test("arguments.done disagreeing with the deltas is a protocol error", async () => {
  await failure([created, itemAdded(0, fnItem("c", "f")), args(0, "{\"a\":1}"), argsDone(0, "{\"a\":2}")], /disagree/);
});

test("no arguments at all is {}; the repair hook is asked once for broken JSON", async () => {
  const { result } = await run([created, itemAdded(0, fnItem("c", "f")), itemDone(0), completed()]);
  assert.deepEqual(result.toolCalls[0]?.arguments, {});
  let asked = 0;
  const repair: ToolArgumentRepair = { repair: async () => { asked++; return { argumentsRaw: "{\"ok\":true}" }; } };
  const r = await run([created, itemAdded(0, fnItem("c", "f")), args(0, "{\"ok\":"), itemDone(0), completed()], { repair });
  assert.equal(asked, 1);
  assert.deepEqual(r.result.toolCalls[0]?.arguments, { ok: true });
});

test("reasoning events are reasoning, never text; unknown reasoning events are ignored", async () => {
  const { events, result } = await run([
    created, itemAdded(0, { type: "reasoning", id: "rs_1", summary: [] }),
    { type: "response.reasoning_summary_part.added", output_index: 0, summary_index: 0 },
    { type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: "thinking " },
    { type: "response.reasoning_text.delta", output_index: 0, content_index: 0, delta: "hard" },
    { type: "response.reasoning_summary_text.done", output_index: 0, text: "thinking " },
    itemDone(0), itemAdded(1, msgItem), text(1, "answer"), itemDone(1), completed(),
  ]);
  assert.deepEqual(events.filter((e) => e.type === "reasoning_delta"), [{ type: "reasoning_delta", text: "thinking " }, { type: "reasoning_delta", text: "hard" }]);
  assert.equal(result.text, "answer");
  assert.equal(result.reasoning, "thinking hard");
});

test("refusal text is delivered as text and the turn finishes as content_filter", async () => {
  const { events, result } = await run([created, itemAdded(0, msgItem), { type: "response.refusal.delta", output_index: 0, delta: "I can't." }, itemDone(0), completed()]);
  assert.deepEqual(events[0], { type: "text_delta", text: "I can't." });
  assert.equal(result.finishReason, "content_filter");
  assert.equal(result.text, "I can't.");
});

test("usage: cached and reasoning tokens; a count the wire omits stays absent, a reported 0 stays 0", async () => {
  const full = await run([created, completed({ input_tokens: 100, input_tokens_details: { cached_tokens: 64 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 12 }, total_tokens: 130 })]);
  assert.deepEqual(full.result.usage, { inputTokens: 100, outputTokens: 30, totalTokens: 130, cachedInputTokens: 64, reasoningTokens: 12 });
  const zero = await run([created, completed({ input_tokens: 5, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } })]);
  assert.deepEqual(zero.result.usage, { inputTokens: 5, outputTokens: 0, totalTokens: 5, cachedInputTokens: 0 });
  const none = await run([created, completed(null)]);
  assert.equal(none.result.usage, undefined);
  assert.equal(none.acc.usage, undefined);
  await failure([created, completed({ input_tokens: -1 })], /usage\.input_tokens/);
  await failure([created, completed({ output_tokens: "7" })], /usage\.output_tokens/);
  await failure([created, completed("lots")], /usage is not an object/);
});

test("response.incomplete: max_output_tokens is length, content_filter is content_filter, anything else is other; the raw reason is kept", async () => {
  const inc = (reason: unknown) => ({ type: "response.incomplete", response: { id: "r", status: "incomplete", incomplete_details: reason === undefined ? null : { reason }, usage: { input_tokens: 1, output_tokens: 2 } } });
  const a = await run([created, itemAdded(0, msgItem), text(0, "cut"), itemDone(0), inc("max_output_tokens")]);
  assert.deepEqual(a.events.at(-1), { type: "finish", finishReason: "length", rawFinishReason: "max_output_tokens" });
  const b = await run([created, inc("content_filter")]);
  assert.equal(b.result.finishReason, "content_filter");
  const c = await run([created, inc("something_new")]);
  assert.deepEqual([c.result.finishReason, c.result.rawFinishReason], ["other", "something_new"]);
  const d = await run([created, inc(undefined)]);
  assert.deepEqual([d.result.finishReason, d.result.rawFinishReason], ["other", "incomplete"]);
});

test("response.failed and error events throw the classified error", async () => {
  const frames = (f: unknown) => [created, itemAdded(0, msgItem), text(0, "x"), f];
  await assert.rejects(run(frames({ type: "response.failed", response: { status: "failed", error: { code: "server_is_overloaded", message: "Our servers are currently overloaded." } } })), (e: unknown) => e instanceof ProviderError && e.kind === "overloaded" && e.retryable);
  await assert.rejects(run(frames({ type: "error", code: "rate_limit_exceeded", message: "slow down" })), (e: unknown) => e instanceof ProviderError && e.kind === "rate_limit");
  await assert.rejects(run(frames({ type: "response.failed", response: { status: "failed" } })), (e: unknown) => e instanceof ProviderError && e.kind === "unknown" && !e.retryable);
});

test("unknown event types are ignored; known ones out of order are protocol errors", async () => {
  const { events } = await run([created, { type: "response.something_new", x: 1 }, { type: "response.in_progress", response: {} }, itemAdded(0, msgItem), { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } }, text(0, "a"), { type: "response.output_text.done", output_index: 0, text: "a" }, { type: "response.content_part.done", output_index: 0 }, itemDone(0), completed()]);
  assert.deepEqual(types(events), ["text_delta", "finish"]);
  await failure([itemAdded(0, msgItem)], /before response\.created/);
  await failure([created, created], /response\.created twice/);
  await failure([created, text(0, "x")], /not open|no item/);
  await failure([created, itemAdded(0, msgItem), itemAdded(0, msgItem)], /already/);
  await failure([created, itemAdded(0, msgItem), itemDone(0), text(0, "late")], /not open|no item/);
  await failure([created, itemAdded(0, msgItem), text(0, "x"), itemDone(0), completed(), text(0, "y")], /after the terminal/);
  await failure([created, itemAdded(0, msgItem), completed()], /not closed|still open/);
});

test("malformed frames and fields fail closed", async () => {
  await failure([42], /not an object/);
  await failure([{ x: 1 }], /no type/);
  await failure([{ type: "response.created" }], /no response/);
  await failure([created, itemAdded(-1, msgItem)], /output_index/);
  await failure([created, itemAdded(0, "x")], /item is not an object/);
  await failure([created, itemAdded(0, { type: "function_call", call_id: "", name: "f" })], /call_id/);
  await failure([created, itemAdded(0, { type: "function_call", call_id: "c", name: "" })], /name/);
  await failure([created, itemAdded(0, fnItem("c", "f")), itemAdded(1, fnItem("c", "g"))], /duplicate/);
  await failure([created, itemAdded(0, msgItem), { type: "response.output_text.delta", output_index: 0, delta: 5 }], /delta is not a string/);
  await failure([created, itemAdded(0, fnItem("c", "f")), text(0, "x")], /text on a function_call/);
  await failure([created, itemAdded(0, msgItem), args(0, "{}")], /arguments on a message/);
  await failure([created, itemAdded(0, fnItem("c", "f")), { type: "response.function_call_arguments.delta", output_index: 0, delta: 1 }], /delta is not a string/);
});

test("tool-call argument bytes are bounded", async () => {
  await failure([created, itemAdded(0, fnItem("c", "f")), args(0, "{\"a\":\"xxxxxxxxxxxx\"}")], /exceed 10 bytes/, { max: 10 });
});

test("snapshot: what had arrived, tool arguments unparsed", async () => {
  const acc = new ResponsesAccumulator(id, 1000);
  for (const f of [created, itemAdded(0, msgItem), text(0, "partial"), itemAdded(1, fnItem("c", "f")), args(1, "{\"a\":")]) acc.push(f);
  assert.deepEqual(acc.snapshot(), { text: "partial", toolCalls: [{ index: 0, id: "c", name: "f", argumentsRaw: "{\"a\":" }] });
});

test("non-stream body replays as the same events: message, reasoning, function_call, usage", async () => {
  const body = {
    id: "resp_ns", object: "response", status: "completed", model: "gpt-synthetic",
    output: [
      { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "plan" }] },
      { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "Hello" }, { type: "output_text", text: " there" }] },
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "f", arguments: "{\"a\":1}" },
    ],
    usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13, output_tokens_details: { reasoning_tokens: 2 } },
  };
  const acc = new ResponsesAccumulator(id, 1000);
  const events: ChatStreamEvent[] = [];
  for (const f of responseToEvents(body)) events.push(...acc.push(f));
  const r = await acc.finish(undefined, undefined, SIG);
  assert.equal(r.text, "Hello there");
  assert.equal(r.reasoning, "plan");
  assert.equal(r.finishReason, "tool_calls");
  assert.deepEqual(r.toolCalls, [{ id: "call_1", name: "f", argumentsRaw: "{\"a\":1}", arguments: { a: 1 } }]);
  assert.deepEqual(r.usage, { inputTokens: 9, outputTokens: 4, totalTokens: 13, reasoningTokens: 2 });
  assert.equal(events.at(-1)?.type, "finish");
});

test("non-stream bodies: incomplete, failed, error objects and junk", async () => {
  const play = async (b: unknown) => { const acc = new ResponsesAccumulator(id, 1000); for (const f of responseToEvents(b)) acc.push(f); return acc.finish(undefined, undefined, SIG); };
  assert.equal((await play({ id: "r", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] })).finishReason, "length");
  await assert.rejects(play({ id: "r", status: "failed", error: { code: "server_error", message: "boom" }, output: [] }), (e: unknown) => e instanceof ProviderError && e.kind === "overloaded" && e.retryable);
  await assert.rejects(play({ error: { code: "invalid_api_key", message: "no" } }), (e: unknown) => e instanceof ProviderError && e.kind === "auth");
  await assert.rejects(play("x"), /not an object/);
  await assert.rejects(play({ status: "completed", output: "x" }), /output is not an array/);
  await assert.rejects(play({ status: "queued", output: [] }), /status/);
  await assert.rejects(play({ status: "completed", output: [1] }), /output item/);
});
