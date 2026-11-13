//! `metrics/logger-port.ts`: the part of the harness logger the metrics server uses (a seam for tests).
use crate::logs::bootstrap::HarnessLogger;
use serde_json::{Map, Value};
use std::sync::Arc;

/// What the metrics endpoint logs through.
pub trait MetricsLog: Send + Sync {
    /// `info(message, fields)`.
    fn info(&self, message: &str, fields: &Map<String, Value>);
    /// `warn(message, fields)`.
    fn warn(&self, message: &str, fields: &Map<String, Value>);
    /// `error(message, fields)`.
    fn error(&self, message: &str, fields: &Map<String, Value>);
}

/// The harness logger as a [`MetricsLog`].
pub struct HarnessLog(pub Arc<dyn HarnessLogger>);

impl MetricsLog for HarnessLog {
    fn info(&self, message: &str, fields: &Map<String, Value>) {
        self.0.info(message, fields);
    }

    fn warn(&self, message: &str, fields: &Map<String, Value>) {
        self.0.warn(message, fields);
    }

    fn error(&self, message: &str, fields: &Map<String, Value>) {
        self.0.error(message, fields);
    }
}
