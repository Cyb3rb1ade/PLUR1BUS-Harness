/** Feature flags this core version carries, over and above the schema-derived methods/notifications
 *  (ADR-016 §3). Empty in 2a-H2 Task 3; Task 5 adds "memory.ops" and "memory.proposals", Task 7 adds
 *  "events.harness". Kept sorted by buildCapabilities, so declaration order here does not matter. */
export const CORE_FEATURES: readonly string[] = [];
