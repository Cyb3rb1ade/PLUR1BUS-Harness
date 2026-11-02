/** D120 H4: pure transcript overlays; persistent messages, events and summaries remain unchanged. */
import { createHash } from "node:crypto";

/** The visibility fields of a stored rewind. An undone rewind has no effect on the active path. */
export interface RewindRange {
  hiddenFromSeq: number;
  hiddenToSeq: number;
  undoneAt: number | null;
  lessonMessageId?: string | null;
}

/** Return active messages in their original order, retaining each original object and its bytes. */
export function activePath<T extends { seq: number; id?: string }>(messages: readonly T[], rewinds: readonly RewindRange[]): T[] {
  const ranges = rewinds.filter(rewind => rewind.undoneAt === null);
  // Undo removes the overlay's note from the view as well; the note remains in the append-only transcript.
  const obsoleteLessons = new Set(rewinds.filter(rewind => rewind.undoneAt !== null)
    .flatMap(rewind => typeof rewind.lessonMessageId === "string" ? [rewind.lessonMessageId] : []));
  return messages.filter(message => !(message.id !== undefined && obsoleteLessons.has(message.id)) && !ranges.some(range =>
    message.seq >= range.hiddenFromSeq && message.seq <= range.hiddenToSeq));
}

/** Exclude summaries whose original inclusive range overlaps an active rewind. */
export function activeSummaries<T extends { fromSeq: number; toSeq: number }>(
  summaries: readonly T[], rewinds: readonly RewindRange[],
): T[] {
  const ranges = rewinds.filter(rewind => rewind.undoneAt === null);
  return summaries.filter(summary => !ranges.some(range =>
    summary.fromSeq <= range.hiddenToSeq && summary.toSeq >= range.hiddenFromSeq));
}

/** SHA-256 of ordered JSON [id,text] tuples, preserving exact UTF-8 transcript text (D120 §10.4). */
export function hiddenDigest(messages: readonly { id: string; text: string }[]): string {
  const hash = createHash("sha256").update("[");
  for (const [index, message] of messages.entries()) {
    if (index > 0) hash.update(",");
    hash.update(JSON.stringify([message.id, message.text]), "utf8");
  }
  return hash.update("]").digest("hex");
}
