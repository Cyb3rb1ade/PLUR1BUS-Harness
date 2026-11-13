//! One test executable for the `neo_*` integration tests of the engine.
//!
//! Every file under `tests/` used to be an executable of its own, each linking the whole store stack. The files
//! stay where they are and are mounted here as modules, so a test is now named `<file>::<test>`. A file mounted
//! with `#[path]` resolves its own `mod` and `#[path]` declarations relative to `tests/`, as before.
//!
//! Each file brings its own copy of the support modules it mounts, as it did as an executable of its own.
#![allow(clippy::duplicate_mod)]

#[path = "../neo_acl.rs"]
mod neo_acl;
#[path = "../neo_candidate_index.rs"]
mod neo_candidate_index;
#[path = "../neo_capture_hook.rs"]
mod neo_capture_hook;
#[path = "../neo_capture_journal.rs"]
mod neo_capture_journal;
#[path = "../neo_capture_journal_edges.rs"]
mod neo_capture_journal_edges;
#[path = "../neo_capture_journal_parity.rs"]
mod neo_capture_journal_parity;
#[path = "../neo_correction_effects.rs"]
mod neo_correction_effects;
#[path = "../neo_derived.rs"]
mod neo_derived;
#[path = "../neo_embedding_drain.rs"]
mod neo_embedding_drain;
#[path = "../neo_episode_state.rs"]
mod neo_episode_state;
#[path = "../neo_episode_store.rs"]
mod neo_episode_store;
#[path = "../neo_episode_store_edges.rs"]
mod neo_episode_store_edges;
#[path = "../neo_episode_turn_selection.rs"]
mod neo_episode_turn_selection;
#[path = "../neo_episodes.rs"]
mod neo_episodes;
#[path = "../neo_format.rs"]
mod neo_format;
#[path = "../neo_global.rs"]
mod neo_global;
#[path = "../neo_merged.rs"]
mod neo_merged;
#[path = "../neo_n1.rs"]
mod neo_n1;
#[path = "../neo_narrative.rs"]
mod neo_narrative;
#[path = "../neo_narrative_store.rs"]
mod neo_narrative_store;
#[path = "../neo_participant_names.rs"]
mod neo_participant_names;
#[path = "../neo_postprocessing.rs"]
mod neo_postprocessing;
#[path = "../neo_prelude.rs"]
mod neo_prelude;
#[path = "../neo_recovery_identity.rs"]
mod neo_recovery_identity;
#[path = "../neo_revisions.rs"]
mod neo_revisions;
#[path = "../neo_routing.rs"]
mod neo_routing;
#[path = "../neo_session_store.rs"]
mod neo_session_store;
#[path = "../neo_startup_recovery.rs"]
mod neo_startup_recovery;
#[path = "../neo_status.rs"]
mod neo_status;
#[path = "../neo_turn_batch.rs"]
mod neo_turn_batch;
#[path = "../neo_turns.rs"]
mod neo_turns;
#[path = "../neo_vectors.rs"]
mod neo_vectors;
#[path = "../neo_watermark.rs"]
mod neo_watermark;
