/** Source card parsing is shared with offline import; this module has no Engine or target-write authority. */
import { SourceReader } from "./source-reader.ts";
import { ImportError, type SourceType } from "./types.ts";

export function splitImportedCards(content: string): string[] {
  if (!content) return [];
  const normalized = content.replace(/\r\n/g, "\n");
  const chunks = normalized.split(/(?:^|\n)§(?:\n|$)/);
  const cards: string[] = [];
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (trimmed.length > 0) {
      cards.push(trimmed);
    }
  }
  return cards;
}


/** Candidate order and spelling are the existing importer rules, including the case-sensitive profile layout. */
export const CARD_FILES = {
  openclaw: [[["MEMORY.md", "memory.md"], "MEMORY.md"], [["USER.md", "user.md"], "USER.md"]],
  hermes: [[["memories/MEMORY.md"], "memories/MEMORY.md"], [["memories/USER.md"], "memories/USER.md"]],
} as const;

export async function previewSourceCards(reader: SourceReader, family: SourceType, workspace: string, sourceId: string) {
  let totalCards = 0;
  const errors: { sourceRef: string; reason: string }[] = [];
  for (const [names, file] of CARD_FILES[family]) {
    let found: string | undefined;
    for (const name of names) {
      const candidate = reader.paths.join(workspace, ...name.split("/"));
      if (await reader.exists(candidate)) { found = candidate; break; }
    }
    if (!found) continue;
    try { totalCards += splitImportedCards(await reader.text(found, 16 * 1024 * 1024)).length; }
    catch (error) {
      SourceReader.refuseFatal(error);
      errors.push({ sourceRef: `${sourceId}:${file}`, reason: error instanceof ImportError ? error.reason : "source-unreadable" });
    }
  }
  return { totalCards, errors };
}
