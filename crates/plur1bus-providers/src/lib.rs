//! Blocking provider protocols. Credentials, egress approval and cancellation belong to the caller.
#![forbid(unsafe_code)]

pub mod cache;
mod error;
mod gemini_schema;
pub mod local;
mod ordered;
pub mod reasoning;
mod request;
mod response;
pub mod router;
mod sse;
mod transport;

pub use error::{ErrorKind, ProviderError, TimeoutPhase};
pub use ordered::Json;
pub use request::{RequestOptions, SignedThinking, Wire};
pub use response::{retry_after_date_ms, ToolRepair, ToolRepairInput};
pub use sse::{SseEvent, SseParser};
pub use transport::{pinned_http_agent, Adapter, Config, Ports, Timeouts};
