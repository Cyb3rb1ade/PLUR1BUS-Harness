//! Channel wire protocols with host-supplied credentials, connections, clocks and stores.
#![forbid(unsafe_code)]

#[cfg(feature = "http")]
pub mod http;
#[cfg(feature = "telegram")]
pub mod telegram;
