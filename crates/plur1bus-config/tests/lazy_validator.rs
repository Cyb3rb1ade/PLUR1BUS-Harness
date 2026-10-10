//! Reading config.json for a fast-fail CLI path must not build the JSON-Schema validator (compiling the schema, after validating it
//! against the draft 2020-12 meta-schema, is the dominant start-up cost of the CLI in a debug build). One test in this file on purpose:
//! the validator is a process-wide `OnceLock`, so the test binary must not have built it for another reason first.
use plur1bus_config as cfg;
use std::fs;

#[test]
fn reading_without_validation_never_builds_the_validator_and_validating_paths_still_do() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("config.json");

    // Missing file: the defaults.
    assert_eq!(cfg::read_unvalidated(&p).unwrap(), cfg::defaults());
    assert!(
        !cfg::validator_built(),
        "defaults() must not need the validator"
    );

    // A document the schema rejects is still read: defaults filled, nothing checked.
    fs::write(
        &p,
        r#"{"schemaVersion":"not-a-number","agents":{"bernd":{}}}"#,
    )
    .unwrap();
    let v = cfg::read_unvalidated(&p).unwrap();
    assert_eq!(v["schemaVersion"], "not-a-number");
    assert!(v["agents"]["bernd"].is_object());
    assert!(
        v.get("core").is_some(),
        "schema defaults are filled in like the validating reader does"
    );
    assert!(
        !cfg::validator_built(),
        "an unvalidated read must not build the validator"
    );

    // Text that is not JSON is an error on every path.
    fs::write(&p, "{ not json").unwrap();
    assert!(matches!(
        cfg::read_unvalidated(&p),
        Err(cfg::ConfigError::NotJson(_))
    ));
    assert!(!cfg::validator_built());

    // The validating reader and the writers keep their guarantee.
    fs::write(&p, r#"{"schemaVersion":"not-a-number"}"#).unwrap();
    assert!(matches!(cfg::read(&p), Err(cfg::ConfigError::Invalid(_))));
    assert!(cfg::validator_built(), "read() builds it on first use");
}
