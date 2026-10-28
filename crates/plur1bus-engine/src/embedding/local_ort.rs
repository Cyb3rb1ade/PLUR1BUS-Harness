//! Lazy revision-pinned local embeddings with shared CPU ONNX inference.

use super::artifacts::{self, Artifact, ArtifactError};
use super::identity::identity_from_value;
use super::normalize::NormalizedEmbeddingConfig;
use super::{Cancel, EmbedError, EmbedKind, EmbeddingProvider, VectorSpaceIdentity};
use crate::contract::{Cancelled, EngineError};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, TryLockError};
use std::time::Duration;

mod session;
/// Transformers.js-compatible encode-then-cut tokenization and batch padding.
pub mod tokenizer;

/// Bounded local-model errors; input text and native runtime messages are never retained.
#[derive(Debug)]
pub enum LocalModelError {
    /// The profile or local provider settings are invalid.
    InvalidConfig,
    /// The pinned tokenizer configuration or encoded values are invalid.
    InvalidTokenizer,
    /// Inference returned an invalid tensor or vector.
    InvalidTensor,
    /// The host has not supplied a usable dynamic ONNX Runtime library.
    RuntimeUnavailable,
    /// A native inference operation failed.
    RuntimeFailed,
    /// The caller cancelled or its deadline expired.
    Cancelled(Cancelled),
    /// A pinned model file is absent or has changed.
    Artifact(ArtifactError),
    /// A noncommercial profile requires explicit host consent.
    LicenceConsentRequired,
}

impl fmt::Display for LocalModelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidConfig => f.write_str("invalid local model configuration"),
            Self::InvalidTokenizer => f.write_str("invalid pinned tokenizer"),
            Self::InvalidTensor => f.write_str("invalid local inference output"),
            Self::RuntimeUnavailable => {
                f.write_str("set ORT_DYLIB_PATH to the host-provided ONNX Runtime 1.30.0 library")
            }
            Self::RuntimeFailed => f.write_str("local inference failed"),
            Self::Cancelled(reason) => write!(f, "local inference cancelled: {reason}"),
            Self::Artifact(error) => write!(f, "{error}"),
            Self::LicenceConsentRequired => {
                f.write_str("explicit noncommercial model consent is required")
            }
        }
    }
}
impl std::error::Error for LocalModelError {}
impl From<Cancelled> for LocalModelError {
    fn from(value: Cancelled) -> Self {
        Self::Cancelled(value)
    }
}
impl From<ArtifactError> for LocalModelError {
    fn from(value: ArtifactError) -> Self {
        Self::Artifact(value)
    }
}

impl From<LocalModelError> for EmbedError {
    fn from(value: LocalModelError) -> Self {
        match value {
            LocalModelError::Cancelled(reason) => Self::Cancelled(reason),
            LocalModelError::InvalidTensor => Self::InvalidVector,
            _ => Self::Unavailable,
        }
    }
}

/// Initialize the process-wide CPU runtime from a host-verified library path.
/// Tests use their SHA-verified helper; production normally supplies `ORT_DYLIB_PATH`.
pub fn initialize_runtime(path: &Path) -> Result<(), LocalModelError> {
    session::initialize(path)
}

/// Pooling performed when the pinned graph does not expose a sentence embedding.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Pooling {
    /// Average the attended token states.
    Mean,
    /// Average with a Float32Array accumulator, as EmbeddingGemma's fallback does.
    MeanFloat32,
    /// Select the last attended token, independent of the padding side.
    LastAttended,
}

fn normalized_projection(row: &[f32], width: usize) -> Result<Vec<f32>, LocalModelError> {
    let row = row.get(..width).ok_or(LocalModelError::InvalidTensor)?;
    if row.is_empty() || row.iter().any(|n| !n.is_finite()) {
        return Err(LocalModelError::InvalidTensor);
    }
    let norm = row
        .iter()
        .map(|n| f64::from(*n).powi(2))
        .sum::<f64>()
        .sqrt();
    if !norm.is_finite() || norm <= 0.0 {
        return Err(LocalModelError::InvalidTensor);
    }
    Ok(row.iter().map(|n| (f64::from(*n) / norm) as f32).collect())
}

/// Pool `[batch, sequence, native_width]` states, then slice and renormalize.
pub fn pool_hidden(
    data: &[f32],
    shape: &[usize],
    mask: &[i64],
    width: usize,
    pooling: Pooling,
) -> Result<Vec<Vec<f32>>, LocalModelError> {
    let [batch, sequence, native] = shape else {
        return Err(LocalModelError::InvalidTensor);
    };
    let count = batch
        .checked_mul(*sequence)
        .ok_or(LocalModelError::InvalidTensor)?;
    if *sequence == 0
        || *native == 0
        || width == 0
        || width > *native
        || mask.len() != count
        || count.checked_mul(*native) != Some(data.len())
        || data.iter().any(|n| !n.is_finite())
    {
        return Err(LocalModelError::InvalidTensor);
    }
    let mut output = Vec::with_capacity(*batch);
    for row in 0..*batch {
        let mask = &mask[row * sequence..(row + 1) * sequence];
        let attended = mask
            .iter()
            .filter(|n| {
                if pooling == Pooling::MeanFloat32 {
                    **n == 1
                } else {
                    **n != 0
                }
            })
            .count();
        if attended == 0 {
            return Err(LocalModelError::InvalidTensor);
        }
        let states = &data[row * sequence * native..(row + 1) * sequence * native];
        let pooled = match pooling {
            Pooling::Mean => {
                let mut sum = vec![0.0_f64; *native];
                for (token, keep) in mask.iter().enumerate() {
                    if *keep != 0 {
                        for (index, value) in sum.iter_mut().enumerate() {
                            *value += f64::from(states[token * native + index]);
                        }
                    }
                }
                sum.into_iter()
                    .map(|sum| (sum / attended as f64) as f32)
                    .collect::<Vec<_>>()
            }
            Pooling::MeanFloat32 => {
                let mut sum = vec![0.0_f32; *native];
                for (token, keep) in mask.iter().enumerate() {
                    if *keep == 1 {
                        for (index, value) in sum.iter_mut().enumerate() {
                            *value += states[token * native + index];
                        }
                    }
                }
                sum.into_iter().map(|sum| sum / attended as f32).collect()
            }
            Pooling::LastAttended => {
                let token = mask
                    .iter()
                    .rposition(|n| *n != 0)
                    .ok_or(LocalModelError::InvalidTensor)?;
                states[token * native..(token + 1) * native].to_vec()
            }
        };
        output.push(normalized_projection(&pooled, width)?);
    }
    Ok(output)
}

fn project_outputs(
    profile: &Artifact,
    batch: &tokenizer::EncodedBatch,
    width: usize,
    outputs: &BTreeMap<String, (Vec<usize>, Vec<f32>)>,
) -> Result<Vec<Vec<f32>>, LocalModelError> {
    let native = profile.output_dimensions.unwrap_or(width);
    if native == 0 || width == 0 || width > native {
        return Err(LocalModelError::InvalidTensor);
    }
    let runtime = profile.runtime.as_deref();
    if matches!(runtime, Some("jina-v5" | "embeddinggemma-2")) {
        if let Some((shape, data)) = outputs
            .get("sentence_embedding")
            .filter(|(shape, _)| shape.len() == 2)
        {
            if shape != &[batch.batch, native]
                || batch.batch.checked_mul(native) != Some(data.len())
            {
                return Err(LocalModelError::InvalidTensor);
            }
            return data
                .chunks(native)
                .map(|row| normalized_projection(row, width))
                .collect();
        }
    }
    let names: &[&str] = match runtime {
        Some("jina-v3") => &[
            "text_embeds",
            "last_hidden_state",
            "logits",
            "token_embeddings",
        ],
        Some("jina-v5" | "embeddinggemma-2") => &["last_hidden_state", "token_embeddings"],
        _ => &["last_hidden_state", "logits", "token_embeddings"],
    };
    let (shape, data) = names
        .iter()
        .find_map(|name| outputs.get(*name))
        .ok_or(LocalModelError::InvalidTensor)?;
    if shape != &[batch.batch, batch.sequence, native] {
        return Err(LocalModelError::InvalidTensor);
    }
    let pooling = match runtime {
        Some("jina-v5") => Pooling::LastAttended,
        Some("embeddinggemma-2") => Pooling::MeanFloat32,
        _ => Pooling::Mean,
    };
    pool_hidden(data, shape, &batch.attention_mask, width, pooling)
}

pub(super) struct PreparedLocal {
    pub(super) model_path: PathBuf,
    pub(super) tokenizer: tokenizer::ModelTokenizer,
    cache_dir: PathBuf,
}
pub(super) type PreparedCache = Mutex<Option<Arc<PreparedLocal>>>;

pub(super) fn cached_preparation(
    cache: &PreparedCache,
    profile: &'static Artifact,
    cache_dir: &Path,
    cap: Option<usize>,
    cancel: &Cancel,
) -> Result<Arc<PreparedLocal>, LocalModelError> {
    let mut guard = loop {
        cancel.check()?;
        match cache.try_lock() {
            Ok(guard) => break guard,
            Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(5)),
            Err(TryLockError::Poisoned(_)) => return Err(LocalModelError::RuntimeFailed),
        }
    };
    if let Some(value) = guard.as_ref() {
        return Ok(value.clone());
    }
    let resolved = match profile.dtype.as_deref() {
        Some(dtype) => artifacts::resolve_dtype(&profile.repo, dtype, cache_dir)?,
        None => artifacts::resolve(&profile.repo, cache_dir)?,
    };
    cancel.check()?;
    let file = profile
        .files
        .iter()
        .find(|file| file.path.ends_with(".onnx"))
        .ok_or(LocalModelError::InvalidConfig)?;
    let tokenizer = tokenizer::ModelTokenizer::from_artifact(profile, &resolved.directory, cap)?;
    let prepared = Arc::new(PreparedLocal {
        model_path: resolved.directory.join(&file.path),
        tokenizer,
        cache_dir: cache_dir.to_owned(),
    });
    *guard = Some(prepared.clone());
    Ok(prepared)
}

pub(super) fn infer(
    profile: &Artifact,
    prepared: &PreparedLocal,
    batch: &tokenizer::EncodedBatch,
    task_id: Option<i64>,
    cancel: &Cancel,
) -> Result<session::InferenceOutputs, LocalModelError> {
    session::infer(
        profile,
        &prepared.model_path,
        batch,
        task_id,
        cancel,
        || {
            // The single process session can be evicted by another model. Verify every
            // artifact again before reloading bytes, even when its tokenizer is cached.
            match profile.dtype.as_deref() {
                Some(dtype) => artifacts::resolve_dtype(&profile.repo, dtype, &prepared.cache_dir)?,
                None => artifacts::resolve(&profile.repo, &prepared.cache_dir)?,
            };
            cancel.check()?;
            Ok(())
        },
    )
}

pub(super) fn requires_nc(profile: &Artifact) -> bool {
    profile.licence.as_deref() == Some("CC-BY-NC-4.0")
        || profile.repo == "jinaai/jina-reranker-v2-base-multilingual"
}

fn invalid(field: &str) -> EngineError {
    EngineError::Invalid {
        field: field.into(),
        message: "invalid pinned local model settings".into(),
    }
}

/// A lazy local embedding provider; construction never opens or downloads model files.
pub struct LocalEmbedding {
    identity: VectorSpaceIdentity,
    profile: &'static Artifact,
    cache_dir: PathBuf,
    query_prefix: String,
    passage_prefix: String,
    width: usize,
    max_tokens: usize,
    max_batch_size: usize,
    prepared: PreparedCache,
}

/// Build one of the pinned local embedding profiles after explicit host consent checks.
pub fn build_local_embedding(
    config: &NormalizedEmbeddingConfig,
    cache_dir: &Path,
    accept_nc: bool,
) -> Result<Box<dyn EmbeddingProvider>, EngineError> {
    let local = config.local().ok_or_else(|| invalid("embedding.local"))?;
    let dtype = local.get("dtype").and_then(Value::as_str);
    let profile = artifacts::pinned_profile(config.model(), dtype)
        .filter(|p| p.role == "embedding")
        .ok_or_else(|| invalid("embedding.local.model"))?;
    if requires_nc(profile) && !accept_nc {
        return Err(EngineError::NotAvailable {
            reason: "noncommercial-licence-not-accepted".into(),
        });
    }
    if local
        .get("revision")
        .and_then(Value::as_str)
        .is_some_and(|revision| revision != profile.revision)
    {
        return Err(invalid("embedding.local.revision"));
    }
    let query_prefix = local
        .get("queryPrefix")
        .and_then(Value::as_str)
        .unwrap_or(profile.query_prefix.as_deref().unwrap_or("query: "))
        .to_owned();
    let passage_prefix = local
        .get("passagePrefix")
        .and_then(Value::as_str)
        .unwrap_or(profile.passage_prefix.as_deref().unwrap_or("passage: "))
        .to_owned();
    if matches!(
        profile.runtime.as_deref(),
        Some("jina-v5" | "embeddinggemma-2")
    ) && (Some(query_prefix.as_str()) != profile.query_prefix.as_deref()
        || Some(passage_prefix.as_str()) != profile.passage_prefix.as_deref())
    {
        return Err(invalid("embedding.local.prefix"));
    }
    let max_tokens = match local.get("maxTokens").filter(|v| !v.is_null()) {
        None => 512,
        Some(value) => super::normalize::safe_positive_integer(value)
            .filter(|n| (32..=8192).contains(n))
            .ok_or_else(|| invalid("embedding.local.maxTokens"))? as usize,
    };
    let max_batch_size = match local.get("maxBatchSize") {
        Some(value) if profile.runtime.as_deref() == Some("embeddinggemma-2") => {
            super::normalize::safe_positive_integer(value)
                .filter(|n| *n <= 64)
                .ok_or_else(|| invalid("embedding.local.maxBatchSize"))? as usize
        }
        Some(_) => return Err(invalid("embedding.local.maxBatchSize")),
        None => profile.default_batch_size.unwrap_or(64),
    };
    let width = config.dimensions();
    if width == 0
        || (!profile.matryoshka_dimensions.is_empty()
            && !profile.matryoshka_dimensions.contains(&width))
        || (profile.repo == "intfloat/multilingual-e5-small" && width != 384)
    {
        return Err(invalid("embedding.local.dimensions"));
    }
    let mut raw = local.clone();
    let object = raw
        .as_object_mut()
        .ok_or_else(|| invalid("embedding.local"))?;
    object.insert("provider".into(), json!("local-transformers"));
    object.insert("model".into(), json!(profile.repo));
    object.insert("dimensions".into(), json!(width));
    object.insert("revision".into(), json!(profile.revision));
    object.insert("queryPrefix".into(), json!(query_prefix));
    object.insert("passagePrefix".into(), json!(passage_prefix));
    object.insert("pooling".into(), json!("mean"));
    object.insert("normalization".into(), json!("l2"));
    object.insert(
        "dtype".into(),
        json!(profile.dtype.as_deref().unwrap_or("float32")),
    );
    object.insert(
        "artifacts".into(),
        serde_json::to_value(&profile.files).map_err(|_| invalid("embedding.local.artifacts"))?,
    );
    let identity = identity_from_value(&raw).map_err(|_| invalid("embedding.identity"))?;
    Ok(Box::new(LocalEmbedding {
        identity,
        profile,
        cache_dir: cache_dir.to_owned(),
        query_prefix,
        passage_prefix,
        width,
        max_tokens,
        max_batch_size,
        prepared: Mutex::new(None),
    }))
}

impl EmbeddingProvider for LocalEmbedding {
    fn identity(&self) -> &VectorSpaceIdentity {
        &self.identity
    }
    fn embed(
        &self,
        texts: &[String],
        kind: EmbedKind,
        cancel: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        cancel.check().map_err(EmbedError::Cancelled)?;
        if texts.is_empty() {
            return Ok(vec![]);
        }
        let prepared = cached_preparation(
            &self.prepared,
            self.profile,
            &self.cache_dir,
            Some(self.max_tokens),
            cancel,
        )
        .map_err(EmbedError::from)?;
        let query = matches!(kind, EmbedKind::Query);
        let prefix = if query {
            &self.query_prefix
        } else {
            &self.passage_prefix
        };
        let task = if self.profile.runtime.as_deref() == Some("jina-v3") {
            let purpose = if query {
                "retrieval.query"
            } else {
                "retrieval.passage"
            };
            Some(
                self.profile
                    .task_adaptations
                    .iter()
                    .position(|name| name == purpose)
                    .ok_or(EmbedError::Unavailable)? as i64,
            )
        } else {
            None
        };
        let mut vectors = Vec::with_capacity(texts.len());
        for texts in texts.chunks(self.max_batch_size) {
            cancel.check().map_err(EmbedError::Cancelled)?;
            let prefixed = texts
                .iter()
                .map(|text| format!("{prefix}{text}"))
                .collect::<Vec<_>>();
            let batch = prepared
                .tokenizer
                .encode_batch(&prefixed, None)
                .map_err(EmbedError::from)?;
            let outputs =
                infer(self.profile, &prepared, &batch, task, cancel).map_err(EmbedError::from)?;
            let rows = project_outputs(self.profile, &batch, self.width, &outputs)
                .map_err(EmbedError::from)?;
            vectors.extend(rows);
        }
        cancel.check().map_err(EmbedError::Cancelled)?;
        Ok(vectors)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod projection_tests {
    use super::*;
    use crate::embedding::artifacts::pinned_profile;

    fn batch() -> tokenizer::EncodedBatch {
        tokenizer::EncodedBatch {
            input_ids: vec![1],
            attention_mask: vec![1],
            token_type_ids: vec![0],
            batch: 1,
            sequence: 1,
        }
    }
    fn hidden(width: usize, first: f32, second: f32) -> (Vec<usize>, Vec<f32>) {
        let mut row = vec![0.0; width];
        row[0] = first;
        row[1] = second;
        (vec![1, 1, width], row)
    }
    fn first_two(rows: &[Vec<f32>], expected: [f32; 2]) {
        assert!((rows[0][0] - expected[0]).abs() < 1e-6);
        assert!((rows[0][1] - expected[1]).abs() < 1e-6);
    }
    #[test]
    fn jina_v3_projects_all_node_hidden_output_names_in_their_exact_priority() {
        let profile = pinned_profile("jinaai/jina-embeddings-v3", None).unwrap();
        let mut outputs = BTreeMap::from([
            ("text_embeds".into(), hidden(1024, 3.0, 4.0)),
            ("last_hidden_state".into(), hidden(1024, 4.0, 3.0)),
            ("logits".into(), hidden(1024, 0.0, 5.0)),
            ("token_embeddings".into(), hidden(1024, 5.0, 0.0)),
            (
                "sentence_embedding".into(),
                (vec![1, 1024], hidden(1024, 5.0, 0.0).1),
            ),
        ]);
        first_two(
            &project_outputs(profile, &batch(), 64, &outputs).unwrap(),
            [0.6, 0.8],
        );
        outputs.remove("text_embeds");
        first_two(
            &project_outputs(profile, &batch(), 64, &outputs).unwrap(),
            [0.8, 0.6],
        );
        outputs.remove("last_hidden_state");
        first_two(
            &project_outputs(profile, &batch(), 64, &outputs).unwrap(),
            [0.0, 1.0],
        );
        outputs.remove("logits");
        first_two(
            &project_outputs(profile, &batch(), 64, &outputs).unwrap(),
            [1.0, 0.0],
        );
    }
    #[test]
    fn e5_uses_feature_extraction_output_priority_and_does_not_take_sentence_embeddings() {
        let profile = pinned_profile("intfloat/multilingual-e5-small", None).unwrap();
        let mut outputs = BTreeMap::from([
            ("last_hidden_state".into(), hidden(384, 3.0, 4.0)),
            ("logits".into(), hidden(384, 4.0, 3.0)),
            ("token_embeddings".into(), hidden(384, 5.0, 0.0)),
            (
                "sentence_embedding".into(),
                (vec![1, 384], hidden(384, 5.0, 0.0).1),
            ),
        ]);
        first_two(
            &project_outputs(profile, &batch(), 384, &outputs).unwrap(),
            [0.6, 0.8],
        );
        outputs.remove("last_hidden_state");
        first_two(
            &project_outputs(profile, &batch(), 384, &outputs).unwrap(),
            [0.8, 0.6],
        );
        outputs.remove("logits");
        first_two(
            &project_outputs(profile, &batch(), 384, &outputs).unwrap(),
            [1.0, 0.0],
        );
    }
    #[test]
    fn gemma_selects_float32_hidden_pooling_and_prefers_sentence_embeddings_when_present() {
        let profile = pinned_profile("google/embeddinggemma-2", None).unwrap();
        let mut encoded = batch();
        encoded.sequence = 3;
        encoded.attention_mask = vec![1, 1, 1];
        let mut states = vec![0.0; 3 * 768];
        states[0] = 1.0;
        states[1] = 1e-7;
        states[768] = 1e-7;
        states[2 * 768] = -1.0;
        let mut outputs = BTreeMap::from([("last_hidden_state".into(), (vec![1, 3, 768], states))]);
        first_two(
            &project_outputs(profile, &encoded, 128, &outputs).unwrap(),
            [0.766_134_56, 0.642_680_2],
        );
        outputs.insert(
            "sentence_embedding".into(),
            (vec![1, 768], hidden(768, 3.0, 4.0).1),
        );
        first_two(
            &project_outputs(profile, &encoded, 128, &outputs).unwrap(),
            [0.6, 0.8],
        );
    }
    #[test]
    fn jina_v5_hidden_fallback_keeps_last_attended_pooling() {
        let profile =
            pinned_profile("jinaai/jina-embeddings-v5-text-nano-retrieval", None).unwrap();
        let mut encoded = batch();
        encoded.sequence = 2;
        encoded.attention_mask = vec![1, 1];
        let mut states = hidden(768, 5.0, 0.0).1;
        states.extend(hidden(768, 3.0, 4.0).1);
        let outputs = BTreeMap::from([("token_embeddings".into(), (vec![1, 2, 768], states))]);
        first_two(
            &project_outputs(profile, &encoded, 128, &outputs).unwrap(),
            [0.6, 0.8],
        );
    }
}
