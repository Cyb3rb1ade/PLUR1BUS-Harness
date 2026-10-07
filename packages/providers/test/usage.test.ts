// Usage normalisation (C7): a count the provider did not report is `undefined`, never 0.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUsage } from "../src/accumulate.ts";
import { ProviderError, createChatCompletionsAdapter, parseGeminiUsage } from "../src/index.ts";
import type { ChatResult, ChatStreamEvent } from "../src/index.ts";
import { adapterFor, basic, candidate, collect, json, sse as geminiSse } from "./gemini/helpers.ts";
import { basicRequest, credentials, sseHeaders, startStub } from "./helpers/stub.ts";

const T = { timeout: 15_000 };
const isUnknown = (e: unknown) => e instanceof ProviderError && e.kind === "unknown";

test("OpenAI: full usage, cached and reasoning details", () => {
  assert.deepEqual(parseUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }), { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  assert.deepEqual(
    parseUsage({ prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, prompt_tokens_details: { cached_tokens: 64 }, completion_tokens_details: { reasoning_tokens: 12 } }),
    { inputTokens: 100, outputTokens: 40, totalTokens: 140, cachedInputTokens: 64, reasoningTokens: 12 },
  );
  // a reported zero is a zero, not "absent"
  assert.deepEqual(parseUsage({ prompt_tokens: 3, completion_tokens: 0, completion_tokens_details: { reasoning_tokens: 0 } }),
    { inputTokens: 3, outputTokens: 0, totalTokens: 3, reasoningTokens: 0 });
  // the provider's total wins over the sum
  assert.equal(parseUsage({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 9 })?.totalTokens, 9);
});

test("partial usage: only prompt/completion, only total, empty object", () => {
  assert.deepEqual(parseUsage({ prompt_tokens: 7 }), { inputTokens: 7 });
  assert.deepEqual(parseUsage({ completion_tokens: 7 }), { outputTokens: 7 });
  assert.deepEqual(parseUsage({ prompt_tokens: 7, completion_tokens: 2 }), { inputTokens: 7, outputTokens: 2, totalTokens: 9 });
  assert.deepEqual(parseUsage({ total_tokens: 21 }), { totalTokens: 21 });
  assert.equal(parseUsage({}), undefined);
  assert.equal(parseUsage({ prompt_tokens: null, completion_tokens: null, prompt_tokens_details: {}, completion_tokens_details: null }), undefined);
});

test("Ollama / LM Studio style usage", () => {
  // Ollama /v1: OpenAI names
  assert.deepEqual(parseUsage({ prompt_tokens: 26, completion_tokens: 298, total_tokens: 324 }), { inputTokens: 26, outputTokens: 298, totalTokens: 324 });
  // native fields forwarded by a shim: fallback only
  assert.deepEqual(parseUsage({ prompt_eval_count: 26, eval_count: 298 }), { inputTokens: 26, outputTokens: 298, totalTokens: 324 });
  assert.deepEqual(parseUsage({ prompt_eval_count: 26 }), { inputTokens: 26 });
  // OpenAI field wins when both exist
  assert.deepEqual(parseUsage({ prompt_tokens: 5, prompt_eval_count: 99, completion_tokens: 6, eval_count: 99 }), { inputTokens: 5, outputTokens: 6, totalTokens: 11 });
  // LM Studio: all three, no details
  assert.deepEqual(parseUsage({ prompt_tokens: 12, completion_tokens: 30, total_tokens: 42 }), { inputTokens: 12, outputTokens: 30, totalTokens: 42 });
  // a malformed native field is still an error
  assert.throws(() => parseUsage({ eval_count: -1 }), isUnknown);
});

test("OpenAI usage: malformed values are still protocol errors", () => {
  for (const bad of [{ prompt_tokens: -1 }, { prompt_tokens: 1.5 }, { completion_tokens: "7" }, { total_tokens: -2 },
    { prompt_tokens_details: { cached_tokens: 0.5 } }, { completion_tokens_details: { reasoning_tokens: "x" } }, [], "x", null]) {
    assert.throws(() => parseUsage(bad), isUnknown, JSON.stringify(bad));
  }
});

test("Gemini: thinking tokens, cached, tool-use prompt", () => {
  assert.deepEqual(parseGeminiUsage({ promptTokenCount: 100, toolUsePromptTokenCount: 20, candidatesTokenCount: 30, thoughtsTokenCount: 50, cachedContentTokenCount: 64, totalTokenCount: 200 }),
    { inputTokens: 120, outputTokens: 80, totalTokens: 200, cachedInputTokens: 64, reasoningTokens: 50 });
  assert.deepEqual(parseGeminiUsage({ promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 6 }),
    { inputTokens: 10, outputTokens: 10, totalTokens: 20, reasoningTokens: 6 });
  assert.deepEqual(parseGeminiUsage({ promptTokenCount: 10, toolUsePromptTokenCount: 5, candidatesTokenCount: 1 }), { inputTokens: 15, outputTokens: 1, totalTokens: 16 });
});

test("Gemini: missing and partial counts stay absent", () => {
  assert.equal(parseGeminiUsage({}), undefined);
  assert.equal(parseGeminiUsage({ promptTokenCount: null }), undefined);
  assert.deepEqual(parseGeminiUsage({ promptTokenCount: 4 }), { inputTokens: 4 });
  assert.deepEqual(parseGeminiUsage({ candidatesTokenCount: 4 }), { outputTokens: 4 });
  assert.deepEqual(parseGeminiUsage({ thoughtsTokenCount: 4 }), { outputTokens: 4, reasoningTokens: 4 });
  assert.deepEqual(parseGeminiUsage({ toolUsePromptTokenCount: 3 }), { inputTokens: 3 });
  assert.deepEqual(parseGeminiUsage({ totalTokenCount: 9 }), { totalTokens: 9 });
  assert.deepEqual(parseGeminiUsage({ cachedContentTokenCount: 0 }), { cachedInputTokens: 0 });
  // total derived only when BOTH sides are known
  assert.equal(parseGeminiUsage({ promptTokenCount: 4 })?.totalTokens, undefined);
  assert.equal(parseGeminiUsage({ promptTokenCount: 4, candidatesTokenCount: 0 })?.totalTokens, 4);
});

test("Gemini: malformed values are still protocol errors", () => {
  for (const bad of [{ promptTokenCount: -1 }, { candidatesTokenCount: 1.5 }, { thoughtsTokenCount: "7" }, { totalTokenCount: -1 }, { cachedContentTokenCount: 0.1 }, [], null, "x"]) {
    assert.throws(() => parseGeminiUsage(bad), isUnknown, JSON.stringify(bad));
  }
});

// ---- end to end: stream / non-stream parity ----

async function openai(usage: unknown, mode: "stream" | "complete"): Promise<{ result: ChatResult; events: ChatStreamEvent[] }> {
  const stub = await startStub((_q, res) => {
    if (mode === "complete") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "c", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], ...(usage === undefined ? {} : { usage }) }));
      return;
    }
    sseHeaders(res);
    res.write(`data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`);
    if (usage !== undefined) res.write(`data: ${JSON.stringify({ id: "c", choices: [], usage })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
  try {
    const a = createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: credentials() });
    if (mode === "complete") return { result: await a.complete(basicRequest), events: [] };
    const events = await collect(a.stream(basicRequest));
    const done = events.at(-1);
    assert.ok(done?.type === "done");
    return { result: done.result, events };
  } finally { await stub.close(); }
}

test("OpenAI stream and non-stream agree, for partial and absent usage", T, async () => {
  for (const [usage, expected] of [
    [{ prompt_tokens: 8, completion_tokens: 3, total_tokens: 11, prompt_tokens_details: { cached_tokens: 2 } }, { inputTokens: 8, outputTokens: 3, totalTokens: 11, cachedInputTokens: 2 }],
    [{ prompt_tokens: 8 }, { inputTokens: 8 }],
    [{ total_tokens: 11 }, { totalTokens: 11 }],
    [{}, undefined],
    [undefined, undefined],
  ] as const) {
    const s = await openai(usage, "stream"), c = await openai(usage, "complete");
    assert.deepEqual(s.result.usage, expected, JSON.stringify(usage));
    assert.deepEqual(c.result.usage, expected, JSON.stringify(usage));
    assert.equal("usage" in s.result, expected !== undefined);
    assert.equal(s.events.filter((e) => e.type === "usage").length, expected === undefined ? 0 : 1);
  }
});

test("OpenAI: an empty usage chunk does not erase an earlier one", T, async () => {
  const stub = await startStub((_q, res) => {
    sseHeaders(res);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 1 } })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: {} })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
  try {
    const events = await collect(createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: credentials() }).stream(basicRequest));
    assert.equal(events.filter((e) => e.type === "usage").length, 1);
    const done = events.at(-1);
    assert.ok(done?.type === "done");
    assert.deepEqual(done.result.usage, { inputTokens: 4, outputTokens: 1, totalTokens: 5 });
  } finally { await stub.close(); }
});

test("OpenAI: malformed usage still rejects stream and non-stream", T, async () => {
  for (const mode of ["stream", "complete"] as const) {
    await assert.rejects(openai({ prompt_tokens: -1, completion_tokens: 2 }, mode), isUnknown);
    await assert.rejects(openai({ prompt_tokens: "7" }, mode), isUnknown);
  }
});

test("Gemini stream and non-stream agree, including no usage at all", T, async () => {
  const meta = { promptTokenCount: 7, candidatesTokenCount: 2, thoughtsTokenCount: 4, cachedContentTokenCount: 3 };
  const expected = { inputTokens: 7, outputTokens: 6, totalTokens: 13, cachedInputTokens: 3, reasoningTokens: 4 };
  for (const [um, want] of [[meta, expected], [{ promptTokenCount: 7 }, { inputTokens: 7 }], [{}, undefined], [undefined, undefined]] as const) {
    const body = { ...candidate([{ text: "ok" }], "STOP"), ...(um === undefined ? {} : { usageMetadata: um }) };
    const s1 = await startStub((_q, res) => json(res, body));
    const s2 = await startStub((_q, res) => geminiSse(res, [body]));
    try {
      const c = await adapterFor(s1).adapter.complete(basic);
      const events = await collect(adapterFor(s2).adapter.stream(basic));
      const done = events.at(-1);
      assert.ok(done?.type === "done");
      assert.deepEqual(c.usage, want);
      assert.deepEqual(done.result.usage, want);
      assert.equal(events.filter((e) => e.type === "usage").length, want === undefined ? 0 : 1);
    } finally { await s1.close(); await s2.close(); }
  }
});

test("Gemini stream: one cumulative usage event; empty usageMetadata later does not erase it", T, async () => {
  const stub = await startStub((_q, res) => geminiSse(res, [
    { ...candidate([{ text: "a" }]), usageMetadata: { promptTokenCount: 5 } },
    { ...candidate([{ text: "b" }], "STOP"), usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } },
    { usageMetadata: {} },
  ]));
  try {
    const events = await collect(adapterFor(stub).adapter.stream(basic));
    const us = events.filter((e) => e.type === "usage");
    assert.equal(us.length, 1);
    assert.deepEqual(us[0]?.type === "usage" && us[0].usage, { inputTokens: 5, outputTokens: 2, totalTokens: 7 });
  } finally { await stub.close(); }
});
