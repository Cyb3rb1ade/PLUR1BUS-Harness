/** Pure formatting of already-authorised live memory cards; access and proposal filtering belong to the caller. */
import { createRedactor } from "../../logs/redact.ts";
import { categoryForMemoryCard } from "./categories.ts";
import { MEMORY_CATEGORIES, MEMORY_EXPORT_MARKER } from "./model.ts";

/** A structural projection of MemoryCard, with optional metadata when the caller has it. */
export interface MemoryExportCard {
  text: string;
  createdAt?: number | null;
  category?: string | null;
  kind?: string | null;
}

function exportDate(timestamp: number | null | undefined): { value: number; label: string } {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return { value: Number.POSITIVE_INFINITY, label: "unknown" };
  }
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  if (!Number.isFinite(date.getTime()) || year < 0 || year > 9_999) {
    return { value: Number.POSITIVE_INFINITY, label: "unknown" };
  }
  return { value: timestamp, label: date.toISOString().slice(0, 10) };
}

function fenceFor(texts: readonly string[]): string {
  let length = 3;
  for (const text of texts) {
    for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  }
  return "`".repeat(length);
}

/**
 * Redacts every card before folding line breaks into a single entry line. The caller supplies only authorised,
 * live cards without open proposals. Unknown dates sort last; equal dates retain input order. No card is truncated.
 */
export function formatMemoryExport(cards: readonly MemoryExportCard[]): string {
  const redactor = createRedactor();
  const entries = cards.map((card, index) => ({
    category: categoryForMemoryCard(card),
    // Redact multiline headers before flattening; flattening first would change the redactor's header boundaries.
    text: redactor.text(card.text).replace(/[\s\u0000-\u001f\u007f-\u009f]+/gu, " ").trim(),
    date: exportDate(card.createdAt),
    index,
  }));
  const fence = fenceFor(entries.map(entry => entry.text));
  const lines = [fence, MEMORY_EXPORT_MARKER];
  for (const category of MEMORY_CATEGORIES) {
    lines.push(`## ${category[0]!.toUpperCase()}${category.slice(1)}`);
    const group = entries.filter(entry => entry.category === category);
    group.sort((left, right) => left.date.value - right.date.value || left.index - right.index);
    for (const entry of group) lines.push(`[${entry.date.label}] [memory] - ${entry.text}`);
  }
  lines.push(fence, "STATUS: COMPLETE");
  return lines.join("\n");
}
