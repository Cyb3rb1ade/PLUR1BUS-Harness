/** D69/D103 context enrichment and fair skill slots; catalogue policy stays with the caller. */
import type { SkillPick } from "./skills.ts";

/** User context and task summaries admitted by the turn's existing triage boundary. */
export interface SkillQueryContext {
  current: string;
  previousUser?: string;
  tasks?: readonly { summary: string }[];
}

/** Keep current intent first, then prior user context and each task summary, omitting duplicate text. */
export function enrichedSkillQuery(input: SkillQueryContext): string {
  const pieces = [input.current, input.previousUser ?? "", ...(input.tasks ?? []).map(task => task.summary)];
  return [...new Set(pieces.map(piece => piece.trim()).filter(Boolean))].join("\n");
}

const FOLLOWUPS = new Set([
  "yes", "no", "ok", "okay", "ja", "nein", "genau", "continue", "weiter",
  "yes continue", "yes please continue", "yes please", "please continue", "go ahead", "yes go ahead",
  "do it", "yes do it", "ja weiter", "ja bitte weiter", "ja bitte", "bitte weiter", "mach weiter",
  "mach das", "ok weiter", "okay weiter", "ok continue", "okay continue", "weiter so",
]);

/** Only closed continuation/approval phrases reuse prior picks; added task text starts a new selection (D69). */
export function isSkillFollowup(text: string): boolean {
  const normalized = text.toLocaleLowerCase("en").replace(/[.,!?;:…]+/gu, " ").trim().replace(/\s+/gu, " ");
  return FOLLOWUPS.has(normalized);
}

/** Pins first, then one distinct skill per task before extras, with at most three skills overall (D103). */
export function fairTaskSkills(
  taskPicks: readonly (readonly SkillPick[])[],
  pinned: readonly SkillPick[] = [],
): SkillPick[] {
  const selected = new Map<string, SkillPick>();
  const add = (skill: SkillPick) => {
    if (selected.size < 3 && !selected.has(skill.id)) selected.set(skill.id, skill);
  };
  for (const skill of [...pinned, ...taskPicks.flat().filter(skill => skill.source === "pinned")]) add(skill);
  const queues = taskPicks.map(skills => [...skills]);
  while (selected.size < 3 && queues.some(queue => queue.length)) {
    for (const queue of queues) {
      while (queue.length && selected.has(queue[0]!.id)) queue.shift();
      const next = queue.shift();
      if (next) add(next);
    }
  }
  return [...selected.values()];
}
