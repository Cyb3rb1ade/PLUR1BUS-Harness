// H9: the three real wire adapters behind one modelProfiles profile (chat_completions -> anthropic -> responses), served by
// loopback stubs. Fallback happens on transient failures only; auth, invalid_request and context_length stop the chain.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createAnthropicAdapter, createChatCompletionsAdapter, createResponsesAdapter, createRouterFromProfiles, ProviderError } from "../../src/index.ts";
import type { ProviderRegistry, RouterEvent } from "../../src/index.ts";
import { sseHeaders, startStub } from "../helpers/stub.ts";
import type { Handler, Stub } from "../helpers/stub.ts";
import { FakeClock, REQ } from "./helpers.ts";

const T = { timeout: 20_000 };
const RESPONSES_TEXT = readFileSync(new URL("../contract/fixtures/responses.text.sse", import.meta.url), "utf8");

const jsonError = (status: number, body: object): Handler => (_q, res) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const unreachable: Handler = (_q, res) => { res.writeHead(500, { "content-type": "application/json" }); res.end("{}"); };

interface Rig { stubs: Record<"chat" | "anthropic" | "responses", Stub>; run<R>(fn: (r: { router: ReturnType<typeof createRouterFromProfiles>["router"]; events: RouterEvent[] }) => Promise<R>): Promise<R> }

async function rig(handlers: Record<"chat" | "anthropic" | "responses", Handler>, order: ("chat" | "anthropic" | "responses")[] = ["chat", "anthropic", "responses"]): Promise<Rig> {
  const stubs = { chat: await startStub(handlers.chat), anthropic: await startStub(handlers.anthropic), responses: await startStub(handlers.responses) };
  const registry: ProviderRegistry = new Map([
    ["oa", { adapter: createChatCompletionsAdapter({ baseUrl: stubs.chat.baseUrl, credentials: { authorization: () => "Bearer sk-mixed-chat-0000000000" } }) }],
    ["an", { adapter: createAnthropicAdapter({ baseUrl: stubs.anthropic.baseUrl, credentials: { apiKey: () => "sk-ant-mixed-0000000000" } }) }],
    ["re", { adapter: createResponsesAdapter({ baseUrl: stubs.responses.baseUrl, credentials: { authorization: () => "Bearer sk-mixed-responses-000000" } }) }],
  ]);
  const ref = { chat: "oa/chat-model", anthropic: "an/claude-model", responses: "re/responses-model" };
  const { router } = createRouterFromProfiles(
    { mixed: { candidates: order.map((w) => ({ model: ref[w] })), params: { maxTokens: 64 } } },
    registry,
    { clock: new FakeClock(), random: () => 0.5, retry: { maxRetries: 0 }, breaker: { failureThreshold: 100 }, onEvent: (e) => events.push(e) },
  );
  const events: RouterEvent[] = [];
  return {
    stubs,
    async run(fn) {
      try { return await fn({ router, events }); } finally { await Promise.all(Object.values(stubs).map((s) => s.close())); }
    },
  };
}

test("overloaded at chat_completions and at anthropic: the profile falls through to the responses candidate, each wire gets its own request", T, async () => {
  const r = await rig({
    chat: jsonError(503, { error: { message: "busy", type: "server_error" } }),
    anthropic: jsonError(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
    responses: (_q, res) => { sseHeaders(res); res.end(RESPONSES_TEXT); },
  });
  await r.run(async ({ router, events }) => {
    const out = await router.complete("mixed", REQ);
    assert.equal(out.result.text, "Hello, world");
    assert.deepEqual(out.served, { provider: "re", model: "responses-model" });
    assert.deepEqual(events.filter((e) => e.type === "provider.fallback").map((e) => e.type === "provider.fallback" && [e.from.provider, e.to.provider, e.reason]), [["oa", "an", "overloaded"], ["an", "re", "overloaded"]]);
    const [c, a, p] = [r.stubs.chat.requests[0]!, r.stubs.anthropic.requests[0]!, r.stubs.responses.requests[0]!];
    assert.deepEqual([c.url, a.url, p.url], ["/v1/chat/completions", "/v1/messages", "/v1/responses"]);
    assert.deepEqual([JSON.parse(c.body).model, JSON.parse(a.body).model, JSON.parse(p.body).model], ["chat-model", "claude-model", "responses-model"]);
    assert.deepEqual([JSON.parse(c.body).max_tokens, JSON.parse(a.body).max_tokens, JSON.parse(p.body).max_output_tokens], [64, 64, 64]);
    assert.equal(c.headers["authorization"], "Bearer sk-mixed-chat-0000000000");
    assert.equal(a.headers["x-api-key"], "sk-ant-mixed-0000000000");
    assert.equal(p.headers["authorization"], "Bearer sk-mixed-responses-000000");
    // no credential crosses to another wire
    assert.equal(JSON.stringify([a.headers, p.headers]).includes("sk-mixed-chat"), false);
    assert.equal(JSON.stringify([c.headers, p.headers]).includes("sk-ant-mixed"), false);
    assert.equal(JSON.stringify([c.headers, a.headers]).includes("sk-mixed-responses"), false);
  });
});

test("rate limit at the responses candidate falls back to the next wire", T, async () => {
  const r = await rig({
    chat: unreachable, anthropic: (_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); },
    responses: (_q, res) => { res.writeHead(429, { "content-type": "application/json", "x-ratelimit-reset-requests": "1s" }); res.end(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "slow", type: "requests" } })); },
  }, ["responses", "chat"]);
  await r.run(async ({ router, events }) => {
    const e = await router.complete("mixed", REQ).then(() => undefined, (x: unknown) => x);
    assert.ok(e instanceof ProviderError && e.kind === "overloaded", "the chat stub's 500 is the last candidate's failure");
    assert.equal(r.stubs.responses.requests.length, 1);
    assert.equal(r.stubs.chat.requests.length, 1);
    assert.equal(r.stubs.anthropic.requests.length, 0);
    assert.deepEqual(events.filter((x) => x.type === "provider.fallback").map((x) => x.type === "provider.fallback" && x.reason), ["rate_limit"]);
  });
});

const FAILS: [string, number, object, ProviderError["kind"]][] = [
  ["auth", 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, "auth"],
  ["invalid_request", 400, { type: "error", error: { type: "invalid_request_error", message: "max_tokens: must be positive" } }, "invalid_request"],
  ["context_length", 400, { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum" } }, "context_length"],
];
const RFAILS: [string, number, object, ProviderError["kind"]][] = [
  ["auth", 401, { error: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "invalid_api_key" } }, "auth"],
  ["invalid_request", 400, { error: { message: "Unsupported parameter: foo", type: "invalid_request_error", param: "foo", code: "unsupported_parameter" } }, "invalid_request"],
  ["context_length", 400, { error: { message: "Your input exceeds the context window of this model.", type: "invalid_request_error", code: "context_length_exceeded" } }, "context_length"],
];

for (const wire of ["anthropic", "responses"] as const) {
  for (const [label, status, body, kind] of wire === "anthropic" ? FAILS : RFAILS) {
    test(`${wire}: ${label} stops the chain; the next candidate is never asked`, T, async () => {
      const handlers = { chat: unreachable, anthropic: unreachable, responses: unreachable, [wire]: jsonError(status, body) };
      const r = await rig(handlers, [wire, "chat", wire === "anthropic" ? "responses" : "anthropic"]);
      await r.run(async ({ router, events }) => {
        const e = await router.complete("mixed", REQ).then(() => undefined, (x: unknown) => x);
        assert.ok(e instanceof ProviderError && e.kind === kind && !e.retryable, `${wire} ${label}: ${String(e)}`);
        assert.equal(r.stubs[wire].requests.length, 1);
        assert.equal(r.stubs.chat.requests.length, 0);
        assert.equal(wire === "anthropic" ? r.stubs.responses.requests.length : r.stubs.anthropic.requests.length, 0);
        assert.deepEqual(events, []);
      });
    });
  }
}
