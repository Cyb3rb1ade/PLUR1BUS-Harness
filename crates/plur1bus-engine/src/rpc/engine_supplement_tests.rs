//! The real process facade returns the unchanged Node-recorded static supplement.
#![allow(clippy::unwrap_used, reason = "fixture drift must fail the test")]
use super::*;
use crate::contract::testing::FakeHost;

#[test]
fn system_supplement_is_cached_from_config_without_store_or_model_work() {
    let golden: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/recall/golden/render/system-supplement.json"
    ))
    .unwrap();
    for configured in [None, Some(false), Some(true)] {
        let scratch =
            tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let state = scratch.path().join("not-created");
        let config =
            configured.map_or_else(|| json!({}), |enabled| json!({"neo":{"enabled":enabled}}));
        let host = Arc::new(FakeHost::new(
            state.clone(),
            serde_json::from_value(config).unwrap(),
        ));
        let engine = ProcessEngine::new(host.clone(), None).unwrap();
        let expected = golden["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["input"]["neo"] == configured.unwrap_or(true))
            .unwrap();
        assert_eq!(
            serde_json::to_string(&engine.system_supplement()).unwrap(),
            expected["rawLine"].as_str().unwrap()
        );
        host.set_config(
            serde_json::from_value(json!({"neo":{"enabled":!configured.unwrap_or(true)}})).unwrap(),
        );
        assert_eq!(
            serde_json::to_value(engine.system_supplement()).unwrap(),
            expected["lines"]
        );
        assert!(!state.exists());
        assert_eq!(engine.models().status().embedder.state, ModelState::Loading);
        assert!(!engine.status().ready);
        engine.close(None).unwrap();
        assert_eq!(
            serde_json::to_value(engine.system_supplement()).unwrap(),
            expected["lines"]
        );
        assert!(!state.exists());
    }
}
