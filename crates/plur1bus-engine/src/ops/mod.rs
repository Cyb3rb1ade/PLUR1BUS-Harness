//! Foreground memory operations, sharing, import and administration.
mod archive;
pub mod context;
pub mod correction;
mod correction_dynamics;
pub mod import;
pub mod import_ledger;
pub mod import_lock;
pub mod import_primitives;
/// Finished-card encoding policy shared with the capture rules.
pub mod import_row;
mod journal;
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
/// Per-run write-ahead rollback markers, fenced by the shared import lease.
pub mod unimport_ledger;
pub mod write;

mod proposal_store;
/// Durable shared-copy proposals and resolution.
pub mod proposals;

/// Foreground system-only identity migration and reversal.
pub mod rebind;
/// Engine-wide identity claims and reversible ownership journals.
pub mod rebind_ledger;
/// Durable workspace enablement and maintenance guards.
pub mod workspace_policy;
/// Native caller-bound policy administration; contextless wire remains unavailable.
pub mod workspace_policy_ops;

/// Fenced caller-bound import rollback and preview.
pub mod unimport;
mod unimport_plan;
