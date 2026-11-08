//! Ordinary archives apply installed configured module declarations without resolving their references.
use super::archive::{verify, visit};
use super::create::{create, testkit};
use super::manifest::redacted_config_keys;
use super::redact::PLACEHOLDER;
use super::restore::{restore, RestoreOpts};
use crate::paths::Layout;
use flate2::read::GzDecoder;
use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::Path;

fn install(layout: &Layout, schema: Value) {
    let directory = layout.home.join("modules/fixture");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("index.js"), "export {};\n").unwrap();
    fs::write(
        directory.join("module.json"),
        json!({
            "name":"fixture", "version":"0.1.0", "apiVersion":"1", "entry":"index.js",
            "scope":"installation", "priority":500, "configSchema":schema
        })
        .to_string(),
    )
    .unwrap();
}

fn module_schema() -> Value {
    json!({
        "type":"object", "$defs": {
            "name":{"type":"string"},
            "reference":{
                "x-secret-reference":true, "x-secret-reference-kind":"engine-input",
                "type":"object", "required":["source","provider","id"], "additionalProperties":false,
                "properties":{"source":{"const":"store"},"provider":{"const":"fixture"},"id":{"type":"string"}}
            }
        },
        "properties": {
            "ordinary":{"type":"string", "x-sensitive":true},
            "endpoint":{"type":"string", "x-url-credentials":true},
            "headers":{"type":"object", "additionalProperties":{"type":"string", "x-sensitive":true}},
            "publicHandle":{"type":"string", "x-sensitive":true, "x-secret-reference":{"$ref":"#/$defs/name"}},
            "structuredHandle":{"x-sensitive":true, "x-secret-reference":{"$ref":"#/$defs/reference"}},
            "maxTokens":{"type":"integer"}, "enabled":{"type":"boolean"}
        }
    })
}

fn config_in(archive: &Path) -> Value {
    let mut bytes = Vec::new();
    visit(archive, &mut |file, reader| {
        if file.path == "config.json" {
            reader.read_to_end(&mut bytes)?;
        }
        Ok(())
    })
    .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[test]
fn installed_module_literals_are_removed_and_prefixed_reference_data_round_trips() {
    let directory = tempfile::tempdir().unwrap();
    let layout = Layout::new(directory.path().join("source"));
    let snapshot = testkit::staged(&layout, b"database bytes", false);
    install(&layout, module_schema());
    let secret = uuid::Uuid::new_v4().to_string();
    let reference = uuid::Uuid::new_v4().to_string();
    let config = json!({"schemaVersion":1,"modules":{"fixture":{
        "enabled":false,"ordinary":secret,"headers":{"arbitrary":secret},
        "endpoint":format!("https://{secret}:{secret}@relay.example.test/module?ordinary={secret}&flag#public"),
        "publicHandle":reference,"structuredHandle":{"source":"store","provider":"fixture","id":reference},
        "maxTokens":4096
    }}});
    let original = config.to_string();
    fs::write(layout.home.join("config.json"), &original).unwrap();
    let archive = directory.path().join("module.tar.gz");
    create(&layout, &archive, &snapshot).unwrap();
    let mut all_bytes = Vec::new();
    GzDecoder::new(fs::File::open(&archive).unwrap())
        .read_to_end(&mut all_bytes)
        .unwrap();
    assert!(
        !all_bytes
            .windows(secret.len())
            .any(|bytes| bytes == secret.as_bytes()),
        "the archive exposed a module-declared literal"
    );
    let archived = config_in(&archive);
    assert_eq!(archived["modules"]["fixture"]["ordinary"], PLACEHOLDER);
    assert_eq!(
        archived["modules"]["fixture"]["headers"]["arbitrary"],
        PLACEHOLDER
    );
    assert_eq!(
        archived["modules"]["fixture"]["endpoint"],
        "https://REDACTED@relay.example.test/module?ordinary=REDACTED&flag#REDACTED"
    );
    assert_eq!(archived["modules"]["fixture"]["maxTokens"], 4096);
    let manifest = verify(&archive).unwrap();
    let expected = [
        "modules.fixture.endpoint",
        "modules.fixture.headers.arbitrary",
        "modules.fixture.ordinary",
    ];
    assert_eq!(
        redacted_config_keys(&manifest.secrets.note).unwrap(),
        expected
    );
    assert!(!manifest.secrets.note.contains(&secret));
    assert!(!manifest.secrets.note.contains(&reference));
    assert_eq!(
        fs::read_to_string(layout.home.join("config.json")).unwrap(),
        original
    );
    let destination = Layout::new(directory.path().join("destination"));
    fs::create_dir_all(&destination.home).unwrap();
    let report = restore(
        &destination,
        &archive,
        &RestoreOpts {
            force: false,
            dry_run: false,
            fail_at: None,
        },
    )
    .unwrap();
    assert_eq!(report.redacted_config_keys, expected);
    let restored: Value =
        serde_json::from_slice(&fs::read(destination.home.join("config.json")).unwrap()).unwrap();
    for document in [&archived, &restored] {
        for key in ["publicHandle", "structuredHandle"] {
            assert_eq!(
                serde_json::to_vec(&document["modules"]["fixture"][key]).unwrap(),
                serde_json::to_vec(&config["modules"]["fixture"][key]).unwrap(),
                "module references must preserve their data bytes"
            );
        }
    }
}

#[test]
fn unavailable_configured_installed_module_metadata_refuses_the_archive_without_leaking_values() {
    for problem in [
        "missing",
        "invalid",
        "unsupported",
        "reference-only",
        "registry",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let layout = Layout::new(directory.path().join("source"));
        let snapshot = testkit::staged(&layout, b"database bytes", false);
        install(&layout, module_schema());
        let secret = uuid::Uuid::new_v4().to_string();
        let original =
            json!({"schemaVersion":1,"modules":{"fixture":{"enabled":false,"ordinary":secret}}})
                .to_string();
        fs::write(layout.home.join("config.json"), &original).unwrap();
        let manifest = layout.home.join("modules/fixture/module.json");
        match problem {
            "missing" => fs::remove_file(manifest).unwrap(),
            "invalid" => fs::write(manifest, format!("invalid metadata {secret}")).unwrap(),
            "unsupported" => install(
                &layout,
                json!({"allOf":[{"properties":{"ordinary":{"x-sensitive":true}}}]}),
            ),
            "reference-only" => install(
                &layout,
                json!({"$defs":{"name":{"type":"string","x-secret-reference":true}},
                    "properties":{"ordinary":{"$ref":"#/$defs/name"}}}),
            ),
            "registry" => {
                fs::remove_dir_all(layout.home.join("modules")).unwrap();
                fs::write(layout.home.join("modules"), "unavailable registry").unwrap();
            }
            _ => unreachable!(),
        }
        let archive = directory.path().join("refused.tar.gz");
        let error = create(&layout, &archive, &snapshot)
            .err()
            .expect("unavailable module policy must refuse backup");
        assert_eq!(error.reason, "config-policy-invalid", "{problem}");
        assert!(
            !error.detail.contains(&secret),
            "module diagnostics exposed a configured value"
        );
        assert!(!archive.exists(), "a refused backup published an archive");
        assert_eq!(
            fs::read_to_string(layout.home.join("config.json")).unwrap(),
            original
        );
    }
}

#[test]
fn token_looking_reference_names_cannot_survive_an_ordinary_archive() {
    let directory = tempfile::tempdir().unwrap();
    let layout = Layout::new(directory.path().join("source"));
    let snapshot = testkit::staged(&layout, b"database bytes", false);
    let pasted = format!("sk-{}", uuid::Uuid::new_v4().simple());
    let name = format!(
        "service.{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    );
    let original = json!({"schemaVersion":1,"channels":{"telegram":{"tokenSecret":name}},
        "voice":{"providers":{"elevenlabs":{"apiKeyRef":pasted}}}})
    .to_string();
    fs::write(layout.home.join("config.json"), &original).unwrap();
    let archive = directory.path().join("reference-guard.tar.gz");
    create(&layout, &archive, &snapshot).unwrap();
    let archived = config_in(&archive);
    assert_eq!(archived["channels"]["telegram"]["tokenSecret"], name);
    assert_eq!(
        archived["voice"]["providers"]["elevenlabs"]["apiKeyRef"],
        PLACEHOLDER
    );
    let mut bytes = Vec::new();
    GzDecoder::new(fs::File::open(&archive).unwrap())
        .read_to_end(&mut bytes)
        .unwrap();
    assert!(!bytes
        .windows(pasted.len())
        .any(|bytes| bytes == pasted.as_bytes()));
    assert_eq!(
        redacted_config_keys(&verify(&archive).unwrap().secrets.note).unwrap(),
        ["voice.providers.elevenlabs.apiKeyRef"]
    );
    assert_eq!(
        fs::read_to_string(layout.home.join("config.json")).unwrap(),
        original
    );
    let destination = Layout::new(directory.path().join("destination"));
    fs::create_dir_all(&destination.home).unwrap();
    let report = restore(
        &destination,
        &archive,
        &RestoreOpts {
            force: false,
            dry_run: false,
            fail_at: None,
        },
    )
    .unwrap();
    assert_eq!(
        report.redacted_config_keys,
        ["voice.providers.elevenlabs.apiKeyRef"]
    );
    let restored: Value =
        serde_json::from_slice(&fs::read(destination.home.join("config.json")).unwrap()).unwrap();
    assert_eq!(restored["channels"]["telegram"]["tokenSecret"], name);
    assert_eq!(
        restored["voice"]["providers"]["elevenlabs"]["apiKeyRef"],
        PLACEHOLDER
    );
}

#[test]
fn reference_only_module_slots_preserve_names_and_remove_pasted_keys_with_restore_guidance() {
    let directory = tempfile::tempdir().unwrap();
    let layout = Layout::new(directory.path().join("source"));
    let snapshot = testkit::staged(&layout, b"database bytes", false);
    install(
        &layout,
        json!({"type":"object","$defs":{"name":{"type":"string"}},"properties":{
            "enabled":{"type":"boolean"},
            "directSafe":{"type":"string","x-secret-reference":true},
            "directPasted":{"type":"string","x-secret-reference":true},
            "linkedSafe":{"type":"string","x-secret-reference":{"$ref":"#/$defs/name"}},
            "linkedPasted":{"type":"string","x-secret-reference":{"$ref":"#/$defs/name"}},
            "ordinary":{"type":"string","x-sensitive":true},
            "inheritedKind":{"type":"string","x-secret-reference-kind":"env-name","x-value-schema":{"x-secret-reference":true}},
            "metadataSafe":{"type":"string","x-value-schema":{"type":"string","x-secret-reference":true}},
            "metadataPasted":{"type":"string","x-value-schema":{"type":"string","x-secret-reference":true}}
        }}),
    );
    let name = format!(
        "service.{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    );
    let pasted = format!("sk-{}", uuid::Uuid::new_v4().simple());
    let literal = uuid::Uuid::new_v4().to_string();
    let config = json!({"schemaVersion":1,"modules":{"fixture":{
        "enabled":false,"inheritedKind":"_FIXTURE_KEY","directSafe":name,"linkedSafe":name,"metadataSafe":name,"metadataPasted":pasted,
        "directPasted":pasted,"linkedPasted":pasted,"ordinary":literal
    }}});
    let original = config.to_string();
    fs::write(layout.home.join("config.json"), &original).unwrap();
    let archive = directory.path().join("reference-only.tar.gz");
    let policy = crate::config_redaction::ConfigDisclosurePolicy::load(&layout, &config).unwrap();
    let public = policy.project(&config);
    assert_eq!(
        public["modules"]["fixture"]["inheritedKind"],
        "_FIXTURE_KEY"
    );
    for key in ["directSafe", "linkedSafe", "metadataSafe"] {
        assert_eq!(public["modules"]["fixture"][key], name);
    }
    for key in ["directPasted", "linkedPasted", "metadataPasted", "ordinary"] {
        assert_eq!(public["modules"]["fixture"][key], "••••");
    }
    let registered = policy.secret_values(&config);
    assert!(!registered.iter().any(|value| value == "_FIXTURE_KEY"));
    assert!(registered.contains(&pasted) && registered.contains(&literal));
    assert!(!registered.contains(&name));
    let warnings = policy.reference_warnings(&config);
    assert_eq!(
        warnings
            .iter()
            .map(|warning| warning.key.as_str())
            .collect::<Vec<_>>(),
        [
            "modules.fixture.directPasted",
            "modules.fixture.linkedPasted",
            "modules.fixture.metadataPasted"
        ]
    );
    assert!(!format!("{warnings:?}").contains(&pasted));
    create(&layout, &archive, &snapshot).unwrap();
    let mut bytes = Vec::new();
    GzDecoder::new(fs::File::open(&archive).unwrap())
        .read_to_end(&mut bytes)
        .unwrap();
    for secret in [&pasted, &literal] {
        assert!(
            !bytes
                .windows(secret.len())
                .any(|bytes| bytes == secret.as_bytes()),
            "the archive exposed a reference-slot literal"
        );
    }
    let archived = config_in(&archive);
    assert_eq!(
        archived["modules"]["fixture"]["inheritedKind"],
        "_FIXTURE_KEY"
    );
    for key in ["directSafe", "linkedSafe", "metadataSafe"] {
        assert_eq!(archived["modules"]["fixture"][key], name);
    }
    for key in ["directPasted", "linkedPasted", "metadataPasted", "ordinary"] {
        assert_eq!(archived["modules"]["fixture"][key], PLACEHOLDER);
    }
    let expected = [
        "modules.fixture.directPasted",
        "modules.fixture.linkedPasted",
        "modules.fixture.metadataPasted",
        "modules.fixture.ordinary",
    ];
    assert_eq!(
        redacted_config_keys(&verify(&archive).unwrap().secrets.note).unwrap(),
        expected
    );
    let destination = Layout::new(directory.path().join("destination"));
    fs::create_dir_all(&destination.home).unwrap();
    let report = restore(
        &destination,
        &archive,
        &RestoreOpts {
            force: false,
            dry_run: false,
            fail_at: None,
        },
    )
    .unwrap();
    assert_eq!(report.redacted_config_keys, expected);
    let restored: Value =
        serde_json::from_slice(&fs::read(destination.home.join("config.json")).unwrap()).unwrap();
    assert_eq!(
        restored["modules"]["fixture"]["inheritedKind"],
        "_FIXTURE_KEY"
    );
    for key in ["directSafe", "linkedSafe", "metadataSafe"] {
        assert_eq!(restored["modules"]["fixture"][key], name);
    }
    assert_eq!(
        fs::read_to_string(layout.home.join("config.json")).unwrap(),
        original
    );
}

#[test]
fn uri_credentials_create_restore_and_validate_with_ascii_placeholders_and_reentry_keys() {
    let directory = tempfile::tempdir().unwrap();
    let layout = Layout::new(directory.path().join("source"));
    let snapshot = testkit::staged(&layout, b"database bytes", false);
    let schema = json!({"type":"object","properties":{
        "endpoint":{"type":"string","format":"uri","x-url-credentials":true},
        "reference":{"type":"string","x-secret-reference":true}
    }});
    install(&layout, schema.clone());
    let secret = uuid::Uuid::new_v4().simple().to_string();
    let uri = format!("https://public-user:{secret}@relay.example.test/public/path?token={secret}&region=us-east-1#password={secret}");
    let mut config = plur1bus_config::defaults();
    config["modules"]["fixture"] =
        json!({"enabled":false,"endpoint":uri,"reference":"curated-key"});
    config["channels"]["telegram"] = json!({"enabled":true,"tokenSecret":"telegram.bot","mode":"webhook",
        "webhook":{"url":uri,"secret":secret,"maxBodyBytes":2048}});
    config["privacy"]["localOnly"] = json!(false);
    plur1bus_config::validate(&config).unwrap();
    fs::write(layout.config_path(), config.to_string()).unwrap();
    let archive = directory.path().join("uri.tar.gz");
    create(&layout, &archive, &snapshot).unwrap();
    let archived = config_in(&archive);
    let expected = "https://REDACTED@relay.example.test/public/path?token=REDACTED&region=REDACTED#password=REDACTED";
    assert_eq!(archived["modules"]["fixture"]["endpoint"], expected);
    assert_eq!(archived["channels"]["telegram"]["webhook"]["url"], expected);
    plur1bus_config::validate(&archived).unwrap();
    let validator = jsonschema::options()
        .should_validate_formats(true)
        .build(&schema)
        .unwrap();
    assert!(validator.is_valid(&archived["modules"]["fixture"]));
    let destination = Layout::new(directory.path().join("restored"));
    fs::create_dir_all(&destination.home).unwrap();
    let report = restore(
        &destination,
        &archive,
        &RestoreOpts {
            force: false,
            dry_run: false,
            fail_at: None,
        },
    )
    .unwrap();
    assert!(report
        .redacted_config_keys
        .contains(&"modules.fixture.endpoint".to_owned()));
    assert!(report
        .redacted_config_keys
        .contains(&"channels.telegram.webhook.url".to_owned()));
    assert!(report
        .redacted_config_keys
        .contains(&"channels.telegram.webhook.secret".to_owned()));
    let restored: Value =
        serde_json::from_slice(&fs::read(destination.config_path()).unwrap()).unwrap();
    plur1bus_config::validate(&restored).unwrap();
    assert!(validator.is_valid(&restored["modules"]["fixture"]));
    assert_eq!(restored["modules"]["fixture"]["reference"], "curated-key");
    assert_eq!(restored["modules"]["fixture"]["endpoint"], expected);
    let regenerated = restored["channels"]["telegram"]["webhook"]["secret"]
        .as_str()
        .unwrap();
    assert_ne!(regenerated, secret);
    assert_ne!(regenerated, PLACEHOLDER);
    assert_eq!(regenerated.len(), 64);
}

#[test]
fn absent_and_schema_less_modules_are_archived_with_private_unknown_strings() {
    for installed in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let layout = Layout::new(directory.path().join("source"));
        let snapshot = testkit::staged(&layout, b"database bytes", false);
        if installed {
            install(&layout, json!({}));
            let path = layout.home.join("modules/fixture/module.json");
            let mut manifest: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            manifest.as_object_mut().unwrap().remove("configSchema");
            fs::write(path, manifest.to_string()).unwrap();
        }
        let secret = uuid::Uuid::new_v4().to_string();
        let config = json!({"schemaVersion":1,
            "providers":{"unlisted":{"apiKey":secret}},"oauth":{"opaque":{"clientSecret":secret}},
            "engine":{"unknown":secret},"voice":{"local":{"catalogOverride":{"opaque":secret}}},
            "modules":{"fixture":{"enabled":false,"literal":secret,"nested":[secret,7,true]}}
        });
        fs::write(layout.config_path(), config.to_string()).unwrap();
        let archive = directory.path().join("unknown.tar.gz");
        create(&layout, &archive, &snapshot).unwrap();
        let archived = config_in(&archive);
        assert!(!archived.to_string().contains(&secret));
        assert_eq!(archived["modules"]["fixture"]["enabled"], false);
        assert_eq!(
            archived["modules"]["fixture"]["nested"],
            json!([PLACEHOLDER, 7, true])
        );
        assert_eq!(archived["providers"]["unlisted"]["apiKey"], PLACEHOLDER);
        assert_eq!(archived["oauth"]["opaque"]["clientSecret"], PLACEHOLDER);
        assert_eq!(archived["engine"]["unknown"], PLACEHOLDER);
        assert_eq!(
            archived["voice"]["local"]["catalogOverride"]["opaque"],
            PLACEHOLDER
        );
    }
}
