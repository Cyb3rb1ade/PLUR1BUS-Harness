//! Generated-media tests for the MM-1 bounded image edge.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::*;
use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use std::io::Cursor;

fn png(width: u32, height: u32, color: [u8; 4]) -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(RgbaImage::from_pixel(width, height, Rgba(color)))
        .write_to(&mut bytes, ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}

#[test]
fn transparent_pixels_are_composited_on_white_before_scaling() {
    let tensor = preprocess(&png(48, 48, [13, 47, 89, 0]), 1, &Cancel::never()).unwrap();
    assert_eq!(tensor.pixels, vec![1.0; 9 * 768]);
    let tensor = preprocess(&png(48, 48, [10, 20, 30, 128]), 1, &Cancel::never()).unwrap();
    assert_eq!(
        &tensor.pixels[..3],
        &[132.0 / 255.0, 137.0 / 255.0, 142.0 / 255.0]
    );
}

#[test]
fn patch_coordinates_and_padding_preserve_column_row_order() {
    let tensor = preprocess(&png(96, 48, [255, 0, 127, 255]), 3, &Cancel::never()).unwrap();
    assert_eq!(tensor.max_patches, 27);
    assert_eq!(tensor.soft_tokens, 2);
    assert_eq!(
        &tensor.positions[..14],
        &[0, 0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 0, 1]
    );
    assert!(tensor.positions[36..].iter().all(|&value| value == -1));
    assert!(tensor.pixels[18 * 768..].iter().all(|&value| value == 0.0));
}

#[test]
fn invalid_budgets_and_cancelled_work_fail_before_decode() {
    for budget in [0, 281, usize::MAX] {
        assert!(matches!(
            preprocess(&[], budget, &Cancel::never()),
            Err(ImageError::InvalidBudget(_))
        ));
    }
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(matches!(
        preprocess(&[], 140, &cancel),
        Err(ImageError::Cancelled(_))
    ));
}

#[test]
fn corrupt_and_unsupported_images_are_rejected() {
    assert!(matches!(
        preprocess(b"GIF89a", 140, &Cancel::never()),
        Err(ImageError::UnsupportedFormat)
    ));
    assert!(matches!(
        preprocess(b"\x89PNG\r\n\x1a\n", 140, &Cancel::never()),
        Err(ImageError::Decode(_) | ImageError::InvalidContainer)
    ));
}
#[test]
fn exif_orientation_is_applied_before_lossless_patchification() {
    use image::ImageEncoder;
    let colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
    let source = image::RgbImage::from_fn(96, 48, |x, y| {
        image::Rgb(colors[usize::from(y >= 24) * 2 + usize::from(x >= 48)])
    });
    let corners = [
        [0, 1, 2, 3],
        [1, 0, 3, 2],
        [3, 2, 1, 0],
        [2, 3, 0, 1],
        [0, 2, 1, 3],
        [2, 0, 3, 1],
        [3, 1, 2, 0],
        [1, 3, 0, 2],
    ];
    for orientation in 1..=8 {
        // Minimal little-endian TIFF IFD containing the EXIF Orientation tag.
        let exif = vec![
            73,
            73,
            42,
            0,
            8,
            0,
            0,
            0,
            1,
            0,
            18,
            1,
            3,
            0,
            1,
            0,
            0,
            0,
            orientation,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
        ];
        for webp in [false, true] {
            let mut bytes = Vec::new();
            if webp {
                let mut encoder = image::codecs::webp::WebPEncoder::new_lossless(&mut bytes);
                encoder.set_exif_metadata(exif.clone()).unwrap();
                encoder
                    .write_image(&source, 96, 48, image::ExtendedColorType::Rgb8)
                    .unwrap();
            } else {
                let mut encoder = image::codecs::png::PngEncoder::new(&mut bytes);
                encoder.set_exif_metadata(exif.clone()).unwrap();
                encoder
                    .write_image(&source, 96, 48, image::ExtendedColorType::Rgb8)
                    .unwrap();
            }
            let tensor = preprocess(&bytes, 2, &Cancel::never()).unwrap();
            let (width, height) = if orientation >= 5 { (48, 96) } else { (96, 48) };
            for (corner, (x, y)) in [
                (0, 0),
                (width - 1, 0),
                (0, height - 1),
                (width - 1, height - 1),
            ]
            .into_iter()
            .enumerate()
            {
                let patch = y / 16 * (width / 16) + x / 16;
                let start = patch * 768 + y % 16 * 48 + x % 16 * 3;
                let expected = colors[corners[orientation as usize - 1][corner]]
                    .map(|value| value as f32 / 255.0);
                assert_eq!(
                    &tensor.pixels[start..start + 3],
                    &expected,
                    "orientation={orientation}, webp={webp}, corner={corner}"
                );
            }
            assert_eq!(tensor.soft_tokens, 2);
            assert_eq!(tensor.positions.last(), Some(&((height / 16 - 1) as i64)));
        }
    }
}

#[test]
fn jpeg_decode_accepts_generated_images_and_respects_exif_dimensions() {
    use image::ImageEncoder;
    let source = image::RgbImage::from_pixel(96, 48, image::Rgb([255, 0, 0]));
    let mut bytes = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 95);
    encoder
        .set_exif_metadata(vec![
            73, 73, 42, 0, 8, 0, 0, 0, 1, 0, 18, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
        ])
        .unwrap();
    encoder
        .write_image(&source, 96, 48, image::ExtendedColorType::Rgb8)
        .unwrap();
    let tensor = preprocess(&bytes, 2, &Cancel::never()).unwrap();
    assert_eq!(&tensor.positions[6..8], &[0, 1]);
    assert_eq!(tensor.soft_tokens, 2);
    assert!(tensor.pixels[0] >= 253.0 / 255.0);
    assert!(tensor.pixels[1] <= 2.0 / 255.0);
    assert!(tensor.pixels[2] <= 2.0 / 255.0);
}

#[test]
fn oversized_encoded_images_fail_before_format_detection() {
    assert!(matches!(
        preprocess(&vec![0; MAX_ENCODED_BYTES + 1], 1, &Cancel::never()),
        Err(ImageError::EncodedLimit)
    ));
}

#[test]
fn enormous_png_dimensions_fail_before_pixel_allocation() {
    for (width, height) in [(50_000_u32, 1_000_u32), (40_000_001, 1), (8_000, 3_000)] {
        let mut bytes = png(1, 1, [0, 0, 0, 255]);
        bytes[16..20].copy_from_slice(&width.to_be_bytes());
        bytes[20..24].copy_from_slice(&height.to_be_bytes());
        let mut crc = !0_u32;
        for &byte in &bytes[12..29] {
            crc ^= u32::from(byte);
            for _ in 0..8 {
                crc = (crc >> 1) ^ (0xedb8_8320 & 0_u32.wrapping_sub(crc & 1));
            }
        }
        bytes[29..33].copy_from_slice(&(!crc).to_be_bytes());
        assert!(matches!(
            preprocess(&bytes, 1, &Cancel::never()),
            Err(ImageError::PixelLimit
                | ImageError::AllocationLimit
                | ImageError::Decode(image::ImageError::Limits(_)))
        ));
    }
}

#[test]
fn grayscale_headers_over_the_pixel_limit_fail_even_below_the_byte_limit() {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageLuma8(image::GrayImage::new(1, 1))
        .write_to(&mut bytes, ImageFormat::Png)
        .unwrap();
    let mut bytes = bytes.into_inner();
    bytes[16..20].copy_from_slice(&8_000_u32.to_be_bytes());
    bytes[20..24].copy_from_slice(&6_000_u32.to_be_bytes());
    let mut crc = !0_u32;
    for &byte in &bytes[12..29] {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & 0_u32.wrapping_sub(crc & 1));
        }
    }
    bytes[29..33].copy_from_slice(&(!crc).to_be_bytes());
    assert!(matches!(
        preprocess(&bytes, 1, &Cancel::never()),
        Err(ImageError::PixelLimit)
    ));
}

fn webp_container(chunks: &[(&[u8; 4], &[u8])]) -> Vec<u8> {
    let mut body = b"WEBP".to_vec();
    for (kind, data) in chunks {
        body.extend_from_slice(*kind);
        body.extend_from_slice(&(data.len() as u32).to_le_bytes());
        body.extend_from_slice(data);
        if data.len() % 2 != 0 {
            body.push(0);
        }
    }
    let mut bytes = b"RIFF".to_vec();
    bytes.extend_from_slice(&(body.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&body);
    bytes
}

#[test]
fn claimed_metadata_ranges_are_rejected_before_decoder_metadata_reads() {
    for kind in [b"EXIF", b"ICCP", b"XMP "] {
        let mut bytes = webp_container(&[
            (b"VP8X", &[8, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
            (b"VP8L", &[47, 0, 0, 0, 0]),
            (kind, &[]),
        ]);
        let length = bytes.len();
        // Keep the red case safe: the missing guard allocates only64KiB, then returns Decode.
        bytes[length - 4..].copy_from_slice(&65_536_u32.to_le_bytes());
        assert!(matches!(
            preprocess(&bytes, 1, &Cancel::never()),
            Err(ImageError::InvalidContainer)
        ));
    }
    for bytes in [
        b"\x89PNG\r\n\x1a\n\x00\x01\x00\x00eXIf".as_slice(),
        b"\xff\xd8\xff\xe1\xff\xff".as_slice(),
    ] {
        assert!(matches!(
            preprocess(bytes, 1, &Cancel::never()),
            Err(ImageError::InvalidContainer)
        ));
    }
}

#[test]
fn webp_inner_dimensions_must_match_the_bounded_canvas_and_frame() {
    let vp8 = [0, 0, 0, 157, 1, 42, 16, 0, 16, 0];
    let bytes = webp_container(&[(b"VP8X", &[0; 10]), (b"VP8 ", &vp8)]);
    assert!(matches!(
        preprocess(&bytes, 1, &Cancel::never()),
        Err(ImageError::InvalidContainer)
    ));
    let mut frame = vec![0; 16];
    frame.extend_from_slice(b"VP8 ");
    frame.extend_from_slice(&10_u32.to_le_bytes());
    frame.extend_from_slice(&vp8);
    let bytes = webp_container(&[
        (b"VP8X", &[2, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        (b"ANIM", &[0; 6]),
        (b"ANMF", &frame),
    ]);
    assert!(matches!(
        preprocess(&bytes, 1, &Cancel::never()),
        Err(ImageError::InvalidContainer)
    ));
}

#[test]
fn webp_preflight_checks_padding_nested_ranges_and_valid_inner_headers() {
    let vp8 = [0, 0, 0, 157, 1, 42, 1, 0, 1, 0];
    let canvas = [0; 10];
    let bytes = webp_container(&[(b"VP8X", &canvas), (b"VP8 ", &vp8)]);
    container::validate(&bytes, ImageFormat::WebP, &Cancel::never()).unwrap();
    let mut frame = vec![0; 16];
    frame.extend_from_slice(b"VP8 ");
    frame.extend_from_slice(&10_u32.to_le_bytes());
    frame.extend_from_slice(&vp8);
    let bytes = webp_container(&[(b"VP8X", &canvas), (b"ANMF", &frame)]);
    container::validate(&bytes, ImageFormat::WebP, &Cancel::never()).unwrap();
    frame[20..24].copy_from_slice(&65_536_u32.to_le_bytes());
    let bytes = webp_container(&[(b"VP8X", &canvas), (b"ANMF", &frame)]);
    assert!(matches!(
        container::validate(&bytes, ImageFormat::WebP, &Cancel::never()),
        Err(ImageError::InvalidContainer)
    ));
    let mut bytes = webp_container(&[(b"VP8L", &[47, 0, 0, 0, 0])]);
    bytes.pop();
    let riff_size = bytes.len() as u32 - 8;
    bytes[4..8].copy_from_slice(&riff_size.to_le_bytes());
    assert!(matches!(
        container::validate(&bytes, ImageFormat::WebP, &Cancel::never()),
        Err(ImageError::InvalidContainer)
    ));
}
