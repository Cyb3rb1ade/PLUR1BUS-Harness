#![allow(clippy::unwrap_used, reason = "assertions against a checked fixture")]

use plur1bus_media::units::{self, Invalid, Units};
use serde_json::{json, Value};

fn project(units: Units) -> Value {
    match units {
        Units::Images(quantity) => json!({"unit":"image","quantity":quantity}),
        Units::VideoSeconds(quantity) => json!({"unit":"videoSecond","quantity":quantity}),
    }
}

#[test]
fn metadata_only_media_counts_match_the_production_export() {
    let vectors: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/media/units.json")).unwrap();
    for vector in vectors["cases"].as_array().unwrap() {
        let mut request = vector["input"].clone();
        if let Some(repeat) = request["promptRepeat"].as_u64() {
            request["prompt"] = json!("x".repeat(repeat as usize));
        }
        let actual = match units::requested(&request) {
            Ok(requested) => {
                let files: Vec<Option<f64>> =
                    serde_json::from_value(vector["files"].clone()).unwrap();
                let delivered = units::delivered(requested, &files).unwrap();
                json!({"requested":project(requested),"delivered":project(delivered)})
            }
            Err(Invalid::TooLarge) => json!({"error":"too_large"}),
            Err(Invalid::UnsupportedParameter) => json!({"error":"unsupported_parameter"}),
        };
        if let Some(error) = vector["expected"]["error"].as_str() {
            assert_eq!(actual["error"], error);
        } else {
            for key in ["requested", "delivered"] {
                assert_eq!(actual[key]["unit"], vector["expected"][key]["unit"]);
                assert_eq!(
                    actual[key]["quantity"].as_f64(),
                    vector["expected"][key]["quantity"].as_f64()
                );
            }
        }
    }
}
