//! Bounded, unpadded 16 kHz mono Gemma4 log-Mel preprocessing (MM-1).

use super::fft::{magnitudes, FFT_LENGTH, FREQUENCY_BINS};
use crate::contract::Cancel;
use std::fmt;
use std::ops::Range;

/// Maximum samples in one 30-second 16 kHz MM-1 audio window.
pub const MAX_WINDOW_SAMPLES: usize = 480_000;

/// A validated processor configuration for deterministic Gemma4 preprocessing.
#[derive(Clone, Debug)]
pub struct AudioProfile {
    feature_size: usize,
    frame_length: usize,
    hop_length: usize,
    mel_floor: f64,
    window: Vec<f32>,
    mel_filters: Vec<f64>,
}

impl AudioProfile {
    /// Validate explicit audio settings from the pinned processor JSON, without defaults.
    pub fn from_processor_config(processor: &serde_json::Value) -> Result<Self, AudioError> {
        let config = processor
            .get("feature_extractor")
            .ok_or(AudioError::InvalidProfile)?;
        // These are the explicit settings recovered from revision daa72c51243991dfcaf9f9137d2c573d8f7790c0.
        // Refuse unsupported modes instead of silently applying the deterministic MM-1 path to them.
        let supported = serde_json::json!({
            "feature_extractor_type": "Gemma4AudioFeatureExtractor",
            "feature_size": 128, "sampling_rate": 16000,
            "fft_length": 512, "frame_length": 320, "hop_length": 160,
            "fft_overdrive": false, "dither": 0.0, "input_scale_factor": 1.0,
            "min_frequency": 0.0, "max_frequency": 8000.0, "mel_floor": 0.001,
            "padding_side": "right", "padding_value": 0.0,
            "return_attention_mask": true, "preemphasis": 0.0,
            "preemphasis_htk_flavor": true, "per_bin_mean": null, "per_bin_stddev": null
        });
        if config != &supported {
            return Err(AudioError::InvalidProfile);
        }
        let frame_length = 320;
        let feature_size = 128;
        let window = (0..frame_length)
            .map(|index| {
                (0.5 - 0.5
                    * (2.0 * std::f64::consts::PI * index as f64 / frame_length as f64).cos())
                    as f32
            })
            .collect();
        Ok(Self {
            feature_size,
            frame_length,
            hop_length: 160,
            mel_floor: 0.001,
            window,
            mel_filters: mel_filters(feature_size),
        })
    }
}

/// Owned frame-major features and their matching boolean validity mask.
#[derive(Clone, Debug, PartialEq)]
pub struct AudioTensor {
    /// Flattened `[frames, feature_size]` natural-log Mel features.
    pub features: Vec<f32>,
    /// One validity bit per frame; no waveform padding is introduced here.
    pub mask: Vec<bool>,
    /// Number of output frames.
    pub frames: usize,
    /// Number of Mel bins in each frame.
    pub feature_size: usize,
    /// Number of valid soft tokens after the encoder's two stride-two layers.
    pub soft_tokens: usize,
}

/// Refusal at the bounded audio preprocessing edge.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AudioError {
    /// The processor configuration is incomplete or not supported by this implementation.
    InvalidProfile,
    /// No audio samples were supplied.
    EmptyInput,
    /// A nonfinite mono audio sample was supplied.
    NonfiniteInput,
    /// More than one 30-second window was supplied; use [`window_ranges`].
    WindowTooLong,
    /// Caller cancellation or a deadline stopped preprocessing.
    Cancelled,
}

impl fmt::Display for AudioError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidProfile => "audio processor settings are incomplete or unsupported",
            Self::EmptyInput => "audio window is empty; supply finite 16 kHz mono samples",
            Self::NonfiniteInput => "audio window contains nonfinite samples",
            Self::WindowTooLong => "audio window exceeds 30 seconds; split it with window_ranges",
            Self::Cancelled => "audio preprocessing was cancelled",
        })
    }
}

impl std::error::Error for AudioError {}

/// Split an arbitrary sample count into consecutive windows without losing the final tail.
pub fn window_ranges(sample_count: usize) -> impl Iterator<Item = Range<usize>> {
    (0..sample_count)
        .step_by(MAX_WINDOW_SAMPLES)
        .map(move |start| start..start.saturating_add(MAX_WINDOW_SAMPLES).min(sample_count))
}

/// Preprocess one finite 16 kHz mono window without truncation or waveform padding.
/// Windows too short for `unfold(frame_length + 1)` yield zero frames and soft tokens.
pub fn preprocess(
    samples: &[f32],
    profile: &AudioProfile,
    cancel: &Cancel,
) -> Result<AudioTensor, AudioError> {
    check_cancel(cancel)?;
    if samples.is_empty() {
        return Err(AudioError::EmptyInput);
    }
    if samples.len() > MAX_WINDOW_SAMPLES {
        return Err(AudioError::WindowTooLong);
    }
    if samples.iter().any(|sample| !sample.is_finite()) {
        return Err(AudioError::NonfiniteInput);
    }
    check_cancel(cancel)?;
    let padded_length = samples.len() + profile.frame_length / 2;
    let frames = if padded_length > profile.frame_length {
        (padded_length - profile.frame_length - 1) / profile.hop_length + 1
    } else {
        0
    };
    let mut features = Vec::with_capacity(frames * profile.feature_size);
    for frame in 0..frames {
        check_cancel(cancel)?;
        let buffer = analysis_frame(samples, frame, profile);
        let spectrum = magnitudes(&buffer);
        for filter in profile.mel_filters.chunks_exact(FREQUENCY_BINS) {
            let mel: f64 = filter
                .iter()
                .zip(spectrum)
                .map(|(weight, value)| weight * value)
                .sum();
            features.push((mel + profile.mel_floor).ln() as f32);
        }
    }
    check_cancel(cancel)?;
    Ok(AudioTensor {
        features,
        mask: vec![true; frames],
        frames,
        feature_size: profile.feature_size,
        // EmbeddingGemma2Processor._process_audio sums mask[0], mask[4], ... without
        // applying its generic Gemma4 parent's audio_seq_length cap. No right padding
        // means every produced frame is valid, including the first semicausal frame.
        soft_tokens: frames.div_ceil(4),
    })
}

fn analysis_frame(samples: &[f32], frame: usize, profile: &AudioProfile) -> [f64; FFT_LENGTH] {
    let mut buffer = [0.0; FFT_LENGTH];
    let left_padding = profile.frame_length / 2;
    for (index, sample) in buffer.iter_mut().enumerate().take(profile.frame_length) {
        let position = frame * profile.hop_length + index;
        if position >= left_padding {
            // Python multiplies a float32 waveform by a float32 Hann window before its double FFT.
            *sample = f64::from(samples[position - left_padding] * profile.window[index]);
        }
    }
    buffer
}

fn mel_filters(feature_size: usize) -> Vec<f64> {
    let maximum_mel = 2595.0 * (1.0_f64 + 8000.0 / 700.0).log10();
    let frequencies: Vec<f64> = (0..feature_size + 2)
        .map(|index| {
            let mel = maximum_mel * index as f64 / (feature_size + 1) as f64;
            700.0 * (10.0_f64.powf(mel / 2595.0) - 1.0)
        })
        .collect();
    let mut filters = Vec::with_capacity(feature_size * FREQUENCY_BINS);
    for triangle in frequencies.windows(3) {
        for bin in 0..FREQUENCY_BINS {
            let frequency = bin as f64 * 8000.0 / (FREQUENCY_BINS - 1) as f64;
            let rising = (frequency - triangle[0]) / (triangle[1] - triangle[0]);
            let falling = (triangle[2] - frequency) / (triangle[2] - triangle[1]);
            filters.push(rising.min(falling).max(0.0));
        }
    }
    filters
}

fn check_cancel(cancel: &Cancel) -> Result<(), AudioError> {
    cancel.check().map_err(|_| AudioError::Cancelled)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;

    fn processor() -> serde_json::Value {
        serde_json::json!({
            "audio_ms_per_token": 40, "audio_seq_length": 280,
            "feature_extractor": {
                "feature_extractor_type": "Gemma4AudioFeatureExtractor",
                "feature_size": 128, "sampling_rate": 16000,
                "fft_length": 512, "frame_length": 320, "hop_length": 160,
                "fft_overdrive": false, "dither": 0.0, "input_scale_factor": 1.0,
                "min_frequency": 0.0, "max_frequency": 8000.0, "mel_floor": 0.001,
                "padding_side": "right", "padding_value": 0.0,
                "return_attention_mask": true, "preemphasis": 0.0,
                "preemphasis_htk_flavor": true, "per_bin_mean": null, "per_bin_stddev": null
            }
        })
    }

    fn profile() -> AudioProfile {
        AudioProfile::from_processor_config(&processor()).unwrap()
    }

    #[test]
    fn missing_and_unsupported_settings_are_refused_without_defaults() {
        assert!(AudioProfile::from_processor_config(&serde_json::json!({})).is_err());
        for (key, value) in [
            ("sampling_rate", serde_json::json!(48000)),
            ("feature_size", serde_json::json!(usize::MAX)),
            ("fft_overdrive", serde_json::json!(true)),
            ("dither", serde_json::json!(0.1)),
            ("per_bin_mean", serde_json::json!([1.0])),
            ("preemphasis_htk_flavor", serde_json::json!(false)),
        ] {
            let mut config = processor();
            config["feature_extractor"][key] = value;
            assert!(
                AudioProfile::from_processor_config(&config).is_err(),
                "{key}"
            );
        }
    }

    #[test]
    fn invalid_windows_fail_before_spectrogram_allocation() {
        let profile = profile();
        assert_eq!(
            preprocess(&[], &profile, &Cancel::never()),
            Err(AudioError::EmptyInput)
        );
        for sample in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            assert_eq!(
                preprocess(&[sample], &profile, &Cancel::never()),
                Err(AudioError::NonfiniteInput)
            );
        }
        assert_eq!(
            preprocess(
                &vec![0.0; MAX_WINDOW_SAMPLES + 1],
                &profile,
                &Cancel::never()
            ),
            Err(AudioError::WindowTooLong)
        );
    }

    #[test]
    fn cancellation_is_checked_before_work() {
        let cancel = Cancel::never();
        cancel.cancel();
        assert_eq!(
            preprocess(&[0.0; 320], &profile(), &cancel),
            Err(AudioError::Cancelled)
        );
    }

    #[test]
    fn semicausal_unfold_counts_the_extra_sample_and_preserves_the_first_frame() {
        let profile = profile();
        for (samples, frames, tokens) in [
            (1, 0, 0),
            (160, 0, 0),
            (161, 1, 1),
            (320, 1, 1),
            (321, 2, 1),
            (801, 5, 2),
        ] {
            let tensor = preprocess(&vec![0.0; samples], &profile, &Cancel::never()).unwrap();
            assert_eq!(tensor.frames, frames, "{samples} samples");
            assert_eq!(tensor.mask, vec![true; frames], "{samples} samples");
            assert_eq!(tensor.features.len(), frames * 128);
            assert_eq!(tensor.soft_tokens, tokens, "{samples} samples");
        }
    }

    #[test]
    fn thirty_seconds_preserves_all_seven_hundred_fifty_audio_tokens() {
        let tensor =
            preprocess(&vec![0.0; MAX_WINDOW_SAMPLES], &profile(), &Cancel::never()).unwrap();
        assert_eq!(tensor.frames, 2999);
        assert_eq!(tensor.soft_tokens, 750);
        assert!(tensor
            .features
            .iter()
            .all(|feature| (*feature - -6.907_755_4).abs() < 1e-6));
        assert!(tensor.mask.iter().all(|valid| *valid));
    }

    #[test]
    fn window_ranges_keep_every_sample_past_thirty_seconds() {
        assert_eq!(
            window_ranges(0).collect::<Vec<_>>(),
            Vec::<Range<usize>>::new()
        );
        assert_eq!(
            window_ranges(960_001).collect::<Vec<_>>(),
            vec![0..480_000, 480_000..960_000, 960_000..960_001]
        );
        assert_eq!(window_ranges(480_000).collect::<Vec<_>>(), vec![0..480_000]);
    }
}
