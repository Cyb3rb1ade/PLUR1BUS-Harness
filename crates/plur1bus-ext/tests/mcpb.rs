//! MCPB/DXT normalization contracts: upstream versions, framing, setup metadata and explicit environment (M-A9).
use plur1bus_ext::manifest::Kind;
use plur1bus_ext::mcpb::{
    check_mcpb_runtime, check_mcpb_tree, normalise_mcpb, parse_mcpb_manifest, resolve_mcp_config,
    McpbContext, SignatureStatus,
};
use plur1bus_ext::refusal::reason;
use plur1bus_ext::zipaudit::{audit_zip, read_entry, Limits};
use serde_json::{json, Value};
use std::io::{Cursor, Write};

const CREATED: &str = "2026-10-28T12:00:00Z";

fn manifest(version: &str, runtime: &str) -> Value {
    json!({
        "manifest_version": version, "name": "demo-server", "version": "1.2.3",
        "description": "A demo server", "author": {"name":"Example"}, "license":"MIT",
        "server": {"type": runtime, "entry_point":"server/main.js", "mcp_config": {
            "command": if runtime == "node" {"node"} else if runtime == "binary" {"${__dirname}/server/main.js"} else {"uv"},
            "args":["${__dirname}/server/main.js"], "env": {"DEMO":"value"}
        }}
    })
}

fn context() -> McpbContext {
    McpbContext {
        platform: "linux".into(),
        extension_dir: "/extensions/demo-server".into(),
        path_separator: "/".into(),
        system_dirs: [
            ("HOME".into(), "/home/demo".into()),
            ("DOCUMENTS".into(), "/home/demo/Documents".into()),
        ]
        .into(),
        ..Default::default()
    }
}

fn archive(m: &Value, extra: &[(&str, &[u8])]) -> Vec<u8> {
    let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    w.start_file("manifest.json", options).unwrap();
    w.write_all(&serde_json::to_vec(m).unwrap()).unwrap();
    w.start_file("server/main.js", options).unwrap();
    w.write_all(b"console.log('demo');").unwrap();
    for (name, bytes) in extra {
        w.start_file(*name, options).unwrap();
        w.write_all(bytes).unwrap();
    }
    w.finish().unwrap().into_inner()
}

fn normalize(bytes: &[u8]) -> (plur1bus_ext::mcpb::McpbReport, Vec<u8>) {
    let mut output = Cursor::new(Vec::new());
    let report = normalise_mcpb(
        &mut Cursor::new(bytes),
        &context(),
        &Limits::default(),
        CREATED,
        &mut output,
    )
    .unwrap();
    (report, output.into_inner())
}

fn signed(mut bytes: Vec<u8>) -> Vec<u8> {
    // Minimal DER ContentInfo/signedData envelope: structural fixture, never a valid cryptographic signature.
    let der = b"\x30\x0f\x06\x09\x2a\x86\x48\x86\xf7\x0d\x01\x07\x02\xa0\x02\x30\x00";
    bytes.extend_from_slice(b"MCPB_SIG_V1");
    bytes.extend_from_slice(&(der.len() as u32).to_le_bytes());
    bytes.extend_from_slice(der);
    bytes.extend_from_slice(b"MCPB_SIG_END");
    bytes
}

#[test]
fn all_manifest_versions_and_dxt_alias_normalize_to_disabled_unsigned_packages() {
    for version in ["0.1", "0.2", "0.3", "0.4"] {
        for alias in [false, true] {
            let mut m = manifest(version, "node");
            if alias {
                m["dxt_version"] = m
                    .as_object_mut()
                    .unwrap()
                    .remove("manifest_version")
                    .unwrap();
            }
            let (report, bytes) = normalize(&archive(&m, &[]));
            assert_eq!(report.manifest.kind, Kind::McpServer);
            assert_eq!(report.manifest.requires["runtime"]["type"], "node");
            assert!(!report.manifest.default_enabled);
            assert_eq!(report.signature, SignatureStatus::Unsigned);
            let audited = audit_zip(&mut Cursor::new(bytes), &Limits::default()).unwrap();
            assert!(audited
                .entries
                .iter()
                .any(|e| e.name == "payload/manifest.json"));
            assert!(!audited.entries.iter().any(|e| e.name.ends_with(".minisig")));
        }
    }
}

#[test]
fn each_schema_is_closed_at_nested_boundaries_and_version_specific() {
    for pointer in [
        "/unexpected",
        "/author/unexpected",
        "/server/unexpected",
        "/server/mcp_config/unexpected",
    ] {
        let mut m = manifest("0.4", "node");
        let (parent, key) = pointer.rsplit_once('/').unwrap();
        let object = if parent.is_empty() {
            &mut m
        } else {
            m.pointer_mut(parent).unwrap()
        };
        object[key] = json!(true);
        assert_eq!(
            parse_mcpb_manifest(&serde_json::to_vec(&m).unwrap())
                .unwrap_err()
                .reason,
            reason::PACKAGE_INVALID
        );
    }
    let mut m = manifest("0.1", "node");
    m["privacy_policies"] = json!(["https://example.test/privacy"]);
    assert!(parse_mcpb_manifest(&serde_json::to_vec(&m).unwrap()).is_err());
    m["manifest_version"] = json!("0.2");
    assert!(parse_mcpb_manifest(&serde_json::to_vec(&m).unwrap()).is_ok());
    m["dxt_version"] = json!("0.1");
    assert!(parse_mcpb_manifest(&serde_json::to_vec(&m).unwrap()).is_err());
}

#[test]
fn uv_requires_version_four_pyproject_and_no_bundled_python_environment() {
    let mut m = manifest("0.4", "uv");
    let (report, _) = normalize(&archive(
        &m,
        &[("pyproject.toml", b"[project]\nname='demo'\n")],
    ));
    assert_eq!(report.manifest.requires["runtime"]["type"], "python");
    assert_eq!(report.manifest.requires["runtime"]["via"], "uv");
    for bad in [
        archive(&m, &[]),
        archive(&m, &[("pyproject.toml", b"x"), ("server/lib/a.py", b"x")]),
        archive(
            &m,
            &[("pyproject.toml", b"x"), ("server/venv/bin/python", b"x")],
        ),
    ] {
        assert!(normalise_mcpb(
            &mut Cursor::new(bad),
            &context(),
            &Limits::default(),
            CREATED,
            &mut Cursor::new(Vec::new())
        )
        .is_err());
    }
    m["manifest_version"] = json!("0.3");
    assert!(parse_mcpb_manifest(&serde_json::to_vec(&m).unwrap()).is_err());
    m["manifest_version"] = json!("0.4");
    m["server"].as_object_mut().unwrap().remove("mcp_config");
    assert!(parse_mcpb_manifest(&serde_json::to_vec(&m).unwrap()).is_err());
}

#[test]
fn signature_framing_is_removed_with_an_explicit_unverified_disclosure() {
    let (report, bytes) = normalize(&signed(archive(&manifest("0.4", "node"), &[])));
    assert_eq!(report.signature, SignatureStatus::NotChecked);
    assert!(report
        .warnings
        .iter()
        .any(|w| w.contains("signature not checked")));
    assert!(!bytes.windows(11).any(|s| s == b"MCPB_SIG_V1"));
}

#[test]
fn malformed_signature_and_zip_tampering_refuse_without_output() {
    let source = archive(&manifest("0.4", "node"), &[]);
    let valid = signed(source.clone());
    let mut appended = valid.clone();
    appended.push(0);
    let mut wrong_length = valid.clone();
    wrong_length[source.len() + b"MCPB_SIG_V1".len()] ^= 1;
    let mut corrupt_zip = valid.clone();
    corrupt_zip[43] ^= 1;
    let mut corrupt_der = valid.clone();
    corrupt_der[source.len() + b"MCPB_SIG_V1".len() + 4] = 0x31;
    for (bad, expected) in [
        (appended, reason::SIGNATURE_INVALID),
        (wrong_length, reason::SIGNATURE_INVALID),
        (corrupt_zip, reason::DIGEST),
        (corrupt_der, reason::SIGNATURE_INVALID),
    ] {
        let mut out = Cursor::new(Vec::new());
        assert_eq!(
            normalise_mcpb(
                &mut Cursor::new(bad),
                &context(),
                &Limits::default(),
                CREATED,
                &mut out
            )
            .unwrap_err()
            .reason,
            expected
        );
        assert!(out.into_inner().is_empty());
    }
}

#[test]
fn path_variables_platform_overrides_and_array_expansion_use_only_context() {
    let mut m = manifest("0.4", "node");
    m["user_config"] = json!({"folders":{"type":"directory","title":"Folders","description":"Locations","multiple":true,"default":["/one","/two"]},
        "count":{"type":"number","title":"Count","description":"Count","default":3,"min":1,"max":9},
        "flag":{"type":"boolean","title":"Flag","description":"Flag","default":false}});
    m["server"]["mcp_config"]["platform_overrides"] = json!({"linux":{"args":["${user_config.folders}","${HOME}${/}test","${DOCUMENTS}","${user_config.count}","${user_config.flag}"],"env":{"ONLY":"linux"}}});
    let parsed = parse_mcpb_manifest(&serde_json::to_vec(&m).unwrap()).unwrap();
    let config = resolve_mcp_config(&parsed, &context()).unwrap();
    assert_eq!(
        config["args"],
        json!([
            "/one",
            "/two",
            "/home/demo/test",
            "/home/demo/Documents",
            "3",
            "false"
        ])
    );
    assert_eq!(config["env"], json!({"ONLY":"linux"}));
    assert!(config.get("platform_overrides").is_none());
}

#[test]
fn sensitive_slots_remain_unresolved_and_are_never_serialized_as_defaults() {
    let mut m = manifest("0.4", "node");
    m["user_config"] = json!({"api_key":{"type":"string","title":"API key","description":"Key","required":true,"sensitive":true,"default":"DO-NOT-LEAK"},
        "file":{"type":"file","title":"File","description":"A path","required":true}});
    m["server"]["mcp_config"]["env"] = json!({"API_KEY":"${user_config.api_key}"});
    let (report, bytes) = normalize(&archive(&m, &[]));
    assert!(report.config.contains_key("file"));
    assert!(!report.config.contains_key("api_key"));
    assert_eq!(
        report.manifest.capabilities["secrets"][0]["slot"],
        "api_key"
    );
    assert_eq!(
        report.mcp_config["env"]["API_KEY"],
        "${user_config.api_key}"
    );
    assert!(report.needs_setup.contains(&"api_key".into()));
    assert!(report.needs_setup.contains(&"file".into()));
    let mut source = Cursor::new(bytes);
    let audited = audit_zip(&mut source, &Limits::default()).unwrap();
    for entry in &audited.entries {
        assert!(
            !read_entry(&mut source, entry, Limits::default().entry_bytes)
                .unwrap()
                .windows(11)
                .any(|w| w == b"DO-NOT-LEAK")
        );
    }
}

#[test]
fn user_values_obey_declared_types_multiple_and_bounds_without_leaking_values() {
    let mut m = manifest("0.4", "node");
    m["user_config"] =
        json!({"count":{"type":"number","title":"Count","description":"Count","min":1,"max":3}});
    let parsed = parse_mcpb_manifest(&serde_json::to_vec(&m).unwrap()).unwrap();
    for value in [json!(0), json!(4), json!("PRIVATE-VALUE"), json!([2])] {
        let mut ctx = context();
        ctx.user_config.insert("count".into(), value);
        let error = resolve_mcp_config(&parsed, &ctx).unwrap_err();
        assert!(!error.detail.contains("PRIVATE-VALUE"));
    }
    let mut ctx = context();
    ctx.user_config.insert("undeclared".into(), json!(2));
    assert!(resolve_mcp_config(&parsed, &ctx).is_err());
}

#[test]
fn unknown_variables_and_array_interpolation_are_refused() {
    for arg in ["${UNKNOWN}", "${HOME", "prefix-${user_config.folders}"] {
        let mut m = manifest("0.4", "node");
        m["user_config"] = json!({"folders":{"type":"directory","title":"Folders","description":"Folders","multiple":true,"default":["a"]}});
        m["server"]["mcp_config"]["args"] = json!([arg]);
        let parsed = parse_mcpb_manifest(&serde_json::to_vec(&m).unwrap()).unwrap();
        assert!(resolve_mcp_config(&parsed, &context()).is_err(), "{arg}");
    }
}

#[test]
fn system_directory_variables_cannot_supply_user_config_or_override_reserved_context() {
    let mut m = manifest("0.4", "node");
    m["user_config"] = json!({"secret":{"type":"string","title":"Secret","description":"Secret","sensitive":true}});
    m["server"]["mcp_config"]["env"] = json!({"KEY":"${user_config.secret}"});
    let parsed = parse_mcpb_manifest(&serde_json::to_vec(&m).unwrap()).unwrap();
    for key in ["user_config.secret", "__dirname", "pathSeparator", "/"] {
        let mut ctx = context();
        ctx.system_dirs.insert(key.into(), "PRIVATE-VALUE".into());
        let error = resolve_mcp_config(&parsed, &ctx).unwrap_err();
        assert!(!error.detail.contains("PRIVATE-VALUE"));
    }
}

#[test]
fn sensitive_values_must_use_environment_slots_and_never_command_or_arguments() {
    for field in ["command", "args"] {
        let mut m = manifest("0.4", "node");
        m["user_config"] = json!({"secret":{"type":"string","title":"Secret","description":"Secret","sensitive":true}});
        m["server"]["mcp_config"][field] = if field == "args" {
            json!(["${user_config.secret}"])
        } else {
            json!("${user_config.secret}")
        };
        let parsed = parse_mcpb_manifest(&serde_json::to_vec(&m).unwrap()).unwrap();
        assert!(resolve_mcp_config(&parsed, &context()).is_err());
    }
}

#[test]
fn missing_required_values_and_optional_referenced_values_are_setup_requirements() {
    let mut m = manifest("0.4", "node");
    m["user_config"] =
        json!({"folder":{"type":"directory","title":"Folder","description":"Folder"}});
    m["server"]["mcp_config"]["args"] = json!(["${user_config.folder}"]);
    let (report, _) = normalize(&archive(&m, &[]));
    assert_eq!(report.needs_setup, ["folder"]);
    assert_eq!(report.mcp_config["args"], json!(["${user_config.folder}"]));
}

#[test]
fn windows_platform_selection_preserves_native_paths_and_replaces_whole_environment() {
    let mut m = manifest("0.3", "binary");
    m["server"]["mcp_config"]["platform_overrides"] = json!({"win32":{"command":"${__dirname}${pathSeparator}server${/}demo.exe","args":[],"env":{}}});
    let parsed = parse_mcpb_manifest(&serde_json::to_vec(&m).unwrap()).unwrap();
    let mut ctx = context();
    ctx.platform = "win32".into();
    ctx.extension_dir = "C:\\Extensions\\demo-server".into();
    ctx.path_separator = "\\".into();
    let config = resolve_mcp_config(&parsed, &ctx).unwrap();
    assert_eq!(
        config["command"],
        "C:\\Extensions\\demo-server\\server\\demo.exe"
    );
    assert_eq!(config["args"], json!([]));
    assert_eq!(config["env"], json!({}));
}

#[test]
fn local_runtime_types_preserve_the_source_requirement_ranges() {
    for (kind, required) in [("node", "node"), ("python", "python"), ("binary", "binary")] {
        let mut m = manifest("0.4", kind);
        m["compatibility"] = json!({"runtimes":{"node":">=20","python":">=3.10"}});
        let (report, _) = normalize(&archive(&m, &[]));
        assert_eq!(report.manifest.requires["runtime"]["type"], required);
        if kind != "binary" {
            assert_eq!(
                report.manifest.requires["runtime"]["range"],
                m["compatibility"]["runtimes"][kind]
            );
        }
    }
}

#[test]
fn setup_defaults_are_typed_and_numeric_bounds_are_ordered() {
    for declaration in [
        json!({"type":"number","title":"Count","description":"Count","default":0,"min":1}),
        json!({"type":"number","title":"Count","description":"Count","min":3,"max":1}),
        json!({"type":"boolean","title":"Flag","description":"Flag","default":"false"}),
        json!({"type":"file","title":"Files","description":"Files","multiple":true,"default":"one"}),
        json!({"type":"string","title":"Text","description":"Text","default":["one"]}),
    ] {
        let mut m = manifest("0.4", "node");
        m["user_config"] = json!({"value":declaration});
        assert!(parse_mcpb_manifest(&serde_json::to_vec(&m).unwrap()).is_err());
    }
}

#[test]
fn undeclared_sensitive_context_values_are_refused_without_reflecting_the_value() {
    let mut m = manifest("0.4", "node");
    m["user_config"] = json!({"secret":{"type":"string","title":"Secret","description":"Secret","sensitive":true}});
    let parsed = parse_mcpb_manifest(&serde_json::to_vec(&m).unwrap()).unwrap();
    let mut ctx = context();
    ctx.user_config
        .insert("secret".into(), json!("PRIVATE-VALUE"));
    let error = resolve_mcp_config(&parsed, &ctx).unwrap_err();
    assert!(!error.detail.contains("PRIVATE-VALUE"));
}

#[test]
fn archive_and_manifest_limits_are_applied_before_any_output() {
    let source = archive(&manifest("0.4", "node"), &[]);
    for limits in [
        Limits {
            package_bytes: 16,
            ..Limits::default()
        },
        Limits {
            manifest_bytes: 16,
            ..Limits::default()
        },
        Limits {
            max_entries: 1,
            ..Limits::default()
        },
        Limits {
            entry_bytes: 16,
            ..Limits::default()
        },
    ] {
        let mut out = Cursor::new(Vec::new());
        assert_eq!(
            normalise_mcpb(
                &mut Cursor::new(&source),
                &context(),
                &limits,
                CREATED,
                &mut out
            )
            .unwrap_err()
            .reason,
            reason::TOO_LARGE
        );
        assert!(out.into_inner().is_empty());
    }
}

#[test]
fn source_metadata_is_preserved_and_prompts_are_disclosed_as_not_activated() {
    let mut m = manifest("0.4", "node");
    m["prompts"] = json!([{"name":"prompt","text":"Text"}]);
    m["_meta"] = json!({"example.test":{"value":true}});
    m["tools"] = json!([{"name":"write_file"}]);
    let (report, bytes) = normalize(&archive(&m, &[]));
    assert_eq!(report.manifest.capabilities["tools"][0]["effect"], "write");
    assert!(report
        .warnings
        .iter()
        .any(|w| w.contains("prompts") && w.contains("not activated")));
    let mut input = Cursor::new(bytes);
    let audit = audit_zip(&mut input, &Limits::default()).unwrap();
    let entry = audit
        .entries
        .iter()
        .find(|e| e.name == "payload/manifest.json")
        .unwrap();
    let retained: Value =
        serde_json::from_slice(&read_entry(&mut input, entry, 1 << 20).unwrap()).unwrap();
    assert_eq!(retained["_meta"], m["_meta"]);
}

#[test]
fn variable_replacement_is_literal_and_does_not_recursively_expand_user_values() {
    let mut m = manifest("0.4", "node");
    m["user_config"] = json!({"text":{"type":"string","title":"Text","description":"Text","default":"$&-${HOME}"}});
    m["server"]["mcp_config"]["args"] = json!(["${user_config.text}"]);
    let parsed = parse_mcpb_manifest(&serde_json::to_vec(&m).unwrap()).unwrap();
    assert_eq!(
        resolve_mcp_config(&parsed, &context()).unwrap()["args"],
        json!(["$&-${HOME}"])
    );
}

#[test]
fn arbitrary_source_config_keys_get_unique_secret_aliases_in_hashed_host_metadata() {
    let mut m = manifest("0.1", "node");
    let declaration =
        json!({"type":"string","title":"Secret","description":"Secret","sensitive":true});
    m["user_config"] = json!({"api-key":declaration,"api_key":declaration,"api.key":declaration,"API key":declaration});
    m["user_config"]["x".repeat(150)] = declaration;
    m["server"]["mcp_config"]["env"] =
        json!({"KEY":"${user_config.api-key}","OTHER":"${user_config.api.key}"});
    let (report, bytes) = normalize(&archive(&m, &[]));
    let slots: std::collections::BTreeSet<_> = report.secret_slots.values().collect();
    assert_eq!(slots.len(), 5);
    assert_eq!(report.secret_slots["api_key"], "api_key");
    for slot in slots {
        assert!(slot.len() <= 64 && slot.starts_with(|c: char| c.is_ascii_alphabetic()));
        assert!(slot.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_'));
    }
    let (again, _) = normalize(&archive(&m, &[]));
    assert_eq!(again.secret_slots, report.secret_slots);
    assert_eq!(report.mcp_config["env"]["KEY"], "${user_config.api-key}");
    let mut input = Cursor::new(bytes);
    let audit = audit_zip(&mut input, &Limits::default()).unwrap();
    let entry = audit
        .entries
        .iter()
        .find(|e| e.name == "payload/.plur1bus/mcpb.json")
        .unwrap();
    assert!(report.manifest.files.contains_key(&entry.name));
    let metadata: Value =
        serde_json::from_slice(&read_entry(&mut input, entry, 1 << 20).unwrap()).unwrap();
    assert_eq!(
        metadata["secretSlots"],
        serde_json::to_value(&report.secret_slots).unwrap()
    );
}

#[test]
fn runtime_and_tree_checks_are_reusable_by_the_p1x_staging_boundary() {
    for (kind, required) in [
        ("node", "node"),
        ("python", "python"),
        ("binary", "binary"),
        ("uv", "python"),
    ] {
        let m = parse_mcpb_manifest(&serde_json::to_vec(&manifest("0.4", kind)).unwrap()).unwrap();
        let requires = json!({"runtime":{"type":required,"range":">=0.0.0","via":"uv"}});
        check_mcpb_runtime(&m, &requires).unwrap();
        assert!(check_mcpb_runtime(&m, &json!({"runtime":{"type":"none"}})).is_err());
        check_mcpb_tree(&m, &["manifest.json", "server/main.js", "pyproject.toml"]).unwrap();
        assert!(check_mcpb_tree(&m, &["manifest.json"]).is_err());
        if kind == "uv" {
            assert!(check_mcpb_runtime(&m, &json!({"runtime":{"type":"python"}})).is_err());
            assert!(check_mcpb_tree(&m, &["manifest.json", "server/main.js"]).is_err());
            assert!(check_mcpb_tree(
                &m,
                &[
                    "manifest.json",
                    "server/main.js",
                    "pyproject.toml",
                    "server/lib/a.py"
                ]
            )
            .is_err());
        }
    }
}

#[test]
fn a_large_repeated_environment_expansion_stops_at_the_configuration_budget() {
    let mut m = manifest("0.4", "node");
    m["server"]["mcp_config"]["env"] = json!({"A":"${HOME}","B":"${HOME}","C":"${HOME}"});
    let parsed = parse_mcpb_manifest(&serde_json::to_vec(&m).unwrap()).unwrap();
    let mut ctx = context();
    ctx.system_dirs.insert("HOME".into(), "x".repeat(1 << 20));
    assert_eq!(
        resolve_mcp_config(&parsed, &ctx).unwrap_err().reason,
        reason::TOO_LARGE
    );
}

#[test]
fn normalized_payload_retains_templates_for_the_authenticated_runtime_directory() {
    let m = manifest("0.4", "node");
    let (report, bytes) = normalize(&archive(&m, &[]));
    assert_eq!(
        report.mcp_config["args"],
        json!(["/extensions/demo-server/server/main.js"])
    );
    let mut input = Cursor::new(bytes);
    let audit = audit_zip(&mut input, &Limits::default()).unwrap();
    let entry = audit
        .entries
        .iter()
        .find(|e| e.name == "payload/manifest.json")
        .unwrap();
    let source: Value =
        serde_json::from_slice(&read_entry(&mut input, entry, 1 << 20).unwrap()).unwrap();
    assert_eq!(source["server"]["mcp_config"], m["server"]["mcp_config"]);
}

#[test]
fn worker_context_port_uses_the_final_normalized_package_directory() {
    let mut m = manifest("0.4", "node");
    m["name"] = json!("Example_Server");
    let bytes = archive(&m, &[]);
    let mut output = Cursor::new(Vec::new());
    let report = plur1bus_ext::mcpb::normalise_mcpb_with_context(
        &mut Cursor::new(bytes),
        |name| {
            let mut ctx = context();
            ctx.extension_dir = format!("/extensions/packages/{name}");
            Ok(ctx)
        },
        &Limits::default(),
        CREATED,
        &mut output,
    )
    .unwrap();
    assert_eq!(report.manifest.name, "example-server");
    assert_eq!(
        report.mcp_config["args"],
        json!(["/extensions/packages/example-server/server/main.js"])
    );
}
