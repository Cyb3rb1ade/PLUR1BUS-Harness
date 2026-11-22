//! Shared record policy for hosts of the Rust wire libraries.
#![forbid(unsafe_code)]

use log::{Level, Log, Metadata, Record, SetLoggerError};

/// Keep harness diagnostics and suppress dependency records below WARN (R-W-11).
pub fn allows(metadata: &Metadata<'_>) -> bool {
    metadata.level() <= Level::Warn || metadata.target().starts_with("plur1bus")
}

/// Register a host's logger with the wire-record policy. The host sets its own
/// runtime maximum level and remains responsible for redacting its own messages.
pub fn install(logger: impl Log + 'static) -> Result<(), SetLoggerError> {
    log::set_boxed_logger(Box::new(Filtered(logger)))
}

struct Filtered<L>(L);

impl<L: Log> Log for Filtered<L> {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        allows(metadata) && self.0.enabled(metadata)
    }

    fn log(&self, record: &Record<'_>) {
        if self.enabled(record.metadata()) {
            self.0.log(record);
        }
    }

    fn flush(&self) {
        self.0.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_harness_diagnostics_and_only_dependency_warnings_and_errors() {
        for (target, lowest_allowed) in [
            ("plur1bus_channels::websocket", Level::Trace),
            ("plur1bus_engine", Level::Trace),
            ("tungstenite::protocol", Level::Warn),
            ("ureq_proto", Level::Warn),
            ("unrelated::plur1bus", Level::Warn),
        ] {
            for level in [
                Level::Error,
                Level::Warn,
                Level::Info,
                Level::Debug,
                Level::Trace,
            ] {
                let metadata = Metadata::builder().target(target).level(level).build();
                assert_eq!(
                    allows(&metadata),
                    level <= lowest_allowed,
                    "{target} {level}"
                );
            }
        }
    }
}
