//! Channel wire protocols with host-supplied credentials, connections, clocks and stores.
#![forbid(unsafe_code)]

#[cfg(feature = "discord")]
pub mod discord;
#[cfg(feature = "http")]
pub mod http;
#[cfg(feature = "slack")]
pub mod slack;
#[cfg(feature = "telegram")]
pub mod telegram;
