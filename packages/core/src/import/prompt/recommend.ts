import type { EntryTarget, ParsedEntry, RecommendContext } from "./types.ts";

/** Heuristic detection for instruction / rule patterns even if categorized elsewhere */
export function looksLikeInstruction(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return (
    lower.startsWith("always ") ||
    lower.startsWith("never ") ||
    lower.startsWith("do not ") ||
    lower.startsWith("don't ") ||
    lower.startsWith("immer ") ||
    lower.startsWith("nie ") ||
    lower.startsWith("antworte immer ") ||
    lower.startsWith("du musst ") ||
    lower.startsWith("you must ") ||
    lower.startsWith("instruction:") ||
    lower.startsWith("rule:") ||
    lower.includes("response style:") ||
    lower.includes("output format:")
  );
}

export function recommendTargets(
  entries: ParsedEntry[],
  context: RecommendContext,
): EntryTarget[] {
  const chosenAgent =
    context.currentAgentId ?? context.availableAgents[0] ?? "default";

  return entries.map((entry): EntryTarget => {
    // If the entry contained redacted secrets, skip by default
    if (entry.warnings.includes("secret-redacted")) {
      return {
        target: "skip",
        reason: "secret-redacted",
      };
    }

    // Instructions and instruction-like rules are never imported directly (prompt injection mitigation, B7)
    if (entry.category === "Instructions" || looksLikeInstruction(entry.text)) {
      return {
        target: "skip",
        reason: "instructions-not-imported",
      };
    }

    switch (entry.category) {
      case "Identity":
      case "Career":
      case "Preferences":
        if (context.hasUserBinding) {
          return { target: "user" };
        }
        return {
          target: "skip",
          reason: "requires-user-binding",
        };

      case "Projects":
        return {
          target: "agent",
          agentIds: [chosenAgent],
          reason: "projects-default-agent",
        };

      case "Other":
      default:
        return {
          target: "skip",
          reason: "unclassified",
        };
    }
  });
}
