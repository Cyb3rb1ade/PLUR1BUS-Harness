//! RE-14/T3 persistence uses real scratch files and locks; no permission-bit mocks or test seams.
#![cfg_attr(test, allow(clippy::unwrap_used))]

use plur1bus_engine::tokens::{
    CalibrationError, CalibrationStore, CountRequest, TokenCounter, TokenObservation, TokenRoute,
    MAX_CALIBRATION_BYTES, MAX_CALIBRATION_KEYS, MAX_CALIBRATION_OBSERVATIONS,
};
use serde_json::{json, Value};
use std::fs;

fn route() -> TokenRoute {
    serde_json::from_value(json!({"provider":"anthropic", "platform":"first-party",
        "wire":"anthropic_messages", "model":"claude-sonnet-4-6"}))
    .unwrap()
}
fn request(tokens: usize) -> CountRequest {
    serde_json::from_value(
        json!({"route":route(), "items":[{"id":"a", "text":"x".repeat(tokens * 4)}]}),
    )
    .unwrap()
}
fn observation(x: u64, y: Option<u64>) -> TokenObservation {
    serde_json::from_value(json!({"route":route(), "family":"claude-v1",
        "base":{"tokens":x, "method":"heuristic", "version":1}, "reported":{"inputTotal":y}}))
    .unwrap()
}
fn affine() -> Vec<TokenObservation> {
    [10, 20, 30, 40, 50, 60]
        .into_iter()
        .map(|x| observation(x, Some(2 * x + 7)))
        .collect()
}

#[test]
fn restart_restores_observations_and_refuses_concurrent_writers() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = CalibrationStore::open(directory.path()).unwrap();
    let counter = TokenCounter::heuristic().unwrap();
    counter.observe(&mut store, &affine()).unwrap();
    assert!(matches!(
        CalibrationStore::open(directory.path()),
        Err(CalibrationError::Locked)
    ));
    let before = counter.count_prompt(&request(100), &store).unwrap();
    drop(store);
    let restored = CalibrationStore::open(directory.path()).unwrap();
    assert_eq!(
        counter.count_prompt(&request(100), &restored).unwrap(),
        before
    );
    let state: Value =
        serde_json::from_slice(&fs::read(directory.path().join("token-calibration.json")).unwrap())
            .unwrap();
    assert_eq!(state["version"], 1);
    assert!(!state.to_string().contains(&"x".repeat(100)));
}

#[test]
fn recent_sample_retention_discards_old_regime_and_route_capacity_refuses_new_keys() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = CalibrationStore::open(directory.path()).unwrap();
    let counter = TokenCounter::heuristic().unwrap();
    counter.observe(&mut store, &affine()).unwrap();
    let samples: Vec<_> = (1..=MAX_CALIBRATION_OBSERVATIONS as u64)
        .map(|x| observation(x, Some(3 * x + 11)))
        .collect();
    counter.observe(&mut store, &samples).unwrap();
    let result = counter.count_prompt(&request(100), &store).unwrap();
    assert_eq!(result.total.tokens, 311);
    assert_eq!(
        result.calibration.observations,
        MAX_CALIBRATION_OBSERVATIONS as u64
    );
    let samples: Vec<_> = (1..MAX_CALIBRATION_KEYS)
        .map(|i| {
            let mut sample = observation(1, Some(1));
            sample.route.provider = format!("route-{i}");
            sample
        })
        .collect();
    counter.observe(&mut store, &samples).unwrap();
    let mut extra = observation(1, Some(1));
    extra.route.provider = "one-too-many".into();
    assert!(matches!(
        counter.observe(&mut store, &[extra]),
        Err(CalibrationError::Capacity)
    ));
    assert_eq!(
        counter
            .count_prompt(&request(100), &store)
            .unwrap()
            .total
            .tokens,
        311
    );
}

#[test]
fn corrupt_unknown_version_and_oversized_state_are_not_reset() {
    for bytes in [
        b"{".to_vec(),
        br#"{"version":2,"entries":[]}"#.to_vec(),
        br#"{"version":1,"entries":[],"unexpected":true}"#.to_vec(),
        vec![b' '; MAX_CALIBRATION_BYTES + 1],
    ] {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("token-calibration.json");
        fs::write(&file, &bytes).unwrap();
        assert!(CalibrationStore::open(directory.path()).is_err());
        assert_eq!(fs::read(&file).unwrap(), bytes);
    }
}

#[test]
fn invalid_persisted_keys_samples_and_duplicates_are_refused() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = CalibrationStore::open(directory.path()).unwrap();
    TokenCounter::heuristic()
        .unwrap()
        .observe(&mut store, &affine())
        .unwrap();
    drop(store);
    let file = directory.path().join("token-calibration.json");
    let original: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    let mut invalid = Vec::new();
    let mut state = original.clone();
    state["entries"][0]["key"]["version"] = json!(2);
    invalid.push(state);
    let mut state = original.clone();
    state["entries"][0]["key"]["method"] = json!("calibrated");
    invalid.push(state);
    let mut state = original.clone();
    state["entries"][0]["key"]["family"] = json!("wrong");
    invalid.push(state);
    let mut state = original.clone();
    state["entries"][0]["samples"] = json!([]);
    invalid.push(state);
    let mut state = original.clone();
    state["entries"]
        .as_array_mut()
        .unwrap()
        .push(original["entries"][0].clone());
    invalid.push(state);
    for state in invalid {
        fs::write(&file, serde_json::to_vec(&state).unwrap()).unwrap();
        assert!(CalibrationStore::open(directory.path()).is_err());
    }
}

#[test]
fn failed_save_preserves_memory_and_previous_state_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = CalibrationStore::open(directory.path()).unwrap();
    let counter = TokenCounter::heuristic().unwrap();
    counter.observe(&mut store, &affine()).unwrap();
    let file = directory.path().join("token-calibration.json");
    let bytes = fs::read(&file).unwrap();
    let before = counter.count_prompt(&request(100), &store).unwrap();
    // A directory at the private staging name fails even when tests run as root.
    fs::create_dir(directory.path().join("token-calibration.tmp")).unwrap();
    assert!(matches!(
        counter.observe(&mut store, &[observation(100, Some(999))]),
        Err(CalibrationError::Io(_))
    ));
    assert_eq!(fs::read(&file).unwrap(), bytes);
    assert_eq!(counter.count_prompt(&request(100), &store).unwrap(), before);
    fs::remove_dir(directory.path().join("token-calibration.tmp")).unwrap();
    counter
        .observe(&mut store, &[observation(100, Some(207))])
        .unwrap();
    assert_eq!(
        counter
            .count_prompt(&request(100), &store)
            .unwrap()
            .calibration
            .observations,
        7
    );
}

#[test]
fn stale_staging_is_recovered_under_lock_and_state_files_are_private() {
    let directory = tempfile::tempdir().unwrap();
    let staging = directory.path().join("token-calibration.tmp");
    fs::write(&staging, b"interrupted write").unwrap();
    let mut store = CalibrationStore::open(directory.path()).unwrap();
    assert!(!staging.exists());
    TokenCounter::heuristic()
        .unwrap()
        .observe(&mut store, &affine())
        .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for name in ["token-calibration.json", "token-calibration.lock"] {
            assert_eq!(
                fs::metadata(directory.path().join(name))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}

#[test]
fn rename_failure_rolls_back_memory_and_cleans_only_its_own_staging_file() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = CalibrationStore::open(directory.path()).unwrap();
    let counter = TokenCounter::heuristic().unwrap();
    counter.observe(&mut store, &affine()).unwrap();
    let before = counter.count_prompt(&request(100), &store).unwrap();
    let file = directory.path().join("token-calibration.json");
    let backup = directory.path().join("prior.json");
    fs::rename(&file, &backup).unwrap();
    fs::create_dir(&file).unwrap();
    assert!(matches!(
        counter.observe(&mut store, &[observation(100, Some(999))]),
        Err(CalibrationError::Io(_))
    ));
    assert_eq!(counter.count_prompt(&request(100), &store).unwrap(), before);
    assert!(!directory.path().join("token-calibration.tmp").exists());
    fs::remove_dir(&file).unwrap();
    fs::rename(&backup, &file).unwrap();
    drop(store);
    let store = CalibrationStore::open(directory.path()).unwrap();
    assert_eq!(counter.count_prompt(&request(100), &store).unwrap(), before);
}

#[cfg(unix)]
#[test]
fn symlinked_state_lock_or_staging_are_refused_without_touching_target() {
    use std::os::unix::fs::symlink;
    for name in [
        "token-calibration.json",
        "token-calibration.lock",
        "token-calibration.tmp",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("unrelated");
        fs::write(&target, b"preserve me").unwrap();
        symlink(&target, directory.path().join(name)).unwrap();
        assert!(CalibrationStore::open(directory.path()).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"preserve me");
    }
}
