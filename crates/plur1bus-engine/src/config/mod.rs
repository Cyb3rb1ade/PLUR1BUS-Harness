//! Engine configuration validation and explicit setup profiles at the pinned Node contract.

mod defaults;
/// Pure setup profile construction, compatibility normalization and status presentation.
pub mod profiles;
mod tier;
mod validate;

pub use crate::contract::EngineConfig;
pub use defaults::{effective_config, manifest_defaults};
pub use tier::{tier_of, Tier};
pub use validate::{normalize, validate};

use serde_json::{json, Value};
use std::sync::OnceLock;

// These assertions only concern embedded metadata or shapes already checked above.
// Their provenance is kept at each call; no raw configuration access uses this helper.
trait Embedded<T> {
    fn embedded(self, provenance: &str) -> T;
}

impl<T> Embedded<T> for Option<T> {
    #[allow(
        clippy::expect_used,
        reason = "checked-in metadata and established object-shape invariants"
    )]
    fn embedded(self, provenance: &str) -> T {
        self.expect(provenance)
    }
}

impl<T, E: std::fmt::Debug> Embedded<T> for Result<T, E> {
    #[allow(
        clippy::expect_used,
        reason = "checked-in metadata and established object-shape invariants"
    )]
    fn embedded(self, provenance: &str) -> T {
        self.expect(provenance)
    }
}

/// The copied host-neutral source schema, before the documented runtime compatibility overlay.
pub const SCHEMA_JSON: &str = include_str!("../../schema/engine-config.schema.json");

/// One rejected configuration value, with its path relative to the engine configuration.
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ConfigError {
    /// Dotted property path, with array positions represented as `[index]`.
    pub path: String,
    /// Human-readable cause, including guidance for fields backed by the secret store.
    pub message: String,
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.path, self.message)
    }
}

impl std::error::Error for ConfigError {}

fn error(path: &str, detail: impl Into<String>) -> ConfigError {
    ConfigError {
        path: path.to_owned(),
        message: detail.into(),
    }
}

fn child_path(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.to_owned()
    } else {
        format!("{path}.{key}")
    }
}

fn schema() -> &'static Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        let mut schema: Value = serde_json::from_str(SCHEMA_JSON).embedded("embedded engine schema");
        // These runtime-only fields and the changed default are pinned in schema/DRIFT.json.
        schema["properties"]["runtime"]["properties"]["traceRegistrations"] = json!({"type":"boolean", "default":false});
        schema["properties"]["runtime"]["properties"]["deferPostTurnLlm"]["default"] = json!(true);
        schema["properties"]["groupReasoningFilter"] = json!({
            "type":"object", "additionalProperties":false,
            "properties": {"enabled":{"type":"boolean","default":true},"prefixes":{"type":"array","items":{"type":"string","minLength":1}}}
        });
        schema
    })
}

fn resolved_schema(node: &Value) -> Value {
    if let Some(reference) = node.get("$ref").and_then(Value::as_str) {
        let mut resolved = schema()
            .pointer(
                reference
                    .strip_prefix('#')
                    .embedded("local schema reference"),
            )
            .embedded("embedded schema reference resolves")
            .clone();
        for (key, value) in node.as_object().embedded("schema object") {
            if key != "$ref" {
                resolved[key] = value.clone();
            }
        }
        resolved
    } else {
        node.clone()
    }
}

fn get_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter()
        .try_fold(value, |node, part| node.as_object()?.get(*part))
}

fn set_path(value: &mut Value, path: &[&str], next: Value) {
    let Some((last, parents)) = path.split_last() else {
        *value = next;
        return;
    };
    let mut current = value;
    for part in parents {
        if !current.is_object() {
            *current = json!({});
        }
        let child = current
            .as_object_mut()
            .embedded("object")
            .entry(*part)
            .or_insert_with(|| json!({}));
        if !child.is_object() {
            *child = json!({});
        }
        current = child;
    }
    if !current.is_object() {
        *current = json!({});
    }
    current[*last] = next;
}
