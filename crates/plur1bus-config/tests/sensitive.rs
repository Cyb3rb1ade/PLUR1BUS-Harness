//! Public views use schema annotations while the runtime configuration remains unchanged.
use plur1bus_config as cfg;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn canary() -> String {
    let directory = tempfile::tempdir().unwrap();
    let hash = Sha256::digest(directory.path().to_string_lossy().as_bytes());
    hash.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn shared_reference_vectors_match_projection_text_registration_and_value_free_warnings() {
    fn render(value: &Value) -> Value {
        if value["kind"] == "alphabet" {
            return json!((b'A'..=b'Z')
                .chain(b'a'..=b'z')
                .chain(b'0'..=b'9')
                .map(char::from)
                .collect::<String>());
        }
        if value["kind"] == "hex_alphabet" {
            return json!((b'0'..=b'9')
                .chain(b'a'..=b'f')
                .map(char::from)
                .collect::<String>()
                .repeat(value["count"].as_u64().unwrap() as usize));
        }
        if let Some(repeat) = value.get("repeat").and_then(Value::as_str) {
            return json!(format!(
                "{}{}{}",
                value["prefix"].as_str().unwrap_or(""),
                repeat.repeat(value["count"].as_u64().unwrap() as usize),
                value["suffix"].as_str().unwrap_or("")
            ));
        }
        match value {
            Value::Object(fields) => Value::Object(
                fields
                    .iter()
                    .map(|(key, child)| (key.clone(), render(child)))
                    .collect(),
            ),
            _ => value.clone(),
        }
    }
    let vectors: Vec<Value> = serde_json::from_str(include_str!(
        "../../../packages/config-schema/test/fixtures/reference-values.json"
    ))
    .unwrap();
    let root: Value = serde_json::from_str(cfg::SCHEMA_JSON).unwrap();
    let definitions = root["$defs"].clone();
    for (index, vector) in vectors.into_iter().enumerate() {
        let definition = vector["definition"].as_str().unwrap();
        let schema = json!({"$defs":definitions,"properties":{"ordinary":{
            "x-sensitive":true,"x-secret-reference":{"$ref":format!("#/$defs/{definition}")}
        }}});
        let value = json!({"ordinary":render(&vector["value"])});
        let registered = cfg::secret_text_values_with_schema(&value, &schema);
        let public = cfg::redact_with_schema(&value, &schema);
        if vector["reference"] == true {
            assert_eq!(public, value, "reference vector {index}");
            assert!(
                registered.is_empty(),
                "reference vector {index} entered registry"
            );
        } else {
            assert_ne!(public, value, "literal vector {index} was disclosed");
            assert!(
                !registered.is_empty(),
                "literal vector {index} missed registry"
            );
        }
        let warnings = cfg::reference_warnings_with_schema(&value, &schema);
        assert_eq!(
            !warnings.is_empty(),
            vector["warning"] == true,
            "warning vector {index}"
        );
        for warning in warnings {
            assert_eq!(warning.key, "ordinary");
            assert_eq!(
                warning.message,
                "Reference looks like a pasted key; use a secret-store reference name."
            );
        }
    }
}

#[test]
fn reference_paths_preserve_complete_values_and_escape_dynamic_keys() {
    let schema = json!({"properties":{
        "map":{"type":"object","additionalProperties":{"type":"string","x-sensitive":true,"x-secret-reference":true}},
        "list":{"type":"array","items":{"type":"string","x-sensitive":true,"x-secret-reference":true}}
    }});
    let pasted = format!("sk-{}", &canary()[..24]);
    let value = json!({"map":{"/~":"service.reference","literal":pasted},"list":["service.reference",pasted]});
    assert_eq!(
        cfg::reference_paths_with_schema(&value, &schema),
        ["/list/0", "/map/~1~0"]
    );
    let root: Value = serde_json::from_str(cfg::SCHEMA_JSON).unwrap();
    let engine = json!({"engine":{"embedding":{"apiKey":{"source":"store","provider":"fixture","id":"service.reference"}}}});
    assert_eq!(
        cfg::reference_paths_with_schema(&engine, &root),
        ["/engine/embedding/apiKey"]
    );
}

#[test]
fn store_and_environment_name_safety_requires_a_complete_match_without_trailing_controls() {
    for ending in ["\n", "\r", "\r\n", "\t", " "] {
        for kind in ["store-name", "env-name"] {
            let name = format!("REFERENCE_NAME{ending}");
            let schema = json!({"type":"string","x-sensitive":true,
                "x-secret-reference":true,"x-secret-reference-kind":kind});
            assert_eq!(cfg::redact_with_schema(&json!(name), &schema), "••••");
            assert_eq!(
                cfg::secret_text_values_with_schema(&json!(name), &schema),
                [name]
            );
        }
    }
}

#[test]
fn an_ordinary_marked_member_is_hidden_and_unmarked_names_and_types_are_preserved() {
    let secret = canary();
    let schema = json!({"properties": {
        "ordinary": {"type":"string", "x-sensitive":true},
        "password": {"type":"string"}, "maxTokens": {"type":"integer"}
    }});
    let value = json!({"ordinary":secret, "password":"public-label", "maxTokens":4096,
        "newerField":{"enabled":true}, "empty":[], "unset":null});
    let before = value.clone();
    let public = cfg::redact_with_schema(&value, &schema);
    assert_eq!(public["ordinary"], "••••");
    for key in ["password", "maxTokens", "newerField", "empty", "unset"] {
        assert_eq!(public[key], value[key]);
    }
    assert_eq!(value, before, "public views must not mutate runtime values");
}

#[test]
fn inherited_reference_map_and_array_policies_preserve_the_json_shape() {
    let secret = canary();
    let schema = json!({"properties": {
        "reference": {"type":"object", "x-sensitive":true},
        "headers": {"additionalProperties":{"type":"string", "x-sensitive":true}},
        "rows": {"items":{"properties": {
            "ordinary":{"type":"string", "x-sensitive":true}, "enabled":{"type":"boolean"}
        }}}
    }});
    let value = json!({"reference":{"source":"env", "id":secret},
        "headers":{"constructor":secret,"__proto__":secret},
        "rows":[{"ordinary":secret,"enabled":true}]});
    assert_eq!(
        cfg::redact_with_schema(&value, &schema),
        json!({
            "reference":{"source":"••••","id":"••••"},
            "headers":{"constructor":"••••","__proto__":"••••"},
            "rows":[{"ordinary":"••••","enabled":true}]
        })
    );
}

#[test]
fn every_endpoint_query_value_and_userinfo_is_hidden_without_hiding_hosts_or_paths() {
    let secret = canary();
    for prefix in [
        "https://",
        "https:",
        "https:/",
        "h\tttps://",
        "//",
        "  //",
        "\\\\",
    ] {
        let endpoint = format!("{prefix}{secret}:{secret}@relay.example.test/path?ordinary={secret}&ordinary={secret}#public");
        let masked = cfg::mask_url_credentials(&endpoint);
        assert!(!masked.contains(&secret));
        assert!(masked.contains("relay.example.test/path?ordinary=••••&ordinary=••••#public"));
    }
    for public in [
        "https://relay.example.test/default",
        "https://relay.example.test:443\\status@other.example/path",
        "https://relay.example.test:invalid\\status@other.example/path",
        "file:///folder@relay.example.test/path",
        "mailto:public@relay.example.test",
    ] {
        assert_eq!(cfg::mask_url_credentials(public), public);
    }
}

#[test]
fn endpoint_registration_keeps_literal_normalized_and_decoded_parts_and_never_the_endpoint() {
    let secret = canary();
    let raw = format!("{}\t{}", &secret[..18], &secret[18..]);
    let endpoint =
        format!("  //{raw}:{raw}@relay.example.test/path?ordinary={raw}&encoded=%41%42%43%25");
    let schema = json!({"properties":{"endpoint":{"type":"string","x-url-credentials":true}}});
    let values = cfg::secret_values_with_schema(&json!({"endpoint":endpoint}), &schema);
    for expected in [&raw, &secret, &"ABC%".to_string()] {
        assert!(
            values.contains(expected),
            "missing an extracted credential part"
        );
    }
    for public in [
        &endpoint,
        &"relay.example.test".to_string(),
        &"/path".to_string(),
    ] {
        assert!(
            !values.contains(public),
            "public endpoint material was registered"
        );
    }
}

#[test]
fn root_projection_and_registration_apply_engine_metadata_and_endpoint_array_items() {
    let secret = canary();
    let endpoint = format!("wss://relay.example.test/second?ordinary={secret}");
    let value = json!({
        "engine":{"embedding":{"apiKey":secret,"baseUrl":format!("https://relay.example.test/embed?ordinary={secret}")}},
        "channels":{"buzz":{"relays":[endpoint]}},
        "modelProfiles":{"primary":{"params":{"maxTokens":4096}}}, "unknown":{"newer":true}
    });
    assert_eq!(
        cfg::redact_config(&value),
        json!({
            "engine":{"embedding":{"apiKey":"••••","baseUrl":"https://relay.example.test/embed?ordinary=••••"}},
            "channels":{"buzz":{"relays":["wss://relay.example.test/second?ordinary=••••"]}},
            "modelProfiles":{"primary":{"params":{"maxTokens":4096}}}, "unknown":{"newer":true}
        })
    );
    let values = cfg::config_secret_values(&value);
    assert!(values.contains(&secret));
    assert!(!values.contains(&endpoint));
    let public: Value = json!({"voice":{"providers":{"elevenlabs":{"baseUrl":"https://relay.example.test/default"}}}});
    assert!(cfg::config_secret_values(&public).is_empty());
}

#[test]
fn malformed_secret_scalars_are_fixed_placeholders_and_are_registered_for_text_redaction() {
    let secret = u64::from_str_radix(&canary()[..8], 16).unwrap() + 100_000_000;
    let value = json!({"engine":{"embedding":{"apiKey":secret}}});
    let projected = cfg::redact_config(&value);
    assert_eq!(projected["engine"]["embedding"]["apiKey"], 0);
    assert!(projected["engine"]["embedding"]["apiKey"].is_number());
    assert!(cfg::config_secret_values(&value).contains(&secret.to_string()));
    assert_eq!(value["engine"]["embedding"]["apiKey"], secret);
    let schema = json!({"properties":{"ordinary":{"type":"string","x-sensitive":true},"enabled":{"type":"boolean"}}});
    assert_eq!(
        cfg::redact_with_schema(&json!({"ordinary":true,"enabled":true}), &schema),
        json!({"ordinary":false,"enabled":true})
    );
}

#[test]
fn malformed_homogeneous_collections_retain_their_shape_and_declared_secrecy() {
    let secrets = [canary(), canary(), canary()];
    let schema = json!({"properties":{
        "batch":{"type":"array","items":{"properties":{
            "ordinary":{"type":"string","x-sensitive":true},"enabled":{"type":"boolean"}
        }}},
        "secrets":{"type":"array","items":{"type":"string","x-sensitive":true}},
        "headers":{"type":"object","additionalProperties":{"type":"string","x-sensitive":true}}
    }});
    let value = json!({"batch":{"0":{"ordinary":secrets[0],"enabled":true}},
        "secrets":{"0":secrets[1]},"headers":[secrets[2]]});
    assert_eq!(
        cfg::redact_with_schema(&value, &schema),
        json!({
            "batch":{"0":{"ordinary":"••••","enabled":true}},"secrets":{"0":"••••"},"headers":["••••"]
        })
    );
    let registered = cfg::secret_values_with_schema(&value, &schema);
    for secret in secrets {
        assert!(registered.contains(&secret));
    }
}

#[test]
fn invalid_secret_values_are_not_interpolated_into_config_diagnostics() {
    let secret = canary();
    let mut value = cfg::defaults();
    value["voice"]["providers"]["elevenlabs"]["apiKeyRef"] = json!([secret]);
    let diagnostics = cfg::validate(&value).unwrap_err().join("\n");
    assert!(
        !diagnostics.contains(&secret),
        "a diagnostic printed a rejected secret value"
    );
    assert!(diagnostics.contains("/voice/providers/elevenlabs/apiKeyRef"));
    assert!(diagnostics.contains("string") || diagnostics.contains("type"));
}

#[test]
fn text_inventory_omits_declared_reference_names_and_complete_engine_reference_objects() {
    let name = format!("service.{}", &canary()[..12]);
    let provider = format!("public-{}", &canary()[..16]);
    let id = format!("credential_{}", &canary()[..12]);
    let environment = format!("FIXTURE_{}", canary().to_ascii_uppercase());
    for source in ["env", "store", "file", "exec"] {
        let configured = json!({
            "channels":{"telegram":{"tokenSecret":name}},
            "engine":{"embedding":{"apiKey":{"source":source,"provider":provider,"id":id},
                "apiKeyEnv":environment},"reranker":{"apiKey":"${COHERE_API_KEY}"}}
        });
        let inventory = cfg::config_secret_values(&configured);
        for reference in [
            &name,
            &provider,
            &id,
            &environment,
            &"${COHERE_API_KEY}".to_string(),
        ] {
            assert!(
                inventory.contains(reference),
                "the existing inventory API changed"
            );
        }
        assert!(
            cfg::config_text_secret_values(&configured).is_empty(),
            "reference provisioning metadata entered the text registry"
        );
        let projected = cfg::redact_config(&configured);
        assert_eq!(projected["channels"]["telegram"]["tokenSecret"], name);
        assert_eq!(
            projected["engine"]["embedding"]["apiKey"]["provider"],
            provider
        );
        assert_eq!(projected["engine"]["embedding"]["apiKey"]["id"], id);
    }
}

#[test]
fn text_inventory_applies_local_reference_metadata_to_unrelated_names_maps_and_arrays() {
    let reference = format!("handle/{}", canary());
    let literal = canary();
    let schema = json!({"$defs":{"reference":{"type":"string","pattern":"^handle/"}},"properties":{
        "ordinary":{"x-sensitive":true,"x-secret-reference":{"$ref":"#/$defs/reference"}},
        "batch":{"type":"array","items":{"x-sensitive":true,"x-secret-reference":{"$ref":"#/$defs/reference"}}},
        "map":{"type":"object","additionalProperties":{"x-sensitive":true,"x-secret-reference":{"$ref":"#/$defs/reference"}}},
        "literal":{"x-sensitive":true}
    }});
    let value = json!({"ordinary":reference,"batch":[reference,literal],"map":{"arbitrary":reference},"literal":literal});
    assert_eq!(
        cfg::secret_text_values_with_schema(&value, &schema),
        std::slice::from_ref(&literal)
    );
    assert!(cfg::secret_values_with_schema(&value, &schema).contains(&reference));
    let shared = json!({"ordinary":reference,"literal":reference});
    assert_eq!(
        cfg::secret_text_values_with_schema(&shared, &schema),
        [reference]
    );
}

#[test]
fn text_inventory_keeps_literal_and_every_url_component_even_when_values_equal_reference_names() {
    let shared = canary();
    let query = canary();
    let value = json!({
        "channels":{"telegram":{"tokenSecret":shared}},
        "engine":{"embedding":{"apiKey":shared}},
        "voice":{"providers":{"elevenlabs":{"baseUrl":format!("https://{shared}:{shared}@relay.example.test/public?ordinary={query}&decoded=%41%42%43")}}}
    });
    let registered = cfg::config_text_secret_values(&value);
    for secret in [&shared, &query, &"ABC".to_string()] {
        assert!(
            registered.contains(secret),
            "a non-reference context lost its protection"
        );
    }
    assert!(!registered.contains(&"relay.example.test".to_string()));
}

#[test]
fn malformed_or_nonmatching_reference_metadata_falls_back_to_literal_text_masking() {
    let literal = canary();
    for metadata in [
        json!(false),
        json!(null),
        json!({}),
        json!({"$ref":42}),
        json!({"$ref":"#/$defs/missing"}),
        json!({"$ref":"https://example.test/reference"}),
        json!({"$ref":"#/$defs/reference","extra":true}),
    ] {
        let schema = json!({"$defs":{"reference":{"type":"string"}},"properties":{
            "ordinary":{"x-sensitive":true,"x-secret-reference":metadata}
        }});
        assert_eq!(
            cfg::secret_text_values_with_schema(&json!({"ordinary":literal}), &schema),
            std::slice::from_ref(&literal)
        );
    }
    for value in [
        json!(literal),
        json!({"source":"unknown","provider":"fixture","id":literal}),
        json!({"source":"store","provider":"fixture","id":literal,"extra":literal}),
        json!([literal]),
    ] {
        assert!(
            cfg::config_text_secret_values(&json!({"engine":{"embedding":{"apiKey":value}}}))
                .contains(&literal),
            "a malformed Engine input was silently treated as a reference"
        );
    }
}

#[test]
fn text_reference_validation_never_retrieves_external_schema_resources() {
    let directory = tempfile::tempdir().unwrap();
    let resource = directory.path().join("external.json");
    std::fs::write(&resource, "{\"type\":\"string\"}").unwrap();
    let literal = format!("service.{}", &canary()[..12]);
    for external in [
        format!("file://{}", resource.display()),
        "https://example.test/reference".to_string(),
    ] {
        let schema = json!({"$defs":{"reference":{"$ref":external}},"properties":{
            "ordinary":{"x-sensitive":true,"x-secret-reference":{"$ref":"#/$defs/reference"}}
        }});
        assert_eq!(
            cfg::secret_text_values_with_schema(&json!({"ordinary":literal}), &schema),
            std::slice::from_ref(&literal),
            "external metadata must fall back to safe literal registration"
        );
    }
}

#[test]
fn direct_and_linked_string_references_remain_visible_without_an_extra_kind_tag() {
    let name = format!("service.{}", &canary()[..12]);
    for node in [
        json!({"type":"string","x-sensitive":true,"x-secret-reference":true}),
        json!({"x-sensitive":true,"x-secret-reference":{"$ref":"#/$defs/name"}}),
    ] {
        let schema = json!({"$defs":{"name":{"type":"string"}},"properties":{"ordinary":node}});
        let value = json!({"ordinary":name});
        assert_eq!(cfg::redact_with_schema(&value, &schema), value);
        assert!(cfg::secret_text_values_with_schema(&value, &schema).is_empty());
    }
    let schema = json!({"properties":{"ordinary":{"type":"string","x-sensitive":true,
        "x-secret-reference":true,"x-secret-reference-kind":"unknown"}}});
    assert_eq!(
        cfg::redact_with_schema(&json!({"ordinary":name}), &schema)["ordinary"],
        "••••"
    );
    assert!(
        cfg::secret_text_values_with_schema(&json!({"ordinary":name}), &schema).contains(&name)
    );
}

#[test]
fn pasted_reference_shapes_are_masked_registered_and_warned_without_echoing_values() {
    let seed = canary();
    let alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let offset = usize::from_str_radix(&seed[..2], 16).unwrap() % alphabet.len();
    let high_entropy: String = alphabet.chars().cycle().skip(offset).take(64).collect();
    let candidates = [
        format!("SK-{}", &seed[..24]),
        seed.clone(),
        format!("payload/{high_entropy}"),
        format!("oversize.{}", "a".repeat(100)),
    ];
    for pasted in candidates {
        for configured in [
            json!({"voice":{"providers":{"elevenlabs":{"apiKeyRef":pasted}}}}),
            json!({"auth":{"openai":{"federated":{"file":pasted}}}}),
        ] {
            assert!(!cfg::redact_config(&configured)
                .to_string()
                .contains(&pasted));
            assert!(cfg::config_text_secret_values(&configured).contains(&pasted));
            let warnings = cfg::config_reference_warnings(&configured);
            assert_eq!(warnings.len(), 1);
            assert!(warnings[0].message.contains("looks like a pasted key"));
            assert!(!format!("{warnings:?}").contains(&pasted));
        }
    }
    let ordinary = "a".repeat(64);
    let configured = json!({"channels":{"telegram":{"tokenSecret":ordinary}}});
    assert_eq!(
        cfg::redact_config(&configured),
        configured,
        "repeated ordinary names are not high-entropy tokens"
    );
    assert!(cfg::config_text_secret_values(&configured).is_empty());
}

#[test]
fn clear_file_paths_preserve_source_formats_while_bare_token_ids_stay_protected() {
    let path = format!("/tmp/reference path/{}", "ordinary-segment/".repeat(8));
    let configured = json!({"auth":{"openai":{"federated":{"file":path}}}});
    assert_eq!(cfg::redact_config(&configured), configured);
    assert!(cfg::config_text_secret_values(&configured).is_empty());
    assert!(cfg::config_reference_warnings(&configured).is_empty());
    for source in ["file", "exec"] {
        let configured = json!({"engine":{"embedding":{"apiKey":{"source":source,"provider":"fixture","id":path}}}});
        assert_eq!(cfg::redact_config(&configured), configured);
        assert!(cfg::config_text_secret_values(&configured).is_empty());
        let pasted = format!("ghp_{}", &canary()[..24]);
        let configured = json!({"engine":{"embedding":{"apiKey":{"source":source,"provider":"fixture","id":pasted}}}});
        assert!(!cfg::redact_config(&configured)
            .to_string()
            .contains(&pasted));
        assert!(cfg::config_text_secret_values(&configured).contains(&pasted));
        assert_eq!(cfg::config_reference_warnings(&configured).len(), 1);
    }
}
