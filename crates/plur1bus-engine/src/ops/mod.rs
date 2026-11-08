//! Foreground memory operations, sharing, import and administration.
mod archive;
pub mod context;
pub mod correction;
mod correction_dynamics;
pub mod import_lock;
mod json_fields;
mod ledgers;
/// Import source links without card mutation.
pub mod link;
pub mod memory;
mod memory_state;
mod shared_mutation;
/// Explicit sharing with identity-routed embeddings and source revalidation.
pub mod sharing;
pub mod tombstones;
pub mod write;

mod proposal_store;
/// Durable shared-copy proposals and resolution.
pub mod proposals;
