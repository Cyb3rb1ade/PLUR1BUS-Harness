import type { EntryTarget, ParsedEntry, RecommendContext } from "./types.ts";

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
        reason: "Mögliches Geheimnis erkannt; standardmäßig nicht importieren",
      };
    }

    switch (entry.category) {
      case "Instructions":
        return {
          target: "propose-rule",
          agentIds: [chosenAgent],
          reason: "Regeln werden als Vorschlag angelegt, wirken nie sofort",
        };

      case "Identity":
      case "Career":
      case "Preferences":
        if (context.hasUserBinding) {
          return { target: "user" };
        }
        return {
          target: "skip",
          reason: "Erfordert nachgewiesene Person / Nutzerbindung",
        };

      case "Projects":
        return {
          target: "agent",
          agentIds: [chosenAgent],
          reason: "Projekte werden dem Ziel-Agenten zugeordnet",
        };

      case "Other":
      default:
        return {
          target: "skip",
          reason: "Zu uneinheitlich für automatische Empfehlung",
        };
    }
  });
}
