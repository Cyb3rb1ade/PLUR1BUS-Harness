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
