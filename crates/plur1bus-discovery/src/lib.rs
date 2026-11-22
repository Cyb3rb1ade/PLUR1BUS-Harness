//! Pure model discovery rules. No scheduler, file store or RPC dependencies.
#![forbid(unsafe_code)]

pub mod http;
pub mod overrides;
pub mod reconcile;
pub mod roles;
pub mod scanners;
pub mod trust;
