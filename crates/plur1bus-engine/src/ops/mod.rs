//! Foreground memory operations, sharing, import and administration.
mod archive;
pub mod context;
pub mod correction;
mod correction_dynamics;
/// Human foreground curation using the actual C4 reader and audit-first writer.
pub mod curation;
/// Common native composition of the unchanged memory contract.
pub mod facade;
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
mod memory_stats;
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

/// Read-only status assembly with bounded host backlog and real native sources.
pub mod status;
/// Fenced caller-bound import rollback and preview.
pub mod unimport;
mod unimport_plan;

/// Copied-store schema and embedding identity inspection.
pub mod adopt;

/// Explicit audited schema-marker migration through a Core-link maintenance grant.
pub mod migrate;

/// Shared C7 validation, TTL and query-forget decisions for native adapters.
pub mod memory_guards;

/// S5 committed-tombstone reapplication against an explicitly selected generation.
pub mod tombstone_reapply;

/// Portable engine snapshot integrity checks and manifest format.
pub mod snapshot;

/// F8 native configured-model inventory, separate from readiness and warm-up.
pub mod models;

/// Copy-on-write reembedding migration and confirmation binding.
pub mod reembedding;

/// Caller-bound non-destructive reconsolidation with persisted successors.
pub mod safe_update;
mod safe_update_row;

/// Bounded caller-authorized version-chain reads.
pub mod history;

mod conflict_file;
mod conflict_summary;
/// Durable original-caller conflict observations over actual memory rows.
pub mod conflicts;

/// Durable, original-caller application of private interference plans.
pub mod interference;
pub(crate) mod interference_state;

pub(crate) mod conflict_application_state;

mod curation_occurrence;
/// Archived native normal-store merge commits and original-caller recovery.
pub mod durable_merge;
pub(crate) mod durable_merge_state;
pub(crate) mod normal_duplicate_state;
pub(crate) mod normal_insert_state;

/// Deterministic A1 knowledge publication proposals; no filesystem authority.
pub mod promotion_plan;

/// Caller-bound atomic canonical knowledge publication.
pub mod knowledge_promotion;
