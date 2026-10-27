//! The frozen engine data contract, service ports and process-local runtime handles.

/// Data types generated from the versioned engine contract schema.
/// Runtime service methods stay in schema metadata and are declared by handwritten traits.
pub mod generated {
    // Typify owns these implementations; its emitted helpers do not follow workspace style lints.
    #![allow(
        missing_docs,
        unused_qualifications,
        clippy::all,
        clippy::pedantic,
        clippy::unwrap_used
    )]
    include!(concat!(env!("OUT_DIR"), "/contract.rs"));
}

/// Engine configuration generated separately to keep the public EngineConfig name readable.
pub mod generated_config {
    // Configuration types are generated from the independently versioned configuration schema.
    #![allow(
        missing_docs,
        unused_qualifications,
        clippy::all,
        clippy::pedantic,
        clippy::unwrap_used
    )]
    include!(concat!(env!("OUT_DIR"), "/engine_config.rs"));
}

pub use generated::*;
pub use generated_config::EngineConfig;

/// Frozen feature flags that a host can test before using optional engine surfaces.
pub type Capabilities = EngineCapabilities;

/// The result of inspecting a copied store before host-owned adoption.
pub type AdoptReport = StoreAdoptResult;

pub mod limits;

mod admin_ops;
mod cancel;
mod channels;
mod embedding;
mod engine;
mod errors;
mod host;
mod jobs;
mod memory_ops;
mod models;
mod runtime;
mod store_ops;

pub use admin_ops::{AdminOps, ObsidianOps, ReembeddingOps, WorkspacePolicyOps};
pub use cancel::{Cancel, CancelReason, Cancelled};
pub use channels::ChannelRegistry;
pub use embedding::EmbeddingService;
pub use engine::Engine;
pub use errors::{EmbedError, EngineError, ErrorId, HostError, MemoryOpError, StoreError};
pub use host::{
    AddressRules, CanonicalIdentityPathCallback, Decision, EgressGate, HostServices,
    IpcAddressCallback, LlmPort, PlatformCapabilities, Scheme, SecretPort, SecretValue,
    SecurePathCallback, Target, UnsafeLinkCallback,
};
pub use jobs::JobRegistry;
pub use memory_ops::{MemoryCurationOps, MemoryOps, MemoryProposalsOps};
pub use models::ModelsService;
pub use runtime::{AgentStoreHandle, CaptureHandle, EventReceiver};
pub use store_ops::StoreOps;

/// In-memory host fixtures for engine tests and downstream test suites.
#[cfg(any(test, feature = "testkit"))]
pub mod testing;
