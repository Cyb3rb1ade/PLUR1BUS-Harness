//! RE-D11's numerical and calibration contract, independent of model loading.
#![allow(clippy::unwrap_used, reason = "fixed score and profile fixtures")]

use plur1bus_engine::{
    contract::VectorSpaceIdentity,
    embedding::identity::identity_from_value,
    recall::score::{cosine_from_squared_l2, ScoreScale},
};
use serde_json::{json, Value};

fn e5_identity() -> VectorSpaceIdentity {
    identity_from_value(&json!({
        "provider":"local-transformers", "model":"intfloat/multilingual-e5-small",
        "dimension":384, "revision":"614241f622f53c4eeff9890bdc4f31cfecc418b3",
        "normalization":"l2", "dtype":"float32"
    }))
    .unwrap()
}

#[test]
fn score_is_the_cosine_similarity_of_unit_vectors() {
    let left = [0.6_f64, 0.8];
    for right in [[0.8, 0.6], [1.0, 0.0], [-0.6, -0.8], [-0.8, 0.6]] {
        let distance = (left[0] - right[0]).powi(2) + (left[1] - right[1]).powi(2);
        let actual = cosine_from_squared_l2(distance);
        let expected = left[0] * right[0] + left[1] * right[1];
        assert!((actual - expected).abs() < 1e-12, "{left:?} {right:?}");
    }
}

#[test]
fn min_score_filters_at_the_calibrated_value_of_the_profile() {
    let profile = ScoreScale::configured(&json!({"scoreScale":"cosine"}), &e5_identity()).unwrap();
    assert_eq!(profile.threshold(0.2), 0.82);
    let floor = profile.threshold(0.2);
    assert!(profile.distance_score(0.35) >= floor);
    assert!(profile.distance_score(0.37) < floor);

    let legacy = ScoreScale::configured(&Value::Null, &e5_identity()).unwrap();
    assert_eq!(legacy, ScoreScale::Legacy);
    assert_eq!(legacy.threshold(0.2), 0.2);

    let mut uncalibrated = e5_identity();
    uncalibrated.revision = "unknown-revision".into();
    assert!(ScoreScale::configured(&json!({"scoreScale":"cosine"}), &uncalibrated).is_err());
    let explicit = json!({"scoreScale":"cosine","cosineMinScore":0.6});
    assert_eq!(
        ScoreScale::configured(&explicit, &uncalibrated)
            .unwrap()
            .threshold(0.2),
        0.6
    );
    uncalibrated.normalization = "none".into();
    assert!(ScoreScale::configured(&explicit, &uncalibrated).is_err());
}

#[test]
fn boosters_keep_their_relative_weight_on_the_new_scale() {
    let cosine = ScoreScale::configured(&json!({"scoreScale":"cosine"}), &e5_identity()).unwrap();
    let legacy = ScoreScale::Legacy;
    let base = 0.82;
    let legacy_base = legacy.distance_score(2.0 * (1.0 - base));
    let legacy_deltas = [
        legacy.boost(legacy_base, 1.0, 1.0, "trusted") - legacy_base,
        legacy.boost(legacy_base, 1.0, 1.5, "observed") - legacy_base,
        legacy.boost(legacy_base, 1.1, 1.0, "observed") - legacy_base,
    ];
    let cosine_deltas = [
        cosine.boost(base, 1.0, 1.0, "trusted") - base,
        cosine.boost(base, 1.0, 1.5, "observed") - base,
        cosine.boost(base, 1.1, 1.0, "observed") - base,
    ];
    let scale = (3.0_f64 - 2.0 * base).powi(2) / 2.0;
    for (old, new) in legacy_deltas.into_iter().zip(cosine_deltas) {
        assert!((new - scale * old).abs() < 1e-12, "{old} {new}");
    }
}

#[test]
fn calibration_requires_the_pinned_profile_dimensions_and_dtype() {
    let profile = serde_json::to_value(e5_identity()).unwrap();
    let request = json!({"scoreScale":"cosine"});
    for (field, value) in [
        ("provider", json!("other-provider")),
        ("model", json!("other-model")),
        ("dimension", json!(768)),
        ("dtype", json!("float16")),
    ] {
        let mut different = profile.clone();
        different[field] = value;
        let different = identity_from_value(&different).unwrap();
        assert!(
            ScoreScale::configured(&request, &different).is_err(),
            "{field}"
        );
    }
}

#[test]
fn explicit_scales_keep_the_cosine_boundaries_and_legacy_threshold() {
    let identity = e5_identity();
    let legacy = json!({"scoreScale":"legacy","cosineMinScore":0.9});
    assert_eq!(
        ScoreScale::configured(&legacy, &identity).unwrap(),
        ScoreScale::Legacy
    );
    assert_eq!(
        ScoreScale::configured(&legacy, &identity)
            .unwrap()
            .threshold(0.3),
        0.3
    );
    assert!(ScoreScale::configured(&json!({"scoreScale":"unknown"}), &identity).is_err());

    for floor in [-1.0, 1.0] {
        let recall = json!({"scoreScale":"cosine","cosineMinScore":floor});
        assert_eq!(
            ScoreScale::configured(&recall, &identity)
                .unwrap()
                .threshold(0.3),
            floor
        );
    }
    for floor in [-1.001, 1.001] {
        let recall = json!({"scoreScale":"cosine","cosineMinScore":floor});
        assert!(ScoreScale::configured(&recall, &identity).is_err());
    }
    assert_eq!(cosine_from_squared_l2(-0.001), 1.0);
    assert_eq!(cosine_from_squared_l2(4.001), -1.0);
}
