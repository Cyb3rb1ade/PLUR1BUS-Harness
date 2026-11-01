//! Explicit deterministic encoder seam for host-authorized orchestration tests, never auto-selected.

use super::audio::AudioTensor;
use super::embedder::{
    validate_features, MediaEncoder, MediaError, MediaModality, FEATURE_WIDTH, MEDIA_DIMENSIONS,
};
use super::image::ImageTensor;
use crate::contract::Cancel;

/// Deterministic graph-output seam; it does not claim semantic quality or real-model acceptance.
pub struct FlatMediaEncoder {
    _private: (),
}

impl FlatMediaEncoder {
    /// Require the explicit test-internals gate before constructing a seam connected to any host.
    pub fn authorized() -> Result<Self, MediaError> {
        if std::env::var("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref() != Ok("1") {
            return Err(MediaError::InvalidProfile);
        }
        Ok(Self { _private: () })
    }

    #[cfg(test)]
    pub(crate) fn for_test() -> Self {
        Self { _private: () }
    }
}

impl MediaEncoder for FlatMediaEncoder {
    fn vision(&self, images: &[ImageTensor], cancel: &Cancel) -> Result<Vec<f32>, MediaError> {
        cancel.check()?;
        if images.is_empty() || images.len() > 4 {
            return Err(MediaError::InvalidTensor);
        }
        let rows = images
            .iter()
            .try_fold(0usize, |total, image| total.checked_add(image.soft_tokens))
            .ok_or(MediaError::ResourceLimit)?;
        if rows == 0 || rows > 4 * 280 {
            return Err(MediaError::InvalidTensor);
        }
        Ok(vec![1.0; rows * FEATURE_WIDTH])
    }
    fn audio(&self, audio: &AudioTensor, cancel: &Cancel) -> Result<Vec<f32>, MediaError> {
        cancel.check()?;
        if audio.soft_tokens == 0 || audio.soft_tokens > 750 {
            return Err(MediaError::InvalidTensor);
        }
        Ok(vec![1.0; audio.soft_tokens * FEATURE_WIDTH])
    }
    fn fuse(
        &self,
        modality: MediaModality,
        features: &[f32],
        cancel: &Cancel,
    ) -> Result<Vec<f32>, MediaError> {
        cancel.check()?;
        validate_features(features, features.len() / FEATURE_WIDTH)?;
        let mut vector = vec![0.0; MEDIA_DIMENSIONS];
        vector[match modality {
            MediaModality::Image => 0,
            MediaModality::Audio => 1,
            MediaModality::Video => 2,
        }] = 3.0;
        vector[3] = 4.0;
        Ok(vector)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use crate::media::embedder::{LocalMediaEmbedder, MediaEmbedder, MediaInput, VideoFrame};
    use crate::media::identity::test_text_identity;
    use std::sync::Arc;
    fn image() -> Vec<u8> {
        let rgb = ::image::RgbImage::from_pixel(48, 48, ::image::Rgb([1, 2, 3]));
        let mut output = std::io::Cursor::new(Vec::new());
        rgb.write_to(&mut output, ::image::ImageFormat::Png)
            .unwrap();
        output.into_inner()
    }
    #[test]
    fn explicit_flat_boundary_returns_normalized_vectors_and_original_frame_indices() {
        let provider = LocalMediaEmbedder::with_encoder(
            test_text_identity(),
            Arc::new(FlatMediaEncoder::for_test()),
        )
        .unwrap();
        let encoded = image();
        let result = provider
            .embed(&MediaInput::Image(&encoded), &Cancel::never())
            .unwrap();
        assert_eq!(result.segments.len(), 1);
        assert_eq!(result.segments[0].vector[0], 0.6);
        assert_eq!(result.segments[0].vector[3], 0.8);
        let frames: Vec<_> = (0..5)
            .map(|i| VideoFrame {
                bytes: &encoded,
                timestamp_ms: i * 1000,
            })
            .collect();
        let result = provider
            .embed(&MediaInput::Video(&frames), &Cancel::never())
            .unwrap();
        assert_eq!(result.segments.len(), 5);
        for (i, segment) in result.segments.iter().enumerate() {
            assert_eq!(segment.source_index, Some(i));
            assert_eq!(segment.start_ms, Some(i as u64 * 1000));
            assert_eq!(segment.vector.len(), 768);
        }
        let cancel = Cancel::never();
        cancel.cancel();
        assert!(matches!(
            provider.embed(&MediaInput::Image(&encoded), &cancel),
            Err(MediaError::Cancelled(_))
        ));
    }
    #[test]
    fn audio_keeps_a_short_final_tail_as_a_distinct_normalized_segment() {
        let provider = LocalMediaEmbedder::with_encoder(
            test_text_identity(),
            Arc::new(FlatMediaEncoder::for_test()),
        )
        .unwrap();
        let samples = vec![0.0; 480001];
        let result = provider
            .embed(&MediaInput::Audio(&samples), &Cancel::never())
            .unwrap();
        assert_eq!(result.segments.len(), 2);
        assert_eq!(result.segments[0].start_ms, Some(0));
        assert_eq!(result.segments[0].end_ms, result.segments[1].start_ms);
        assert_eq!(result.segments[1].end_ms, Some(30000));
        assert!(result
            .segments
            .iter()
            .all(|segment| segment.vector[1] == 0.6 && segment.vector[3] == 0.8));
    }
}
