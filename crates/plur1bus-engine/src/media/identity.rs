//! Separate, versioned media-space identity; the Node text identity algorithm stays unchanged.

use super::artifacts::{graph_files, text_profile, MediaGraph, MODEL, REPOSITORY, REVISION};
use super::embedder::{MediaError, MediaSettings};
use crate::contract::VectorSpaceIdentity;
use crate::embedding::artifacts::ArtifactFile;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Complete immutable media pipeline description, independent of the text table's identity.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSpaceIdentity {
    /// Identity of the compatible existing native-width q8 text space.
    pub text_vector_space_identity: VectorSpaceIdentity,
    /// Source repository for the immutable encoder exports.
    pub artifact_repository: String,
    /// Commit pin shared by all three graph families.
    pub artifact_revision: String,
    /// Vision graph quantization; MM-1 accepts only q8.
    pub vision_dtype: String,
    /// Audio graph quantization; always q8.
    pub audio_dtype: String,
    /// Vision graph and external-weight sizes and hashes.
    pub vision_artifacts: Vec<ArtifactFile>,
    /// Audio graph and external-weight sizes and hashes.
    pub audio_artifacts: Vec<ArtifactFile>,
    /// Versioned decode, orientation, white-alpha-composite, PIL bicubic and patch path.
    pub image_preprocessing: String,
    /// Versioned unpadded 16 kHz mono FFT/Mel path and segmentation rule.
    pub audio_preprocessing: String,
    /// Versioned direct placeholder-ID and BOS/EOS construction rule.
    pub tokenization: String,
    /// Maximum pooled features for a photo.
    pub image_soft_tokens: usize,
    /// Maximum pooled features for each sampled video frame.
    pub video_soft_tokens: usize,
    /// Maximum sampled frames per video.
    pub max_video_frames: usize,
    /// Versioned deterministic frame selection and batching rule.
    pub video_sampling: String,
    /// Minimum and maximum frames in each encoder batch.
    pub video_batch_range: [usize; 2],
    /// Native normalized output width, with no media MRL projection.
    pub dimensions: usize,
}

impl MediaSpaceIdentity {
    /// Validate the real q8 text-space identity and build the fixed MM-1 media profile.
    pub fn new(text: VectorSpaceIdentity) -> Result<Self, MediaError> {
        Self::new_with_settings(text, MediaSettings::default())
    }

    /// Build an identity for the same validated budgets actually selected by the media provider.
    #[allow(clippy::needless_pass_by_value)] // Canonicalization replaces the owned input with its normalized value.
    pub fn new_with_settings(
        text: VectorSpaceIdentity,
        settings: MediaSettings,
    ) -> Result<Self, MediaError> {
        let settings = settings.validate()?;
        let (text, _, _) = crate::store::identity::canonical_identity(&text)
            .map_err(|_| MediaError::InvalidProfile)?;
        validate_text_identity(&text)?;
        Ok(Self {
            text_vector_space_identity: text,
            artifact_repository: REPOSITORY.into(), artifact_revision: REVISION.into(),
            vision_dtype: "q8".into(), audio_dtype: "q8".into(),
            vision_artifacts: graph_files(MediaGraph::Vision)?,
            audio_artifacts: graph_files(MediaGraph::Audio)?,
            image_preprocessing: "mm1-image-v1:jpeg-png-webp;exif;white-alpha;pil-bicubic-fixed22;hwc16;scale1/255;pool3;pad-minus1".into(),
            audio_preprocessing: "mm1-audio-v1:mono16k;windows480000-all-tail;rebalance-tail-min161;left160;hann320;hop160;fft512;htk128;ln-mel+0.001;no-right-pad;mask-stride4".into(),
            tokenization: "mm1-tokens-v1:bos2;boi255999;image258880;video258884;eoi258882;boa256000;audio258881;eoa258883;eos1;pad0;context8192".into(),
            image_soft_tokens: settings.image_soft_tokens, video_soft_tokens: settings.video_soft_tokens, max_video_frames: 32,
            video_sampling: "floor-linspace-endpoints-v1;batch4-except-final5-is3+2;per-frame-vector".into(),
            video_batch_range: [2,4], dimensions: 768,
        })
    }

    /// Stable SHA-256 over every serialized field in the versioned Rust media identity.
    pub fn space_id(&self) -> Result<String, MediaError> {
        let json = serde_json::to_vec(self).map_err(|_| MediaError::InvalidProfile)?;
        Ok(format!("{:x}", Sha256::digest(json)))
    }
}

fn validate_text_identity(text: &VectorSpaceIdentity) -> Result<(), MediaError> {
    let profile = text_profile()?;
    let mut expected: Vec<_> = profile
        .files
        .iter()
        .map(|file| (&file.path, &file.sha256))
        .collect();
    expected.sort_unstable();
    let actual: Vec<_> = text
        .artifacts
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|file| (&file.path, &file.sha256))
        .collect();
    let prefix: serde_json::Value =
        serde_json::from_str(&text.prefix_scheme).map_err(|_| MediaError::InvalidProfile)?;
    let token_cap = text.token_cap.as_ref().and_then(Option::as_ref);
    let valid_prefix = prefix.as_array().is_some_and(|parts| {
        parts.len() == 4
            && parts[0].as_str() == profile.query_prefix.as_deref()
            && parts[1].as_str() == profile.passage_prefix.as_deref()
            && parts[2] == "mean"
            && (parts[3].is_null()
                || token_cap.is_some_and(|cap| parts[3].as_number() == Some(cap)))
    });
    if text.provider != "local-transformers"
        || text.model != MODEL
        || text.revision != REVISION
        || text.dtype != "q8"
        || text.dimension.as_u64() != Some(768)
        || text.normalization != "l2"
        || text.pooling.as_deref() != Some("mean")
        || !text.instruction.is_empty()
        || !valid_prefix
        || actual != expected
        || token_cap.is_some_and(|cap| cap.as_u64().is_none_or(|n| !(32..=8192).contains(&n)))
    {
        return Err(MediaError::InvalidProfile);
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
pub(crate) fn test_text_identity() -> VectorSpaceIdentity {
    let profile = text_profile().unwrap();
    serde_json::from_value(serde_json::json!({
        "provider":"local-transformers", "model":MODEL,"revision":REVISION,"dimension":768,
        "normalization":"l2","prefixScheme":serde_json::to_string(&serde_json::json!([profile.query_prefix,profile.passage_prefix,"mean",null])).unwrap(),
        "instruction":"","dtype":"q8","tokenCap":null,"pooling":"mean",
        "artifacts":profile.files.iter().map(|f|serde_json::json!({"path":f.path,"sha256":f.sha256})).collect::<Vec<_>>()
    })).unwrap()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    #[test]
    fn identity_changes_for_every_pipeline_parameter() {
        let identity = MediaSpaceIdentity::new(test_text_identity()).unwrap();
        let original = identity.space_id().unwrap();
        let fields = serde_json::to_value(&identity).unwrap();
        for key in fields
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>()
        {
            let mut changed = fields.clone();
            match &mut changed[&key] {
                serde_json::Value::String(value) => value.push_str("-changed"),
                serde_json::Value::Number(value) => *value = (value.as_u64().unwrap() + 1).into(),
                serde_json::Value::Array(items) => {
                    items.pop();
                }
                serde_json::Value::Object(object) => {
                    object.insert("instruction".into(), serde_json::json!("changed"));
                }
                _ => unreachable!(),
            }
            // Fixed-size batch bounds must retain their array shape to deserialize.
            if key == "videoBatchRange" {
                changed[&key] = serde_json::json!([2, 3]);
            }
            let changed: MediaSpaceIdentity = serde_json::from_value(changed).unwrap();
            assert_ne!(original, changed.space_id().unwrap(), "{key}");
        }
        let mut changed = identity.clone();
        changed.video_soft_tokens = 71;
        assert_ne!(original, changed.space_id().unwrap());
        let mut changed = identity.clone();
        changed.audio_artifacts[0].sha256 = "0".repeat(64);
        assert_ne!(original, changed.space_id().unwrap());
    }
    #[test]
    fn unrelated_or_projected_text_spaces_cannot_label_media_vectors() {
        let mut wrong = test_text_identity();
        wrong.dtype = "q4".into();
        assert!(MediaSpaceIdentity::new(wrong).is_err());
        let mut wrong = test_text_identity();
        wrong.dimension = 512.into();
        assert!(MediaSpaceIdentity::new(wrong).is_err());
        let mut wrong = test_text_identity();
        wrong.artifacts.as_mut().unwrap()[0].sha256 = "0".repeat(64);
        assert!(MediaSpaceIdentity::new(wrong).is_err());
    }
}
