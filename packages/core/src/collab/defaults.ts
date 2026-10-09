import type { CollabSettings } from "./types.ts";

/** ADR-003 §Collaboration guardrail table, ADR-010 §4 subagent return cap. */
export const DEFAULT_COLLAB_SETTINGS: CollabSettings = {
  maxDepth: 1,
  maxFanout: 3,
  maxPairPerTurn: 2,
  maxTurns: 25,
  timeoutMs: 5 * 60 * 1000,
  returnTokens: 2000,
  allowCrossProject: false,
  repeatWindowMs: 30_000,
  tokenBudget: null,
  costBudget: null,
};

export const SPAN_PREVIEW_CHARS = 256;
