//! `config-warnings.ts`: runtime configuration warnings contain bounded schema keys and guidance, never the configured
//! values or validator payloads. The warnings themselves (`configurationWarnings` of `packages/config-schema`) are computed
//! by [`plur1bus_config::configuration_warnings`]; this module delivers one bounded batch through a logger.
use crate::logs::bootstrap::HarnessLogger;
use plur1bus_config::ConfigWarning;
use serde_json::{Map, Value};

pub use plur1bus_config::{config_warnings, configuration_warnings};

const MAX_WARNINGS: usize = 50;
const MAX_KEY_CHARS: usize = 256;
const MAX_GUIDANCE_CHARS: usize = 512;

/// `text.slice(0, units)`: at most `units` UTF-16 code units. A cut inside a surrogate pair drops the whole character (a
/// JavaScript string would keep a lone surrogate, which a Rust string cannot hold).
pub fn slice_units(text: &str, units: usize) -> String {
    let mut used = 0;
    let mut out = String::new();
    for c in text.chars() {
        used += c.len_utf16();
        if used > units {
            break;
        }
        out.push(c);
    }
    out
}

/// Delivers one bounded warning batch (the first 50, key cut at 256 and guidance at 512 UTF-16 units) as
/// `configuration warning` records with the fields `key` and `guidance`. With no logger nothing is delivered.
pub fn log_config_warnings(logger: Option<&dyn HarnessLogger>, warnings: &[ConfigWarning]) {
    let Some(logger) = logger else {
        return;
    };
    for ConfigWarning { key, message } in warnings.iter().take(MAX_WARNINGS) {
        let mut fields = Map::new();
        fields.insert("key".into(), Value::String(slice_units(key, MAX_KEY_CHARS)));
        fields.insert(
            "guidance".into(),
            Value::String(slice_units(message, MAX_GUIDANCE_CHARS)),
        );
        logger.warn("configuration warning", &fields);
    }
}
