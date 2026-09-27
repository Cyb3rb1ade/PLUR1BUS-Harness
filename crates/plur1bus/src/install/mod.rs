//! Installer foundations (2a-H3b-b, HB6–HB10): release targets, pinned hashes, the one verified download client,
//! the one verified extractor (⟂EXT 1), and the install and release manifests. Reached only from `setup`, `update`
//! and `1staid repair`; never from `supervisor/` (spec §4 dependency budget, enforced by scripts/lint-hygiene.mjs).
// The consumers (setup, update --check, the installer checks and repair) land in 2a-H3b-b Tasks 4–8; until then only
// the unit tests reach most of this module.
#![allow(dead_code)]

pub mod archive;
pub mod fetch;
pub mod manifest;
pub mod pins;
pub mod targets;
