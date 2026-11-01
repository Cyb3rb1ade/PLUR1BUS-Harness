//! Thin ordinary-backup adapter to the configuration crate's shared projector.
use super::redact::PLACEHOLDER;
use super::BackupError;
use serde_json::Value;

/// Project the private staging copy and return key names plus whether its bytes need rewriting.
pub(super) fn redact(
    value: &mut Value,
    schema: &Value,
) -> Result<(Vec<String>, bool), BackupError> {
    let (projected, keys) = plur1bus_config::placeholder_with_schema(value, schema, PLACEHOLDER)
        .map_err(|error| BackupError::new("config-policy-invalid", error.to_string()))?;
    let changed = projected != *value;
    *value = projected;
    Ok((keys, changed))
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
            json!(null),
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
    fn an_explicitly_disabled_reference_marker_is_not_invalid_metadata_or_an_exemption() {
        let literal = uuid::Uuid::new_v4().to_string();
        let schema = serde_json::json!({"properties":{
            "public":{"type":"string","x-secret-reference":false},
            "ordinary":{"type":"string","x-sensitive":true,"x-secret-reference":false}
        }});
        let mut value = serde_json::json!({"public":"service.reference","ordinary":literal});
        let (keys, changed) = redact(&mut value, &schema).unwrap();
        assert!(changed);
        assert_eq!(keys, ["ordinary"]);
        assert_eq!(value["public"], "service.reference");
        assert_eq!(value["ordinary"], PLACEHOLDER);
    }

    #[test]
    fn a_reference_marker_cannot_broaden_endpoint_credential_masking() {
        let literal = uuid::Uuid::new_v4().to_string();
        let schema =
            serde_json::json!({"type":"string","x-secret-reference":true,"x-url-credentials":true});
        let mut value = serde_json::json!(format!(
            "https://{literal}@relay.example.test/public?ordinary={literal}"
        ));
        let (keys, changed) = redact(&mut value, &schema).unwrap();
        assert!(changed);
        assert_eq!(keys, [""]);
        assert_eq!(
            value,
            "https://REDACTED@relay.example.test/public?ordinary=REDACTED"
        );
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
