//! The frozen engine data contract and its generated configuration types.

/// Data types generated from the versioned engine contract schema.
/// Runtime service methods stay in schema metadata and are declared by handwritten traits.
pub mod generated {
    // Typify owns these implementations; its emitted helpers do not follow workspace style lints.
    #![allow(missing_docs, unused_qualifications, clippy::all, clippy::pedantic)]
    include!(concat!(env!("OUT_DIR"), "/contract.rs"));
}

/// Engine configuration generated separately to keep the public EngineConfig name readable.
pub mod generated_config {
    // Configuration types are generated from the independently versioned configuration schema.
    #![allow(missing_docs, unused_qualifications, clippy::all, clippy::pedantic)]
    include!(concat!(env!("OUT_DIR"), "/engine_config.rs"));
}

pub use generated::*;
pub use generated_config::EngineConfig;

/// Frozen feature flags that a host can test before using optional engine surfaces.
pub type Capabilities = EngineCapabilities;

/// The result of inspecting a copied store before host-owned adoption.
pub type AdoptReport = StoreAdoptResult;

pub mod limits;
