//! Runtime-generated Pillow and pinned Apache Transformers.js preprocessing parity (MM-1/E13).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use image::{DynamicImage, ImageFormat, RgbImage};
use plur1bus_engine::contract::Cancel;
use plur1bus_engine::media::image::preprocess;
use std::io::{Cursor, Write};
use std::path::Path;
use std::process::{Command, Stdio};

fn reference(program: &str, arguments: &[&str], input: &serde_json::Value) -> serde_json::Value {
    let mut child = Command::new(program)
        .args(arguments)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("reference runtime must be installed");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
        .unwrap();
    let result = child.wait_with_output().unwrap();
    assert!(
        result.status.success(),
        "reference process failed: {program}"
    );
    serde_json::from_slice(&result.stdout).unwrap()
}

fn unhex(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

fn encoded(rgb: Vec<u8>, width: usize, height: usize) -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(RgbImage::from_raw(width as u32, height as u32, rgb).unwrap())
        .write_to(&mut bytes, ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}

#[test]
fn generated_rgb_preprocessing_equals_pillow_resize_bytes_exactly() {
    // These target sizes are computed independently by the pinned Apache processor's formula.
    for (source, target, budget) in [
        ([1, 1], [48, 48], 1),
        ([2, 3], [48, 48], 2),
        ([31, 19], [96, 48], 3),
        ([17, 13], [48, 48], 2),
        ([1, 257], [48, 6720], 140),
        ([1, 500_000], [48, 48], 1),
        ([257, 1], [6720, 48], 140),
        ([113, 79], [96, 48], 5),
        ([97, 101], [96, 96], 5),
        ([48, 13], [48, 48], 1),
        ([13, 48], [48, 48], 1),
        ([96, 96], [48, 48], 1),
        ([11, 7], [48, 48], 2),
        ([1920, 1080], [528, 288], 70),
        ([1920, 1080], [720, 384], 140),
        ([1920, 1080], [1056, 576], 280),
    ] {
        for pattern in ["gradient", "checker", "impulse"] {
            let request = serde_json::json!({"source":source,"target":target,"pattern":pattern});
            let result = reference(
                "python3",
                &["-c", include_str!("media_image_reference.py")],
                &request,
            );
            let rgb = unhex(result["source"].as_str().unwrap());
            let expected = unhex(result["resized"].as_str().unwrap());
            let tensor = preprocess(
                &encoded(rgb, source[0], source[1]),
                budget,
                &Cancel::never(),
            )
            .unwrap();
            let columns = target[0] / 16;
            let rows = target[1] / 16;
            assert_eq!(tensor.soft_tokens, columns * rows / 9);
            for row in 0..rows {
                for column in 0..columns {
                    let patch = row * columns + column;
                    for dy in 0..16 {
                        let start = ((row * 16 + dy) * target[0] + column * 16) * 3;
                        for offset in 0..48 {
                            let value = (f64::from(expected[start + offset]) / 255.0) as f32;
                            assert_eq!(tensor.pixels[patch * 768 + dy * 48 + offset], value,
                                "{source:?} -> {target:?}, {pattern}, patch={patch}, dy={dy}, offset={offset}");
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn generated_hwc_patches_equal_the_pinned_apache_processor_exactly() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let root = manifest
        .ancestors()
        .find(|path| path.join("pnpm-lock.yaml").exists())
        .unwrap();
    for (width, height, budget) in [(48, 48, 1), (96, 48, 3), (48, 96, 3)] {
        let rgb: Vec<_> = (0..width * height * 3)
            .map(|index| ((index * 37 + index / 31) % 256) as u8)
            .collect();
        let result = reference(
            "node",
            &[
                manifest
                    .join("tests/media_image_reference.mjs")
                    .to_str()
                    .unwrap(),
                root.to_str().unwrap(),
            ],
            &serde_json::json!({"rgb":rgb,"width":width,"height":height,"budget":budget}),
        );
        let actual = preprocess(&encoded(rgb, width, height), budget, &Cancel::never()).unwrap();
        let expected = unhex(result["pixels"].as_str().unwrap());
        let actual: Vec<_> = actual
            .pixels
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect();
        assert_eq!(actual, expected);
        let tensor = preprocess(
            &encoded(vec![0; width * height * 3], width, height),
            budget,
            &Cancel::never(),
        )
        .unwrap();
        let positions: Vec<i64> = serde_json::from_value(result["positions"].clone()).unwrap();
        assert_eq!(tensor.positions, positions);
        assert_eq!(
            tensor.soft_tokens,
            result["soft_tokens"].as_u64().unwrap() as usize
        );
    }
}

#[test]
fn frozen_jpeg_decodes_stay_within_two_lsb_and_png_is_exact() {
    let manifest = std::env::var_os("PLUR1BUS_MEDIA_JPEG_REFERENCE").expect(
        "PLUR1BUS_MEDIA_JPEG_REFERENCE must name the frozen jpeg-reference.py JSON manifest",
    );
    let reference: serde_json::Value =
        serde_json::from_slice(&std::fs::read(manifest).unwrap()).unwrap();
    let cases = reference["cases"].as_array().unwrap();
    assert_eq!(
        cases.len(),
        4,
        "all JPEG420/JPEG444/progressive420/PNG fixtures are required"
    );
    assert_eq!(
        cases
            .iter()
            .map(|case| case["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "jpeg-420",
            "jpeg-444",
            "jpeg-progressive-420",
            "png-lossless"
        ],
        "all frozen coding/subsampling variants must be checked individually"
    );
    for case in cases {
        let bytes = std::fs::read(case["encoded"].as_str().unwrap()).unwrap();
        let expected = std::fs::read(case["decoded"].as_str().unwrap()).unwrap();
        let actual = plur1bus_engine::media::image::decode_rgb(&bytes, &Cancel::never()).unwrap();
        assert_eq!(actual.as_raw().len(), expected.len());
        let deviations: Vec<_> = actual
            .as_raw()
            .iter()
            .zip(&expected)
            .map(|(&a, &b)| a.abs_diff(b))
            .collect();
        let max = deviations.iter().copied().max().unwrap();
        let mean = deviations.iter().map(|&v| f64::from(v)).sum::<f64>() / deviations.len() as f64;
        eprintln!(
            "{} decoder_max_lsb={max} decoder_mean_lsb={mean:.12}",
            case["name"]
        );
        assert!(
            max <= if case["jpeg"].as_bool().unwrap() {
                2
            } else {
                0
            },
            "{}: independent decoder bound",
            case["name"]
        );
    }
}
