import type { Api } from "../../api/index.ts";
import "./rpc-types.ts";
export interface ModelSwitchPreview {
  sessionId: string; profile: string; previousProfile: string | null; revision: number; applied: boolean;
  warning: "cache-rebuild-cost-prefixes-preserved";
}
/** Preview is immutable input to confirmation: never reread a changed text field when applying it. */
export async function previewModelSwitch(api: Api, sessionId: string, profile: string): Promise<ModelSwitchPreview> {
  return api.rpc("session.model.set", { sessionId, profile }, { write: true });
}
export async function confirmModelSwitch(api: Api, preview: ModelSwitchPreview): Promise<ModelSwitchPreview> {
  return api.rpc("session.model.set", { sessionId: preview.sessionId, profile: preview.profile, confirmed: true, expectedRevision: preview.revision }, { write: true });
}

/** The harness reasoning scale, cheapest first; "default" sends nothing and lets the provider decide. */
export const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningLevel = typeof REASONING_LEVELS[number];
export type ReasoningChoice = ReasoningLevel | "default";
export interface ChatModelOption {
  name: string; displayName: string; provider: string; model: string; local: boolean; selectable: boolean;
  disabledReason?: "local-only" | "unavailable";
  reasoning: { kind: "none" | "effort" | "budget" | "toggle"; levels: ReasoningLevel[]; default?: ReasoningLevel; source: "api" | "table" | "unknown"; note?: string; budgetTokens?: Partial<Record<ReasoningLevel, number>> };
  outputUsdPerMTok?: number;
}
export interface ChatModelState { sessionId: string; profile: string | null; defaultProfile: string | null; reasoning: ReasoningChoice; revision: number; profiles: ChatModelOption[] }
export interface ChatModelSet {
  sessionId: string; profile: string; previousProfile: string | null; reasoning: ReasoningChoice; effectiveReasoning: ReasoningChoice; adjusted: boolean; revision: number;
  warning?: "cache-rebuild-cost-prefixes-preserved"; costHint?: "reasoning-cost-higher";
}
export async function loadChatModel(api: Api, sessionId: string, signal?: AbortSignal): Promise<ChatModelState> {
  return api.rpc("chat.model.get", { sessionId }, signal ? { signal } : {});
}
/** Applies from the next turn; the revision is the one the shown state came with (a stale one is refused, never merged). */
export async function setChatModel(api: Api, state: Pick<ChatModelState, "sessionId" | "revision">, profile: string, reasoning: ReasoningChoice): Promise<ChatModelSet> {
  return api.rpc("chat.model.set", { sessionId: state.sessionId, profile, reasoning, expectedRevision: state.revision }, { write: true });
}
/** The profile the chat routes to now: its own choice, else the default profile. */
export const activeProfile = (s: ChatModelState): string | null => s.profile ?? s.defaultProfile;
/** The level a profile's primary model will use for a choice: the choice, or the nearest supported one (ties: cheaper). */
export function effectiveLevel(choice: ReasoningChoice, levels: readonly ReasoningLevel[]): ReasoningChoice {
  if (choice === "default") return "default";
  if (levels.length === 0) return "default";
  if (levels.includes(choice)) return choice;
  const at = REASONING_LEVELS.indexOf(choice);
  return levels.reduce((best, l) => {
    const d = Math.abs(REASONING_LEVELS.indexOf(l) - at), bd = Math.abs(REASONING_LEVELS.indexOf(best) - at);
    return d < bd || (d === bd && REASONING_LEVELS.indexOf(l) < REASONING_LEVELS.indexOf(best)) ? l : best;
  }, levels[0]!);
}
