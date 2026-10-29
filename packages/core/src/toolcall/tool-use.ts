// Tool-need detection and per-attempt choice policy (N-E2–E5); all inputs are supplied by the trusted turn owner.
import type { ToolChoice } from "../../../providers/src/types.ts";
import type { TriageTask } from "../triage/index.ts";
import { lookupQuirks, type ProviderFamily } from "./quirks.ts";

/** Per-agent policy, with prefer as the default for omitted configuration. */
export type ToolUseMode = "auto" | "prefer" | "require-first";
/** Bounded telemetry labels; message contents never become a label. */
export type ToolNeedReason = "category" | "url" | "path" | "current-data" | "attachment" | "skill-tools";
/** Evidence of a tool need, optionally identifying one unambiguous currently offered tool. */
export interface ToolNeed {
  needed: boolean;
  reasons: readonly ToolNeedReason[];
  namedTool?: string;
}
/** Scoped task and capability metadata for detecting the current turn's tool need. */
export interface ToolNeedInput {
  message: string;
  tasks?: readonly Pick<TriageTask, "categories" | "confidence">[];
  categoriesWithTools?: readonly string[];
  attachments?: boolean;
  allowedTools?: readonly string[];
  offeredTools?: readonly string[];
  minConfidence?: number;
}

const TOOL_NEED_MIN_CONFIDENCE = 0.65;
const URL = /\bhttps?:\/\/\S+/i;
const PATHS = [
  /(?:^|[\s"'`(])(?:\.{1,2}[\\/]|~[\\/])[^\s]+/iu,
  /(?:^|[\s"'`(])(?:\\\\\?\\)?[a-z]:[\\/][^\s]+/iu,
  /(?:^|[\s"'`(])\\\\[^\s\\]+\\[^\s]+/iu,
  /(?:^|[\s"'`(])\/[\p{L}\p{N}_.@~-][^\s]*/iu,
];
const CURRENT_WORDS = [
  /\b(?:aktuell(?:e[nrsm]?)?|neueste[nrsm]?|heute|heutig(?:e[nrsm]?)?|jetzt|gestern|morgen)\b/iu,
  /\b(?:derzeit|derzeitig(?:e[nrsm]?)?|today|tonight|yesterday|tomorrow|latest|current|currently)\b/iu,
  /\b(?:recent|recently|newest|up[- ]to[- ]date|real[- ]time)\b/iu,
];

/** Detect a bounded set of reasons; no task text or personal data enters telemetry labels. */
export function detectToolNeed(input: ToolNeedInput): ToolNeed {
  const reasons: ToolNeedReason[] = [];
  const available = new Set(input.categoriesWithTools ?? []);
  const threshold = input.minConfidence ?? TOOL_NEED_MIN_CONFIDENCE;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw Error("invalid tool-need confidence");
  const matchedCategory = input.tasks?.some(task => Object.entries(task.categories).some(([category, probability]) =>
    available.has(category) && task.confidence * probability >= threshold));
  if (matchedCategory) reasons.push("category");
  if (URL.test(input.message)) reasons.push("url");
  if (PATHS.some(pattern => pattern.test(input.message))) reasons.push("path");
  if (CURRENT_WORDS.some(pattern => pattern.test(input.message))) reasons.push("current-data");
  if (input.attachments) reasons.push("attachment");
  const allowed = [...new Set(input.allowedTools ?? [])].filter(name => name.trim().length > 0);
  if (allowed.length) reasons.push("skill-tools");
  const matching = allowed.filter(name => input.offeredTools?.includes(name));
  const namedTool = matching.length === 1 ? matching[0] : undefined;
  return { needed: reasons.length > 0, reasons, ...(namedTool ? { namedTool } : {}) };
}

/** Candidate-specific information, including reasoning and local compatibility, resolved before the provider call. */
export interface ToolChoiceInput {
  mode?: ToolUseMode;
  need: ToolNeed;
  round: number;
  hasToolCall?: boolean;
  tools: readonly string[];
  family: ProviderFamily;
  local?: boolean;
  modelFamily?: string;
  thinking?: boolean;
  /** The caller alone may request the one retry after buffering an answer without a needed tool. */
  retry?: boolean;
}
/** Effective provider-neutral choice and evidence for forced/suppressed tool-use telemetry. */
export interface TurnToolChoice {
  choice: ToolChoice;
  forced: boolean;
  suppressed?: "anthropic-thinking" | "local-unverified" | "no-tools";
}

/** Evaluate per provider attempt, after reasoning selection; canonical names are aliased by the wire wrapper. */
export function toolChoiceForTurn(input: ToolChoiceInput): TurnToolChoice {
  const mode = input.mode ?? "prefer";
  const automatic: TurnToolChoice = { choice: "auto", forced: false };
  const eligibleRound = input.round === 0 || input.retry;
  if (mode === "auto" || input.hasToolCall || !eligibleRound || (mode === "prefer" && !input.need.needed)) {
    return automatic;
  }
  if (!input.tools.length) return { ...automatic, suppressed: "no-tools" };
  if (input.family === "anthropic" && input.thinking) return { ...automatic, suppressed: "anthropic-thinking" };
  // Local compatibility is an evidenced model-family quirk, never inferred from a server's OpenAI-shaped wire.
  const quirks = lookupQuirks(input.modelFamily ?? "local-small");
  if (input.local && (input.modelFamily === quirks.family || !quirks.supportsForcedToolChoice)) {
    return { ...automatic, suppressed: "local-unverified" };
  }
  const choice = input.need.namedTool && input.tools.includes(input.need.namedTool)
    ? { name: input.need.namedTool }
    : "required";
  return { choice, forced: true };
}
