pub mod types {
    include!(concat!(env!("OUT_DIR"), "/types.rs"));
}
include!(concat!(env!("OUT_DIR"), "/rpc_version.rs"));
pub const SUPPORTED_RPC_MAJOR: u64 = 1;
pub mod client;
pub mod error;
pub mod transport;
pub use client::{Client, ConnectOptions, Hello};
pub use error::{is_unavailable, RpcError};
