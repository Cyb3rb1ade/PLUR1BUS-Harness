// W1 vector inputs use explicit breakpoints so emission can be compared independently of the prompt builder.
import { fileURLToPath } from "node:url";
import { emitProviderCache } from "../../packages/core/src/composition/cache-emit.ts";
import { buildAnthropicBody, buildRequestBody, type CacheRoute, type ChatRequest } from "../../packages/providers/src/index.ts";
import { buildResponsesBody } from "../../packages/providers/src/responses/request.ts";
import { exporterMain } from "./lib.mjs";

type Prompt = Parameters<typeof emitProviderCache>[4];

const request = (model: string): ChatRequest => ({
  model, messages: [
    { role: "system", content: "Instructions" },
    { role: "system", content: "Facts" },
    { role: "user", content: "Look up an example." },
    { role: "assistant", toolCalls: [{ id: "call_fixture", name: "lookup", arguments: "{}" }] },
    { role: "tool", toolCallId: "call_fixture", content: "Found." },
    { role: "user", content: "Volatile recall" },
  ],
  tools: [{ name: "lookup", parameters: { type: "object" } }],
});
const segments = [
  { zone: "system", text: "Instructions" },
  { zone: "memory", text: "Facts" },
  { zone: "conversation", kind: "text", text: "Look up an example." },
  { zone: "conversation", kind: "tool_use", id: "call_fixture" },
  { zone: "conversation", kind: "tool_result", id: "call_fixture" },
  { zone: "tools" },
  { zone: "volatile", text: "Volatile recall" },
];
type CacheCase = { name: string; model: string; wire: string; route: CacheRoute; topology?: "empty" | "marked"; headers?: Record<string, string> };

const cases: CacheCase[] = [
  { name: "openrouter-claude", model: "anthropic/claude-sonnet-4.5", wire: "chat_completions", route: { gateway: "openrouter" } },
  { name: "claude-anthropic", model: "claude-sonnet-4-5", wire: "anthropic_messages", route: {} },
  { name: "responses-first-party", model: "gpt-5.6", wire: "codex_responses", route: { vendor: "openai" } },
  { name: "responses-no-breakpoint", model: "gpt-5.6", wire: "codex_responses", route: { vendor: "openai" }, topology: "empty" },
  { name: "responses-plan-platform", model: "gpt-5.6", wire: "codex_responses", route: { vendor: "openai", platform: "chatgpt-plan" } },
  { name: "moonshot-tier", model: "kimi-k3", wire: "chat_completions", route: { vendor: "moonshot" } },
  { name: "xai-preserve-header", model: "grok-4.5", wire: "chat_completions", route: { vendor: "xai" }, headers: { "x-grok-conv-id": "supplied" } },
  { name: "unknown-host", model: "gpt-5.6", wire: "codex_responses", route: {} },
];

export function buildProviderCacheFixtures() {
  return {
    "emitter": {
      schema: "plur1bus.provider-cache/1",
      source: "packages/core/src/composition/cache-emit.ts",
      cases: cases.map(c => {
        const req = request(c.model);
        const body = c.wire === "anthropic_messages" ? buildAnthropicBody(req, { stream: true, defaultMaxTokens: 4096 })
          : c.wire === "codex_responses" ? buildResponsesBody(req, { stream: true, profile: "openai", store: false })
          : buildRequestBody(req, { stream: true, maxTokensField: "max_tokens", includeUsage: true });
        const prompt = {
          model: c.model, session_id: "fixture-session", segments,
          cache: { ttl: "1h" },
          breakpoints: c.topology === "empty" ? [] : [{ segment: 1, ttl: "1h" }, { segment: 4, ttl: "5m" }, { segment: 5, ttl: "5m" }],
        } as unknown as Prompt;
        const headers = { ...c.headers };
        emitProviderCache(c.wire, body, { has: n => Object.hasOwn(headers, n), set: (n, v) => { headers[n] = v; } }, c.route, prompt);
        return { name: c.name, wire: c.wire, requestJson: JSON.stringify(req), route: c.route, prompt, headers: c.headers ?? {},
          expected: { bodyText: JSON.stringify(body), headers } };
      }),
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await exporterMain({ area: "provider-cache", build: buildProviderCacheFixtures }));
}
