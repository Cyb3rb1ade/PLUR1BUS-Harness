/** Feature flags this core version carries, over and above the schema-derived methods/notifications
 *  (ADR-016 §3): the MemoryOps methods ("memory.ops"), D31 proposals ("memory.proposals") and the harness-owned
 *  event notifications ("events.harness", ADR-016 §6). Kept sorted by buildCapabilities, so declaration order here
 *  does not matter. Frozen: the list is the core's hello, so no module may add to it at runtime. */
export const CORE_FEATURES: readonly string[] = Object.freeze(["events.harness", "memory.ops", "memory.proposals"]);
