//! Blocking provider protocols. Credentials, egress approval and cancellation belong to the caller.
#![forbid(unsafe_code)]

pub mod cache;
pub mod display;
mod error;
mod gemini_schema;
pub mod local;
mod ordered;
pub mod provenance;
pub mod reasoning;
mod request;
pub mod resolution;
mod response;
pub mod router;
mod sse;
mod transport;

pub use error::{ErrorKind, ProviderError, TimeoutPhase};
pub use ordered::Json;
pub use request::{RequestOptions, SignedThinking, Wire};
pub use response::{retry_after_date_ms, ToolRepair, ToolRepairInput};
pub use sse::{SseEvent, SseParser};
pub use transport::{
    connect_pinned_tcp, http_read_timed_out, pinned_http_agent, with_pinned_http_cancellation,
    Adapter, Config, HttpCancellation, Ports, Timeouts,
};
