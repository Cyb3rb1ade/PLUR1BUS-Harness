//! Per-server `Capabilities`, built from the schema's own annotations exactly as the TypeScript `buildCapabilities`
//! does (ADR-016 §3, ruling S2): only the methods and notifications whose `x-server` is `server`, each with its
//! `x-stability`, `x-since` and (when present) `x-deprecated`; `extensionPoints` empty; `features` sorted.
use serde_json::{json, Map, Value};

/// The RPC schema, the single source for both languages.
pub const SCHEMA_JSON: &str = include_str!("../../../packages/rpc-schema/schema/rpc.schema.json");

/// Builds the `Capabilities` value `server` (`"core"`, `"supervisor"` or `"module"`) advertises in its handshake. The schema is
/// parsed on every call: this runs once per supervisor start, never on the CLI's start-up path.
pub fn capabilities(server: &str, features: &[&str]) -> Value {
    let schema: Value = serde_json::from_str(SCHEMA_JSON).expect("rpc.schema.json parses");
    let entries = |defs: &Value| -> Map<String, Value> {
        defs.as_object()
            .expect("$defs/methods and $defs/notifications are objects")
            .iter()
            .filter(|(_, def)| def["x-server"].as_str().unwrap_or("core") == server)
            .map(|(name, def)| {
                let mut entry = Map::new();
                entry.insert("stability".into(), def["x-stability"].clone());
                entry.insert("since".into(), def["x-since"].clone());
                if let Some(d) = def.get("x-deprecated") {
                    entry.insert("deprecated".into(), d.clone());
                }
                (name.clone(), Value::Object(entry))
            })
            .collect()
    };
    let mut features: Vec<&str> = features.to_vec();
    features.sort_unstable();
    json!({
        "methods": entries(&schema["$defs"]["methods"]),
        "notifications": entries(&schema["$defs"]["notifications"]),
        "extensionPoints": {},
        "features": features,
    })
}
