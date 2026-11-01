//! MM-3a static config validation also covers supervisor, offline CLI and setup writes.
use plur1bus_config::{defaults, set_many, validate};
use serde_json::json;

#[test]
fn local_catalog_is_checked_globally_and_after_agent_inheritance() {
    for invalid in [json!({"model":"unknown"}), json!({"dimensions":129})] {
        let mut cfg = defaults();
        cfg["memory"]["mediaEmbedding"]
            .as_object_mut()
            .unwrap()
            .extend(invalid.as_object().unwrap().clone());
        assert!(validate(&cfg).is_err());
        let mut cfg = defaults();
        cfg["agents"]["main"] = json!({"memory":{"mediaEmbedding":invalid}});
        assert!(validate(&cfg).is_err());
    }
    let mut cfg = defaults();
    cfg["memory"]["mediaEmbedding"]["enabled"] = json!(false);
    cfg["agents"]["main"] = json!({"memory":{"mediaEmbedding":{"enabled":true,"dimensions":256}}});
    assert!(validate(&cfg).is_ok());
}

#[test]
fn invalid_media_change_cannot_produce_a_write_plan_or_mutate_the_current_config() {
    let cfg = defaults();
    let before = cfg.clone();
    assert!(set_many(
        &cfg,
        &[("memory.mediaEmbedding.dimensions".into(), json!(129))]
    )
    .is_err());
    assert_eq!(cfg, before);
}

#[test]
fn relevant_media_writes_refuse_unknown_active_providers_but_legacy_loads_and_unrelated_changes_survive(
) {
    let mut cfg = defaults();
    cfg["memory"]["mediaEmbedding"]["provider"] = json!("unknown-remote");
    cfg["memory"]["mediaEmbedding"]["model"] = json!("unknown-model");
    cfg["memory"]["mediaEmbedding"]["privacyAck"] = json!({
        "provider":"unknown-remote", "acknowledgedAt":"2026-11-01T00:00:00Z", "by":"owner"
    });
    assert!(
        validate(&cfg).is_ok(),
        "legacy remote configuration stays readable"
    );
    assert!(set_many(&cfg, &[("core.logLevel".into(), json!("debug"))]).is_ok());
    assert!(set_many(&cfg, &[("agents.main.displayName".into(), json!("Main"))]).is_ok());
    let before = cfg.clone();
    for changes in [
        vec![("memory.mediaEmbedding.audio.maxSeconds".into(), json!(900))],
        vec![("privacy.localOnly".into(), json!(false))],
    ] {
        assert!(
            set_many(&cfg, &changes).is_err(),
            "active remote media cannot be saved"
        );
        assert_eq!(cfg, before);
    }
    cfg["memory"]["mediaEmbedding"]["enabled"] = json!(false);
    assert!(set_many(
        &cfg,
        &[("memory.mediaEmbedding.audio.maxSeconds".into(), json!(900))]
    )
    .is_ok());
    assert!(set_many(
        &cfg,
        &[(
            "agents.main.memory.mediaEmbedding.enabled".into(),
            json!(true)
        )]
    )
    .is_err());
}

#[test]
fn a_local_media_object_may_leave_optional_model_and_dimensions_to_the_schema_defaults() {
    assert!(set_many(
        &defaults(),
        &[("memory.mediaEmbedding".into(), json!({"provider":"local"}))]
    )
    .is_ok());
}
