import { isLocalEndpoint as sharedLocalEndpoint, localEndpoints, localOnlyFor } from "../privacy/local-only.ts";
// The per-chat model and reasoning choice: which configured model profiles a chat may pick, what reasoning levels the
// profile's primary model offers, and how a chosen level becomes the one parameter each attempt sends.
// Pure over its ports (no clock, no I/O), so the chat surface, the turn provider and tests share one answer.
import { budgetFor, nearestLevel, reasoningDirective, type ReasoningDescriptor, type ReasoningDirective, type ReasoningLevel } from "../../../providers/src/reasoning.ts";

/** What a chat stores: a level of the harness scale, or "default" (send nothing, the provider decides). */
export type ReasoningChoice = ReasoningLevel | "default";
export const REASONING_CHOICES: readonly ReasoningChoice[] = ["default", "off", "minimal", "low", "medium", "high", "xhigh"];
export const isReasoningChoice = (v: unknown): v is ReasoningChoice => typeof v === "string" && (REASONING_CHOICES as readonly string[]).includes(v);

export interface ChatModelCandidate { provider: string; model: string }
export interface ChatModelSources {
  /** Configured model profiles and their ordered candidates (the first is the primary, the rest fallbacks). */
  profiles(): Readonly<Record<string, readonly ChatModelCandidate[]>>;
  /** The profile a chat without its own choice routes to by default. */
  defaultProfile(): string | undefined;
  /** The reasoning descriptor of one candidate, already fitted to the wire its provider speaks. */
  reasoning(provider: string, model: string): ReasoningDescriptor;
  /** Catalog facts, when the model was discovered. */
  catalog?(provider: string, model: string): { displayName?: string; status?: string } | undefined;
  /** The provider's endpoint (base URL), for the local test. */
  endpoint?(provider: string): string | undefined;
  /** The current configuration, for "Nur lokal" (privacy.localOnly, agents.<id>.privacy.localOnly, privacy.localEndpoints). */
  config?(): unknown;
  /** USD per million output tokens, when the price table knows the model. Reasoning tokens bill as output. */
  outputPrice?(provider: string, model: string): number | undefined;
}

export interface WireReasoning { kind: ReasoningDescriptor["kind"]; levels: ReasoningLevel[]; default?: ReasoningLevel; source: ReasoningDescriptor["source"]; note?: string; budgetTokens?: Partial<Record<ReasoningLevel, number>> }
export interface ChatModelOption {
  name: string; displayName: string; provider: string; model: string; local: boolean; selectable: boolean;
  disabledReason?: "local-only" | "unavailable"; reasoning: WireReasoning; outputUsdPerMTok?: number;
}

// Endpoint classification and override inheritance have one owner (#570 / Phase C).
export function isLocalEndpoint(raw: string | undefined, cfg: unknown): boolean {
  return raw !== undefined && sharedLocalEndpoint(raw, localEndpoints(cfg));
}

const toWire = (d: ReasoningDescriptor): WireReasoning => ({
  kind: d.kind, levels: [...d.levels], ...(d.default ? { default: d.default } : {}), source: d.source, ...(d.note ? { note: d.note } : {}),
  ...(d.kind === "budget" && d.budget ? { budgetTokens: Object.fromEntries(d.levels.map((l) => [l, budgetFor(l, d.budget!)])) } : {}),
});

/** Every configured profile with candidates, sorted by name; locked ones stay listed (disabled, with the reason). */
export function chatModelOptions(s: ChatModelSources, agentId: string): ChatModelOption[] {
  const cfg = s.config?.(), localOnly = localOnlyFor(cfg, agentId);
  return Object.entries(s.profiles()).filter(([, c]) => c.length > 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, candidates]) => {
    const primary = candidates[0]!, facts = s.catalog?.(primary.provider, primary.model);
    const local = candidates.every((c) => isLocalEndpoint(s.endpoint?.(c.provider), cfg));
    const disabledReason = localOnly && !local ? "local-only" as const : facts?.status === "unavailable" ? "unavailable" as const : undefined;
    const price = s.outputPrice?.(primary.provider, primary.model);
    return {
      name, displayName: facts?.displayName ?? primary.model, provider: primary.provider, model: primary.model, local, selectable: disabledReason === undefined,
      ...(disabledReason ? { disabledReason } : {}), reasoning: toWire(s.reasoning(primary.provider, primary.model)), ...(price !== undefined && Number.isFinite(price) && price >= 0 ? { outputUsdPerMTok: price } : {}),
    };
  });
}

/** The level one attempt actually uses: the choice, or the nearest the model supports (adjusted, never silent). */
export function effectiveReasoning(choice: ReasoningChoice, d: Pick<ReasoningDescriptor, "levels">): { level: ReasoningLevel | null; adjusted: boolean } {
  if (choice === "default") return { level: null, adjusted: false };
  const n = nearestLevel(choice, d.levels);
  return n ? { level: n.level, adjusted: n.adjusted } : { level: null, adjusted: true };
}

/** The directive one attempt sends, or undefined (provider default, or a model without reasoning control). */
export function directiveFor(choice: ReasoningChoice | undefined, d: ReasoningDescriptor): ReasoningDirective | undefined {
  if (choice === undefined || choice === "default") return undefined;
  const e = effectiveReasoning(choice, d);
  return e.level === null ? undefined : reasoningDirective(e.level, d);
}
