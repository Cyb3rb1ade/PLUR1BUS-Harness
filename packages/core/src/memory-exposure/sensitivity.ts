// Shared external-memory sensitivity filtering keeps the original block objects and fails closed without a classifier.
import type { MemorySensitivityService } from "../memory-sensitivity/service.ts";

export type SensitivitySource = MemorySensitivityService | (() => MemorySensitivityService | null | undefined);

export function sensitivityService(source: SensitivitySource | undefined): MemorySensitivityService | null | undefined {
  return typeof source === "function" ? source() : source;
}

/** Aggregate blocks cannot be matched reliably to manual card-id labels under the current engine contract. */
export function sensitivityRefusal(
  filter: readonly string[],
  service: MemorySensitivityService | null | undefined,
): "sensitivity-unavailable" | "sensitivity-not-enforceable" | undefined {
  if (filter.length === 0) return undefined;
  if (!service) return "sensitivity-unavailable";
  return service.hasManualCategories(filter) ? "sensitivity-not-enforceable" : undefined;
}

/** A block can contain several cards; withhold it in full if any of its text belongs to an excluded category. */
export async function filterSensitiveBlocks<T extends { name: string; text: string }>(
  blocks: readonly T[],
  filter: readonly string[],
  service: MemorySensitivityService | null | undefined,
): Promise<T[]> {
  if (filter.length === 0) return [...blocks];
  if (!service || sensitivityRefusal(filter, service)) return [];
  const kept: T[] = [];
  for (const block of blocks) {
    const categories = await service.assessAggregate(block.text);
    if (!categories.some(category => filter.includes(category))) kept.push(block);
  }
  // A manual label can be set while an asynchronous classifier runs. Recheck before releasing any text.
  return sensitivityRefusal(filter, service) ? [] : kept;
}
