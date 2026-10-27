#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use plur1bus_engine::config::{self, profiles, Tier};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};

fn repository_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn recordings(folder: &str) -> Vec<(PathBuf, Value)> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/config")
        .join(folder);
    let mut paths = fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    paths.sort();
    paths
        .into_iter()
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .map(|path| {
            let value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            (path, value)
        })
        .collect()
}

#[test]
fn every_recorded_configuration_gets_the_same_verdict() {
    for folder in ["valid", "invalid"] {
        let cases = recordings(folder);
        assert_eq!(cases.len(), 30, "{folder}: require all Node vectors");
        for (path, case) in cases {
            let supplied = case["config"].clone();
            let verdict = config::validate(&supplied);
            assert_eq!(
                verdict.is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}: {verdict:?}",
                path.display()
            );
            if let Ok(config) = &verdict {
                assert_eq!(serde_json::to_value(config).unwrap(), config::normalize(&supplied).unwrap(), "{}: generated config must retain normalized supplied values without adding defaults", path.display());
            }
            if let Err(errors) = verdict {
                let paths = errors
                    .iter()
                    .map(|error| Value::String(error.path.clone()))
                    .collect::<Vec<_>>();
                assert_eq!(Value::Array(paths), case["errors"], "{}", path.display());
                assert!(errors.iter().all(|error| !error.message.is_empty()));
            }
            assert_eq!(supplied, case["config"], "validation mutates no input");
        }
    }
}

#[test]
fn normalized_and_effective_outputs_match_node() {
    for (path, case) in recordings("effective") {
        let raw = &case["args"][0];
        let actual = match case["operation"].as_str().unwrap() {
            "validatePluginConfig" => config::normalize(raw).unwrap(),
            "resolveEffectiveConfig" => config::effective_config(raw).unwrap(),
            "manifestConfigDefaults" => config::manifest_defaults(),
            "engineSchemaRuntimeDefaults" => json!({"deferPostTurnLlm": false}),
            other => panic!("unhandled operation {other}"),
        };
        assert_eq!(actual, case["output"], "{}", path.display());
    }
}

#[test]
fn every_recorded_pure_setup_operation_matches_node() {
    for (path, case) in recordings("setup") {
        let args = case["args"].as_array().unwrap();
        let empty = json!({});
        let arg = |index| args.get(index).unwrap_or(&empty);
        let actual = match case["operation"].as_str().unwrap() {
            "safeProfile" => profiles::safe_profile().unwrap(),
            "recommendedProfile" => profiles::recommended_profile().unwrap(),
            "fullExperienceDefaults" => profiles::full_experience_defaults().unwrap(),
            "customProfileFromSelection" => {
                profiles::custom_profile_from_selection(arg(0)).unwrap()
            }
            "applyFeatureProfile" => {
                profiles::apply_feature_profile(arg(0), arg(1), arg(2)).unwrap()
            }
            "normalizePluginEntryCompatibility" => {
                profiles::normalize_plugin_entry_compatibility(arg(0), arg(1)).unwrap()
            }
            "listCoreFeatures" => profiles::list_core_features(),
            "detectMissingCoreFeatures" => profiles::detect_missing_core_features(arg(0)),
            "applyFullExperiencePolicy" => profiles::apply_full_experience_policy(arg(0)).unwrap(),
            "detectPendingFeatures" => profiles::detect_pending_features(arg(0), arg(1)),
            "isApplyBlocked" => profiles::is_apply_blocked(arg(0), arg(1)),
            "describeProfileDiff" => profiles::describe_profile_diff(arg(0), arg(1)),
            "summarizeFullExperienceStatus" => profiles::summarize_full_experience_status(arg(0)),
            "renderPlur1busStartStatus" => {
                Value::String(profiles::render_start_status(arg(0), arg(1)))
            }
            "reportDormantFeature" => profiles::dormant_feature_events(arg(0)),
            other => panic!("unhandled operation {other}"),
        };
        assert_eq!(actual, case["output"], "{}", path.display());
    }
}

#[test]
fn inline_jev_secret_points_to_the_secret_store() {
    let errors =
        config::validate(&json!({"captureChunkingJev": {"apiKey": "placeholder"}})).unwrap_err();
    assert_eq!(errors[0].path, "captureChunkingJev.apiKey");
    assert!(errors[0]
        .message
        .to_ascii_lowercase()
        .contains("secret store"));
}

#[test]
fn validation_preserves_supplied_values_without_defaults() {
    let raw = json!({"runtime": {"traceRegistrations": true}, "reranker": {}});
    assert_eq!(config::normalize(&raw).unwrap(), raw);
    assert_eq!(config::normalize(&json!({})).unwrap(), json!({}));
    for raw in [
        json!({}),
        json!({"timezone":null,"featuresConfirmedAt":null}),
        json!({"styleDirective":{"timezone":null}}),
    ] {
        assert_eq!(
            serde_json::to_value(config::validate(&raw).unwrap()).unwrap(),
            raw
        );
    }
    assert_eq!(
        config::effective_config(&json!({})).unwrap()["runtime"]["deferPostTurnLlm"],
        true
    );
}

#[test]
fn tiers_follow_the_nearest_annotated_harness_ancestor() {
    for key in [
        "privacy.localOnly",
        "agents.agent-a.persona",
        "modelRoles.fast",
    ] {
        assert_eq!(config::tier_of(key), Tier::Basic, "{key}");
    }
    for key in [
        "engine.runtime.recallTimeoutMs",
        "engine.schicht15.maxPromotionsPerRun",
        "engine.recall.candidateTopK",
        "unknown.future",
    ] {
        assert_eq!(config::tier_of(key), Tier::Advanced, "{key}");
    }
}

#[test]
fn timezone_aliases_case_and_offsets_match_node() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/config/timezones/identifiers.json");
    let recorded: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(recorded["nodeVersion"], "24.21.0");
    for timezone in recorded["canonical"]
        .as_array()
        .unwrap()
        .iter()
        .chain(recorded["acceptedAliases"].as_array().unwrap())
    {
        assert!(
            config::validate(&json!({"timezone":timezone})).is_ok(),
            "{timezone}"
        );
        let lower = timezone.as_str().unwrap().to_ascii_lowercase();
        assert!(
            config::validate(&json!({"timezone":lower})).is_ok(),
            "{lower}"
        );
    }
    for timezone in recorded["rejected"].as_array().unwrap() {
        assert_eq!(
            config::validate(&json!({"timezone":timezone})).unwrap_err()[0].path,
            "timezone",
            "{timezone}"
        );
    }
}

#[test]
fn node_integer_accepts_integral_json_number_spelling() {
    let raw: Value = serde_json::from_str(r#"{"embedding":{"dimensions":1.0}}"#).unwrap();
    assert!(config::validate(&raw).is_ok());
    assert!(config::validate(&json!({"embedding":{"dimensions":1.5}})).is_err());
}

#[test]
fn top_level_feature_object_override_matches_node_rejection() {
    for selection in [
        json!({"autoCapture":{}}),
        json!({"autoRecall":{"enabled":true}}),
    ] {
        let errors = profiles::custom_profile_from_selection(&selection).unwrap_err();
        assert_eq!(errors[0].path, "undefined");
    }
}

#[test]
fn custom_selection_models_the_legacy_prototype_setter_without_mutation() {
    let expected = profiles::custom_profile_from_selection(&json!({})).unwrap();
    for value in [
        Value::Null,
        json!(true),
        json!(false),
        json!(0),
        json!(1),
        json!("x"),
        json!(""),
    ] {
        assert_eq!(
            profiles::custom_profile_from_selection(&json!({"__proto__":value})).unwrap(),
            expected
        );
    }
    for value in [json!({}), json!([])] {
        let errors =
            profiles::custom_profile_from_selection(&json!({"__proto__":value})).unwrap_err();
        assert_eq!(errors[0].path, "");
    }
    assert_eq!(
        config::validate(&json!({"__proto__":true})).unwrap_err()[0].path,
        "__proto__"
    );
}

fn remove_descriptions(value: &mut Value) {
    if let Some(object) = value.as_object_mut() {
        object.remove("description");
        for child in object.values_mut() {
            remove_descriptions(child);
        }
    } else if let Some(array) = value.as_array_mut() {
        for child in array {
            remove_descriptions(child);
        }
    }
}

#[test]
fn the_copied_config_schema_equals_the_pinned_engines() {
    let installed = repository_root().join("packages/core/node_modules/@cyb3rb1ade/plur1bus-memory/engine/config/engine-config.schema.json");
    let bytes =
        fs::read(installed).expect("run pnpm test:prep (the engine package is not installed)");
    let mut original: Value = serde_json::from_slice(&bytes).unwrap();
    let mut copied: Value = serde_json::from_str(config::SCHEMA_JSON).unwrap();
    remove_descriptions(&mut original);
    remove_descriptions(&mut copied);
    assert_eq!(copied, original);
}

#[test]
fn documented_runtime_drift_stays_explicit() {
    let source: Value = serde_json::from_str(config::SCHEMA_JSON).unwrap();
    let ledger_path = repository_root().join("crates/plur1bus-engine/schema/DRIFT.json");
    let ledger: Value = serde_json::from_slice(&fs::read(ledger_path).unwrap()).unwrap();
    let issues = ledger["issues"].as_array().unwrap();
    for issue in issues {
        if let Some(pointer) = issue["schemaPointer"].as_str() {
            if issue["schemaExpectedAbsent"] == true {
                assert!(
                    source.pointer(pointer).is_none(),
                    "source schema gained {}, reconcile runtime overlay and drift ledger",
                    issue["path"]
                );
            } else if issue.get("schemaValue").is_some() {
                assert_eq!(
                    source.pointer(pointer),
                    issue.get("schemaValue"),
                    "{} drift assumption changed",
                    issue["id"]
                );
            }
        }
    }
    assert!(issues
        .iter()
        .any(|issue| issue["id"] == "runtime-trace-registrations"));
    assert!(source["properties"]["runtime"]["properties"]
        .get("traceRegistrations")
        .is_none());
    assert!(source["properties"].get("groupReasoningFilter").is_none());
    assert_eq!(
        source["properties"]["runtime"]["properties"]["deferPostTurnLlm"]["default"],
        false
    );
    let defaults = config::manifest_defaults();
    assert_eq!(defaults["runtime"]["deferPostTurnLlm"], true);
    assert_eq!(defaults["runtime"]["traceRegistrations"], false);
    assert_eq!(defaults["groupReasoningFilter"]["enabled"], true);
}
