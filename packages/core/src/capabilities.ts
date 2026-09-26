/** Feature flags this core version carries, over and above the schema-derived methods/notifications
 *  (ADR-016 §3). Task 5 serves the MemoryOps methods ("memory.ops") and D31 proposals ("memory.proposals");
 *  Task 7 adds "events.harness". Kept sorted by buildCapabilities, so declaration order here does not matter. */
export const CORE_FEATURES: readonly string[] = ["memory.ops", "memory.proposals"];
