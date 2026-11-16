//! The secret names the engine may resolve (P4D-29, R-20-35, R-20-36): `engine/secret-scope.ts`, over the same schema.
//!
//! One definition, read from the configuration schema and nowhere else:
//!
//! - every value of the engine's part of the configuration (`engine`) that sits in a field marked `x-secret-reference`
//!   and is a valid secret name. A store reference of the object form (`{ "source": "store", "provider", "id" }`)
//!   names its `id`; an environment, file or exec reference names nothing the store holds;
//! - the names a block falls back to without a reference of its own: the schema marks the block `x-secret-default`,
//!   and the names are allowed exactly while that block is an object in the configuration. Neither the provider nor
//!   the host of the block is judged; whichever name the engine falls back to is on the list.
//!
//! No field name, block name or name pattern is written here. `fixtures/parity/secrets/engine-scope.json` holds what
//! this and the TypeScript set must both give; both replay it.
use crate::secrets::types::is_secret_name;
use plur1bus_config::{reference_paths_with_schema, SCHEMA_JSON};
use serde_json::Value;
use std::collections::BTreeSet;
use std::sync::OnceLock;

fn schema() -> Option<&'static Value> {
    static SCHEMA: OnceLock<Option<Value>> = OnceLock::new();
    SCHEMA
        .get_or_init(|| serde_json::from_str(SCHEMA_JSON).ok())
        .as_ref()
}

fn referenced(config: &Value, schema: &Value, names: &mut BTreeSet<String>) {
    for pointer in reference_paths_with_schema(config, schema) {
        if !pointer.starts_with("/engine/") {
            continue;
        }
        let Some(value) = config.pointer(&pointer) else {
            continue;
        };
        let name = match value {
            Value::String(name) => Some(name.as_str()),
            Value::Object(fields) if fields.get("source").and_then(Value::as_str) == Some("store") => {
                fields.get("id").and_then(Value::as_str)
            }
            _ => None,
        };
        if let Some(name) = name.filter(|name| is_secret_name(name)) {
            names.insert(name.to_owned());
        }
    }
}

fn defaults(schema: &Value, value: &Value, names: &mut BTreeSet<String>) {
    let (Some(_), Some(members)) = (schema.as_object(), value.as_object()) else {
        return;
    };
    // A node can carry its members beside `x-value-schema` (the `engine` node does); both views count.
    for view in [Some(schema), schema.get("x-value-schema")]
        .into_iter()
        .flatten()
    {
        if let Some(marked) = view.get("x-secret-default").and_then(Value::as_array) {
            names.extend(
                marked
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|name| is_secret_name(name))
                    .map(str::to_owned),
            );
        }
        if let Some(children) = view.get("properties").and_then(Value::as_object) {
            for (key, child) in children {
                if let Some(inner) = members.get(key) {
                    defaults(child, inner, names);
                }
            }
        }
    }
}

/// The set for one configuration; a configuration without an engine part gives the empty set.
pub fn engine_secret_names(config: &Value) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    let (Some(schema), Some(engine)) = (schema(), config.get("engine").filter(|v| v.is_object()))
    else {
        return names;
    };
    referenced(config, schema, &mut names);
    if let Some(engine_schema) = schema.pointer("/properties/engine") {
        defaults(engine_schema, engine, &mut names);
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_vectors_shared_with_typescript() {
        let path = format!(
            "{}/../../fixtures/parity/secrets/engine-scope.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let cases = doc["cases"].as_array().unwrap();
        assert!(cases.len() >= 20, "the vectors are there");
        for case in cases {
            let expected: Vec<String> = case["names"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_str().unwrap().to_owned())
                .collect();
            let got: Vec<String> = engine_secret_names(&case["config"]).into_iter().collect();
            assert_eq!(got, expected, "{}", case["name"]);
        }
    }

    #[test]
    fn every_default_name_of_the_schema_is_a_secret_name() {
        let schema = schema().unwrap();
        let mut found = Vec::new();
        fn walk(node: &Value, found: &mut Vec<String>) {
            match node {
                Value::Object(map) => {
                    for (key, child) in map {
                        if key == "x-secret-default" {
                            for name in child.as_array().unwrap() {
                                found.push(name.as_str().unwrap().to_owned());
                            }
                        } else {
                            walk(child, found);
                        }
                    }
                }
                Value::Array(items) => items.iter().for_each(|i| walk(i, found)),
                _ => {}
            }
        }
        walk(schema, &mut found);
        assert!(!found.is_empty());
        assert!(found.iter().all(|n| is_secret_name(n)), "{found:?}");
    }
}
