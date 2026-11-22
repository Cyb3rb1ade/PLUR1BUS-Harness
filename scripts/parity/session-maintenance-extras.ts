// Cases of `export-session-maintenance.ts` that need no file: the per-turn telemetry, the per-chat model and reasoning choice
// (with the part of `providers/src/reasoning.ts` it needs), the session role routing (real `createSessionRoleProvider` over a
// scripted `create`), and the maintenance configuration. Every answer is what the real module gave.
import { createTurnTelemetry, createTurnTelemetryAggregate, TRIAGE_SAMPLE_LIMIT, TURN_END_REASONS } from "../../packages/core/src/session/turn-telemetry.ts";
import { chatModelOptions, directiveFor, effectiveReasoning, isLocalEndpoint, isReasoningChoice, REASONING_CHOICES } from "../../packages/core/src/session/chat-models.ts";
import { budgetFor, nearestLevel, NO_REASONING, reasoningDirective, REASONING_LEVELS } from "../../packages/providers/src/reasoning.ts";
import { createSessionRoleProvider } from "../../packages/core/src/session/role-routing.ts";
import { sessionMaintenance } from "../../packages/core/src/session/maintenance.ts";
import { runWithAgentScope, scopeFor } from "../../packages/core/src/agents/scope.ts";
import { defaults } from "@plur1bus/config-schema";

type Op = Record<string, any>;
const attempt = (f: () => unknown) => { try { return { ok: f() ?? null }; } catch (e: any) { return { err: String(e?.message) }; } };

// ---- turn telemetry --------------------------------------------------------------------------------------------------

export function telemetryCases() {
  const t = (o: Op = {}) => ({ ...createTurnTelemetry(), ...o });
  const full = (o: Op = {}) => t({ rounds: 3, toolCalls: 4, metaCalls: { search: 1, skillLoad: 2, skillRead: 3 }, skills: { injected: 5, loaded: 6 },
    toolChoice: { status: "required", forced: true }, toolNeed: { detected: true, reasons: ["url", "path"] }, errorsReturned: 2, endReason: "tool-error", triageDurationMs: 12.5, ...o });
  const scenarios: { name: string; ops: Op[] }[] = [
    { name: "fresh", ops: [{ snapshot: true }, { fresh: true }] },
    { name: "one-turn", ops: [{ observe: full() }, { snapshot: true }] },
    { name: "every-end-reason", ops: [...TURN_END_REASONS.map((r) => ({ observe: t({ endReason: r }) })), { snapshot: true }] },
    { name: "unknown-end-reason", ops: [{ observe: t({ endReason: "weird" }) }, { observe: t({ endReason: "" }) }, { snapshot: true }] },
    { name: "bad-counts", ops: [{ observe: t({ rounds: -1, toolCalls: 0.5, errorsReturned: -0.5, metaCalls: { search: -3, skillLoad: 1.5, skillRead: 0 }, skills: { injected: -1, loaded: 2.25 } }) }, { snapshot: true }] },
    { name: "need-without-tool", ops: [{ observe: t({ toolNeed: { detected: true, reasons: ["time"] }, toolCalls: 0 }) }, { observe: t({ toolNeed: { detected: true, reasons: ["time"] }, toolCalls: 1 }) },
      { observe: t({ toolNeed: { detected: true, reasons: [] }, toolCalls: -1 }) }, { observe: t({ toolNeed: { detected: false, reasons: [] }, toolCalls: 0 }) }, { snapshot: true }] },
    { name: "tool-choice", ops: ["auto", "required", "named", "unsupported"].flatMap((status) => [{ observe: t({ toolChoice: { status, forced: status === "required" || status === "named" } }) }]).concat([{ snapshot: true } as any]) },
    { name: "triage-quantiles", ops: [...[5, 1, 3, 2, 4].map((ms) => ({ observe: t({ triageDurationMs: ms }) })), { snapshot: true }, { observe: t({ triageDurationMs: null }) }, { observe: t({ triageDurationMs: -1 }) },
      { observe: t({ triageDurationMs: 0 }) }, { snapshot: true }] },
    { name: "triage-one-sample", ops: [{ observe: t({ triageDurationMs: 7 }) }, { snapshot: true }] },
    { name: "triage-twenty", ops: [...Array.from({ length: 20 }, (_, i) => ({ observe: t({ triageDurationMs: i + 1 }) })), { snapshot: true }] },
    { name: "ring-wraps", ops: [{ series: { n: TRIAGE_SAMPLE_LIMIT, step: 1 } }, { snapshot: true }, { series: { n: 10, step: 1000 } }, { snapshot: true }, { series: { n: TRIAGE_SAMPLE_LIMIT, step: 2 } }, { snapshot: true }] },
    { name: "snapshot-is-a-copy", ops: [{ observe: full() }, { snapshot: true, mutate: true }, { snapshot: true }] },
  ];
  const out = scenarios.map((sc) => {
    const agg = createTurnTelemetryAggregate();
    let n = 0;
    const steps = sc.ops.map((op) => {
      if (op.fresh) return { op, result: createTurnTelemetry() };
      if (op.observe) { agg.observe(op.observe); return { op, result: null }; }
      if (op.series) { for (let i = 0; i < op.series.n; i++) agg.observe(createTurnTelemetry_with(++n * op.series.step)); return { op, result: null }; }
      const snap = agg.snapshot();
      const result = JSON.parse(JSON.stringify(snap));
      if (op.mutate) { snap.turns = 999; snap.endReasons.completed = 999; snap.metaCalls.search = 999; }
      return { op, result };
    });
    return { name: sc.name, steps };
  });
  return { limit: TRIAGE_SAMPLE_LIMIT, endReasons: [...TURN_END_REASONS], scenarios: out };
}
function createTurnTelemetry_with(ms: number) { return { ...createTurnTelemetry(), triageDurationMs: ms }; }

// ---- chat models and reasoning ---------------------------------------------------------------------------------------

const desc = (o: Op) => ({ levels: [], source: "api", ...o });
const EFFORT = desc({ kind: "effort", levels: ["minimal", "low", "medium", "high"], default: "medium", vendorParam: "reasoning_effort", source: "table" });
const BUDGET = desc({ kind: "budget", levels: ["off", "low", "medium", "high", "xhigh"], vendorParam: "thinking.budget_tokens", budget: { min: 1024, max: 32000, default: 4096 } });
const TOGGLE = desc({ kind: "toggle", levels: ["off", "high"], vendorParam: "chat_template_kwargs.enable_thinking", source: "table", note: "qwen" });
const ADAPTIVE = desc({ kind: "effort", levels: ["low", "medium", "high", "xhigh"], vendorParam: "output_config.effort", adaptiveThinking: true, values: { xhigh: "max" } });
const VALUES = desc({ kind: "effort", levels: ["off", "low", "high"], vendorParam: "reasoning.effort", values: { off: "none", low: false } });
const TOGGLE_VALUES = desc({ kind: "toggle", levels: ["off", "low", "high"], vendorParam: "chat_template_kwargs.enable_thinking", values: { low: "x", high: false } });
const NO_PARAM = desc({ kind: "effort", levels: ["low"] });
const BAD_BUDGET = desc({ kind: "budget", levels: ["low"], vendorParam: "thinking.budget_tokens" });
const NONE_WITH_PARAM = desc({ kind: "none", levels: ["low"], vendorParam: "reasoning_effort" });
const EMPTY_NOTE = desc({ kind: "effort", levels: ["low"], vendorParam: "reasoning_effort", note: "" });
export const DESCRIPTORS: Record<string, Op> = { EFFORT, BUDGET, TOGGLE, ADAPTIVE, VALUES, TOGGLE_VALUES, NO_PARAM, BAD_BUDGET, NONE_WITH_PARAM, EMPTY_NOTE, NO_REASONING: JSON.parse(JSON.stringify(NO_REASONING)) };

function subsets<T>(xs: T[]): T[][] { return xs.reduce<T[][]>((acc, x) => acc.concat(acc.map((s) => [...s, x])), [[]]); }

function sourcesOf(spec: Op) {
  const k = (p: string, m: string) => `${p}/${m}`;
  return {
    profiles: () => spec.profiles,
    defaultProfile: () => undefined,
    reasoning: (p: string, m: string) => spec.reasoning?.[k(p, m)] ?? NO_REASONING,
    catalog: (p: string, m: string) => spec.catalog?.[k(p, m)],
    endpoint: (p: string) => spec.endpoints?.[p],
    ...(spec.config !== undefined ? { config: () => spec.config } : {}),
  } as any;
}

export function chatModelCases() {
  const levelSets = [...subsets([...REASONING_LEVELS]), ["high", "low"], ["xhigh", "off"], ["medium", "medium", "low"], ["low", "high"], ["off", "xhigh", "medium"]];
  const nearest = REASONING_LEVELS.flatMap((requested) => levelSets.map((levels) => ({ requested, levels, result: nearestLevel(requested, levels as any) })));
  const budgets = [{ min: 1024, max: 32000, default: 4096 }, { min: 0, max: 0, default: 0 }, { min: 300, max: 100, default: 100 }, { min: 256, max: 256, default: 256 },
    { min: 1000, max: 1_000_000, default: 5000 }, { min: 128, max: 1000, default: 500 }, { min: 0, max: 8192, default: 2048 }];
  const budget = budgets.flatMap((b) => REASONING_LEVELS.map((level) => ({ budget: b, level, tokens: budgetFor(level, b) })));
  const directives = Object.entries(DESCRIPTORS).flatMap(([name, d]) => REASONING_LEVELS.map((level) => ({ descriptor: name, level, ...attempt(() => reasoningDirective(level, d as any)) })));
  const choices = [...REASONING_CHOICES, undefined];
  const effective = Object.entries(DESCRIPTORS).flatMap(([name, d]) => REASONING_CHOICES.map((choice) => ({ descriptor: name, choice, result: effectiveReasoning(choice, d as any) })));
  const directiveForCases = Object.entries(DESCRIPTORS).flatMap(([name, d]) => choices.map((choice) => ({ descriptor: name, ...(choice !== undefined ? { choice } : {}), ...attempt(() => directiveFor(choice as any, d as any)) })));
  const isChoice = ["default", "off", "xhigh", "", "Default", "high ", "medium", "ultra"].map((v) => ({ v, ok: isReasoningChoice(v) }));
  const P = (provider: string, model: string) => ({ provider, model });
  const specs: { name: string; spec: Op; agentId?: string }[] = [
    { name: "basic-sorted", spec: { profiles: { zeta: [P("openai", "gpt")], alpha: [P("anthropic", "opus"), P("openai", "gpt")], default: [P("openai", "gpt")] }, reasoning: { "openai/gpt": EFFORT, "anthropic/opus": BUDGET }, catalog: { "anthropic/opus": { displayName: "Opus", contextWindow: 200000 }, "openai/gpt": { contextWindow: 128000 } } } },
    { name: "name-order-utf16", spec: { profiles: { "\u{1F600}": [P("p", "m")], "￿": [P("p", "m")], "b": [P("p", "m")], "B": [P("p", "m")], "": [P("p", "m")], "é": [P("p", "m")] } } },
    { name: "empty-and-apple", spec: { profiles: { none: [], onlyApple: [P("apple-fm", "system")], badApple: [P("apple-fm", "other")], mixed: [P("apple-fm", "system"), P("apple-fm", "other")], ok: [P("p", "m")] } }, agentId: "a" },
    { name: "apple-window", spec: { profiles: { fm: [P("apple-fm", "system")], fm2: [P("apple-fm", "system"), P("p", "m")] }, catalog: { "p/m": { contextWindow: 100000 } } } },
    { name: "local-only-on", spec: { profiles: { cloud: [P("openai", "gpt")], local: [P("ollama", "llama")], both: [P("ollama", "llama"), P("openai", "gpt")], fm: [P("apple-fm", "system")] }, endpoints: { ollama: "http://localhost:11434", openai: "https://api.openai.com/v1" }, config: { privacy: { localOnly: true } } } },
    { name: "local-only-agent-lifts", spec: { profiles: { cloud: [P("openai", "gpt")], local: [P("ollama", "llama")] }, endpoints: { ollama: "http://127.0.0.1:1", openai: "https://x.test" }, config: { privacy: { localOnly: true }, agents: { bernd: { privacy: { localOnly: false } } } } }, agentId: "bernd" },
    { name: "local-only-agent-sets", spec: { profiles: { cloud: [P("openai", "gpt")], local: [P("ollama", "llama")] }, endpoints: { ollama: "http://[::1]:1", openai: "https://x.test" }, config: { privacy: { localOnly: false }, agents: { bernd: { privacy: { localOnly: true } } } } }, agentId: "bernd" },
    { name: "listed-endpoint", spec: { profiles: { lan: [P("vllm", "q")], other: [P("vllm2", "q")] }, endpoints: { vllm: "http://10.0.0.5:8000/v1", vllm2: "http://10.0.0.6:8000" }, config: { privacy: { localOnly: true, localEndpoints: ["http://10.0.0.5:8000", 7, "not a url"] } } } },
    { name: "no-endpoint", spec: { profiles: { p: [P("x", "y")] }, config: { privacy: { localOnly: true } } } },
    { name: "context-window-bounds", spec: { profiles: { a: [P("p", "a")], b: [P("p", "b")], c: [P("p", "c")], d: [P("p", "d")], e: [P("p", "e")], f: [P("p", "f")], g: [P("p", "g")], h: [P("p", "h")] },
      catalog: { "p/a": { contextWindow: 16384 }, "p/b": { contextWindow: 16383 }, "p/c": { contextWindow: 1.5 }, "p/d": { contextWindow: 0 }, "p/e": { contextWindow: -5 }, "p/f": { contextWindow: 9007199254740992 }, "p/g": { contextWindow: 9007199254740991 }, "p/h": { contextWindow: 20000 } } } },
    { name: "window-min-over-candidates", spec: { profiles: { fb: [P("p", "big"), P("p", "small"), P("p", "none")] }, catalog: { "p/big": { contextWindow: 500000 }, "p/small": { contextWindow: 20000 } } } },
    { name: "disabled-priority", spec: { profiles: { x: [P("openai", "tiny")] }, endpoints: { openai: "https://x.test" }, catalog: { "openai/tiny": { contextWindow: 1000, status: "unavailable" } }, config: { privacy: { localOnly: true } } } },
    { name: "small-beats-unavailable", spec: { profiles: { x: [P("p", "tiny")] }, catalog: { "p/tiny": { contextWindow: 1000, status: "unavailable" } } } },
    { name: "unavailable", spec: { profiles: { x: [P("p", "m")], y: [P("p", "n")] }, catalog: { "p/m": { status: "unavailable" }, "p/n": { status: "ok", displayName: "" } } } },
    { name: "display-name", spec: { profiles: { x: [P("p", "m")], y: [P("p", "n")], z: [P("p", "o")] }, catalog: { "p/m": { displayName: "Fancy" }, "p/n": { displayName: "" } } } },
    { name: "reasoning-kinds", spec: { profiles: { a: [P("p", "effort")], b: [P("p", "budget")], c: [P("p", "toggle")], d: [P("p", "none")], e: [P("p", "empty-note")], f: [P("p", "adaptive")] },
      reasoning: { "p/effort": EFFORT, "p/budget": BUDGET, "p/toggle": TOGGLE, "p/empty-note": EMPTY_NOTE, "p/adaptive": ADAPTIVE } } },
    { name: "no-profiles", spec: { profiles: {} } },
  ];
  const options = specs.map(({ name, spec, agentId }) => ({ name, spec, agentId: agentId ?? "bernd", options: chatModelOptions(sourcesOf(spec), agentId ?? "bernd") }));
  const endpoints = [["http://localhost:1", {}], ["https://example.com", {}], [undefined, {}], ["http://10.0.0.5:80/x", { privacy: { localEndpoints: ["http://10.0.0.5:80"] } }], ["http://10.0.0.5:81", { privacy: { localEndpoints: ["http://10.0.0.5:80"] } }],
    ["ftp://localhost", {}], ["http://user@localhost", {}], ["garbage", {}], ["http://[::1]:9", {}], ["http://127.9.9.9", {}], ["http://localhost.", {}]]
    .map(([raw, cfg]) => ({ raw: raw ?? null, cfg, local: isLocalEndpoint(raw as any, cfg) }));
  return { descriptors: DESCRIPTORS, nearest, budget, directives, effective, directiveFor: directiveForCases, isChoice, options, endpoints };
}

// ---- maintenance -----------------------------------------------------------------------------------------------------

export function maintenanceCases() {
  const base = defaults() as any;
  const variants: Op[] = [
    {},
    { session: { compaction: { softRatio: 0.5, hardRatio: 0.9, summaryMaxTokens: 100, maxMessageTokens: 200, summarizer: "digest", prune: { enabled: false, keepLastTurns: 7, decider: "heuristic", maxMs: 5, batchSize: 3 } } } },
    { session: { compaction: { summarizer: "llm", prune: { enabled: true, keepLastTurns: 1, decider: "off", maxMs: 250.5, batchSize: 1 } } } },
  ];
  return variants.map((v) => {
    const config = JSON.parse(JSON.stringify(base));
    if (v.session) Object.assign(config.session.compaction, v.session.compaction);
    const { compaction, prune } = sessionMaintenance("/home/x", config);
    return { override: v, compaction, prune, defaultsCompaction: base.session.compaction };
  });
}

// ---- role routing ----------------------------------------------------------------------------------------------------

export function keyOrderCases() {
  return [["b", "10", "a", "2"], ["x"], [], ["01", "1", "0", "-1", "1.5", "4294967294", "4294967295", "b"], ["z", "y", "2", "1"]].map((keys) => ({ keys, order: Object.keys(Object.fromEntries(keys.map((k) => [k, 1]))) }));
}

export async function roleRoutingCases() {
  const P = (provider: string, model: string) => ({ provider, model });
  type Spec = { name: string; options: Op; roles: Record<string, string>; summaryMaxTokens: number; ops: Op[] };
  const profiles = (spec: Record<string, Op[]>) => spec;
  const specs: Spec[] = [
    { name: "summarize-profile", options: { profiles: profiles({ default: [P("p", "main")], summarize: [P("p", "cheap"), P("q", "cheaper")] }) }, roles: {}, summaryMaxTokens: 400,
      ops: [{ op: "roleModels" }, { op: "modelProfiles" }, { op: "defaultModelProfile", agentId: "a" }, { op: "summarize", wireMax: null, requestMax: null }, { op: "summarize", wireMax: 1000, requestMax: 50 }, { op: "summarize", wireMax: 20, requestMax: 50 }, { op: "summarize", wireMax: 20, requestMax: 5000 }, { op: "summarize", wireMax: null, requestMax: 5000 },
        { op: "summarize", wireMax: 400, requestMax: 400 }, { op: "summarize", wireMax: 0, requestMax: 0 },
        { op: "summarize", wireMax: 10, requestMax: 10, messages: [{ role: "user", content: "ü\u{1F600}\"q\"\n" }], tools: [{ name: "t", description: "d" }] }, { op: "summarize", wireMax: 10, requestMax: 10, messages: [], tools: [] },
        { op: "summarize", wireMax: 10, requestMax: 10, usage: "none" }, { op: "summarize", wireMax: 10, requestMax: 10, usage: "partial" }, { op: "foreground", wireMax: 10, messages: [{ role: "user", content: "x".repeat(40) }], tools: [{ a: 1 }] }, { op: "summarize", wireMax: 1.5, requestMax: 1000 }, { op: "foreground", wireMax: 99999 }] },
    { name: "role-names-a-model", options: { profiles: profiles({ default: [P("p", "main")], big: [P("x", "a"), P("p", "m"), P("y", "b"), P("p", "m")] }) }, roles: { summarize: "p/m" }, summaryMaxTokens: 300, ops: [{ op: "roleModels" }, { op: "summarize", wireMax: 500, requestMax: 500 }] },
    { name: "role-names-a-profile", options: { profiles: profiles({ default: [P("p", "main")], fast: [P("a", "1"), P("b", "2")] }) }, roles: { summarize: "fast" }, summaryMaxTokens: 300, ops: [{ op: "roleModels" }, { op: "summarize", wireMax: 100, requestMax: 100 }] },
    { name: "role-unknown", options: { profiles: profiles({ default: [P("p", "main")] }) }, roles: { summarize: "nobody/here" }, summaryMaxTokens: 300, ops: [{ op: "roleModels" }, { op: "summarize", wireMax: 100, requestMax: 100 }] },
    { name: "no-role", options: { profiles: profiles({ default: [P("p", "main")] }) }, roles: {}, summaryMaxTokens: 300, ops: [{ op: "roleModels" }, { op: "summarize", wireMax: 100, requestMax: 100 }] },
    { name: "empty-role", options: { profiles: profiles({ default: [P("p", "main")] }) }, roles: { summarize: "" }, summaryMaxTokens: 300, ops: [{ op: "roleModels" }, { op: "summarize", wireMax: 100, requestMax: 100 }] },
    { name: "empty-summarize-profile", options: { profiles: profiles({ default: [P("p", "main")], summarize: [] }) }, roles: {}, summaryMaxTokens: 300, ops: [{ op: "roleModels" }, { op: "summarize", wireMax: 100, requestMax: 100 }, { op: "modelProfiles" }] },
    { name: "integer-like-profile-names", options: { profiles: profiles({ b: [P("p", "x")], "10": [P("p", "m")], "2": [P("p", "m")], a: [P("p", "m")] }) }, roles: { summarize: "p/m" }, summaryMaxTokens: 300, ops: [{ op: "roleModels" }, { op: "summarize", wireMax: 100, requestMax: 100 }, { op: "modelProfiles" }] },
    { name: "reuse-and-key-change", options: { profiles: profiles({ default: [P("p", "main")], summarize: [P("p", "cheap")] }) }, roles: {}, summaryMaxTokens: 300,
      ops: [{ op: "summarize", wireMax: 100, requestMax: 100 }, { op: "summarize", wireMax: 100, requestMax: 100 }, { op: "setProfile", name: "summarize", candidates: [P("p", "cheap")] }, { op: "summarize", wireMax: 100, requestMax: 100 }, { op: "setProfile", name: "summarize", candidates: [P("p", "other")] }, { op: "summarize", wireMax: 100, requestMax: 100 },
        { op: "summarize", wireMax: 100, requestMax: 100 }, { op: "setProfile", name: "summarize", candidates: [] }, { op: "summarize", wireMax: 100, requestMax: 100 }, { op: "setProfile", name: "summarize", candidates: [P("p", "cheap")] }, { op: "summarize", wireMax: 100, requestMax: 100 }] },
    { name: "model-profiles-filter", options: { profiles: profiles({ default: [P("p", "m")], empty: [], other: [P("q", "n")] }), profile: "other" }, roles: {}, summaryMaxTokens: 300, ops: [{ op: "modelProfiles" }, { op: "defaultModelProfile", agentId: "x" }] },
    { name: "default-profile-order", options: { profiles: profiles({ default: [P("p", "m")] }), profileForAgent: { bernd: "agentprof", empty: "" } }, roles: {}, summaryMaxTokens: 300,
      ops: [{ op: "defaultModelProfile", agentId: "bernd" }, { op: "defaultModelProfile", agentId: "empty" }, { op: "defaultModelProfile", agentId: "other" }] },
    { name: "default-profile-from-options", options: { profiles: profiles({ default: [P("p", "m")] }), profile: "chosen" }, roles: {}, summaryMaxTokens: 300, ops: [{ op: "defaultModelProfile", agentId: "other" }] },
    { name: "context-models", options: { profiles: profiles({ default: [P("p", "main"), P("p", "fb")], small: [P("s", "tiny")], large: [P("l", "huge"), P("p", "main")], frontier: [P("f", "top")], routed: [P("r", "x")] }),
      classProfiles: { small: "small", large: "large", frontier: "frontier" }, contextProfiles: { bernd: ["routed", "missing", "default"] } }, roles: {}, summaryMaxTokens: 300,
      ops: [{ op: "contextModels", text: "hi" }, { op: "contextModels", text: "hi", profile: "small" }, { op: "contextModels", text: "hi", profile: "nope" }, { op: "contextModels", text: "hi", profile: "" }, { op: "contextModels", text: "x", scope: "bernd" }, { op: "contextModels", text: "x", scope: "other" }] },
    { name: "context-models-class-errors", options: { profiles: profiles({ default: [P("p", "main")], small: [P("s", "tiny")], large: [P("l", "huge")] }), classProfiles: { small: "small", medium: "$throw", large: "large", frontier: "" } }, roles: {}, summaryMaxTokens: 300,
      ops: [{ op: "contextModels", text: "hi" }] },
    { name: "context-models-key-collision", options: { profiles: profiles({ default: [P("a/b", "c"), P("a", "b/c"), P("d", "e")] }) }, roles: {}, summaryMaxTokens: 300, ops: [{ op: "contextModels", text: "hi" }] },
    { name: "context-models-profile-option", options: { profiles: profiles({ main: [P("p", "main")], extra: [P("e", "x")] }), profile: "main", classProfiles: { small: "extra" } }, roles: {}, summaryMaxTokens: 300, ops: [{ op: "contextModels", text: "hi" }] },
    { name: "classifier-wiring", options: { profiles: profiles({ default: [P("p", "m")] }) }, roles: { decision: "p/m" }, summaryMaxTokens: 300, ops: [{ op: "createOptions" }] },
    { name: "classifier-wiring-require", options: { profiles: profiles({ default: [P("p", "m")] }), requireTriage: true }, roles: {}, summaryMaxTokens: 300, ops: [{ op: "createOptions" }] },
    { name: "classifier-wiring-none", options: { profiles: profiles({ default: [P("p", "m")] }) }, roles: {}, summaryMaxTokens: 300, ops: [{ op: "createOptions" }] },
    { name: "classifier-wiring-empty-decision", options: { profiles: profiles({ default: [P("p", "m")] }) }, roles: { decision: "" }, summaryMaxTokens: 300, ops: [{ op: "createOptions" }] },
  ];
  const out = [];
  for (const sc of specs) out.push(await runRouting(sc));
  return out;
}

async function runRouting(sc: { name: string; options: Op; roles: Record<string, string>; summaryMaxTokens: number; ops: Op[] }) {
  const profiles: Record<string, Op[]> = JSON.parse(JSON.stringify(sc.options.profiles));
  const created: Op[] = [];
  const mkOptions = () => ({
    profiles, system: undefined,
    ...(sc.options.profile !== undefined ? { profile: sc.options.profile } : {}),
    ...(sc.options.requireTriage ? { requireTriage: true } : {}),
    ...(sc.options.profileForAgent ? { profileForAgent: (a: string) => sc.options.profileForAgent[a] } : {}),
    ...(sc.options.classProfiles ? { profileForClass: (c: string) => { const v = sc.options.classProfiles[c]; if (v === "$throw") throw new Error("bad file"); return v; } } : {}),
    ...(sc.options.contextProfiles ? { modelRouting: { contextProfiles: (agentId: string) => sc.options.contextProfiles[agentId] ?? [] } } : {}),
  }) as any;
  // The scripted `create`: it records what it was asked, and its stream pushes one request through the candidates' adapters.
  const requestsSeen: Op[] = [];
  let id = 0;
  const create: any = (opts: any) => {
    const me = ++id;
    created.push({ id: me, profile: opts.profile ?? null, selected: opts.profile && opts.profiles[opts.profile] ? opts.profiles[opts.profile].map((c: any) => `${c.provider}/${c.model}`) : null, classify: typeof opts.classifyMessage === "function", maxTokens: opts.maxTokens ?? null, maxRounds: opts.maxRounds ?? null,
      profiles: Object.fromEntries(Object.keys(opts.profiles).map((n) => [n, (opts.profiles[n] ?? []).map((c: any) => `${c.provider}/${c.model}`)])), profileForClass: typeof opts.profileForClass === "function" ? opts.profileForClass("small") : null });
    return {
      id: `router-${me}`, telemetry: {},
      async *stream(req: any) {
        const first = (opts.profiles[opts.profile ?? "default"] ?? [])[0];
        if (first) for await (const ev of first.adapter.stream({ messages: req.__wireMessages ?? [{ role: "user", content: "hello" }], ...(req.__wireTools !== undefined ? { tools: req.__wireTools } : {}), maxTokens: req.__wireMax ?? undefined, __usage: req.__usage })) void ev;
        yield { type: "delta", text: "x" };
        yield { type: "usage", inputTokens: 1, outputTokens: 2 };
      },
    };
  };
  // Candidates need adapters for the router to wrap; the scripted adapter reports the cap it was given and a usage.
  const doneOf = (request: any) => ({ type: "done", result: { usage: request.__usage === "none" ? undefined : request.__usage === "partial" ? { inputTokens: 5 } : { inputTokens: 100, outputTokens: 7 } } });
  for (const list of Object.values(profiles)) for (const c of list as any[]) c.adapter = { async *stream(request: any) { requestsSeen.push({ maxTokens: request.maxTokens ?? null }); yield doneOf(request); } };
  const withRouting = (options: any) => {
    const p = createSessionRoleProvider(create, options, sc.roles as any, sc.summaryMaxTokens, { triage: async () => ({ ok: true, value: {} }) } as any);
    return p;
  };
  let provider = withRouting(mkOptions());
  const steps: Op[] = [];
  for (const op of sc.ops) {
    const mark = created.length, reqMark = requestsSeen.length;
    let result: Op;
    try {
      switch (op.op) {
        case "roleModels": result = { ok: (provider.roleModels as any)("summarize") }; break;
        case "modelProfiles": result = { ok: provider.modelProfiles!() }; break;
        case "defaultModelProfile": result = { ok: provider.defaultModelProfile!(op.agentId) }; break;
        case "contextModels": {
          const run = () => provider.contextModels!(op.text, op.profile);
          result = { ok: op.scope ? runWithAgentScope(scopeFor(op.scope, "/w"), run) : run() }; break;
        }
        case "setProfile": {
          profiles[op.name] = op.candidates.map((c: any) => ({ ...c, adapter: { async *stream(request: any) { requestsSeen.push({ maxTokens: request.maxTokens ?? null }); yield doneOf(request); } } }));
          result = { ok: null }; break;
        }
        case "createOptions": result = { ok: null }; break;
        default: {
          const chunks: unknown[] = [];
          const req: any = { role: op.op === "summarize" ? "summarize" : undefined, maxOutputTokens: op.requestMax ?? undefined, __wireMax: op.wireMax ?? undefined, __wireMessages: op.messages, __wireTools: op.tools, __usage: op.usage, sessionId: "s", agentId: "a", messages: [], summaries: [], memory: "", signal: new AbortController().signal };
          for await (const c of provider.stream(req)) chunks.push(c);
          result = { ok: chunks };
        }
      }
    } catch (e: any) { result = { err: String(e?.message) }; }
    steps.push({ op, ...result, requests: requestsSeen.slice(reqMark), created: created.slice(mark).map((c) => ({ ...c, id: undefined })) });
  }
  return { name: sc.name, spec: { profileOrder: Object.keys(sc.options.profiles), options: sc.options, roles: sc.roles, summaryMaxTokens: sc.summaryMaxTokens }, created: created.slice(0, 1).map((c) => ({ ...c, id: undefined })), steps };
}
