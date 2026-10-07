pub mod types {
    // typify emits a `oneOf` result (dreams.run: a ledger row or a dry-run plan) as an enum with one large variant.
    #![allow(clippy::large_enum_variant)]
    include!(concat!(env!("OUT_DIR"), "/types.rs"));
}
include!(concat!(env!("OUT_DIR"), "/rpc_version.rs"));
pub const SUPPORTED_RPC_MAJOR: u64 = 1;
pub mod acl;
pub mod capabilities;
pub mod client;
pub mod error;
pub mod transport;
pub mod trust;
#[cfg(windows)]
pub mod win;
pub use capabilities::{capabilities, SCHEMA_JSON};
pub use client::{Client, ConnectOptions, Endpoint};
pub use error::{is_unavailable, RpcError};
