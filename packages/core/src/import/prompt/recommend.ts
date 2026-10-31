import type { EntryTarget, ParsedEntry, RecommendContext } from "./types.ts";

/** Heuristic detection for imperative assistant directives or prompt injection patterns */
export function looksLikeInstruction(text: string): boolean {
  if (typeof text !== "string") return false;
  // Strip zero-width / control characters and markdown formatting syntax (*, _, #, >, `, ", ')
  const clean = text
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[*_#>`"'\-]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();

  // Imperative directive aimed at the assistant
  const assistantDirective =
    /^(please\s+)?(always\s+|never\s+|immer\s+|nie\s+)?(answer|reply|respond|say|speak|output|act\s+as|behave\s+as|antworte|reagiere|sprich|gib\s+aus|handle\s+als)\b/i;
  // Direct obligation commanding the model
  const imperativeMust =
    /^(you\s+must|du\s+musst|you\s+should\s+always|du\s+sollst\s+immer|do\s+not\s+(answer|reply|respond|say|speak|output)|antworte\s+nicht)\b/i;
  // Prompt injection and jailbreak phrasing
  const injection =
    /\b(ignore\s+(all\s+)?previous\s+instructions|system\s+prompt|disregard\s+(all\s+)?prior\s+instructions|vergiss\s+alle\s+vorherigen\s+anweisungen)\b/i;
  // Directive headers
  const instructionHeader =
    /^(instruction|rule|anweisung|regel)\s*:/i;
  // Format / style directives
  const formatDirective =
    /\b(response\s+style|output\s+format|antwortstil|ausgabeformat)\s*:/i;
  // From now on directives
  const fromNowOn =
    /^(from\s+now\s+on|ab\s+sofort)\s+(respond|reply|answer|output|antworte|sprich|act)\b/i;

  return (
    assistantDirective.test(clean) ||
    imperativeMust.test(clean) ||
    injection.test(clean) ||
    instructionHeader.test(clean) ||
    formatDirective.test(clean) ||
    fromNowOn.test(clean)
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

    // Instructions category is never imported directly
    if (entry.category === "Instructions") {
      return {
        target: "skip",
        reason: "instructions-not-imported",
      };
    }

    // Heuristic suspicion: recommend skipping by default, operator can override in preview
    if (looksLikeInstruction(entry.text)) {
      return {
        target: "skip",
        reason: "suspected-instruction",
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
