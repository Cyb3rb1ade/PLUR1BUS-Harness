/** Feature flags this core version carries, over and above the schema-derived methods/notifications
 *  (ADR-016 §3): the MemoryOps methods ("memory.ops"), D31 proposals ("memory.proposals") and the harness-owned
 *  event notifications ("events.harness", ADR-016 §6). Kept sorted by buildCapabilities, so declaration order here
 *  does not matter. */
export const CORE_FEATURES: readonly string[] = ["events.harness", "memory.ops", "memory.proposals"];
