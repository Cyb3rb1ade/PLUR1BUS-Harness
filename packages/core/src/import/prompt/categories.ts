/** Mapping at the prompt-format boundary; the Engine's open-ended kind field is not an enum. */
import { MEMORY_CATEGORIES, type MemoryCategory } from "./model.ts";

function portableCategory(label: string | null | undefined): MemoryCategory | undefined {
  const normalized = label?.trim().toLowerCase();
  return MEMORY_CATEGORIES.find(category => category === normalized);
}

/** Metadata labels may identify a portable category; unrecognised labels fall back to Other. */
export function categoryForMemoryCard(card: { category?: string | null; kind?: string | null }): MemoryCategory {
  return portableCategory(card.category) ?? portableCategory(card.kind) ?? "other";
}

/** The current Engine contract specifies no supported kind vocabulary, so import leaves kind omitted. */
export function kindForMemoryCategory(_category: MemoryCategory): string | undefined {
  return undefined;
}
