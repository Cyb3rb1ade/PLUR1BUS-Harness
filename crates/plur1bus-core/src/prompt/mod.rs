//! The prompt-zone builder (ADR-010 §1; plan P4-42, P4-K K9a): provider-neutral segments with cache-breakpoint
//! markers, ported from `packages/core/src/prompt/`. A library: nothing in the running core calls it yet; the turn
//! loop of P4-43 will.
//!
//! A provider's prompt cache keys on the rendered bytes, so this port is held to TypeScript byte for byte: the vectors
//! of `scripts/parity/export-prompt.ts` record every rendered prompt as the digest of its JSON text, with the zone and
//! prefix hashes, the breakpoints, the TTL prediction and the events (`vectors.rs`).
//!
//! - [`canonical`]: `normalizeText`, `canonicalJson`, `sha256Hex`;
//! - [`model_table`]: the builder's view of the provider cache-profile table and the TTL choice;
//! - [`join`]: the harness join of recall blocks under a cap;
//! - [`builder`]: the four zones, the breakpoints, the prefix registry;
//! - [`session`]: a session with a frozen memory snapshot and folded recalls;
//! - [`skills`]: the catalogue of available skills and the stable tool-use instructions;
//! - [`telemetry`]: cache hit and miss records with the cause of a miss.
//!
//! No module here does I/O; the request clock is a port ([`crate::provider_auth::ports::Clock`]).
pub mod builder;
pub mod canonical;
pub mod join;
pub mod model_table;
pub mod session;
pub mod skills;
pub mod telemetry;
pub mod types;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod vectors;

pub use builder::{
    check_conversation_item, join_recall, sticky_session_id, PromptBuilder, PromptBuilderOptions,
    PromptError,
};
pub use canonical::{canonical_json, normalize_text, sha256_hex};
pub use model_table::{
    choose_cache_ttl, lookup_cache_profile, normalize_model_id, CacheProfile, CacheRoute,
};
pub use session::{PromptSession, PromptSessionOptions};
pub use skills::{
    render_available_skills, skill_description, CatalogueSkill, TOOL_USE_INSTRUCTIONS,
};
pub use telemetry::{CacheTelemetry, CacheUsageRecord, CacheUsageSummary, ProviderCacheUsage};
pub use types::*;
