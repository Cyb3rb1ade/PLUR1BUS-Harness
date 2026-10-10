//! `read_for_lookup`: the cheap read for CLI paths that only look up agents (and, for `memory add|recall`, four numeric budgets).
//! A file that fails the structural check is validated in full and reports the schema errors; one that passes is returned as is.
use plur1bus_config as cfg;
use serde_json::json;

fn read(doc: serde_json::Value, keys: &[&str]) -> Result<serde_json::Value, cfg::ConfigError> {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("config.json");
    std::fs::write(&p, doc.to_string()).unwrap();
    cfg::read_for_lookup(&p, keys)
}
fn invalid(r: Result<serde_json::Value, cfg::ConfigError>) -> Vec<String> {
    match r {
        Err(cfg::ConfigError::Invalid(e)) => e,
        other => panic!("expected Invalid, got {other:?}"),
    }
}

#[test]
fn a_well_formed_file_passes_and_a_missing_one_is_the_defaults() {
    let v = read(
        json!({"schemaVersion":1,"agents":{"bernd":{},"a_b-1":{"displayName":"B"}}}),
        &[],
    )
    .unwrap();
    assert!(v["agents"]["bernd"].is_object());
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        cfg::read_for_lookup(&dir.path().join("none.json"), &[]).unwrap(),
        cfg::defaults()
    );
}

#[test]
fn structural_deviations_report_schema_errors() {
    assert!(!invalid(read(json!({"schemaVersion":"x","agents":{}}), &[])).is_empty());
    assert!(!invalid(read(json!({"schemaVersion":2}), &[])).is_empty());
    assert!(
        !invalid(read(json!({"schemaVersion":1,"nope":true}), &[])).is_empty(),
        "unknown top-level key"
    );
    assert!(!invalid(read(json!({"schemaVersion":1,"agents":[]}), &[])).is_empty());
    assert!(
        !invalid(read(json!({"schemaVersion":1,"agents":{"Bernd":{}}}), &[])).is_empty(),
        "agent id pattern"
    );
    assert!(!invalid(read(json!({"schemaVersion":1,"agents":{"bernd":5}}), &[])).is_empty());
    assert!(
        !invalid(read(
            json!({"schemaVersion":1,"agents":{"bernd":{"bogus":1}}}),
            &[]
        ))
        .is_empty(),
        "unknown agent key"
    );
    assert!(!invalid(read(json!([1]), &[])).is_empty());
}

#[test]
fn the_requested_numeric_keys_are_checked_against_the_schema() {
    let k = ["/core/recall/softBudgetMs", "/core/capture/waitMs"];
    read(
        json!({"schemaVersion":1,"core":{"recall":{"softBudgetMs":400}}}),
        &k,
    )
    .unwrap();
    read(json!({"schemaVersion":1}), &k).unwrap(); // absent: the default applies
    assert!(
        !invalid(read(
            json!({"schemaVersion":1,"core":{"recall":{"softBudgetMs":5}}}),
            &k
        ))
        .is_empty(),
        "below minimum"
    );
    assert!(
        !invalid(read(
            json!({"schemaVersion":1,"core":{"recall":{"softBudgetMs":"400"}}}),
            &k
        ))
        .is_empty(),
        "wrong type"
    );
    assert!(
        !invalid(read(
            json!({"schemaVersion":1,"core":{"capture":{"waitMs":1.5}}}),
            &k
        ))
        .is_empty(),
        "not an integer"
    );
    // Not requested, so not looked at: documented limitation, these reach the core, which validates its own file.
    read(
        json!({"schemaVersion":1,"core":{"recall":{"softBudgetMs":5}}}),
        &[],
    )
    .unwrap();
    read(json!({"schemaVersion":1,"core":{"unknownNested":1}}), &[]).unwrap();
}
