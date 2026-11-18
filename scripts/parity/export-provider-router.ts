// W1 pure routing and reasoning vectors, driven through the frozen TypeScript implementations.
import { fileURLToPath } from "node:url";
import { ProviderError, ProviderRouter, type ProviderErrorKind, type ChatRequest, type ChatStreamEvent, type RouterEvent } from "../../packages/providers/src/index.ts";
import { nearestLevel, reasoningDirective, type ReasoningLevel, type ReasoningDescriptor } from "../../packages/providers/src/reasoning.ts";
import { exporterMain } from "./lib.mjs";

type Step = { events?: ChatStreamEvent[]; error?: ProviderErrorKind; retryAfterMs?: number };
const finish: ChatStreamEvent = { type: "done", result: { text: "done", toolCalls: [], finishReason: "stop", rawFinishReason: "stop", meta: {}, usage: { inputTokens: 2 } } };
const input: ChatRequest = { model: "caller", messages: [{ role: "user", content: "hello" }] };
const cases: Array<{ name: string; script: Record<string, Step[]>; denied?: string[] }> = [
  { name: "retry-then-fallback", script: { a: [{ error: "rate_limit", retryAfterMs: 200 }, { error: "overloaded" }], b: [{ events: [finish] }] } },
  { name: "no-fallback-after-yield", script: { a: [{ events: [{ type: "text_delta", text: "partial" }], error: "network" }], b: [{ events: [finish] }] } },
  { name: "auth-stops", script: { a: [{ error: "auth" }], b: [{ events: [finish] }] } },
  { name: "denied-candidate-falls-back", denied: ["a"], script: { a: [{ events: [finish] }], b: [{ events: [finish] }] } },
];

async function route(c: typeof cases[number]) {
  const routed: unknown[] = [], diagnostics: RouterEvent[] = [], delays: number[] = [], calls: unknown[] = [], settled: unknown[] = [];
  const next = new Map<string, number>();
  let now = 0;
  const router = new ProviderRouter({
    profiles: { chosen: Object.entries(c.script).map(([provider, steps]) => ({
      provider, model: `model-${provider}`,
      adapter: { async *stream(request) {
        const at = next.get(provider) ?? 0;
        const step = steps[at];
        if (step === undefined) throw new Error("missing routing fixture step");
        next.set(provider, at + 1);
        calls.push({ provider, model: request.model, maxTokens: request.maxTokens });
        for (const event of step.events ?? []) yield event;
        if (step.error) throw new ProviderError(step.error, "fixture failure", { retryAfterMs: step.retryAfterMs });
      } },
    })) },
    clock: { now: () => now, sleep: async delay => { delays.push(delay); now += delay; } },
    random: () => 0.5,
    retry: { maxRetries: 1 },
    profileDefaults: { chosen: { maxTokens: 55 } },
    onEvent: event => diagnostics.push(event),
    budget: { authorize(info) {
      if (c.denied?.includes(info.provider)) return { ok: false, reason: "fixture limit" };
      return { ok: true, ticket: { settle(usage) { settled.push({ provider: info.provider, usage: usage ?? null }); } } };
    } },
  });
  let error: string | undefined;
  try {
    for await (const event of router.stream("chosen", input)) routed.push(event);
  } catch (caught) {
    if (!(caught instanceof ProviderError)) throw caught;
    error = caught.kind;
  }
  return { ...c, expected: { routed, diagnostics, delays, calls, settled, error } };
}

const reasoning = [
  { requested: "medium", descriptor: { kind: "budget", source: "table", levels: ["off", "low", "high"], vendorParam: "thinking.budget_tokens", budget: { min: 1024, max: 16384, default: 2048 } } },
  { requested: "high", descriptor: { kind: "effort", source: "table", levels: ["low", "high"], vendorParam: "output_config.effort", adaptiveThinking: true } },
  { requested: "off", descriptor: { kind: "toggle", source: "table", levels: ["off", "high"], vendorParam: "chat_template_kwargs.enable_thinking" } },
  { requested: "low", descriptor: { kind: "none", source: "unknown", levels: [] } },
] satisfies { requested: ReasoningLevel; descriptor: ReasoningDescriptor }[];

export async function buildProviderRouterFixtures() {
  return {
    "routing": { source: "packages/providers/src/router/router.ts", schema: "plur1bus.provider-router/1", input, cases: await Promise.all(cases.map(route)) },
    "reasoning": { source: "packages/providers/src/reasoning.ts", schema: "plur1bus.provider-reasoning/1", cases: reasoning.map(input => {
      const nearest = nearestLevel(input.requested, input.descriptor.levels);
      return { ...input, expected: { nearest, directive: nearest === null ? null : reasoningDirective(nearest.level, input.descriptor) ?? null } };
    }) },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await exporterMain({ area: "provider-router", build: buildProviderRouterFixtures }));
}
