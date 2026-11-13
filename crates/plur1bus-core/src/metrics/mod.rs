//! `packages/core/src/metrics/`: the metrics registry, the core's metrics and the loopback `GET /metrics` endpoint.
pub mod http;
pub mod logger_port;
#[allow(
    clippy::module_inception,
    reason = "named after metrics/metrics.ts, which the port mirrors"
)]
pub mod metrics;
pub mod registry;
pub mod token;
