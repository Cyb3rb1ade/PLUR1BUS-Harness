#![allow(
    clippy::unwrap_used,
    reason = "checked records from the TypeScript exporter"
)]

use plur1bus_documents::{contrast, markdown};
use serde_json::Value;

#[test]
fn markdown_and_contrast_replay_the_real_document_helpers() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/documents/pure.json")).unwrap();
    for vector in fixture["markdown"].as_array().unwrap() {
        assert_eq!(
            markdown::to_html(vector["input"].as_str().unwrap()),
            vector["html"]
        );
    }
    for vector in fixture["ratios"].as_array().unwrap() {
        let result = contrast::ratio(
            vector["foreground"].as_str().unwrap(),
            vector["background"].as_str().unwrap(),
        );
        if let Some(expected) = vector["ratio"].as_f64() {
            assert!((result.unwrap() - expected).abs() <= 1e-12);
        } else {
            assert_eq!(result, Err(contrast::InvalidColour));
        }
    }
}
