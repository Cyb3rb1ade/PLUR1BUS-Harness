//! Pure model discovery rules. No scheduler, file store or RPC dependencies.
#![forbid(unsafe_code)]

pub mod catalog;
pub mod http;
pub mod managed;
pub mod overrides;
pub mod reconcile;
pub mod roles;
pub mod scanners;
pub mod trust;
