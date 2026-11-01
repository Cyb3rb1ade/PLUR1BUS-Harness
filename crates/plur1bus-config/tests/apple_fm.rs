use plur1bus_config::{
    defaults, model_assignment_errors, restart_class_of, set, validate, RestartClass,
};
use serde_json::json;

#[test]
fn managed_switch_is_live_and_reserved_configuration_is_refused() {
    assert_eq!(defaults()["appleFm"]["enabled"], false);
    assert_eq!(restart_class_of("appleFm.enabled"), RestartClass::Live);
    let mut config = defaults();
    config["providers"]["apple-fm"] = json!({});
    assert!(validate(&config)
        .unwrap_err()
        .join(" ")
        .contains("reserved-provider-id"));
}

#[test]
fn agent_roles_and_unknown_apple_models_are_refused_offline() {
    for role in ["chat", "reasoning", "capture", "dream"] {
        for reference in ["apple-fm/system", "short"] {
            let mut config = defaults();
            config["modelProfiles"]["short"] = json!({"candidates":[{"model":"apple-fm/system"}]});
            config["modelRoles"][role] = json!(reference);
            assert!(validate(&config)
                .unwrap_err()
                .join(" ")
                .contains("4096 is below the 16384"));
        }
    }
    for model in ["apple-fm/pcc", "apple-fm/unknown"] {
        assert!(set(
            &defaults(),
            "decision.classProfiles.small",
            json!("apple-fm/system")
        )
        .is_err());
        assert!(set(&defaults(), "modelRoles.decision", json!(model)).is_err());
    }
    assert!(set(&defaults(), "modelRoles.decision", json!("apple-fm/system")).is_ok());
    assert!(set(
        &defaults(),
        "modelRoles.summarize",
        json!("apple-fm/system")
    )
    .is_ok());
}

#[test]
fn known_catalog_windows_are_checked_before_config_transactions_write() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("models.json");
    std::fs::write(
        &path,
        json!({"models":[{"provider":"fixture","id":"small","contextWindow":8192}]}).to_string(),
    )
    .unwrap();
    let before = defaults();
    let after = set(&before, "modelRoles.chat", json!("fixture/small"))
        .unwrap()
        .after;
    let errors = model_assignment_errors(&before, &after, &path);
    assert!(errors.join(" ").contains("8192 is below the 16384"));
    let short = set(&before, "modelRoles.decision", json!("fixture/small"))
        .unwrap()
        .after;
    assert!(model_assignment_errors(&before, &short, &path).is_empty());
    std::fs::write(&path, "invalid catalog").unwrap();
    assert!(model_assignment_errors(&before, &after, &path).is_empty());
    let mut managed = before.clone();
    managed["modelRoles"]["chat"] = json!("apple-fm/system");
    assert!(model_assignment_errors(&before, &managed, &path)
        .join(" ")
        .contains("context-too-small"));
    // A broken catalog cannot prevent unrelated configuration repair.
    assert!(model_assignment_errors(&before, &before, &path).is_empty());
}
