//! One validator for config.json: `validate` here is `validate` of `packages/config-schema` (`src/index.ts`), with the
//! cross-field rules the CLI and the supervisor used to leave to the core, in TypeScript's order and with its texts.
use plur1bus_config::{defaults, set, validate, validate_filled, ConfigError};
use serde_json::{json, Value};

fn only(verdict: Result<(), Vec<String>>) -> String {
    let errors = verdict.unwrap_err();
    assert_eq!(errors.len(), 1, "{errors:?}");
    errors[0].clone()
}

#[test]
fn the_soft_compaction_ratio_must_be_below_the_hard_one() {
    let mut cfg = defaults();
    let hard = cfg["session"]["compaction"]["hardRatio"].as_f64().unwrap();
    for soft in [hard, (hard + 1.0) / 2.0] {
        cfg["session"]["compaction"]["softRatio"] = json!(soft);
        assert_eq!(
            only(validate(&cfg)),
            "/session/compaction softRatio must be below hardRatio"
        );
    }
    cfg["session"]["compaction"]["softRatio"] = json!(hard / 2.0);
    assert_eq!(validate(&cfg), Ok(()));
    // The write path refuses it too: `config set` never stores a file the core would not start on.
    let Err(ConfigError::Invalid(errors)) = set(
        &defaults(),
        "session.compaction.softRatio",
        json!((hard + 1.0) / 2.0),
    ) else {
        panic!("a soft ratio above the hard one was accepted by set");
    };
    assert_eq!(
        errors,
        ["/session/compaction softRatio must be below hardRatio"]
    );
}

#[test]
fn only_the_first_failing_cross_field_rule_is_reported() {
    let mut cfg = defaults();
    let hard = cfg["session"]["compaction"]["hardRatio"].as_f64().unwrap();
    cfg["session"]["compaction"]["softRatio"] = json!(hard);
    cfg["core"]["recall"]["softBudgetMs"] = json!(900);
    cfg["core"]["recall"]["hardBudgetMs"] = json!(800);
    assert_eq!(
        only(validate(&cfg)),
        "/session/compaction softRatio must be below hardRatio"
    );
    cfg["session"]["compaction"]["softRatio"] = json!(hard / 2.0);
    assert_eq!(
        only(validate(&cfg)),
        "/core/recall softBudgetMs must not exceed hardBudgetMs"
    );
}

#[test]
fn the_voice_features_must_fit_the_voice_budget() {
    let mut cfg = defaults();
    cfg["voice"]["v3"]["budgetMs"] = json!(50);
    cfg["voice"]["v3"]["realtime"]["features"]["autoRecall"] = json!({"mode":"on","maxMs":50});
    assert_eq!(validate(&cfg), Ok(()));
    cfg["voice"]["v3"]["realtime"]["features"]["reranker"] = json!({"mode":"deferred","maxMs":10});
    assert_eq!(
        only(validate(&cfg)),
        "/voice/v3/realtime/features/reranker exceeds voice.v3.budgetMs (60 ms)"
    );
    // A feature that is off costs nothing.
    cfg["voice"]["v3"]["realtime"]["features"]["reranker"]["mode"] = json!("off");
    assert_eq!(validate(&cfg), Ok(()));
}

#[test]
fn reduced_is_a_mode_of_tool_schemas_alone() {
    let mut cfg = defaults();
    cfg["voice"]["v3"]["realtime"]["features"]["toolSchemas"]["mode"] = json!("reduced");
    assert_eq!(validate(&cfg), Ok(()));
    cfg["voice"]["v3"]["realtime"]["features"]["autoRecall"]["mode"] = json!("reduced");
    assert_eq!(
        only(validate(&cfg)),
        "/voice/v3/realtime/features/autoRecall reduced is only supported for toolSchemas"
    );
}

#[test]
fn a_missing_or_foreign_caption_acknowledgment_is_named_as_typescript_names_it() {
    let mut cfg = defaults();
    cfg["memory"]["mediaEmbedding"]["caption"]["provider"] = json!("openai");
    assert_eq!(
        only(validate(&cfg)),
        "/memory/mediaEmbedding/caption/privacyAck E_MEDIA_PRIVACY: privacy-acknowledgment-required"
    );
    cfg["memory"]["mediaEmbedding"]["caption"]["privacyAck"] =
        json!({"provider":"other","acknowledgedAt":"2026-10-14T10:00:00Z","by":"alice"});
    assert_eq!(
        only(validate(&cfg)),
        "/memory/mediaEmbedding/caption/privacyAck E_MEDIA_PRIVACY: privacy-acknowledgment-mismatch"
    );
    cfg["memory"]["mediaEmbedding"]["caption"]["privacyAck"]["provider"] = json!("openai");
    assert_eq!(validate(&cfg), Ok(()));
}

#[test]
fn the_validated_configuration_carries_the_defaults() {
    let mut cfg = defaults();
    let soft = cfg["session"]["compaction"]
        .as_object_mut()
        .unwrap()
        .remove("softRatio")
        .unwrap();
    let filled = validate_filled(&cfg).unwrap();
    assert_eq!(filled["session"]["compaction"]["softRatio"], soft);
    assert_eq!(filled, defaults());
}

/// Replaces boolean and number leaves by a string until `left` reaches zero: one type violation per leaf, each at its
/// own path.
fn spoil(value: &mut Value, left: &mut usize) {
    match value {
        Value::Bool(_) | Value::Number(_) if *left > 0 => {
            *value = json!("not this type");
            *left -= 1;
        }
        Value::Object(map) => map.values_mut().for_each(|v| spoil(v, left)),
        _ => {}
    }
}

#[test]
fn the_schema_phase_reports_fifty_violations_and_counts_the_rest() {
    let mut cfg = defaults();
    let mut left = 60;
    spoil(&mut cfg, &mut left);
    assert_eq!(
        left, 0,
        "the defaults hold fewer than 60 booleans and numbers"
    );
    let errors = validate(&cfg).unwrap_err();
    assert_eq!(errors.len(), 51, "{errors:?}");
    assert_eq!(errors[50], "... and 10 more");
}
