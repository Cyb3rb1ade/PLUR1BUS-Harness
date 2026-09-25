use plur1bus_config::{
    defaults, load, restart_class_of, set, validate, write_atomic, ConfigError, RestartClass,
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
