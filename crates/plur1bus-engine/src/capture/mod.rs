//! Shared deterministic row classification for finished-card import and turn capture.
//! Capture admission, replay and worker composition are integrated separately under RX6.
pub mod categorize;
pub mod dynamics;
pub mod fact_quality;
pub mod row_defaults;
