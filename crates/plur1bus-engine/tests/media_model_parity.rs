//! SPDX-License-Identifier: Apache-2.0
//! Real pinned media graphs: identical tensors >=.9999; JPEG E2E >=.9997 per image.
//! JPEG has an independent <=2 LSB/channel decode bound before vector comparison.
//! Pillow/libjpeg-turbo and the Rust decoder can round differently; PNG has no allowance.
//! No downloads, skips, foreign media or committed vectors. See scripts/media/*.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::print_stdout,
    clippy::panic
)]

use plur1bus_engine::contract::Cancel;
use plur1bus_engine::embedding::local_ort::initialize_runtime;
use plur1bus_engine::media::{
    artifacts::{graph_files, MediaGraph, MODEL, REVISION},
    audio::{self, AudioProfile},
    embedder::{MediaEncoder, MediaModality},
    image::preprocess,
    session::SessionMediaEncoder,
    LocalMediaEmbedder, MediaEmbedder, MediaInput,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

#[allow(dead_code)]
mod runtime {
    include!("common/onnx_runtime.rs");
    pub fn required_existing() -> PathBuf {
        let path = std::env::var_os("ORT_DYLIB_PATH")
            .map(PathBuf::from)
            .expect("ORT_DYLIB_PATH must name the existing pinned 1.30.0 library");
        let (_, _, bytes, sha) = pin();
        assert!(
            verified(&path, bytes, sha).unwrap(),
            "existing ORT library must match size/SHA pin"
        );
        // Do NOT call ensure_runtime: unavailable/invalid ORT must fail without downloading.
        path
    }
}
fn run(program: &Path, args: &[&Path]) -> Value {
    let output = Command::new(program)
        .args(args)
        .output()
        .expect("reference runtime is required");
    assert!(
        output.status.success(),
        "{} failed: {}",
        program.display(),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("reference must return JSON")
}
fn read(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}
fn floats(path: &Path, values: &[f32]) {
    fs::write(
        path,
        values
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect::<Vec<_>>(),
    )
    .unwrap();
}
fn required_env(name: &str) -> PathBuf {
    std::env::var_os(name)
        .map(PathBuf::from)
        .unwrap_or_else(|| panic!("required cached dependency: {name}"))
}
fn verify_models(root: &Path) -> Vec<Value> {
    let mut pins = vec![];
    for graph in [MediaGraph::Vision, MediaGraph::Audio, MediaGraph::Fusion] {
        for file in graph_files(graph).unwrap() {
            let path = root.join(&file.path);
            assert!(path.is_file(), "required pinned file: {}", file.path);
            let data = fs::read(path).unwrap();
            assert_eq!(data.len() as u64, file.bytes, "size: {}", file.path);
            assert_eq!(
                format!("{:x}", Sha256::digest(&data)),
                file.sha256,
                "SHA256: {}",
                file.path
            );
            pins.push(json!({"path":file.path,"bytes":file.bytes,"sha256":file.sha256}));
        }
    }
    pins
}
fn exercise(directory: &Path) {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repository = std::env::var_os("PLUR1BUS_MEDIA_PARITY_REPO")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest.parent().unwrap().parent().unwrap().to_owned());
    let cache = required_env("PLUR1BUS_MEDIA_MODELS_CACHE");
    let model = cache.join(MODEL).join(REVISION);
    let pins = verify_models(&model); // Every file checked before any graph load.
    let runtime = runtime::required_existing();
    initialize_runtime(&runtime).expect("verified pinned ORT must initialize");
    let python = required_env("PLUR1BUS_PYTHON");
    let node = required_env("PLUR1BUS_NODE");
    let script = repository.join("scripts/media/jpeg-reference.py");
    let frozen = std::env::var_os("PLUR1BUS_MEDIA_PARITY_FIXTURES").map(PathBuf::from);
    let reference = if let Some(frozen) = frozen {
        run(&python, &[&script, &frozen, Path::new("--reuse")])
    } else {
        run(&python, &[&script, directory])
    };
    assert_eq!(reference["pillow"], "12.3.0");
    assert_eq!(reference["cases"].as_array().unwrap().len(), 4);
    let identity = read(&repository.join(
        "crates/plur1bus-engine/tests/fixtures/vectors/identity-embeddinggemma-2-runtime.json",
    ));
    let provider = LocalMediaEmbedder::new(
        cache.clone(),
        serde_json::from_value(identity["identity"].clone()).unwrap(),
    )
    .unwrap();
    let encoder = SessionMediaEncoder::new(cache);
    let cancel = Cancel::never();
    let mut cases = vec![];
    for mut case in reference["cases"].as_array().unwrap().clone() {
        let name = case["name"].as_str().unwrap().to_owned();
        let bytes = fs::read(case["encoded"].as_str().unwrap()).unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            case["encodedSha256"].as_str().unwrap(),
            "frozen fixture SHA changed after reference generation"
        );
        println!("fixture={name} encoded_sha256={}", case["encodedSha256"]);
        let rust_rgb = plur1bus_engine::media::image::decode_rgb(&bytes, &Cancel::never())
            .expect("production bounded media decoder")
            .into_raw();
        let pil_rgb = fs::read(case["decoded"].as_str().unwrap()).unwrap();
        assert_eq!(rust_rgb.len(), pil_rgb.len());
        let deviations: Vec<_> = rust_rgb
            .iter()
            .zip(&pil_rgb)
            .map(|(a, b)| a.abs_diff(*b))
            .collect();
        let max = *deviations.iter().max().unwrap();
        let mean = deviations.iter().map(|v| f64::from(*v)).sum::<f64>() / deviations.len() as f64;
        let jpeg = case["jpeg"].as_bool().unwrap();
        println!("fixture={name} decoder_max_lsb={max} decoder_mean_lsb={mean:.12}");
        // Independent pixel assertion BEFORE any cosine calculation (including each JPEG).
        assert!(
            max <= if jpeg { 2 } else { 0 },
            "{name}: independent decoder bound"
        );
        let tensor = preprocess(&bytes, 140, &cancel).unwrap();
        let features = encoder
            .vision(std::slice::from_ref(&tensor), &cancel)
            .unwrap();
        let actual = provider.embed(&MediaInput::Image(&bytes), &cancel).unwrap();
        let same_bytes = fs::read(case["samePixels"].as_str().unwrap()).unwrap();
        let same_decoded = provider
            .embed(&MediaInput::Image(&same_bytes), &cancel)
            .unwrap();
        for (field, values) in [
            ("pixels", tensor.pixels.as_slice()),
            ("features", features.as_slice()),
            ("vector", actual.segments[0].vector.as_slice()),
            (
                "sameDecodedVector",
                same_decoded.segments[0].vector.as_slice(),
            ),
        ] {
            let path = directory.join(format!("{name}-{field}.f32"));
            floats(&path, values);
            case[field] = json!(path);
        }
        case["maxPatches"] = json!(tensor.max_patches);
        case["positions"] = json!(tensor.positions);
        cases.push(case);
    }
    let processor = read(&model.join("processor_config.json"));
    let profile = AudioProfile::from_processor_config(&processor).unwrap();
    let samples: Vec<f32> = (0..16000)
        .map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / 16000.0).sin() * 0.1)
        .collect();
    let tensor = audio::preprocess(&samples, &profile, &cancel).unwrap();
    let features = encoder.audio(&tensor, &cancel).unwrap();
    let vector = encoder
        .fuse(MediaModality::Audio, &features, &cancel)
        .unwrap();
    let a = directory.join("audio-input.f32");
    floats(&a, &tensor.features);
    let b = directory.join("audio-features.f32");
    floats(&b, &features);
    let c = directory.join("audio-vector.f32");
    floats(&c, &vector);
    let request = directory.join("request.json");
    fs::write(&request, serde_json::to_vec(&json!({"repository":repository,"directory":model,"pins":pins,"cases":cases,
        "audio":{"features":a,"encoderFeatures":b,"vector":c,"frames":tensor.frames,"mask":tensor.mask}})).unwrap()).unwrap();
    let result = run(
        &node,
        &[
            &repository.join("scripts/media/node-media-reference.mjs"),
            &request,
        ],
    );
    assert_eq!(result["cases"].as_array().unwrap().len(), 4);
    for (case, expected) in result["cases"].as_array().unwrap().iter().zip(&cases) {
        assert_eq!(case["name"], expected["name"]);
        for key in [
            "sameInputFeatureCosine",
            "sameInputFinalCosine",
            "sameDecodedFinalCosine",
        ] {
            let value = case[key].as_f64().unwrap();
            println!("fixture={} {key}={value:.15}", case["name"]);
            assert!(
                value.is_finite() && value >= 0.9999,
                "{} {key}={value}",
                case["name"]
            );
        }
        let value = case["endToEndFinalCosine"].as_f64().unwrap();
        // Owner decision: per-image JPEG >=.9997, never an average; PNG stays >=.9999.
        let minimum = if expected["jpeg"].as_bool().unwrap() {
            0.9997
        } else {
            0.9999
        };
        println!(
            "fixture={} end_to_end_min_cosine={value:.15} required={minimum}",
            case["name"]
        );
        assert!(
            value.is_finite() && value >= minimum,
            "{} JPEG/PNG E2E={value}",
            case["name"]
        );
    }
    assert_eq!(result["audio"]["maskType"], "bool");
    for key in ["featureCosine", "finalCosine"] {
        let value = result["audio"][key].as_f64().unwrap();
        println!("audio {key}={value:.15}");
        assert!(value.is_finite() && value >= 0.9999);
    }
}
#[test]
fn pinned_media_graphs_and_generated_jpeg_png_match_local_oracles() {
    let temp = tempfile::Builder::new()
        .prefix("plur1bus-mm1-parity-")
        .tempdir()
        .unwrap();
    println!("owned_reference_directory={}", temp.path().display());
    let result = std::panic::catch_unwind(|| exercise(temp.path()));
    if result.is_err() || std::env::var_os("PLUR1BUS_MEDIA_PARITY_KEEP").is_some() {
        println!("retained_reference_directory={}", temp.keep().display());
    }
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}
