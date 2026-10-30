// N-C1: a stable, bounded catalogue exposes authored descriptions while skill instructions stay demand-loaded.

/** The author's discovery description is retained independently of the 25-word ranking summary. */
export interface CatalogueSkill {
  entry: { name: string; description: string };
  authoredDescription?: string;
}

export const MAX_SKILL_DESCRIPTION_CHARS = 1024;
export const AVAILABLE_SKILLS_TOKEN_BUDGET = 4000;
const CHARS_PER_TOKEN = 4;
const HEADER = "Available skills";

/** Remove line/control separators so each author description occupies exactly one catalogue line. */
export function skillDescription(description: string): string {
  return description.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ").trim()
    .slice(0, MAX_SKILL_DESCRIPTION_CHARS);
}

/** Uses the prompt builder's chars/4 estimate, including the header and any search overflow hint. */
export function renderAvailableSkills(
  skills: readonly CatalogueSkill[],
  tokenBudget = AVAILABLE_SKILLS_TOKEN_BUDGET,
): string {
  if (!skills.length) return "";
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 32) throw new Error("skill catalogue budget must be at least 32");
  const ordered = [...skills].sort((a, b) => a.entry.name < b.entry.name ? -1 : a.entry.name > b.entry.name ? 1 : 0);
  const lines = [HEADER];
  const maxChars = tokenBudget * CHARS_PER_TOKEN;
  let chars = HEADER.length;
  for (const [index, skill] of ordered.entries()) {
    const description = skillDescription(skill.authoredDescription ?? skill.entry.description);
    const line = `${skill.entry.name}: ${description}`;
    const remaining = ordered.length - index - 1;
    const footer = remaining ? `\n${remaining} more: use capabilities.search` : "";
    if (chars + 1 + line.length + footer.length > maxChars) {
      lines.push(`${ordered.length - index} more: use capabilities.search`);
      break;
    }
    lines.push(line);
    chars += 1 + line.length;
  }
  return lines.join("\n");
}
