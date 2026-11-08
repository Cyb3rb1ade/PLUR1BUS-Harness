//! Restore-safe cutoff state and raw state-file bytes recorded from Node.
#![allow(clippy::unwrap_used)]

use plur1bus_engine::capture::epistemic_cutoff::{
    cutoff_path, enabled_path, ensure_cutoff, finite_ms, read_cutoff,
};
use serde_json::Value;

#[test]
fn cutoff_creation_restore_failure_and_existing_bytes_equal_the_node_recordings() {
    let golden: Value = serde_json::from_str(include_str!(
        "fixtures/capture/golden/epistemic-cutoff.json"
    ))
    .unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let root = physical_tempdir();
        let base = root.path().join("stores");
        std::fs::create_dir_all(cutoff_path(&base).parent().unwrap()).unwrap();
        if let Some(seed) = case["seed"].as_str() {
            std::fs::write(cutoff_path(&base), seed).unwrap();
        }
        if case["enabled"] == true {
            std::fs::write(enabled_path(&base), "1\n").unwrap();
        }
        assert_eq!(
            serde_json::to_string(&read_cutoff(&base)).unwrap(),
            case["before"].as_str().unwrap()
        );
        assert_eq!(
            serde_json::to_string(&ensure_cutoff(&base, 1000)).unwrap(),
            case["result"].as_str().unwrap()
        );
        assert_eq!(
            serde_json::to_string(&ensure_cutoff(&base, 2000)).unwrap(),
            case["again"].as_str().unwrap()
        );
        assert_eq!(
            std::fs::read_to_string(cutoff_path(&base)).ok().as_deref(),
            case["cutoff"].as_str()
        );
        assert_eq!(
            std::fs::read_to_string(enabled_path(&base)).ok().as_deref(),
            case["marker"].as_str()
        );
    }
}

#[test]
fn timestamp_integer_and_cutoff_boundaries_equal_node() {
    let golden: Value = serde_json::from_str(include_str!(
        "fixtures/capture/golden/epistemic-cutoff.json"
    ))
    .unwrap();
    for entry in golden["bounds"].as_array().unwrap() {
        assert_eq!(finite_ms(&entry["value"]), entry["finite"].as_i64());
        let ts = finite_ms(&entry["value"]);
        assert_eq!(
            ts.is_some_and(|v| v > 0 && v < 100),
            entry["before"].as_bool().unwrap()
        );
        assert_eq!(
            ts.is_some_and(|v| v >= 100),
            entry["after"].as_bool().unwrap()
        );
    }
}

#[test]
fn injected_context_prompt_injection_and_new_write_trust_equal_node() {
    use plur1bus_engine::capture::epistemic::{
        decide_capture_status, is_injected_context, looks_like_prompt_injection,
    };
    use plur1bus_engine::text::js::JsString;
    let golden: Value = serde_json::from_str(include_str!(
        "fixtures/capture/golden/epistemic-capture.json"
    ))
    .unwrap();
    for entry in golden["classifications"].as_array().unwrap() {
        let text = JsString::from_utf16_units(
            entry["units"]
                .as_array()
                .unwrap()
                .iter()
                .map(|unit| unit.as_u64().unwrap() as u16)
                .collect(),
        );
        assert_eq!(
            is_injected_context(&text).unwrap(),
            entry["injected"].as_bool().unwrap()
        );
        assert_eq!(
            looks_like_prompt_injection(&text).unwrap(),
            entry["promptInjection"].as_bool().unwrap()
        );
        assert_eq!(
            decide_capture_status(
                &text,
                entry["role"].as_str().unwrap(),
                entry["origin"].as_str().unwrap(),
                entry["cutoffFailed"].as_bool().unwrap()
            )
            .unwrap(),
            entry["status"].as_str().unwrap()
        );
    }
}

// Production rejects symlinks; use the physical system temporary root on macOS too.
fn physical_tempdir() -> tempfile::TempDir {
    tempfile::Builder::new()
        .tempdir_in(std::env::temp_dir().canonicalize().unwrap())
        .unwrap()
}
