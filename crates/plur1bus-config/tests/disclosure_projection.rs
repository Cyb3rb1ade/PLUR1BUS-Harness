//! Hand-authored language-neutral disclosure expectations, with credentials created only at runtime.
use plur1bus_config as cfg;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn canary() -> String {
    let directory = tempfile::tempdir().unwrap();
    Sha256::digest(directory.path().to_string_lossy().as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn replace(value: &Value, canary: &str) -> Value {
    match value {
        Value::String(text) => json!(text
            .replace("$CANARY", canary)
            .replace("$ARCHIVE_MASK", "ARCHIVE_MASK")),
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| replace(item, canary)).collect())
        }
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, value)| (key.clone(), replace(value, canary)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

#[test]
fn shared_display_and_text_vectors() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../packages/config-schema/test/fixtures/disclosure-projection.json"
    ))
    .unwrap();
    let harness: Value = serde_json::from_str(cfg::SCHEMA_JSON).unwrap();
    for case in vectors["cases"].as_array().unwrap() {
        let secret = canary();
        let schema = if case["schema"] == "harness" {
            &harness
        } else {
            &case["schema"]
        };
        let value = replace(&case["value"], &secret);
        assert_eq!(
            cfg::redact_with_schema(&value, schema),
            replace(&case["expectedDisplay"], &secret),
            "{}",
            case["name"]
        );
        let (archive, _) = cfg::placeholder_with_schema(&value, schema, "ARCHIVE_MASK").unwrap();
        assert_eq!(
            archive,
            replace(&case["expectedBackup"], &secret),
            "{} archive",
            case["name"]
        );
        let registered = cfg::secret_text_values_with_schema(&value, schema);
        for part in case["registered"].as_array().unwrap() {
            assert!(
                registered
                    .iter()
                    .any(|value| value == replace(part, &secret).as_str().unwrap()),
                "{} must register {part}",
                case["name"]
            );
        }
        for part in case["notRegistered"].as_array().unwrap() {
            assert!(
                !registered
                    .iter()
                    .any(|value| value == replace(part, &secret).as_str().unwrap()),
                "{} registered public material",
                case["name"]
            );
        }
    }
}

#[test]
fn unknown_string_shapes_stay_private_but_scalars_and_typed_maps_stay_public() {
    let secret = canary();
    let schema = json!({"properties": {
        "open": {"type":"object", "additionalProperties":{}},
        "list": {"type":"array", "items":true},
        "labels":{"type":"object", "additionalProperties":{"type":"string"}}
    }});
    let value = json!({"open":secret,"list":secret,"labels":{"region":"public-region"},"unknown":{"count":9,"enabled":true,"nested":[secret]}});
    assert_eq!(
        cfg::redact_with_schema(&value, &schema),
        json!({"open":"••••","list":"••••","labels":{"region":"public-region"},"unknown":{"count":9,"enabled":true,"nested":["••••"]}})
    );
}

#[test]
fn invalid_reference_syntax_warns_even_for_short_values() {
    let schema = json!({"type":"string","x-secret-reference":true});
    for invalid in ["bad name", "?", "prefixless literal", "x\n"] {
        let warnings = cfg::reference_warnings_with_schema(&json!(invalid), &schema);
        assert_eq!(warnings.len(), 1, "{invalid:?}");
        assert!(!format!("{warnings:?}").contains(invalid));
    }
}

#[test]
fn argument_and_environment_parts_never_register_whole_urls_or_source_paths() {
    let secret = canary();
    let uri =
        format!("https://public-user:{secret}@public.example/path?token={secret}&region=us-east-1");
    let argument = format!("--endpoint={uri}");
    let schema = json!({"properties":{
        "args":{"type":"array","items":{"type":"string","x-sensitive":true},"x-text-credentials":"parts"},
        "env":{"type":"object","x-sensitive":true,"additionalProperties":{"type":"string"},"x-text-credentials":"parts"}
    }});
    let configured = json!({"args":[argument,"--token-file=/home/example/project/key","--api-key",secret],
        "env":{"TOKEN_URL":uri,"TOKEN_FILE":"/home/example/project/key","REGION":"us-east-1"}});
    let registered = cfg::secret_text_values_with_schema(&configured, &schema);
    assert_eq!(registered, [secret]);
    for text in [
        uri.as_str(),
        argument.as_str(),
        "/home/example/project/key",
        "public-user",
        "us-east-1",
    ] {
        assert!(!registered.iter().any(|value| value == text));
    }
}

#[test]
fn credential_query_and_fragment_names_use_boundaries_and_oauth_aliases() {
    let schema = json!({"type":"string","x-url-credentials":true});
    let credential = format!("private-{}", &canary()[..8]);
    let oauth = format!("oauth-{}", &canary()[..8]);
    for name in [
        "key",
        "auth",
        "sig",
        "clientSecret",
        "access_token",
        "code_verifier",
        "csrf",
        "ticket",
        "sessionKey",
        "accountKey",
    ] {
        let value = json!(format!("https://public.example/path?{name}={credential}&monkey=public-value#code={oauth}&design=public-heading"));
        let registered = cfg::secret_text_values_with_schema(&value, &schema);
        assert!(
            registered.contains(&credential),
            "credential name {name} was missed"
        );
        assert!(registered.contains(&oauth));
        assert!(!registered.contains(&"public-value".to_owned()));
        assert!(!registered.contains(&"public-heading".to_owned()));
    }
}

#[test]
fn an_already_redacted_url_keeps_reentry_guidance_in_later_archives() {
    let schema = json!({"type":"string","x-url-credentials":true});
    let value = json!("https://REDACTED@public.example/path?region=REDACTED#REDACTED");
    let (projected, keys) = cfg::placeholder_with_schema(&value, &schema, "ARCHIVE_MASK").unwrap();
    assert_eq!(projected, value);
    assert_eq!(keys, [""]);
}

#[test]
fn unknown_views_mask_strings_but_text_registration_selects_credentials_only() {
    let token = format!("sk-{}", canary());
    let credential = format!("private-value-{}", &canary()[..12]);
    let configured = json!({"engine":{"newPublicLabel":"us-east-1","opaque":token},
        "providers":{"unlisted":{"model":"/home/project","apiKey":credential}},
        "unknown":{"nested":["public-label","long-directory/public-directory/file"]}});
    let view = cfg::redact_config(&configured);
    assert_eq!(view["engine"]["newPublicLabel"], "••••");
    assert_eq!(view["providers"]["unlisted"]["model"], "••••");
    let registered = cfg::config_text_secret_values(&configured);
    assert!(registered.contains(&token));
    assert!(registered.contains(&credential));
    for public in [
        "us-east-1",
        "/home/project",
        "public-label",
        "long-directory/public-directory/file",
    ] {
        assert!(
            !registered.iter().any(|value| value == public),
            "public unknown value entered global text registry: {public}"
        );
    }
}

#[test]
fn relative_paths_and_long_low_entropy_labels_never_become_global_tokens() {
    let path = format!("{}file", "long-directory/".repeat(12));
    let label = "public-label".repeat(12);
    let schema = json!({"type":"array","items":{"type":"string","x-sensitive":true},"x-text-credentials":"parts"});
    let configured = json!([path, label, "--token-file", path]);
    assert!(cfg::secret_text_values_with_schema(&configured, &schema).is_empty());
}

#[test]
fn every_mixed_fragment_segment_is_masked_in_both_projections() {
    let secret = canary();
    let schema = json!({"type":"string","x-url-credentials":true});
    let configured = json!(format!(
        "https://public.example/path?region=public#{}&section&name={secret}",
        secret
    ));
    assert_eq!(
        cfg::redact_with_schema(&configured, &schema),
        "https://public.example/path?region=••••#••••&••••&name=••••"
    );
    let (archive, _) = cfg::placeholder_with_schema(&configured, &schema, "ARCHIVE_MASK").unwrap();
    assert_eq!(
        archive,
        "https://public.example/path?region=REDACTED#REDACTED&REDACTED&name=REDACTED"
    );
}

#[test]
fn a_reference_marker_never_exempts_url_credentials_from_the_text_registry() {
    let schema = json!({"type":"string","x-url-credentials":true,"x-secret-reference":true,"x-secret-reference-kind":"file-path"});
    let credential = format!("private-{}", &canary()[..8]);
    let configured = json!(format!(
        "https://u:{credential}@h.test/path?token={credential}"
    ));
    let registered = cfg::secret_text_values_with_schema(&configured, &schema);
    assert_eq!(registered, [credential]);
    assert_eq!(
        cfg::redact_with_schema(&configured, &schema),
        "https://••••@h.test/path?token=••••"
    );
}

#[test]
fn local_public_references_keep_scalar_and_object_members_modeled() {
    let schema = json!({"type":"object","$defs":{
        "mode":{"type":"string","enum":["fast","quality"]},
        "settings":{"type":"object","properties":{"label":{"type":"string"},"mode":{"$ref":"#/$defs/mode"}}}
    },"properties":{"mode":{"$ref":"#/$defs/mode"},"settings":{"$ref":"#/$defs/settings"}}});
    let secret = canary();
    let configured = json!({"mode":"fast","settings":{"label":"public label","mode":"quality","unknown":secret}});
    assert_eq!(
        cfg::redact_with_schema(&configured, &schema),
        json!({"mode":"fast","settings":{"label":"public label","mode":"quality","unknown":"••••"}})
    );
    let (archive, _) = cfg::placeholder_with_schema(&configured, &schema, "ARCHIVE_MASK").unwrap();
    assert_eq!(
        archive,
        json!({"mode":"fast","settings":{"label":"public label","mode":"quality","unknown":"ARCHIVE_MASK"}})
    );
    assert_eq!(
        cfg::secret_text_values_with_schema(&configured, &schema),
        [secret]
    );
}

#[test]
fn malformed_argument_shapes_recurse_and_named_colon_passwords_remain_literals() {
    let secret = format!("ordinary:{}", &canary()[..8]);
    let schema = json!({"properties":{
        "args":{"type":"array","items":{"type":"string","x-sensitive":true},"x-text-credentials":"parts"},
        "env":{"type":"object","x-sensitive":true,"additionalProperties":{"type":"string"},"x-text-credentials":"parts"}
    }});
    let configured = json!({"args":[{"password":secret},"--password",secret],"env":{"nested":{"API_TOKEN":secret},"PASSWORD":secret}});
    assert_eq!(
        cfg::secret_text_values_with_schema(&configured, &schema),
        [secret]
    );
}

#[test]
fn referenced_privacy_is_conservative_and_reference_cycles_stay_private() {
    let secret = canary();
    let schema = json!({"$defs":{"private":{"type":"string","x-sensitive":true}},"properties":{
        "literal":{"$ref":"#/$defs/private","x-sensitive":false},"cycle":{"$ref":"#/properties/cycle"}
    }});
    let configured = json!({"literal":secret,"cycle":secret});
    assert_eq!(
        cfg::redact_with_schema(&configured, &schema),
        json!({"literal":"••••","cycle":"••••"})
    );
    let (archive, _) = cfg::placeholder_with_schema(&configured, &schema, "ARCHIVE_MASK").unwrap();
    assert_eq!(
        archive,
        json!({"literal":"ARCHIVE_MASK","cycle":"ARCHIVE_MASK"})
    );
}

#[test]
fn text_tokens_with_base64_slashes_keep_entropy_protection() {
    let token = format!(
        "{}/+{}",
        (b'A'..=b'Z')
            .chain(b'a'..=b'z')
            .map(char::from)
            .collect::<String>(),
        (b'0'..=b'9').map(char::from).collect::<String>()
    );
    let schema = json!({"type":"array","items":{"type":"string","x-sensitive":true},"x-text-credentials":"parts"});
    assert_eq!(
        cfg::secret_text_values_with_schema(&json!([token]), &schema),
        [token]
    );
}

#[test]
fn referenced_privacy_cannot_be_weakened_by_value_schema_overlays() {
    let secret = canary();
    let schema = json!({"$defs":{"private":{"type":"string","x-sensitive":true}},"properties":{
        "literal":{"$ref":"#/$defs/private","x-value-schema":{"x-sensitive":false}}
    }});
    assert_eq!(
        cfg::redact_with_schema(&json!({"literal":secret}), &schema),
        json!({"literal":"••••"})
    );
}

#[test]
fn all_shared_capability_boundaries_match_before_module_installation() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../packages/config-schema/test/fixtures/disclosure-policies.json"
    ))
    .unwrap();
    for case in cases.as_array().unwrap() {
        assert_eq!(
            cfg::supports_config_disclosure_policy(&case["schema"]),
            case["supported"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
    }
}
