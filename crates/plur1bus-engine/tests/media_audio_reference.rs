//! MM-1 generated-waveform parity against the pinned Apache Python Gemma4 extractor.
//! Requires `real-models`, PLUR1BUS_AUDIO_REFERENCE_PYTHON, and PLUR1BUS_MEDIA_PROCESSOR_CONFIG.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use plur1bus_engine::contract::Cancel;
use plur1bus_engine::media::audio::{preprocess, AudioProfile};
use std::io::Write;
use std::process::{Command, Stdio};

const MEL_TOLERANCE: f64 = 1e-5;

fn processor() -> serde_json::Value {
    let path = std::env::var_os("PLUR1BUS_MEDIA_PROCESSOR_CONFIG").expect(
        "set PLUR1BUS_MEDIA_PROCESSOR_CONFIG to the recovered pinned processor_config.json",
    );
    let bytes = std::fs::read(path).expect("read pinned processor configuration");
    serde_json::from_slice(&bytes).expect("parse pinned processor configuration")
}

fn reference(samples: &[f32], processor: &serde_json::Value) -> serde_json::Value {
    let python = std::env::var_os("PLUR1BUS_AUDIO_REFERENCE_PYTHON").expect(
        "set PLUR1BUS_AUDIO_REFERENCE_PYTHON to Python with transformers 5.5.0 / NumPy 1.26.4",
    );
    let script =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/media_audio_reference.py");
    let mut child = Command::new(python)
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start pinned Python reference; missing dependencies are an acceptance failure");
    let mut input = child.stdin.take().unwrap();
    serde_json::to_writer(
        &mut input,
        &serde_json::json!({
            "samples": samples, "processorConfig": processor
        }),
    )
    .unwrap();
    input.flush().unwrap();
    drop(input);
    let result = child
        .wait_with_output()
        .expect("wait for pinned Python extractor");
    assert!(
        result.status.success(),
        "Python reference failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    serde_json::from_slice(&result.stdout).expect("parse real Python feature recording")
}

#[test]
fn generated_signals_match_python_mel_features_and_masks() {
    let processor = processor();
    let profile = AudioProfile::from_processor_config(&processor).unwrap();
    let cases: Vec<(&str, Vec<f32>)> = vec![
        ("single_sample", vec![0.125]),
        ("short_boundary", vec![0.0; 160]),
        ("first_frame", vec![0.0; 161]),
        (
            "unfold_boundary",
            (0..321).map(|i| if i == 160 { 1.0 } else { 0.0 }).collect(),
        ),
        (
            "ramp",
            (0..4097)
                .map(|i| ((i % 509) as f32 - 254.0) / 255.0)
                .collect(),
        ),
        (
            "sine",
            (0..16_000)
                .map(|i| (i as f64 * 2.0 * std::f64::consts::PI * 440.0 / 16_000.0).sin() as f32)
                .collect(),
        ),
        (
            "chirp",
            (0..32_001)
                .map(|i| {
                    let time = i as f64 / 16_000.0;
                    (0.8 * (2.0 * std::f64::consts::PI * (30.0 * time + 900.0 * time * time)).sin())
                        as f32
                })
                .collect(),
        ),
        (
            "alternating",
            (0..16_001)
                .map(|i| if i % 2 == 0 { 0.9 } else { -0.9 })
                .collect(),
        ),
        (
            "maximum_window",
            (0..480_000)
                .map(|i| ((i % 127) as f32 - 63.0) / 128.0)
                .collect(),
        ),
    ];
    for (name, samples) in cases {
        let actual = preprocess(&samples, &profile, &Cancel::never()).unwrap();
        let expected = reference(&samples, &processor);
        assert_eq!(
            actual.frames as u64,
            expected["frames"].as_u64().unwrap(),
            "{name}"
        );
        assert_eq!(
            actual.feature_size as u64,
            expected["featureSize"].as_u64().unwrap(),
            "{name}"
        );
        assert_eq!(
            actual.soft_tokens as u64,
            expected["softTokens"].as_u64().unwrap(),
            "{name}"
        );
        let mask: Vec<bool> = serde_json::from_value(expected["mask"].clone()).unwrap();
        assert_eq!(actual.mask, mask, "{name}");
        let features = expected["features"].as_array().unwrap();
        assert_eq!(actual.features.len(), features.len(), "{name}");
        let maximum_error = actual
            .features
            .iter()
            .zip(features)
            .enumerate()
            .map(|(index, (actual, expected))| {
                let expected = expected.as_f64().unwrap();
                assert!(
                    actual.is_finite() && expected.is_finite(),
                    "{name}, feature {index}"
                );
                (f64::from(*actual) - expected).abs()
            })
            .fold(0.0_f64, f64::max);
        assert!(
            maximum_error <= MEL_TOLERANCE,
            "{name}: maximum Mel error {maximum_error} exceeds {MEL_TOLERANCE}"
        );
        println!(
            "{name}: frames={}, soft_tokens={}, maximum_absolute_error={maximum_error}",
            actual.frames, actual.soft_tokens
        );
    }
}
