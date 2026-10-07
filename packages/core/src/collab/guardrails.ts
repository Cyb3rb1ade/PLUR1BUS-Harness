import type { GuardrailReason } from "./errors.ts";
import type { CollabSettings } from "./types.ts";

export interface GuardrailInput {
  settings: CollabSettings;
  fromAgent: string;
  toAgent: string;
  /** Agents already on this nested path, starting with the root from-agent. */
  path: string[];
  fanout: number;
  pairCount: number;
  now: number;
  chainStartedAt: number;
  lastRepeatAt: number | null;
  sameProject: boolean;
  tokensUsed: number;
  nextTokens: number;
  costUsed: number;
  nextCost: number;
}

export function evaluateGuardrails(i: GuardrailInput): GuardrailReason | null {
  if (i.fromAgent === i.toAgent) return "self-call";
  if (i.path.includes(i.toAgent)) return "cycle";
  if (i.path.length > i.settings.maxDepth) return "depth";
  if (i.fanout >= i.settings.maxFanout) return "fanout";
  if (i.pairCount >= i.settings.maxPairPerTurn) return "pair-limit";
  if (i.now - i.chainStartedAt >= i.settings.timeoutMs) return "timeout";
  if (i.lastRepeatAt !== null && i.now - i.lastRepeatAt < i.settings.repeatWindowMs) return "repeat";
  if (!i.sameProject && !i.settings.allowCrossProject) return "project-boundary";
  if (i.settings.tokenBudget !== null && i.tokensUsed + i.nextTokens > i.settings.tokenBudget) return "token-budget";
  if (i.settings.costBudget !== null && i.costUsed + i.nextCost > i.settings.costBudget) return "cost-budget";
  return null;
}
