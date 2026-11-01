//! Bounded media orchestration with explicit encoder injection and per-segment provenance.

use super::audio::{self, AudioProfile, AudioTensor};
use super::identity::MediaSpaceIdentity;
use super::image::{self, ImageTensor};
use super::video::VideoPlan;
use crate::contract::{Cancel, Cancelled, VectorSpaceIdentity};
use std::fmt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Native width of every stored media vector; MM-1 never projects it to an MRL width.
pub const MEDIA_DIMENSIONS: usize = 768;
/// Encoder feature width consumed by the pinned media-conditioned text graph.
pub const FEATURE_WIDTH: usize = 512;

/// Provenance of an independently searchable vector.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaModality {
    /// A complete image.
    Image,
    /// One contiguous window of mono 16 kHz audio.
    Audio,
    /// One sampled frame from a video.
    Video,
}

/// Borrowed encoded frame and caller-supplied monotonic presentation time.
#[derive(Clone, Copy, Debug)]
pub struct VideoFrame<'a> {
    /// JPEG, PNG or WebP image bytes.
    pub bytes: &'a [u8],
    /// Milliseconds from the beginning of the video.
    pub timestamp_ms: u64,
}

/// Decoded-by-host audio or bounded encoded images; paths and ffmpeg stay outside this library.
#[derive(Clone, Copy, Debug)]
pub enum MediaInput<'a> {
    /// A JPEG, PNG or WebP image.
    Image(&'a [u8]),
    /// Finite mono samples already resampled to 16 kHz by the host.
    Audio(&'a [f32]),
    /// Ordered encoded frames; uniformly sampled to at most 32 frames.
    Video(&'a [VideoFrame<'a>]),
}

/// A normalized native-width vector and its original media interval.
#[derive(Clone, Debug, PartialEq)]
pub struct MediaSegment {
    /// Exactly 768 finite L2-normalized values.
    pub vector: Vec<f32>,
    /// The source media family.
    pub modality: MediaModality,
    /// Inclusive start timestamp where applicable.
    pub start_ms: Option<u64>,
    /// Exclusive audio end, or the sampled frame timestamp for a video frame.
    pub end_ms: Option<u64>,
    /// Index of the source video frame; absent for image and audio.
    pub source_index: Option<usize>,
}

/// Every resulting segment; no audio tail or selected video frame is silently collapsed.
#[derive(Clone, Debug, PartialEq)]
pub struct MediaEmbedding {
    /// Ordered independent segments for later one-segment-per-row persistence.
    pub segments: Vec<MediaSegment>,
}

/// Mathematical support; availability of host-prepared graph files is checked lazily.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MediaCapabilities {
    /// Encoded image input is supported.
    pub image: bool,
    /// Mono 16 kHz audio input is supported.
    pub audio: bool,
    /// Encoded video-frame input is supported.
    pub video: bool,
    /// Native output width.
    pub dimensions: usize,
}

/// Typed, bounded failures; native error text and media contents are never retained.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MediaError {
    /// Explicit caller cancellation or monotonic deadline expiry.
    Cancelled(Cancelled),
    /// Input is empty, too short, nonfinite or has inconsistent metadata.
    InvalidInput,
    /// A graph tensor has an unexpected name, type, size or nonfinite value.
    InvalidTensor,
    /// The requested profile or text identity does not match the pinned native q8 space.
    InvalidProfile,
    /// No supported q8 media target matches this host.
    UnsupportedPlatform,
    /// Input or direct media-token sequence exceeds a bounded resource limit.
    ResourceLimit,
    /// Host preparation has not supplied a readable regular file.
    ArtifactMissing {
        /// Catalogue-relative filename, without host directories.
        file: String,
    },
    /// Host cache file length differs from the immutable pin.
    ArtifactSize {
        /// Catalogue-relative filename.
        file: String,
    },
    /// Host cache file hash differs from the immutable pin.
    ArtifactHash {
        /// Catalogue-relative filename.
        file: String,
    },
    /// The host has not initialized the shared runtime or provided its library path.
    RuntimeUnavailable,
    /// A native operation or worker failed; details are intentionally not retained.
    RuntimeFailed,
}

impl From<Cancelled> for MediaError {
    fn from(value: Cancelled) -> Self {
        Self::Cancelled(value)
    }
}
impl fmt::Display for MediaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled(_) => f.write_str("media embedding cancelled"),
            Self::InvalidInput => f.write_str("invalid media input"),
            Self::InvalidTensor => f.write_str("invalid media graph tensor"),
            Self::InvalidProfile => f.write_str("incompatible media profile or text identity"),
            Self::UnsupportedPlatform => f.write_str("unsupported media platform"),
            Self::ResourceLimit => f.write_str("media resource limit exceeded"),
            Self::ArtifactMissing { file } => {
                write!(f, "host must prepare pinned media artifact: {file}")
            }
            Self::ArtifactSize { file } => write!(f, "media artifact size mismatch: {file}"),
            Self::ArtifactHash { file } => write!(f, "media artifact SHA-256 mismatch: {file}"),
            Self::RuntimeUnavailable => f.write_str("media runtime unavailable"),
            Self::RuntimeFailed => f.write_str("media runtime failed"),
        }
    }
}
impl std::error::Error for MediaError {}

/// Independent media provider beside the unchanged text `EmbeddingProvider` contract.
pub trait MediaEmbedder: Send + Sync {
    /// Complete versioned media-space identity for every returned vector.
    fn identity(&self) -> &MediaSpaceIdentity;
    /// Supported inputs and native output width, independent of lazy file readiness.
    fn capabilities(&self) -> MediaCapabilities;
    /// Embed every selected segment under the caller's shared cancellation budget.
    fn embed(&self, input: &MediaInput<'_>, cancel: &Cancel) -> Result<MediaEmbedding, MediaError>;
}

/// Explicit graph boundary shared by production ORT and deliberately injected test encoders.
pub trait MediaEncoder: Send + Sync {
    /// Produce concatenated finite `[sum(soft_tokens),512]` features for one bounded image batch.
    fn vision(&self, images: &[ImageTensor], cancel: &Cancel) -> Result<Vec<f32>, MediaError>;
    /// Produce finite `[soft_tokens,512]` features for one unpadded audio window.
    fn audio(&self, audio: &AudioTensor, cancel: &Cancel) -> Result<Vec<f32>, MediaError>;
    /// Combine one item's validated features and direct placeholder IDs into a native-width vector.
    fn fuse(
        &self,
        modality: MediaModality,
        features: &[f32],
        cancel: &Cancel,
    ) -> Result<Vec<f32>, MediaError>;
}

/// Lazy local media provider; construction reads no files and initializes no native session.
pub struct LocalMediaEmbedder {
    identity: MediaSpaceIdentity,
    encoder: Arc<dyn MediaEncoder>,
    audio_profile: AudioProfile,
    admission: Mutex<()>,
}

impl LocalMediaEmbedder {
    /// Construct real independent q8 sessions from a host-prepared cache root and compatible text identity.
    pub fn new(
        cache_root: PathBuf,
        text_identity: VectorSpaceIdentity,
    ) -> Result<Self, MediaError> {
        super::artifacts::platform_dtypes(std::env::consts::OS, std::env::consts::ARCH)?;
        Self::with_encoder(
            text_identity,
            Arc::new(super::session::SessionMediaEncoder::new(cache_root)),
        )
    }

    /// Explicitly inject an encoder boundary. Hosts must authorize any non-production test encoder.
    pub fn with_encoder(
        text_identity: VectorSpaceIdentity,
        encoder: Arc<dyn MediaEncoder>,
    ) -> Result<Self, MediaError> {
        let identity = MediaSpaceIdentity::new(text_identity)?;
        let audio_profile = AudioProfile::from_processor_config(&serde_json::json!({"feature_extractor": {
            "feature_extractor_type":"Gemma4AudioFeatureExtractor","feature_size":128,"sampling_rate":16000,
            "fft_length":512,"frame_length":320,"hop_length":160,"fft_overdrive":false,"dither":0.0,
            "input_scale_factor":1.0,"min_frequency":0.0,"max_frequency":8000.0,"mel_floor":0.001,
            "padding_side":"right","padding_value":0.0,"return_attention_mask":true,"preemphasis":0.0,
            "preemphasis_htk_flavor":true,"per_bin_mean":null,"per_bin_stddev":null
        }})).map_err(|_| MediaError::InvalidProfile)?;
        Ok(Self {
            identity,
            encoder,
            audio_profile,
            admission: Mutex::new(()),
        })
    }

    fn segment(
        &self,
        modality: MediaModality,
        features: &[f32],
        expected: usize,
        cancel: &Cancel,
    ) -> Result<MediaSegment, MediaError> {
        validate_features(features, expected)?;
        cancel.check()?;
        let vector = normalize(self.encoder.fuse(modality, features, cancel)?)?;
        cancel.check()?;
        Ok(MediaSegment {
            vector,
            modality,
            start_ms: None,
            end_ms: None,
            source_index: None,
        })
    }

    fn embed_inner(
        &self,
        input: &MediaInput<'_>,
        cancel: &Cancel,
    ) -> Result<MediaEmbedding, MediaError> {
        cancel.check()?;
        let mut segments = Vec::new();
        match input {
            MediaInput::Image(bytes) => {
                let tensor = image::preprocess(bytes, 140, cancel).map_err(image_error)?;
                let expected = tensor.soft_tokens;
                let features = self.encoder.vision(&[tensor], cancel)?;
                segments.push(self.segment(MediaModality::Image, &features, expected, cancel)?);
            }
            MediaInput::Audio(samples) => {
                for range in audio_ranges(samples.len())? {
                    cancel.check()?;
                    let tensor =
                        audio::preprocess(&samples[range.clone()], &self.audio_profile, cancel)
                            .map_err(|error| match error {
                                audio::AudioError::Cancelled => cancel
                                    .check()
                                    .err()
                                    .map(MediaError::Cancelled)
                                    .unwrap_or(MediaError::RuntimeFailed),
                                _ => MediaError::InvalidInput,
                            })?;
                    let features = self.encoder.audio(&tensor, cancel)?;
                    let mut segment =
                        self.segment(MediaModality::Audio, &features, tensor.soft_tokens, cancel)?;
                    segment.start_ms = Some((range.start as u64) * 1000 / 16000);
                    segment.end_ms = Some((range.end as u64) * 1000 / 16000);
                    segments.push(segment);
                }
            }
            MediaInput::Video(frames) => {
                if frames
                    .windows(2)
                    .any(|pair| pair[0].timestamp_ms > pair[1].timestamp_ms)
                {
                    return Err(MediaError::InvalidInput);
                }
                let plan = VideoPlan::new(frames.len()).map_err(|_| MediaError::InvalidInput)?;
                for batch in &plan.batches {
                    cancel.check()?;
                    let tensors = plan.indices[batch.clone()]
                        .iter()
                        .map(|index| {
                            image::preprocess(frames[*index].bytes, 70, cancel).map_err(image_error)
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    let features = self.encoder.vision(&tensors, cancel)?;
                    let expected = tensors.iter().map(|tensor| tensor.soft_tokens).sum();
                    validate_features(&features, expected)?;
                    let mut offset = 0;
                    for (tensor, index) in tensors.iter().zip(&plan.indices[batch.clone()]) {
                        let end = offset + tensor.soft_tokens * FEATURE_WIDTH;
                        let mut segment = self.segment(
                            MediaModality::Video,
                            &features[offset..end],
                            tensor.soft_tokens,
                            cancel,
                        )?;
                        segment.start_ms = Some(frames[*index].timestamp_ms);
                        segment.end_ms = segment.start_ms;
                        segment.source_index = Some(*index);
                        segments.push(segment);
                        offset = end;
                    }
                }
            }
        }
        cancel.check()?;
        Ok(MediaEmbedding { segments })
    }
}

impl MediaEmbedder for LocalMediaEmbedder {
    fn identity(&self) -> &MediaSpaceIdentity {
        &self.identity
    }
    fn capabilities(&self) -> MediaCapabilities {
        MediaCapabilities {
            image: true,
            audio: true,
            video: true,
            dimensions: MEDIA_DIMENSIONS,
        }
    }
    fn embed(&self, input: &MediaInput<'_>, cancel: &Cancel) -> Result<MediaEmbedding, MediaError> {
        cancel.check()?;
        let _admission = super::session::lock_cancel(&self.admission, cancel)?;
        // The low-priority worker owns all preprocessing and native runs; caller thread priority is preserved.
        std::thread::scope(|scope| {
            let worker = std::thread::Builder::new()
                .name("media-background".into())
                .spawn_scoped(scope, || {
                    super::session::lower_worker_priority()?;
                    self.embed_inner(input, cancel)
                })
                .map_err(|_| MediaError::RuntimeFailed)?;
            worker.join().map_err(|_| MediaError::RuntimeFailed)?
        })
    }
}

#[allow(clippy::needless_pass_by_value)] // Result::map_err consumes the decoder error; retain no native metadata.
fn image_error(error: image::ImageError) -> MediaError {
    match error {
        image::ImageError::Cancelled(reason) => MediaError::Cancelled(reason),
        image::ImageError::EncodedLimit
        | image::ImageError::PixelLimit
        | image::ImageError::AllocationLimit => MediaError::ResourceLimit,
        _ => MediaError::InvalidInput,
    }
}

pub(crate) fn validate_features(features: &[f32], rows: usize) -> Result<(), MediaError> {
    if rows == 0
        || rows.checked_mul(FEATURE_WIDTH) != Some(features.len())
        || features.iter().any(|value| !value.is_finite())
    {
        return Err(MediaError::InvalidTensor);
    }
    Ok(())
}

fn normalize(mut vector: Vec<f32>) -> Result<Vec<f32>, MediaError> {
    if vector.len() != MEDIA_DIMENSIONS || vector.iter().any(|value| !value.is_finite()) {
        return Err(MediaError::InvalidTensor);
    }
    let norm = vector
        .iter()
        .map(|value| f64::from(*value).powi(2))
        .sum::<f64>()
        .sqrt();
    if !norm.is_finite() || norm <= 0.0 {
        return Err(MediaError::InvalidTensor);
    }
    for value in &mut vector {
        *value = (f64::from(*value) / norm) as f32;
    }
    Ok(vector)
}

fn audio_ranges(count: usize) -> Result<Vec<std::ops::Range<usize>>, MediaError> {
    if count < 161 {
        return Err(MediaError::InvalidInput);
    }
    let mut ranges: Vec<_> = audio::window_ranges(count).collect();
    if ranges.len() > 1 && ranges.last().is_some_and(|range| range.len() < 161) {
        let last = ranges.len() - 1;
        let boundary = count - 161;
        ranges[last - 1].end = boundary;
        ranges[last].start = boundary;
    }
    Ok(ranges)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    #[test]
    fn normalization_refuses_bad_width_nonfinite_and_zero_but_handles_huge_finite_vectors() {
        assert!(normalize(vec![0.0; 768]).is_err());
        assert!(normalize(vec![1.0; 512]).is_err());
        assert!(normalize(vec![f32::INFINITY; 768]).is_err());
        let vector = normalize(vec![f32::MAX; 768]).unwrap();
        assert!((vector.iter().map(|v| f64::from(*v).powi(2)).sum::<f64>() - 1.0).abs() < 1e-6);
    }
    #[test]
    fn audio_windows_preserve_every_sample_even_a_single_sample_tail() {
        for count in [161, 480000, 480001, 480160, 480161, 960001] {
            let ranges = audio_ranges(count).unwrap();
            assert_eq!(ranges.first().unwrap().start, 0);
            assert_eq!(ranges.last().unwrap().end, count);
            assert!(ranges
                .iter()
                .all(|range| (161..=480000).contains(&range.len())));
            assert!(ranges.windows(2).all(|pair| pair[0].end == pair[1].start));
            assert_eq!(ranges.iter().map(|range| range.len()).sum::<usize>(), count);
        }
    }
}
