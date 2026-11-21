//! Channel wire protocols with host-supplied credentials, connections, clocks and stores.
#![forbid(unsafe_code)]

#[cfg(feature = "discord")]
pub mod discord;
#[cfg(feature = "email")]
pub mod email;
#[cfg(feature = "http")]
pub mod http;
#[cfg(feature = "signal")]
pub mod signal;
#[cfg(feature = "slack")]
pub mod slack;
#[cfg(any(feature = "email", feature = "websocket"))]
mod stream;
#[cfg(feature = "telegram")]
pub mod telegram;
#[cfg(feature = "websocket")]
pub mod websocket;
