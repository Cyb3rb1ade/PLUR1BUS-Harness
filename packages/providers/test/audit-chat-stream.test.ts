// Audit c16: stream contract and bounds of the chat_completions path (and the byte cap shared by all four wires).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAnthropicAdapter, createChatCompletionsAdapter, createGeminiAdapter, createResponsesAdapter, ProviderError,
} from "../src/index.ts";
import type { ChatRequest, ChatStreamEvent, StreamingAdapter } from "../src/index.ts";

const T = { timeout: 20_000 };
const REQ: ChatRequest = { model: "m", messages: [{ role: "user", content: "hi" }] };
const SSE = { "content-type": "text/event-stream" };
const sse = (...frames: unknown[]): Response => new Response(frames.map((f) => `data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`).join(""), { headers: SSE });
const chat = (fetch: typeof globalThis.fetch, extra: object = {}) =>
  createChatCompletionsAdapter({ baseUrl: "https://example.test/v1", credentials: { authorization: () => undefined }, fetch, ...extra });
async function events(a: StreamingAdapter): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of a.stream(REQ)) out.push(e);
  return out;
}

test("chat_completions: usage repeated in several chunks is reported once, after finish (the contract the other wires keep)", T, async () => {
  const u = (completion: number) => ({ prompt_tokens: 5, completion_tokens: completion });
  const ev = await events(chat((async () => sse(
    { choices: [{ index: 0, delta: { content: "a" } }], usage: u(1) },
    { choices: [{ index: 0, delta: { content: "b" } }], usage: u(2) },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: u(2) },
    "[DONE]",
  )) as typeof globalThis.fetch));
  assert.deepEqual(ev.map((e) => e.type), ["text_delta", "text_delta", "finish", "usage", "done"]);
  const usage = ev.find((e) => e.type === "usage");
  assert.deepEqual(usage?.type === "usage" && usage.usage, { inputTokens: 5, outputTokens: 2, totalTokens: 7 });
});

test("chat_completions: a lone usage chunk after finish is still reported once, before done", T, async () => {
  const ev = await events(chat((async () => sse(
    { choices: [{ index: 0, delta: { content: "a" }, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
    "[DONE]",
  )) as typeof globalThis.fetch));
  assert.deepEqual(ev.map((e) => e.type), ["text_delta", "finish", "usage", "done"]);
});

test("chat_completions: a failed stream keeps the usage seen so far in partial", T, async () => {
  const a = chat((async () => sse({ choices: [{ index: 0, delta: { content: "a" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }, "{not json")) as typeof globalThis.fetch);
  await assert.rejects(events(a), (e: unknown) => e instanceof ProviderError && e.partial?.usage?.inputTokens === 5);
});

// ------------------------------------------------------------------------------------- the streamed byte cap (all wires)

/** An endless SSE body of well-formed small events; counts the bytes the client pulled and whether it cancelled. */
function endless(frames: (n: number) => string, head: string) {
  const state = { pulled: 0, cancelled: false };
  const enc = new TextEncoder();
  let n = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      const text = n === 0 ? head + frames(n++) : frames(n++);
      const bytes = enc.encode(text);
      state.pulled += bytes.byteLength;
      c.enqueue(bytes);
    },
    cancel() { state.cancelled = true; },
  });
  return { state, response: () => new Response(body, { headers: SSE }) };
}
const pad = "x".repeat(4096);
const data = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const LIMITS = { maxBodyBytes: 256 * 1024 };

const WIRES: { name: string; head: string; frame: (n: number) => string; make: (f: typeof globalThis.fetch) => StreamingAdapter }[] = [
  {
    name: "chat_completions", head: "", frame: () => data({ choices: [{ index: 0, delta: { content: pad } }] }),
    make: (fetch) => chat(fetch, { limits: LIMITS }),
  },
  {
    name: "gemini", head: "", frame: () => data({ candidates: [{ content: { parts: [{ text: pad }] } }] }),
    make: (fetch) => createGeminiAdapter({ credentials: { apiKey: () => "k-0123456789" }, fetch, limits: LIMITS }),
  },
  {
    name: "anthropic", head: data({ type: "message_start", message: { id: "m", model: "m" } }) + data({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    frame: () => data({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: pad } }),
    make: (fetch) => createAnthropicAdapter({ credentials: { apiKey: () => "k-0123456789" }, fetch, limits: LIMITS }),
  },
  {
    name: "responses", head: data({ type: "response.created", response: { id: "r", model: "m" } }) + data({ type: "response.output_item.added", output_index: 0, item: { type: "message" } }),
    frame: () => data({ type: "response.output_text.delta", output_index: 0, delta: pad }),
    make: (fetch) => createResponsesAdapter({ credentials: { authorization: () => undefined }, fetch, limits: LIMITS }),
  },
];

for (const w of WIRES) {
  test(`${w.name}: a stream that never ends is cut at maxBodyBytes, not buffered without bound`, T, async () => {
    const src = endless(w.frame, w.head);
    const a = w.make((async () => src.response()) as typeof globalThis.fetch);
    let seen = 0;
    await assert.rejects(async () => { for await (const _ of a.stream(REQ)) seen += 1; },
      (e: unknown) => e instanceof ProviderError && e.code === "protocol" && /exceeds/.test(e.message) && e.partial !== undefined);
    assert.ok(seen > 0, "events before the cut were delivered");
    assert.ok(src.state.pulled < LIMITS.maxBodyBytes + 128 * 1024, `pulled ${src.state.pulled} bytes`);
    assert.equal(src.state.cancelled, true, "the connection was released");
  });
}
