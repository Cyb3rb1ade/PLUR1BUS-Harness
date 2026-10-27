//! Inspection of stores copied for host-owned adoption.

use super::{AdoptReport, EngineError, StoreAdoptRequest};

/// Inspect copied stores without moving the source or changing host configuration.
pub trait StoreOps: Send + Sync {
    /// Inspect a copied store, its expected vector identity and the requested dry-run mode.
    fn adopt(&self, request: StoreAdoptRequest) -> Result<AdoptReport, EngineError>;
}
