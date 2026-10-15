// How a run's outcome is shown: a tone for the badge and a label in the UI language. Shared by the history tab and the history of a personal task.
import type { BadgeTone } from "../../components/card.ts";
import { t, type Key } from "../../i18n.ts";

export function outcomeTone(outcome: string): BadgeTone {
  switch (outcome) {
    case "completed":
      return "ok";
    case "skipped":
      return "neutral";
    case "incomplete":
    case "failed":
    case "abandoned":
      return "err";
    default:
      return "neutral";
  }
}

const OUTCOME_LABEL = {
  completed: "recurring.status.completed",
  skipped: "recurring.status.skipped",
  incomplete: "recurring.status.incomplete",
  failed: "recurring.status.failed",
  abandoned: "recurring.status.abandoned",
} as const satisfies Record<string, Key>;

/** The outcome in the UI language; an outcome this UI does not know (the schema keeps runs open) is shown as the server sent it. */
export function outcomeLabel(outcome: string): string {
  // An own-property check: `in` would also match inherited names such as "toString" and hand a function to t().
  return Object.prototype.hasOwnProperty.call(OUTCOME_LABEL, outcome) ? t(OUTCOME_LABEL[outcome as keyof typeof OUTCOME_LABEL]) : outcome;
}
