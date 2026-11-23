//! MCP protocol boundaries for host-owned transports.
#![forbid(unsafe_code)]

pub mod auth;
pub mod bridge_body;
mod connection_fault;
pub mod http;
mod provenance;
pub mod registry;
mod replies;
mod runtime;
pub mod server;
pub mod session;
mod session_schema;
pub mod stdio;

mod session_ports;
