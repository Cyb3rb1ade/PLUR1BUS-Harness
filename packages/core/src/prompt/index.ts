// The M2 prompt-zone builder (ADR-010 §1): provider-neutral segments with cache-breakpoint markers. The wire formats that
// turn them into requests live in packages/providers.
export { createPromptBuilder, joinRecall, type PromptBuilder, type PromptBuilderOptions } from "./builder.ts";
export { createPromptSession, type PromptSession, type PromptSessionOptions, type RecallInput } from "./session.ts";
export { PROVIDER_CACHE_CONFIG, CACHE_PROFILES, lookupCacheProfile, normalizeModelId, type CacheProfile, type CacheTtl } from "./model-table.ts";
export { chooseCacheTtl } from "./ttl.ts";
export { canonicalJson, normalizeText, sha256Hex } from "./canonical.ts";
export {
  DEFAULT_MEMORY_CAP_CHARS, DEFAULT_VOLATILE_CAP_CHARS, STABLE_ZONES,
  type ZoneMetadata, type Breakpoint, type ConversationItem, type PromptEvent, type RenderInput, type RenderedPrompt, type Segment, type StableZone,
  type ToolDef, type VolatileInput, type ZoneHashes, type ZoneName,
} from "./types.ts";

export { createCacheTelemetry, stickySessionId, type CacheTelemetry, type ProviderCacheUsage, type CacheUsageRecord, type CacheUsageSummary } from "./telemetry.ts";
