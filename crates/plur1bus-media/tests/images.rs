#![allow(clippy::unwrap_used, reason = "codec fixture assertions")]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use plur1bus_media::images::{embed, sanitize, verify, Format, Metadata};
use serde_json::{json, Value};

#[test]
fn image_codecs_match_the_production_typescript_recordings() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/media/image-codecs.json"
    ))
    .unwrap();
    let payload = &fixture["payload"];
    let metadata = Metadata {
        prompt: payload["prompt"].as_str().unwrap(),
        parameters: &payload["parameters"],
        metadata: &payload["metadata"],
    };
    for case in fixture["cases"].as_array().unwrap() {
        let format: Format = serde_json::from_value(case["format"].clone()).unwrap();
        let source = STANDARD.decode(case["input"].as_str().unwrap()).unwrap();
        let (observed, safe) = sanitize(&source).unwrap();
        assert_eq!(observed, format);
        assert_eq!(STANDARD.encode(safe), case["expected"]["sanitized"]);
        assert_eq!(
            STANDARD.encode(embed(&source, format, &metadata).unwrap()),
            case["expected"]["embedded"]
        );
    }
    for case in fixture["refusals"].as_array().unwrap() {
        let format: Format = serde_json::from_value(case["format"].clone()).unwrap();
        let source = STANDARD.decode(case["source"].as_str().unwrap()).unwrap();
        let error = match case["mode"].as_str().unwrap() {
            "sanitize" => sanitize(&source).err().unwrap(),
            "verify" => verify(&source).err().unwrap(),
            _ => embed(&source, format, &metadata).err().unwrap(),
        };
        assert_eq!(json!(error), case["code"]);
    }
}
