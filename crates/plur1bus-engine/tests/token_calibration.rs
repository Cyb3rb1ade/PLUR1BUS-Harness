//! RE-14/T3: real prompt fitting, normalized usage and bounded transactional filesystem state.
#![cfg_attr(test, allow(clippy::unwrap_used))]

use plur1bus_engine::cache_profiles::CacheProfileTable;
use plur1bus_engine::tokens::{
    normalize_profile_usage, BaseEstimate, CalibrationError, CalibrationStore, CountRequest,
    NormalizedTokenUsage, ProfileUsage, TokenCounter, TokenMethod, TokenObservation, TokenRoute,
};
use serde_json::json;

fn route() -> TokenRoute {
    serde_json::from_value(json!({"provider":"anthropic", "platform":"first-party",
        "wire":"anthropic_messages", "model":"claude-sonnet-4-6"}))
    .unwrap()
}

fn request(tokens: usize) -> CountRequest {
    serde_json::from_value(json!({"route": route(), "cumulative":true,
        "items":[{"id":"a", "text":"x".repeat(tokens * 4)}]}))
    .unwrap()
}

fn observation(x: u64, y: Option<u64>) -> TokenObservation {
    TokenObservation {
        route: route(),
        family: "claude-v1".into(),
        base: BaseEstimate {
            tokens: x,
            method: TokenMethod::Heuristic,
            version: 1,
        },
        reported: NormalizedTokenUsage {
            input_total: y,
            cache_read: None,
            cache_write: None,
        },
    }
}

fn affine() -> Vec<TokenObservation> {
    [10, 20, 30, 40, 50, 60]
        .into_iter()
        .map(|x| observation(x, Some(2 * x + 7)))
        .collect()
}

#[test]
fn affine_prompt_recovers_slope_intercept_and_keeps_raw_counts() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = CalibrationStore::open(directory.path()).unwrap();
    let counter = TokenCounter::heuristic().unwrap();
    let raw = counter.count(&request(100)).unwrap();
    assert_eq!(counter.observe(&mut store, &affine()).unwrap().accepted, 6);
    let result = counter.count_prompt(&request(100), &store).unwrap();
    assert_eq!(result.base, raw);
    assert_eq!(result.total.tokens, 207);
    assert_eq!(result.method, TokenMethod::Calibrated);
    assert_eq!(result.calibration.observations, 6);
    assert_eq!(result.calibration.version, 1);
    let fit = result.fit.unwrap();
    assert_eq!((fit.slope, fit.intercept), (2.0, 7.0));
    assert_eq!(counter.count(&request(100)).unwrap(), raw);
}

#[test]
fn multi_item_prompt_adds_intercept_once_and_preserves_message_prefixes() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = CalibrationStore::open(directory.path()).unwrap();
    let counter = TokenCounter::heuristic().unwrap();
    counter.observe(&mut store, &affine()).unwrap();
    let request: CountRequest = serde_json::from_value(json!({"route":route(), "cumulative":true,
        "items":[{"id":"a", "messages":[{"role":"user","segments":[{"text":"x".repeat(80)},
            {"text":"x".repeat(80)}]}]}, {"id":"b", "text":"x".repeat(240)}]}))
    .unwrap();
    let result = counter.count_prompt(&request, &store).unwrap();
    assert_eq!(result.total.tokens, 207);
    assert_eq!(result.base.items[0].tokens, 40);
    assert_eq!(result.base.items[1].tokens, 60);
    let prefixes = &result.base.cumulative.as_ref().unwrap()[0].counts;
    assert_eq!((prefixes[0].tokens, prefixes[1].tokens), (20, 40));
    assert_eq!(result.base, counter.count(&request).unwrap());
}

#[test]
fn missing_sparse_constant_and_nonpositive_fits_keep_honest_fallback() {
    let counter = TokenCounter::heuristic().unwrap();
    for observations in [
        vec![],
        affine()[..5].to_vec(),
        vec![observation(10, Some(20)); 8],
        (1..=8).map(|x| observation(x, Some(10 - x))).collect(),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let mut store = CalibrationStore::open(directory.path()).unwrap();
        counter.observe(&mut store, &observations).unwrap();
        let result = counter.count_prompt(&request(100), &store).unwrap();
        assert_eq!(result.method, TokenMethod::Heuristic);
        assert_eq!(
            (result.total.lower, result.total.tokens, result.total.upper),
            (0, 100, 400)
        );
        assert!(result.fit.is_none());
    }
}

#[test]
fn full_route_family_and_base_method_are_isolated() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = CalibrationStore::open(directory.path()).unwrap();
    let counter = TokenCounter::heuristic().unwrap();
    counter.observe(&mut store, &affine()).unwrap();
    for field in ["provider", "platform", "wire", "model"] {
        let mut changed = serde_json::to_value(route()).unwrap();
        changed[field] = json!(format!("other-{}", changed[field].as_str().unwrap()));
        let mut req = request(100);
        req.route = Some(serde_json::from_value(changed).unwrap());
        assert_eq!(
            counter.count_prompt(&req, &store).unwrap().method,
            TokenMethod::Heuristic
        );
    }
    assert!(store
        .fit(&route(), "claude-v2", TokenMethod::Heuristic)
        .is_none());
    assert!(store
        .fit(&route(), "claude-v1", TokenMethod::Exact)
        .is_none());
    assert!(store
        .fit(&route(), "claude-v1", TokenMethod::TokenizerText)
        .is_none());
    let mut family_only = request(100);
    family_only.route = None;
    family_only.family = Some("claude-v1".into());
    assert_eq!(
        counter.count_prompt(&family_only, &store).unwrap().method,
        TokenMethod::Heuristic
    );
    let mut other = affine();
    for item in &mut other {
        item.route.provider = "other".into();
        item.reported.input_total = Some(999);
    }
    counter.observe(&mut store, &other).unwrap();
    assert_eq!(
        counter
            .count_prompt(&request(100), &store)
            .unwrap()
            .total
            .tokens,
        207
    );
}

#[test]
fn invalid_version_feedback_family_and_route_reject_the_whole_batch() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = CalibrationStore::open(directory.path()).unwrap();
    let counter = TokenCounter::heuristic().unwrap();
    let mut invalid = Vec::new();
    let mut value = observation(10, Some(20));
    value.base.version = 2;
    invalid.push(value);
    let mut value = observation(10, Some(20));
    value.base.method = TokenMethod::Calibrated;
    invalid.push(value);
    let mut value = observation(10, Some(20));
    value.family = "claude-v2".into();
    invalid.push(value);
    let mut value = observation(10, Some(20));
    value.route.wire.clear();
    invalid.push(value);
    let mut value = observation(10, Some(20));
    value.route.provider = "x".repeat(1025);
    invalid.push(value);
    for value in invalid {
        let mut batch = affine();
        batch.push(value);
        assert!(matches!(
            counter.observe(&mut store, &batch),
            Err(CalibrationError::InvalidObservation(_))
        ));
        assert_eq!(
            counter
                .count_prompt(&request(100), &store)
                .unwrap()
                .calibration
                .observations,
            0
        );
        assert!(!directory.path().join("token-calibration.json").exists());
    }
}

#[test]
fn normalized_input_is_authoritative_and_missing_differs_from_zero() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = CalibrationStore::open(directory.path()).unwrap();
    let counter = TokenCounter::heuristic().unwrap();
    let mut missing = observation(10, None);
    missing.reported.cache_read = Some(100);
    let result = counter
        .observe(&mut store, &[missing, observation(0, Some(0))])
        .unwrap();
    assert_eq!((result.accepted, result.missing_input), (1, 1));
    let mut samples = affine();
    for sample in &mut samples {
        sample.reported.cache_read = Some(10);
        sample.reported.cache_write = Some(5);
    }
    counter.observe(&mut store, &samples).unwrap();
    assert_eq!(
        counter
            .count_prompt(&request(100), &store)
            .unwrap()
            .total
            .tokens,
        207
    );
    let absent: NormalizedTokenUsage = serde_json::from_value(json!({})).unwrap();
    assert_eq!(serde_json::to_value(absent).unwrap(), json!({}));
    assert!(serde_json::from_value::<NormalizedTokenUsage>(json!({"inputTokens":5})).is_err());
}

#[test]
fn table_selected_numeric_conversion_preserves_absence_and_checks_overflow() {
    let table = CacheProfileTable::bundled().unwrap();
    let inclusive = &table
        .rows()
        .iter()
        .find(|row| row.usage.input_includes_cache)
        .unwrap()
        .usage;
    let exclusive = &table
        .rows()
        .iter()
        .find(|row| !row.usage.input_includes_cache)
        .unwrap()
        .usage;
    let parts = ProfileUsage {
        input: Some(1000),
        cache_read: Some(600),
        cache_write: Some(200),
    };
    assert_eq!(
        normalize_profile_usage(inclusive, &parts)
            .unwrap()
            .input_total,
        Some(1000)
    );
    let parts = ProfileUsage {
        input: Some(200),
        ..parts
    };
    assert_eq!(
        normalize_profile_usage(exclusive, &parts)
            .unwrap()
            .input_total,
        Some(1000)
    );
    for parts in [
        ProfileUsage {
            input: None,
            ..parts.clone()
        },
        ProfileUsage {
            cache_read: None,
            ..parts.clone()
        },
        ProfileUsage {
            cache_write: None,
            ..parts.clone()
        },
    ] {
        assert_eq!(
            normalize_profile_usage(exclusive, &parts)
                .unwrap()
                .input_total,
            None
        );
    }
    let missing: ProfileUsage = serde_json::from_value(json!({"input":0})).unwrap();
    assert_eq!(
        normalize_profile_usage(inclusive, &missing)
            .unwrap()
            .input_total,
        Some(0)
    );
    assert_eq!(
        normalize_profile_usage(inclusive, &missing)
            .unwrap()
            .cache_read,
        None
    );
    let zeros = ProfileUsage {
        input: Some(0),
        cache_read: Some(0),
        cache_write: Some(0),
    };
    assert_eq!(
        normalize_profile_usage(exclusive, &zeros)
            .unwrap()
            .input_total,
        Some(0)
    );
    let overflow = ProfileUsage {
        input: Some(u64::MAX),
        cache_read: Some(1),
        cache_write: Some(0),
    };
    assert!(matches!(
        normalize_profile_usage(exclusive, &overflow),
        Err(CalibrationError::Overflow)
    ));
}

#[test]
fn gross_and_high_leverage_outliers_do_not_poison_affine_fit() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = CalibrationStore::open(directory.path()).unwrap();
    let counter = TokenCounter::heuristic().unwrap();
    let mut samples = affine();
    samples.extend([
        observation(35, Some(100_000)),
        observation(1_000_000, Some(3)),
    ]);
    counter.observe(&mut store, &samples).unwrap();
    let result = counter.count_prompt(&request(100), &store).unwrap();
    assert_eq!(result.total.tokens, 207);
    assert_eq!(result.fit.unwrap().slope, 2.0);
}

#[test]
fn noisy_residuals_and_extrapolation_have_ordered_wider_intervals() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = CalibrationStore::open(directory.path()).unwrap();
    let counter = TokenCounter::heuristic().unwrap();
    let samples: Vec<_> = [
        (10, 28),
        (20, 46),
        (30, 68),
        (40, 86),
        (50, 108),
        (60, 126),
        (70, 148),
        (80, 166),
    ]
    .into_iter()
    .map(|(x, y)| observation(x, Some(y)))
    .collect();
    counter.observe(&mut store, &samples).unwrap();
    let near = counter.count_prompt(&request(40), &store).unwrap().total;
    let far = counter.count_prompt(&request(200), &store).unwrap().total;
    assert!((85..=89).contains(&near.tokens));
    assert!(near.lower < near.tokens && near.tokens < near.upper);
    assert!(far.lower <= far.tokens && far.tokens <= far.upper);
    assert!(far.upper - far.lower > near.upper - near.lower);
}

#[test]
fn negative_intercept_and_extreme_prediction_clamp_without_wrapping() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = CalibrationStore::open(directory.path()).unwrap();
    let counter = TokenCounter::heuristic().unwrap();
    let samples: Vec<_> = (10..=80)
        .step_by(10)
        .map(|x| observation(x, Some(x / 2 - 5)))
        .collect();
    counter.observe(&mut store, &samples).unwrap();
    let fit = store
        .fit(&route(), "claude-v1", TokenMethod::Heuristic)
        .unwrap();
    assert_eq!((fit.slope, fit.intercept), (0.5, -5.0));
    assert_eq!(fit.predict(0).tokens, 0);
    let bounds = fit.predict(u64::MAX);
    assert!(bounds.lower <= bounds.tokens && bounds.tokens <= bounds.upper);
    counter.observe(&mut store, &affine()).unwrap();
    let too_large = observation(u64::MAX, Some(u64::MAX));
    assert!(matches!(
        counter.observe(&mut store, &[too_large]),
        Err(CalibrationError::InvalidObservation(_))
    ));
}

#[test]
fn already_normalized_anthropic_thousand_stays_thousand_not_eighteen_hundred() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = CalibrationStore::open(directory.path()).unwrap();
    let counter = TokenCounter::heuristic().unwrap();
    let samples: Vec<_> = (100..=600)
        .step_by(100)
        .map(|x| {
            let mut sample = observation(x, Some(x + 900));
            sample.reported.cache_read = Some(600);
            sample.reported.cache_write = Some(200);
            sample
        })
        .collect();
    counter.observe(&mut store, &samples).unwrap();
    assert_eq!(
        counter
            .count_prompt(&request(100), &store)
            .unwrap()
            .total
            .tokens,
        1000
    );
}
