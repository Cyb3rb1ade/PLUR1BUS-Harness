// Reasoning / thinking intensity, normalised across providers.
//
// The UI and the session speak one scale (`ReasoningLevel`). A model's catalog entry carries a `ReasoningDescriptor`:
// what the model supports and which wire parameter carries it. `reasoningDirective()` turns a level into the one
// vendor parameter an adapter writes; adapters never guess, and a directive an adapter cannot express is refused
// before any I/O (fail closed, never a silent drop).

/** The harness scale, cheapest first. A model supports a subset; the UI only offers that subset. */
export const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningLevel = typeof REASONING_LEVELS[number];

/**
 * The wire parameter that carries the setting, spelled as on the wire:
 * - `reasoning_effort`: top-level string on OpenAI-compatible `/chat/completions` (OpenAI, xAI, Ollama, LM Studio, vLLM).
 * - `reasoning.effort`: OpenRouter's `reasoning` object on `/chat/completions`, and the Responses API's `reasoning`.
 * - `chat_template_kwargs.enable_thinking`: on/off toggle of Qwen3 / DeepSeek hybrid models behind vLLM or SGLang.
 * - `thinking.budget_tokens`: Anthropic extended thinking (0 = thinking off).
 * - `output_config.effort`: stable top-level Anthropic effort on curated supported models.
 * - `thinkingConfig.thinkingBudget`: Gemini 2.5 thinking budget in tokens (0 = off where the model allows it).
 * - `thinkingConfig.thinkingLevel`: Gemini 3 thinking level.
 */
export const REASONING_VENDOR_PARAMS = [
  "reasoning_effort", "reasoning.effort", "chat_template_kwargs.enable_thinking", "thinking.budget_tokens",
  "thinkingConfig.thinkingBudget", "thinkingConfig.thinkingLevel", "output_config.effort",
] as const;
export type ReasoningVendorParam = typeof REASONING_VENDOR_PARAMS[number];

export type ReasoningKind = "none" | "effort" | "budget" | "toggle";

export interface ReasoningBudget { min: number; max: number; default: number }

export interface ReasoningDescriptor {
  kind: ReasoningKind;
  /** The supported levels in scale order; empty for `none`. */
  levels: ReasoningLevel[];
  /** The level the provider uses when nothing is sent. */
  default?: ReasoningLevel;
  vendorParam?: ReasoningVendorParam;
  /** `effort` / `toggle`: the wire value per level (e.g. `off` -> "none" or false). Absent level = the level's own name. */
  values?: Partial<Record<ReasoningLevel, string | boolean>>;
  /** `budget`: token bounds; levels map onto them (see `budgetFor`). */
  budget?: ReasoningBudget;
  /** Where the description came from: the provider's own model list, the curated table, or nothing known. */
  source: "api" | "table" | "unknown";
  /** A stable hint code for the UI, e.g. `reasoning-unknown`. */
  note?: string;
}

/** What one request asks the adapter to write. */
export interface ReasoningDirective { vendorParam: ReasoningVendorParam; value: string | number | boolean }

export const NO_REASONING: ReasoningDescriptor = Object.freeze({ kind: "none", levels: [], source: "unknown", note: "reasoning-unknown" }) as ReasoningDescriptor;

export function isReasoningLevel(v: unknown): v is ReasoningLevel {
  return typeof v === "string" && (REASONING_LEVELS as readonly string[]).includes(v);
}

/**
 * The supported level nearest to `requested` on the scale; on a tie the cheaper one. `adjusted` is true whenever the
 * result differs from the request, so the caller can show it (never a silent substitution). `null` when the model
 * supports no level at all.
 */
export function nearestLevel(requested: ReasoningLevel, levels: readonly ReasoningLevel[]): { level: ReasoningLevel; adjusted: boolean } | null {
  if (levels.length === 0) return null;
  if (levels.includes(requested)) return { level: requested, adjusted: false };
  const at = REASONING_LEVELS.indexOf(requested);
  let best = levels[0]!;
  for (const l of levels) {
    const d = Math.abs(REASONING_LEVELS.indexOf(l) - at), bd = Math.abs(REASONING_LEVELS.indexOf(best) - at);
    if (d < bd || (d === bd && REASONING_LEVELS.indexOf(l) < REASONING_LEVELS.indexOf(best))) best = l;
  }
  return { level: best, adjusted: true };
}

/** Tokens for a budget level: off 0, minimal = min, low 1/8, medium 1/4, high 1/2, xhigh = max of the range (never below min). */
export function budgetFor(level: ReasoningLevel, b: ReasoningBudget): number {
  if (level === "off") return 0;
  const share: Record<Exclude<ReasoningLevel, "off">, number> = { minimal: 0, low: 0.125, medium: 0.25, high: 0.5, xhigh: 1 };
  if (level === "minimal") return b.min;
  return Math.max(b.min, Math.min(b.max, Math.floor((b.max * share[level]) / 256) * 256));
}

/**
 * The directive for `level` on a model described by `d`; `undefined` for a model without reasoning control. The level
 * must already be one the model supports (use `nearestLevel` first): anything else throws, so a caller bug is loud.
 */
export function reasoningDirective(level: ReasoningLevel, d: ReasoningDescriptor): ReasoningDirective | undefined {
  if (d.kind === "none" || d.vendorParam === undefined) return undefined;
  if (!d.levels.includes(level)) throw new Error(`reasoning level ${level} is not supported by this model`);
  if (d.kind === "budget") {
    if (!d.budget) throw new Error("budget reasoning needs bounds");
    return { vendorParam: d.vendorParam, value: budgetFor(level, d.budget) };
  }
  if (d.kind === "toggle") return { vendorParam: d.vendorParam, value: (d.values?.[level] as boolean | undefined) ?? level !== "off" };
  return { vendorParam: d.vendorParam, value: d.values?.[level] ?? level };
}

/** Adapter guard: the directive's parameter must be one this wire can write, with a value of the right type. */
export function checkReasoningDirective(r: ReasoningDirective, allowed: readonly ReasoningVendorParam[], wire: string): string | null {
  if (!allowed.includes(r.vendorParam)) return `reasoning parameter ${r.vendorParam} is not supported by the ${wire} wire`;
  const numeric = r.vendorParam === "thinking.budget_tokens" || r.vendorParam === "thinkingConfig.thinkingBudget";
  const boolean = r.vendorParam === "chat_template_kwargs.enable_thinking";
  if (numeric && !(Number.isSafeInteger(r.value) && (r.value as number) >= 0)) return `${r.vendorParam} must be a non-negative integer`;
  if (boolean && typeof r.value !== "boolean") return `${r.vendorParam} must be a boolean`;
  if (!numeric && !boolean && !(typeof r.value === "string" && /^[a-z]{1,16}$/.test(r.value))) return `${r.vendorParam} must be a short lowercase word`;
  return null;
}
