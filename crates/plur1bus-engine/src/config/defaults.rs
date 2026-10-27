use super::Embedded;
use super::{normalize, resolved_schema, schema, ConfigError};
use serde_json::{Map, Value};

/// Validate raw input, normalize review aliases and materialize the Node manifest defaults.
pub fn effective_config(raw: &Value) -> Result<Value, Vec<ConfigError>> {
    let normalized = normalize(raw)?;
    Ok(materialize(schema(), Some(&normalized)).embedded("root object is supplied"))
}

/// Return a private manifest-default configuration; changing it cannot alter later results.
pub fn manifest_defaults() -> Value {
    effective_config(&Value::Object(Map::new())).embedded("manifest defaults are valid")
}

fn materialize(node: &Value, supplied: Option<&Value>) -> Option<Value> {
    let node = resolved_schema(node);
    let value = supplied.or_else(|| node.get("default"));
    let supports_object = node.get("type").is_some_and(|kind| {
        kind == "object"
            || kind
                .as_array()
                .is_some_and(|types| types.iter().any(|kind| kind == "object"))
    });
    let properties = node.get("properties").and_then(Value::as_object);
    if value.is_none() && supports_object {
        if let Some(properties) = properties {
            let mut output = Map::new();
            for (key, child) in properties {
                if let Some(value) = materialize(child, None) {
                    output.insert(key.clone(), value);
                }
            }
            return (!output.is_empty()).then_some(Value::Object(output));
        }
    }
    let value = value?;
    if let (Some(object), Some(properties)) = (value.as_object(), properties) {
        let mut output = object.clone();
        for (key, child) in properties {
            if let Some(value) = materialize(child, output.get(key)) {
                output.insert(key.clone(), value);
            }
        }
        return Some(Value::Object(output));
    }
    if let (Some(array), Some(items)) = (value.as_array(), node.get("items")) {
        return Some(Value::Array(
            array
                .iter()
                .map(|value| materialize(items, Some(value)).embedded("supplied array value"))
                .collect(),
        ));
    }
    Some(value.clone())
}
