// Reasoning control per catalog model: what levels a model offers and which wire parameter carries them.
// Sources, in this order: (a) what the provider's own model list says (stored as `api.reasoning` by the discovery scan),
// (b) the curated, versioned table `catalog/reasoning-metadata.json`, (c) nothing known -> kind "none" with a hint.
// The descriptor is finally fitted to the wire the profile speaks (a parameter that wire cannot write is never offered).
import bundled from "../../catalog/reasoning-metadata.json" with { type: "json" };
import {
  NO_REASONING, REASONING_LEVELS, REASONING_VENDOR_PARAMS, isReasoningLevel,
  type ReasoningDescriptor, type ReasoningKind, type ReasoningLevel, type ReasoningVendorParam,
} from "../../../providers/src/reasoning.ts";
import { hasNestedQuantifier } from "./metadata.ts";
import type { ApiReasoning } from "./types.ts";
import type { ProviderFamily } from "../toolcall/quirks.ts";

export interface ReasoningRule {
  pattern: string; kind: ReasoningKind; levels?: ReasoningLevel[]; default?: ReasoningLevel; vendorParam?: ReasoningVendorParam;
  adaptiveThinking?: true;
  values?: Partial<Record<ReasoningLevel, string | boolean>>; budget?: { min: number; max: number; default: number };
}
export interface CompiledReasoningTable { revision: string; sections: Map<string, { rule: ReasoningRule; re: RegExp }[]> }

const KINDS: readonly ReasoningKind[] = ["none", "effort", "budget", "toggle"];
const MAX_PATTERN = 200;

/** Validates and compiles a table; throws one Error listing every violation (same RE2-safe pattern subset as the model table). */
export function loadReasoningTable(...args: [raw?: unknown]): CompiledReasoningTable {
  const raw = (args.length === 0 ? bundled : args[0]) as { schema?: unknown; revision?: unknown; vendors?: unknown } | null;
  if (typeof raw !== "object" || raw === null) throw new Error("reasoning table must be an object");
  const errors: string[] = [];
  if (raw.schema !== "plur1bus.reasoning-metadata/1") errors.push("schema must be plur1bus.reasoning-metadata/1");
  if (typeof raw.revision !== "string" || raw.revision === "") errors.push("revision must be a non-empty string");
  const sections = new Map<string, { rule: ReasoningRule; re: RegExp }[]>();
  const seen = new Set<string>();
  if (typeof raw.vendors !== "object" || raw.vendors === null || Array.isArray(raw.vendors)) errors.push("vendors must be an object");
  else for (const [section, rules] of Object.entries(raw.vendors as Record<string, unknown>)) {
    if (!Array.isArray(rules)) { errors.push(`${section}: must be an array of rules`); continue; }
    const out: { rule: ReasoningRule; re: RegExp }[] = [];
    rules.forEach((x: unknown, i: number) => {
      const w = `${section}[${i}]`, r = x as Partial<ReasoningRule> | null;
      if (typeof r !== "object" || r === null || typeof r.pattern !== "string") { errors.push(`${w}: pattern must be a string`); return; }
      const p = r.pattern; let ok = true;
      const fail = (m: string) => { errors.push(`${w}: ${m}`); ok = false; };
      if (p.length > MAX_PATTERN || !p.startsWith("^") || !p.endsWith("$") || /\\[1-9]|\\k<|\(\?<?[=!]/.test(p) || hasNestedQuantifier(p)) fail("pattern must be anchored, at most 200 characters and RE2-safe");
      if (seen.has(p)) fail("duplicate pattern"); seen.add(p);
      if (!KINDS.includes(r.kind as ReasoningKind)) fail("kind must be none, effort, budget or toggle");
      if (r.kind !== "none") {
        if (!Array.isArray(r.levels) || r.levels.length === 0 || !r.levels.every(isReasoningLevel)) fail("levels must be a non-empty list of off|minimal|low|medium|high|xhigh");
        else if (r.levels.some((l, k) => k > 0 && REASONING_LEVELS.indexOf(l) <= REASONING_LEVELS.indexOf(r.levels![k - 1]!))) fail("levels must be in scale order without repeats");
        if (!(REASONING_VENDOR_PARAMS as readonly unknown[]).includes(r.vendorParam)) fail("vendorParam is not a known reasoning parameter");
        if (r.default !== undefined && !(r.levels ?? []).includes(r.default)) fail("default must be one of the levels");
        if (r.kind === "budget" && !(r.budget && Number.isSafeInteger(r.budget.min) && Number.isSafeInteger(r.budget.max) && Number.isSafeInteger(r.budget.default) && r.budget.min > 0 && r.budget.min <= r.budget.default && r.budget.default <= r.budget.max)) fail("budget needs integer min <= default <= max, min > 0");
        if (r.values !== undefined && (typeof r.values !== "object" || Object.entries(r.values).some(([k, v]) => !(r.levels ?? []).includes(k as ReasoningLevel) || !(typeof v === "string" ? /^[a-z]{1,16}$/.test(v) : typeof v === "boolean")))) fail("values must map listed levels to short lowercase words or booleans");
      }
      if (r.adaptiveThinking !== undefined && (r.adaptiveThinking !== true || r.kind !== "effort" || r.vendorParam !== "output_config.effort")) fail("adaptiveThinking needs Anthropic effort");
      if (!ok) return;
      out.push({ rule: r as ReasoningRule, re: new RegExp(p) });
    });
    sections.set(section, out);
  }
  if (errors.length) throw new Error(`invalid reasoning table:\n- ${errors.join("\n- ")}`);
  return { revision: raw.revision as string, sections };
}

export function lookupReasoning(t: CompiledReasoningTable, vendor: string | undefined, id: string): ReasoningRule | null {
  for (const n of vendor && vendor !== "generic" ? [vendor, "generic"] : ["generic"]) for (const { rule, re } of t.sections.get(n) ?? []) if (re.test(id)) return rule;
  return null;
}

const fromRule = (r: ReasoningRule, source: "api" | "table"): ReasoningDescriptor => r.kind === "none"
  ? { kind: "none", levels: [], source }
  : { kind: r.kind, levels: [...(r.levels ?? [])], ...(r.default ? { default: r.default } : {}), ...(r.vendorParam ? { vendorParam: r.vendorParam } : {}), ...(r.values ? { values: { ...r.values } } : {}), ...(r.adaptiveThinking ? {adaptiveThinking:true as const}:{}), ...(r.budget ? { budget: { ...r.budget } } : {}), source };

/**
 * (a) API, (b) table, (c) unknown. The API decides whether a model reasons at all; where it says so without the details
 * (Gemini `thinking`, Ollama `thinking` capability), a matching table rule supplies them, else a conservative default.
 * OpenRouter's `supported_parameters` is complete on its own: its unified `reasoning.effort` object.
 */
export function resolveReasoning(o: { vendor?: string | undefined; id: string; api?: ApiReasoning | undefined }, t: CompiledReasoningTable): ReasoningDescriptor {
  const rule = lookupReasoning(t, o.vendor, o.id);
  const a = o.api;
  if (a) {
    if (!a.supported) return { kind: "none", levels: [], source: "api" };
    if (a.style === "openrouter") return { kind: "effort", levels: ["minimal", "low", "medium", "high"], vendorParam: "reasoning.effort", source: "api" };
    if (rule && rule.kind !== "none") return fromRule(rule, "api");
    if (a.style === "gemini") return { kind: "budget", levels: ["low", "medium", "high"], vendorParam: "thinkingConfig.thinkingBudget", budget: { min: 1024, max: 24576, default: 8192 }, source: "api" };
    if (a.style === "ollama") return { kind: "toggle", levels: ["off", "medium"], default: "medium", vendorParam: "reasoning_effort", values: { off: "none", medium: "medium" }, source: "api" };
  }
  if (rule) return fromRule(rule, "table");
  return { ...NO_REASONING, levels: [] };
}

const WIRE: Readonly<Record<ProviderFamily, readonly ReasoningVendorParam[]>> = {
  "openai-chat": ["reasoning_effort", "reasoning.effort", "chat_template_kwargs.enable_thinking"],
  "openai-responses": ["reasoning.effort"],
  anthropic: ["thinking.budget_tokens", "output_config.effort"],
  gemini: ["thinkingConfig.thinkingBudget", "thinkingConfig.thinkingLevel"],
};

/** The descriptor as the profile's wire can carry it: the Responses API spells OpenAI's effort `reasoning.effort`; a
 *  parameter the wire cannot write at all degrades to `none` with the hint `reasoning-wire-unsupported`. */
export function fitToWire(d: ReasoningDescriptor, family: ProviderFamily): ReasoningDescriptor {
  if (d.kind === "none" || d.vendorParam === undefined) return d;
  const param = family === "openai-responses" && d.vendorParam === "reasoning_effort" ? "reasoning.effort" : d.vendorParam;
  if (!WIRE[family].includes(param)) return { kind: "none", levels: [], source: d.source, note: "reasoning-wire-unsupported" };
  return param === d.vendorParam ? d : { ...d, vendorParam: param };
}
