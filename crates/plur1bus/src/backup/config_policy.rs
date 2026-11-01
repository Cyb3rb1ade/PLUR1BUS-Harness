//! Ordinary-backup disclosure policy from configuration metadata. References are never resolved.
use super::redact::PLACEHOLDER;
use super::BackupError;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};

static EMPTY_SCHEMA: Value = Value::Null;

struct NoExternalSchemas;

impl jsonschema::Retrieve for NoExternalSchemas {
    fn retrieve(
        &self,
        _: &jsonschema::Uri<&str>,
    ) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        Err(std::io::Error::other("external reference metadata is unsupported").into())
    }
}

#[derive(Clone, Copy, Default)]
struct Flags {
    sensitive: bool,
    url_credentials: bool,
}

fn field<'a>(schema: &'a Value, name: &str) -> Option<&'a Value> {
    schema
        .get("x-value-schema")
        .and_then(|metadata| metadata.get(name))
        .or_else(|| schema.get(name))
}

fn schema_object(value: Option<&Value>) -> &Value {
    value
        .filter(|node| node.is_object())
        .unwrap_or(&EMPTY_SCHEMA)
}

fn member<'a>(schema: &'a Value, name: &str) -> &'a Value {
    schema
        .get("x-value-schema")
        .and_then(|metadata| metadata.get("properties"))
        .and_then(|properties| properties.get(name))
        .or_else(|| {
            schema
                .get("properties")
                .and_then(|properties| properties.get(name))
        })
        .unwrap_or_else(|| schema_object(field(schema, "additionalProperties")))
}

fn annotated(schema: &Value, inherited: Flags) -> Flags {
    Flags {
        sensitive: inherited.sensitive
            || field(schema, "x-sensitive").and_then(Value::as_bool) == Some(true),
        url_credentials: inherited.url_credentials
            || field(schema, "x-url-credentials").and_then(Value::as_bool) == Some(true),
    }
}

fn value_flags(schema: &Value, inherited: Flags) -> Flags {
    let flags = annotated(schema, inherited);
    let kind = field(schema, "type").and_then(Value::as_str);
    let homogeneous = kind == Some("object")
        && schema
            .get("properties")
            .and_then(Value::as_object)
            .is_none_or(|properties| properties.is_empty())
        && schema
            .get("x-value-schema")
            .and_then(|metadata| metadata.get("properties"))
            .and_then(Value::as_object)
            .is_none_or(|properties| properties.is_empty());
    let item = field(schema, "items").or_else(|| {
        homogeneous
            .then(|| field(schema, "additionalProperties"))
            .flatten()
    });
    if kind == Some("array") || homogeneous {
        annotated(schema_object(item), flags)
    } else {
        flags
    }
}

fn metadata_error() -> BackupError {
    BackupError::new(
        "config-policy-invalid",
        "configuration secret-reference metadata is invalid; repair the installed schema before creating a backup",
    )
}

struct Projection<'a> {
    references: HashMap<*const Value, (jsonschema::Validator, &'a Value)>,
    local_references: HashMap<&'a str, *const Value>,
    keys: BTreeSet<String>,
    changed: bool,
}

impl<'a> Projection<'a> {
    fn references(&mut self, node: &'a Value, root: &'a Value) -> Result<(), BackupError> {
        match node {
            Value::Object(fields) => {
                if let Some(metadata) = fields.get("x-secret-reference") {
                    let target = if metadata.as_bool() == Some(true) {
                        node
                    } else {
                        let reference = metadata
                            .as_object()
                            .filter(|object| object.len() == 1)
                            .and_then(|object| object.get("$ref"))
                            .and_then(Value::as_str)
                            .filter(|reference| reference.starts_with("#/$defs/"))
                            .ok_or_else(metadata_error)?;
                        let target = root.pointer(&reference[1..]).ok_or_else(metadata_error)?;
                        self.local_references
                            .insert(reference, target as *const Value);
                        target
                    };
                    let key = target as *const Value;
                    if let std::collections::hash_map::Entry::Vacant(entry) =
                        self.references.entry(key)
                    {
                        let mut schema = serde_json::json!({"allOf":[target]});
                        if let Some(definitions) = root.get("$defs") {
                            schema["$defs"] = definitions.clone();
                        }
                        let validator = jsonschema::options()
                            .with_retriever(NoExternalSchemas)
                            .build(&schema)
                            .map_err(|_| metadata_error())?;
                        entry.insert((validator, target));
                    }
                }
                for child in fields.values() {
                    self.references(child, root)?;
                }
            }
            Value::Array(children) => {
                for child in children {
                    self.references(child, root)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn is_reference(&self, value: &Value, schema: &Value) -> bool {
        let key = match field(schema, "x-secret-reference") {
            Some(Value::Bool(true)) => Some(schema as *const Value),
            Some(metadata) => metadata
                .get("$ref")
                .and_then(Value::as_str)
                .and_then(|reference| self.local_references.get(reference))
                .copied(),
            None => None,
        };
        key.and_then(|key| self.references.get(&key))
            .is_some_and(|(validator, schema)| {
                validator.is_valid(value) && plur1bus_config::reference_safety(value, schema)
            })
    }

    fn visit(&mut self, value: &mut Value, schema: &Value, key: &str, inherited: Flags) {
        let flags = value_flags(schema, inherited);
        let kind = field(schema, "type").and_then(Value::as_str);
        if flags.sensitive && self.is_reference(value, schema) {
            return;
        }
        let collection = matches!(kind, Some("array" | "object"));
        if flags.sensitive && !(collection && (value.is_object() || value.is_array())) {
            if value.is_null() || value.as_str() == Some("") {
                return;
            }
            self.keys.insert(key.to_string());
            if value.as_str() != Some(PLACEHOLDER) {
                *value = Value::String(PLACEHOLDER.to_string());
                self.changed = true;
            }
            return;
        }
        match value {
            Value::String(text) if flags.url_credentials => {
                let masked = plur1bus_config::mask_url_credentials(text);
                let credentials = plur1bus_config::secret_values_with_schema(
                    value,
                    &serde_json::json!({"x-url-credentials": true}),
                );
                let changed = value.as_str() != Some(masked.as_str());
                if changed || !credentials.is_empty() {
                    self.keys.insert(key.to_string());
                }
                if changed {
                    *value = Value::String(masked);
                    self.changed = true;
                }
            }
            Value::Array(items) => {
                let item_schema = schema_object(field(schema, "items"));
                for (index, child) in items.iter_mut().enumerate() {
                    self.visit(
                        child,
                        item_schema,
                        &child_key(key, &index.to_string()),
                        flags,
                    );
                }
            }
            Value::Object(members) => {
                for (name, child) in members {
                    self.visit(child, member(schema, name), &child_key(key, name), flags);
                }
            }
            _ => {}
        }
    }
}

fn child_key(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}.{name}")
    }
}

/// Replace declared literals and URL credentials; return replaced key names and whether any bytes need rewriting.
pub(super) fn redact(
    value: &mut Value,
    schema: &Value,
) -> Result<(Vec<String>, bool), BackupError> {
    let mut projection = Projection {
        references: HashMap::new(),
        local_references: HashMap::new(),
        keys: BTreeSet::new(),
        changed: false,
    };
    projection.references(schema, schema)?;
    projection.visit(value, schema, "", Flags::default());
    Ok((projection.keys.into_iter().collect(), projection.changed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn declarations_control_unrelated_names_maps_arrays_and_opaque_metadata() {
        let secret = uuid::Uuid::new_v4().to_string();
        let schema = json!({"properties": {
            "ordinary": {"type":"string", "x-sensitive":true},
            "password": {"type":"string"},
            "headers": {"type":"object", "additionalProperties":{"type":"string", "x-sensitive":true}},
            "arguments": {"type":"array", "items":{"type":"string", "x-sensitive":true}},
            "opaque": {"properties":{"direct":{"type":"string", "x-sensitive":true}},
                "x-value-schema":{"properties":{"metadata":{"type":"string", "x-sensitive":true}}}}
        }});
        let mut config = json!({"ordinary":secret, "password":"public-label",
            "headers":{"arbitrary":secret}, "arguments":[secret],
            "opaque":{"direct":secret,"metadata":secret}, "maxTokens":4096});
        let (keys, changed) = redact(&mut config, &schema).unwrap();
        assert!(changed);
        assert!(!config.to_string().contains(&secret));
        assert_eq!(config["password"], "public-label");
        assert_eq!(config["maxTokens"], 4096);
        assert_eq!(
            keys,
            [
                "arguments.0",
                "headers.arbitrary",
                "opaque.direct",
                "opaque.metadata",
                "ordinary"
            ]
        );
    }

    #[test]
    fn malformed_reference_metadata_refuses_even_when_no_value_uses_it() {
        for metadata in [
            json!(false),
            json!({"$ref":"#/$defs/missing"}),
            json!({"$ref":42}),
        ] {
            let schema = json!({"properties":{"ordinary":{"x-sensitive":true,"x-secret-reference":metadata}}});
            assert_eq!(
                redact(&mut json!({}), &schema).unwrap_err().reason,
                "config-policy-invalid"
            );
        }
    }

    #[test]
    fn reference_metadata_never_reads_external_schema_resources() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("schema.json");
        std::fs::write(&path, json!({"type":"string"}).to_string()).unwrap();
        for external in [
            format!("file://{}", path.display()),
            "https://schema.example.test/reference.json".to_owned(),
        ] {
            let schema = json!({"$defs":{"name":{"$ref":external}},"properties":{
                "ordinary":{"x-sensitive":true,"x-secret-reference":{"$ref":"#/$defs/name"}}
            }});
            assert_eq!(
                redact(&mut json!({}), &schema).unwrap_err().reason,
                "config-policy-invalid"
            );
        }
    }

    #[test]
    fn malformed_secret_reference_values_are_placeholders_but_valid_reference_objects_stay() {
        let secret = uuid::Uuid::new_v4().to_string();
        let schema: Value = serde_json::from_str(plur1bus_config::SCHEMA_JSON).unwrap();
        let reference =
            json!({"source":"file", "provider":"fixture", "id":format!("/private/{secret}")});
        let mut config = json!({"engine":{
            "embedding":{"apiKey":reference,"apiKeyRef":{"literal":secret}},
            "reranker":{"apiKey":{"source":"store","provider":"fixture","id":secret,"literal":secret}}
        }});
        let (keys, _) = redact(&mut config, &schema).unwrap();
        assert_eq!(config["engine"]["embedding"]["apiKey"], reference);
        assert_eq!(config["engine"]["embedding"]["apiKeyRef"], PLACEHOLDER);
        assert_eq!(config["engine"]["reranker"]["apiKey"], PLACEHOLDER);
        assert_eq!(
            keys,
            ["engine.embedding.apiKeyRef", "engine.reranker.apiKey"]
        );
    }
}
