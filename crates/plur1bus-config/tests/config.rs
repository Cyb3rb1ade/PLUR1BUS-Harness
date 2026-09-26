use plur1bus_config::{
    defaults, filter_config_by_tier, filter_schema_by_tier, load, restart_class_of, set, tier_of,
    validate, write_atomic, ConfigError, RestartClass, Tier,
};
use serde_json::{json, Value};
use std::fs;

fn ts_defaults() -> Value {
    serde_json::from_str(
        &fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/config-schema/fixtures/defaults.json"
        ))
        .unwrap(),
    )
    .unwrap()
}

fn ts_restart_plan_cases() -> Value {
    serde_json::from_str(
        &fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/config-schema/fixtures/restart-plan-cases.json"
        ))
        .unwrap(),
    )
    .unwrap()
}

fn ts_tier_cases() -> Value {
    serde_json::from_str(
        &fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/config-schema/fixtures/tier-cases.json"
        ))
        .unwrap(),
    )
    .unwrap()
}

#[test]
fn defaults_equal_the_typescript_fixture() {
    assert_eq!(defaults(), ts_defaults());
}

#[test]
fn load_creates_defaults_and_rejects_invalid() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("config.json");
    let l = load(&p).unwrap();
    assert!(l.created);
    assert_eq!(l.config, defaults());
    fs::write(
        &p,
        r#"{ "schemaVersion": 1, "core": { "logLevel": "loud" } }"#,
    )
    .unwrap();
    match load(&p) {
        Err(ConfigError::Invalid(errs)) => {
            assert!(errs.iter().any(|e| e.contains("logLevel")), "{errs:?}")
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(
        fs::read_to_string(&p).unwrap(),
        r#"{ "schemaVersion": 1, "core": { "logLevel": "loud" } }"#,
        "invalid file untouched"
    );
}

#[test]
fn restart_classes_match_the_schema() {
    assert_eq!(restart_class_of("core.logLevel"), RestartClass::Live);
    assert_eq!(restart_class_of("agents.bernd"), RestartClass::Live);
    assert_eq!(
        restart_class_of("engine.recallMinScore"),
        RestartClass::Core
    );
    assert_eq!(restart_class_of("embedding.useClass"), RestartClass::Core);
}

#[test]
fn set_produces_a_plan_and_refuses_bad_values() {
    let c = defaults();
    let plan = set(&c, "core.recall.softBudgetMs", json!(250)).unwrap();
    assert_eq!(plan.changed, vec!["core.recall.softBudgetMs"]);
    assert_eq!(plan.restart.live, vec!["core.recall.softBudgetMs"]);
    assert!(!plan.restart.core);
    assert_eq!(plan.after["core"]["recall"]["softBudgetMs"], 250);
    match set(&c, "core.recall.softBudgetMs", json!("abc")) {
        Err(ConfigError::Invalid(e)) => {
            assert!(e
                .iter()
                .any(|s| s.contains("softBudgetMs") || s.contains("integer")))
        }
        o => panic!("{o:?}"),
    }
    match set(&c, "nope.key", json!(1)) {
        Err(ConfigError::Invalid(_)) | Err(ConfigError::UnknownKey(_)) => {}
        o => panic!("{o:?}"),
    }
    let core_plan = set(&c, "engine.recallMinScore", json!(0.5)).unwrap();
    assert!(core_plan.restart.core);
    let agent_plan = set(
        &c,
        "agents.bernd",
        json!({ "createdAt": "2026-09-24T00:00:00Z" }),
    )
    .unwrap();
    assert_eq!(agent_plan.restart.live, vec!["agents.bernd"]);
}

#[test]
fn write_atomic_round_trips_and_validate_reports_paths() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("config.json");
    write_atomic(&p, &defaults()).unwrap();
    assert_eq!(load(&p).unwrap().config, defaults());
    assert!(validate(&json!({ "schemaVersion": 1, "bogus": 1 })).is_err());
}

/// R10 parity fix round 1: TS compares values via `JSON.stringify`, so `1` and `1.0` are equal
/// (JS has one numeric type). serde_json's derived `PartialEq` treats `Number::from(400)` and
/// `Number::from_f64(400.0)` as different, so a value that only changes numeric *representation*
/// (not numeric *value*) must not be reported as a change. This is a dedicated Rust-only unit test
/// rather than a JSON fixture case because JS/JSON cannot express `400.0` distinctly from `400` —
/// `JSON.stringify(400.0) === "400"` — so the TS side has no way to author this case at all.
#[test]
fn numeric_representation_only_is_not_a_change() {
    let before = json!({ "core": { "recall": { "softBudgetMs": 400 } } });
    let after = json!({ "core": { "recall": { "softBudgetMs": 400.0 } } });
    let plan = plur1bus_config::restart_plan(&before, &after);
    assert_eq!(
        plan.changed,
        Vec::<String>::new(),
        "400 vs 400.0 must not be reported as a change"
    );
    assert!(!plan.restart.core);
    assert!(plan.restart.live.is_empty());

    // A real numeric change (int vs int) must still be detected regardless of representation.
    let after2 = json!({ "core": { "recall": { "softBudgetMs": 401.0 } } });
    let plan2 = plur1bus_config::restart_plan(&before, &after2);
    assert_eq!(plan2.changed, vec!["core.recall.softBudgetMs"]);

    // Large integers must compare exactly (no f64 precision loss): 2^53 + 1 is not representable
    // exactly as f64, so an as_f64()-only comparison would wrongly call this unchanged.
    let big_before = json!({ "n": 9_007_199_254_740_993_i64 });
    let big_after = json!({ "n": 9_007_199_254_740_992_i64 });
    let big_plan = plur1bus_config::restart_plan(&big_before, &big_after);
    assert_eq!(
        big_plan.changed,
        vec!["n"],
        "large integers must compare exactly, not via f64"
    );
}

/// R10 parity: the Rust restart plan must equal the TS `restartPlan` result for every
/// committed case (live leaf, core-class, add/remove/rename an open-map entry, add to an
/// empty open map, two changes of different classes at once).
#[test]
fn restart_plan_matches_the_typescript_fixture_cases() {
    let cases = ts_restart_plan_cases();
    let cases = cases.as_array().expect("array of cases");
    assert!(
        cases.len() >= 7,
        "expected at least 7 cases, got {}",
        cases.len()
    );
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let before = case["before"].clone();
        let after = case["after"].clone();
        let expected = &case["expected"];
        let plan = plur1bus_config::restart_plan(&before, &after);
        assert_eq!(
            json!(plan.changed),
            expected["changed"],
            "case {name}: changed mismatch"
        );
        assert_eq!(
            plan.restart.live,
            expected["restart"]["live"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect::<Vec<_>>(),
            "case {name}: restart.live mismatch"
        );
        assert_eq!(
            plan.restart.core,
            expected["restart"]["core"].as_bool().unwrap(),
            "case {name}: restart.core mismatch"
        );
        assert_eq!(
            plan.restart.modules,
            expected["restart"]["modules"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect::<Vec<_>>(),
            "case {name}: restart.modules mismatch"
        );
    }
}

#[test]
fn date_time_format_matches_the_typescript_validator() {
    let cases: Value = serde_json::from_str(
        &fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/config-schema/fixtures/format-cases.json"
        ))
        .unwrap(),
    )
    .unwrap();
    let cases = cases.as_array().unwrap();
    assert!(cases.len() >= 20);
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let valid = c["valid"].as_bool().unwrap();
        assert_eq!(validate(&c["config"]).is_ok(), valid, "{name}");
    }
}

#[test]
fn set_rejects_a_created_at_that_is_not_a_date_time() {
    match set(
        &defaults(),
        "agents.bernd",
        json!({ "createdAt": "yesterday" }),
    ) {
        Err(ConfigError::Invalid(errs)) => {
            assert!(errs.iter().any(|e| e.contains("createdAt")), "{errs:?}")
        }
        other => panic!("expected Invalid, got {other:?}"),
    }
    assert!(set(
        &defaults(),
        "agents.bernd",
        json!({ "createdAt": "2026-09-24T00:00:00Z" })
    )
    .is_ok());
}

#[test]
fn tier_cases_match_the_typescript_fixture() {
    let fixture = ts_tier_cases();
    for case in fixture["cases"].as_array().unwrap() {
        let key = case["key"].as_str().unwrap();
        let expected = match case["tier"].as_str().unwrap() {
            "basic" => Tier::Basic,
            "advanced" => Tier::Advanced,
            other => panic!("unknown tier {other}"),
        };
        assert_eq!(tier_of(key), expected, "{key}");
    }
}

#[test]
fn filtered_schemas_match_the_typescript_fixture() {
    let fixture = ts_tier_cases();
    let schema: Value = serde_json::from_str(plur1bus_config::SCHEMA_JSON).unwrap();
    assert_eq!(
        filter_schema_by_tier(&schema, Tier::Basic),
        fixture["filtered"]["basic"]
    );
    assert_eq!(
        filter_schema_by_tier(&schema, Tier::Advanced),
        fixture["filtered"]["advanced"]
    );
}

#[test]
fn filter_config_by_tier_matches_ts_semantics() {
    let d = defaults();
    let advanced = filter_config_by_tier(&d, Tier::Advanced);
    assert!(advanced.get("agents").is_none());
    let basic = filter_config_by_tier(&d, Tier::Basic);
    assert!(basic.get("core").is_none());
    assert!(basic.get("agents").is_some());
}
