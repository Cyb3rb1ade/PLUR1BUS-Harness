//! `.p1x` extension packages (spec 2026-09-27 §5, §8). This crate audits, verifies and packs packages; it never
//! extracts (X1-R3), and the supervisor never links it for package bytes (X1-R2).
pub mod compat;
pub mod manifest;
pub mod refusal;
pub mod zipaudit;
