import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { emitProviderCache, type HeaderSink } from "../../src/composition/cache-emit.ts";
import { conversationItems } from "../../src/composition/provider.ts";
import { providerFetch } from "../../src/composition/http.ts";
import { promptContext } from "../../src/composition/context.ts";
import { createPromptBuilder, type CacheRoute, type CacheTtl } from "../../src/prompt/index.ts";
import { buildRequestBody, buildAnthropicBody } from "../../../providers/src/index.ts";
import { buildResponsesBody } from "../../../providers/src/responses/request.ts";
import type { ChatMessage, ChatRequest } from "../../../providers/src/index.ts";

type Body = Record<string, unknown>;
type Part = Record<string, unknown>;

const STABLE = "stable instructions ".repeat(600);
const ask: ChatMessage = { role: "user", content: "read the file" };
const loop: ChatMessage[] = [ask, { role: "assistant", content: null, toolCalls: [{ id: "call_1", name: "file_read", arguments: "{\"path\":\"a\"}" }] }, { role: "tool", toolCallId: "call_1", content: "file bytes" }];

/** A turn as composition/provider.ts builds it: the real builder's prefix, the wire messages, then the recall tail. */
function turn(model: string, conversation: ChatMessage[], o: { route?: CacheRoute; system?: string; cacheTtl?: CacheTtl; cacheHint?: "none" } = {}) {
  const rendered = createPromptBuilder().render({
    agentId: "a1", sessionId: "s1", model, ...(o.route ? { route: o.route } : {}), ...(o.cacheTtl ? { cacheTtl: o.cacheTtl } : {}), ...(o.cacheHint ? { cacheHint: o.cacheHint } : {}),
    tools: [{ name: "file.read", description: "Read a file" }], system: [o.system ?? STABLE], memory: "remembered facts",
    conversation: conversationItems(conversation), volatile: { blocks: [{ name: "recall", text: "live recall", chars: 11, droppable: false }] },
  });
  const prefix: ChatMessage[] = rendered.segments.filter(s => s.zone === "system" || s.zone === "memory").map(s => ({ role: "system", content: s.text }));
  const tail: ChatMessage[] = rendered.segments.filter(s => s.zone === "volatile").map(s => ({ role: "user", content: s.text }));
  const request: ChatRequest = { model, messages: [...prefix, ...conversation, ...tail], tools: [{ name: "file_read", description: "Read a file", parameters: { type: "object" } }] };
  return { rendered, request };
}
const chat = (r: ChatRequest): Body => buildRequestBody(r, { stream: true, maxTokensField: "max_tokens", includeUsage: true });
const responses = (r: ChatRequest): Body => buildResponsesBody(r, { stream: true, profile: "openai", store: false });
function emit(format: string, body: Body, route: CacheRoute, rendered: ReturnType<typeof turn>["rendered"]) {
  const headers: Record<string, string> = {};
  const sink: HeaderSink = { has: n => n.toLowerCase() in headers, set: (n, v) => { headers[n.toLowerCase()] = v; } };
  emitProviderCache(format, body, sink, route, rendered);
  return { body, headers };
}
const marked = (v: unknown) => JSON.stringify(v).includes("cache_control");
const messagesOf = (b: Body) => b.messages as Part[];

describe("cache emitter: explicit breakpoints", () => {
  it("OpenRouter to Claude: session_id, cache_control on the stable system text parts and on the last user text, never on the recall", () => {
    const { rendered, request } = turn("anthropic/claude-sonnet-4.5", [ask]);
    assert.ok(rendered.breakpoints.length >= 2);
    const { body, headers } = emit("chat_completions", chat(request), { gateway: "openrouter" }, rendered);
    assert.equal(body.session_id, rendered.session_id);
    assert.deepEqual(headers, {});
    const [system, memory, user, recall] = messagesOf(body);
    assert.deepEqual((system!.content as Part[])[0]!.cache_control, { type: "ephemeral" });
    assert.deepEqual((memory!.content as Part[])[0]!.cache_control, { type: "ephemeral" });
    assert.deepEqual(user!.content, [{ type: "text", text: "read the file", cache_control: { type: "ephemeral" } }]);
    assert.equal(recall!.content, "live recall", "the recall tail stays a plain string");
  });

  it("OpenRouter to Claude in a tool loop: the trailing breakpoint lands on the tool message, never on the assistant's tool call", () => {
    const { rendered, request } = turn("anthropic/claude-sonnet-4.5", loop);
    const { body } = emit("chat_completions", chat(request), { gateway: "openrouter" }, rendered);
    const tool = messagesOf(body).find(m => m.role === "tool")!;
    assert.deepEqual(tool.content, [{ type: "text", text: "file bytes", cache_control: { type: "ephemeral" } }]);
    assert.equal(marked(messagesOf(body).find(m => m.role === "assistant")), false);
  });

  it("a 1h stable TTL is written on the marker; the trailing one stays 5m", () => {
    const { rendered, request } = turn("anthropic/claude-sonnet-4.5", [ask], { cacheTtl: "1h" });
    const { body } = emit("chat_completions", chat(request), { gateway: "openrouter" }, rendered);
    assert.deepEqual((messagesOf(body)[1]!.content as Part[])[0]!.cache_control, { type: "ephemeral", ttl: "1h" });
    assert.deepEqual((messagesOf(body)[2]!.content as Part[])[0]!.cache_control, { type: "ephemeral" });
  });

  it("OpenAI GPT-5.6+ on Responses: instructions become a developer message with marked parts, explicit mode, prompt_cache_key", () => {
    const { rendered, request } = turn("gpt-5.6", loop);
    const { body } = emit("codex_responses", responses(request), { vendor: "openai" }, rendered);
    assert.equal(body.instructions, undefined);
    const input = body.input as Part[];
    assert.deepEqual(input[0]!.role, "developer");
    const parts = input[0]!.content as Part[];
    assert.deepEqual(parts.map(p => p.text), rendered.segments.filter(s => s.zone === "system" || s.zone === "memory").map(s => s.text));
    assert.ok(parts.some(p => (p.prompt_cache_breakpoint as Part | undefined)?.mode === "explicit"));
    const output = input.find(i => i.type === "function_call_output")!;
    assert.deepEqual(output.output, [{ type: "input_text", text: "file bytes", prompt_cache_breakpoint: { mode: "explicit" } }]);
    assert.deepEqual(body.prompt_cache_options, { mode: "explicit" });
    assert.equal(body.prompt_cache_key, rendered.session_id);
    assert.equal(JSON.stringify(input.at(-1)).includes("prompt_cache_breakpoint"), false, "the recall tail is never a breakpoint");
  });

  it("OpenAI GPT-5.6+ with no breakpoint (below the minimum or the profile's hint none): explicit mode, so no paid write", () => {
    for (const o of [{ system: "short" }, { cacheHint: "none" as const }]) {
      const { rendered, request } = turn("gpt-5.6", [ask], o);
      assert.equal(rendered.breakpoints.length, 0);
      const { body } = emit("codex_responses", responses(request), { vendor: "openai" }, rendered);
      assert.deepEqual(body.prompt_cache_options, { mode: "explicit" });
      assert.equal(typeof body.instructions, "string", "nothing to mark, so instructions stay");
    }
  });

  it("OpenAI GPT-5.6+ on Chat Completions or through the ChatGPT plan: no breakpoint fields (not documented there)", () => {
    const { rendered, request } = turn("gpt-5.6", [ask]);
    const onChat = emit("chat_completions", chat(request), { vendor: "openai" }, rendered).body;
    assert.equal(onChat.prompt_cache_options, undefined);
    assert.equal(onChat.prompt_cache_key, rendered.session_id);
    const plan = emit("codex_responses", responses(request), { vendor: "openai", platform: "chatgpt-plan" }, rendered).body;
    assert.equal(plan.prompt_cache_options, undefined);
    assert.equal(plan.prompt_cache_key, undefined, "the plan endpoint gets only fields it is known to accept");
    assert.equal(JSON.stringify(plan).includes("prompt_cache_breakpoint"), false);
  });

  it("the Anthropic wire keeps getting the builder's markers whatever the route", () => {
    const { rendered, request } = turn("claude-sonnet-4-5", loop);
    const body = buildAnthropicBody(request, { stream: true, defaultMaxTokens: 1024 });
    emit("anthropic_messages", body, {}, rendered);
    const last = (body.messages as { content: Part[] }[]).at(-1)!.content;
    assert.deepEqual(last[0]!.cache_control, { type: "ephemeral" });
    assert.equal(last[1]!.cache_control, undefined);
  });
});

describe("cache emitter: implicit providers", () => {
  it("Moonshot K3: the TTL tier and prompt_cache_key; the tier follows the builder's stable TTL", () => {
    for (const [ttl, want] of [[undefined, "5m"], ["1h", "1h"]] as const) {
      const { rendered, request } = turn("kimi-k3", [ask], ttl ? { cacheTtl: ttl } : {});
      const { body } = emit("chat_completions", chat(request), { vendor: "moonshot" }, rendered);
      assert.deepEqual(body.prompt_cache_options, { mode: "implicit", ttl: want });
      assert.equal(body.prompt_cache_key, rendered.session_id);
      assert.equal(marked(body), false);
    }
  });

  it("Moonshot K3 on the Messages wire: the tier as a top-level cache_control and the user id as the affinity key", () => {
    for (const [ttl, want] of [[undefined, "5m"], ["1h", "1h"]] as const) {
      const { rendered, request } = turn("kimi-k3", [ask], ttl ? { cacheTtl: ttl } : {});
      const body = buildAnthropicBody(request, { stream: true, defaultMaxTokens: 1024 });
      emit("anthropic_messages", body, { vendor: "moonshot" }, rendered);
      assert.deepEqual(body.cache_control, { type: "ephemeral", ttl: want });
      assert.deepEqual(body.metadata, { user_id: rendered.session_id });
      assert.equal(JSON.stringify(body.messages).includes("cache_control"), false, "no block markers for an implicit cache");
    }
  });

  it("xAI: x-grok-conv-id on Chat Completions, prompt_cache_key on Responses", () => {
    const { rendered, request } = turn("grok-4.7", [ask]);
    const c = emit("chat_completions", chat(request), { vendor: "xai" }, rendered);
    assert.deepEqual(c.headers, { "x-grok-conv-id": rendered.session_id });
    assert.equal(c.body.prompt_cache_key, undefined);
    const r = emit("codex_responses", responses(request), { vendor: "xai" }, rendered);
    assert.deepEqual(r.headers, {});
    assert.equal(r.body.prompt_cache_key, rendered.session_id);
  });

  it("OpenAI before 5.6 and Mistral: prompt_cache_key only", () => {
    for (const [model, vendor] of [["gpt-4.1", "openai"], ["mistral-large-4", "mistral"]] as const) {
      const { rendered, request } = turn(model, [ask]);
      const { body } = emit("chat_completions", chat(request), { vendor }, rendered);
      assert.equal(body.prompt_cache_key, rendered.session_id, model);
      assert.equal(body.prompt_cache_options, undefined, model);
    }
  });

  it("DeepSeek, Gemini-compatible and local servers get nothing; OpenRouter to an implicit upstream gets only session_id", () => {
    for (const [model, route] of [["deepseek-v4.1-flash", { vendor: "deepseek" }], ["qwen3:8b", { local: true }]] as const) {
      const { rendered, request } = turn(model, [ask], { route });
      const before = JSON.stringify(chat(request));
      const { body, headers } = emit("chat_completions", chat(request), route, rendered);
      assert.equal(JSON.stringify(body), before, model);
      assert.deepEqual(headers, {});
    }
    const { rendered, request } = turn("deepseek/deepseek-chat", [ask]);
    const { body } = emit("chat_completions", chat(request), { gateway: "openrouter" }, rendered);
    assert.equal(body.session_id, rendered.session_id);
    assert.equal(marked(body), false);
  });

  it("a provider's own fields go only to that provider's API: an unknown or foreign host gets nothing", () => {
    for (const [model, route] of [["grok-4.7", {}], ["gpt-4.1", { vendor: "mistral" }], ["kimi-k3", {}]] as const) {
      const { rendered, request } = turn(model, [ask]);
      const before = JSON.stringify(chat(request));
      const { body, headers } = emit("chat_completions", chat(request), route, rendered);
      assert.equal(JSON.stringify(body), before, model);
      assert.deepEqual(headers, {}, model);
    }
  });

  it("never overwrites a key the request already carries", () => {
    const { rendered, request } = turn("gpt-4.1", [ask]);
    const body = { ...chat(request), prompt_cache_key: "caller" };
    emit("chat_completions", body, { vendor: "openai" }, rendered);
    assert.equal(body.prompt_cache_key, "caller");
  });
});

describe("providerFetch with a route", () => {
  it("inside a turn the emitted header reaches the transport; outside a turn nothing is added", async () => {
    const { rendered, request } = turn("grok-4.7", [ask]);
    const seen: RequestInit[] = [];
    const f = providerFetch({ decide: async () => { throw new Error("no egress"); } }, "chat_completions", (async (_i: unknown, init?: RequestInit) => { seen.push(init!); return new Response("{}"); }) as typeof fetch, { vendor: "xai" });
    const init = { method: "POST", headers: { "x-probe": "1" }, body: JSON.stringify(chat(request)) };
    await promptContext.run(rendered, () => f("https://api.x.ai/v1/chat/completions", init));
    await f("https://api.x.ai/v1/chat/completions", init);
    assert.deepEqual(seen[0]!.headers, { "x-probe": "1", "x-grok-conv-id": rendered.session_id });
    assert.deepEqual(seen[1]!.headers, { "x-probe": "1" });
    assert.equal(seen[1]!.body, init.body, "outside a turn the body is passed through verbatim");
  });

  it("the Gemini wire is never rewritten", async () => {
    const { rendered } = turn("gemini-2.5-pro", [ask]);
    let body: unknown;
    const f = providerFetch({ decide: async () => { throw new Error("no egress"); } }, "gemini", (async (_i: unknown, init?: RequestInit) => { body = init?.body; return new Response("{}"); }) as typeof fetch, { vendor: "google" });
    await promptContext.run(rendered, () => f("https://generativelanguage.googleapis.com/x", { method: "POST", body: "{\"contents\": []}" }));
    assert.equal(body, "{\"contents\": []}");
  });
});
