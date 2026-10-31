// The M2 prompt-zone builder (ADR-010 §1): provider-neutral segments with cache-breakpoint markers. The wire formats that
// turn them into requests live in packages/providers.
export { createPromptBuilder, joinRecall, type PromptBuilder, type PromptBuilderOptions } from "./builder.ts";
export { createPromptSession, type PromptSession, type PromptSessionOptions, type RecallInput } from "./session.ts";
export { CACHE_PROFILES, lookupCacheProfile, normalizeModelId, type CacheProfile, type CacheRoute, type CacheTtl } from "./model-table.ts";
export { chooseCacheTtl } from "./ttl.ts";
export { canonicalJson, normalizeText, sha256Hex } from "./canonical.ts";
export {
  DEFAULT_MEMORY_CAP_CHARS, DEFAULT_VOLATILE_CAP_CHARS, STABLE_ZONES,
  type ZoneMetadata, type Breakpoint, type ConversationItem, type PromptEvent, type RenderInput, type RenderedPrompt, type Segment, type StableZone,
  type ToolDef, type VolatileInput, type ZoneHashes, type ZoneName,
} from "./types.ts";

export { createCacheTelemetry, stickySessionId, type CacheTelemetry, type ProviderCacheUsage, type CacheUsageRecord, type CacheUsageSummary, CACHE_MISS_CAUSES, CACHE_SESSION_STATE_LIMIT, type CacheMissCause, type CacheOutcome, type NotCacheableReason, type CacheModelSummary } from "./telemetry.ts";
