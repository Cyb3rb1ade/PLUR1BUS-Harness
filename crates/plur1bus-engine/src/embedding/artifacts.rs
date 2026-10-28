//! Pinned local-model metadata and read-only artifact verification.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/// The catalogue's original SPDX identifier, without inferred licence metadata.
pub type LicenceId = String;

/// One file in an immutable local-model profile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ArtifactFile {
    /// Cache-relative path used by Transformers.js.
    pub path: String,
    /// Different upstream filename when the source is remapped into the cache.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    /// Exact expected byte length.
    #[serde(rename = "size")]
    pub bytes: u64,
    /// Lowercase SHA-256 of the complete file bytes.
    pub sha256: String,
}

/// A complete immutable Node local-model profile, including absent licence metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Artifact {
    /// Logical model identifier; also the directory path below the cache root.
    #[serde(rename = "model")]
    pub repo: String,
    /// Pinned cache revision.
    pub revision: String,
    /// Every file that must pass verification before this profile can be loaded.
    #[serde(rename = "artifacts")]
    pub files: Vec<ArtifactFile>,
    /// Original licence identifier; absence is preserved rather than inferred.
    #[serde(default, rename = "license", skip_serializing_if = "Option::is_none")]
    pub licence: Option<LicenceId>,
    /// Embedding or reranker role.
    pub role: String,
    /// Named runtime contract for models with specialized inference.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    /// Upstream base model revision, where declared.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_model_revision: Option<String>,
    /// Repository providing the artifact bytes, where different from the logical model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_repository: Option<String>,
    /// Upstream artifact revision, where explicitly declared.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_revision: Option<String>,
    /// Pinned graph dtype, where declared.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dtype: Option<String>,
    /// Native embedding width, where declared.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_dimensions: Option<usize>,
    /// Supported output widths, in the original catalogue order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub matryoshka_dimensions: Vec<usize>,
    /// Supported task adapters, in the original catalogue order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub task_adaptations: Vec<String>,
    /// Pinned maximum text context, where declared.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_context_tokens: Option<usize>,
    /// Default batch size, where declared.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_batch_size: Option<usize>,
    /// Exact query prefix, including empty strings and trailing spaces.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query_prefix: Option<String>,
    /// Exact passage prefix, including empty strings and trailing spaces.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passage_prefix: Option<String>,
    /// Commercial-use restriction only when declared by Node.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commercial_use: Option<bool>,
}

/// A verified revision directory and every verified local file, in catalogue order.
#[derive(Debug)]
pub struct ResolvedArtifact {
    /// Exact profile whose complete file list was verified.
    pub profile: &'static Artifact,
    /// Node-compatible revision-scoped cache directory.
    pub directory: PathBuf,
    /// Verified absolute or cache-root-relative paths, according to the supplied root.
    pub files: Vec<PathBuf>,
}

/// A local artifact cannot be resolved; no error path downloads or changes files.
#[derive(Debug)]
pub enum ArtifactError {
    /// No pinned profile exists for this model and optional dtype.
    Unknown {
        /// Logical model identifier requested by the caller.
        repo: String,
        /// Explicit dtype requested by the caller, or the model default.
        dtype: Option<String>,
    },
    /// The named file must be supplied by host model preparation.
    Missing {
        /// Logical model identifier whose cache is incomplete.
        repo: String,
        /// Missing cache-relative artifact path.
        file: String,
    },
    /// A declared artifact is not a regular file.
    InvalidFile {
        /// Logical model identifier whose artifact is invalid.
        repo: String,
        /// Cache-relative artifact path that is not a regular file.
        file: String,
    },
    /// A file has a different byte length from its pinned metadata.
    SizeMismatch {
        /// Logical model identifier whose artifact size changed.
        repo: String,
        /// Cache-relative artifact path with the size mismatch.
        file: String,
        /// Pinned file size in bytes.
        expected: u64,
        /// Observed file size in bytes.
        actual: u64,
    },
    /// The file has a different digest from the pinned bytes.
    HashMismatch {
        /// Logical model identifier whose artifact digest changed.
        repo: String,
        /// Cache-relative artifact path with the digest mismatch.
        file: String,
        /// Pinned lowercase hexadecimal SHA-256 digest.
        expected: String,
        /// Computed lowercase hexadecimal SHA-256 digest.
        actual: String,
    },
    /// Reading an existing file failed.
    Io {
        /// Logical model identifier whose artifact could not be read.
        repo: String,
        /// Cache-relative artifact path that could not be read.
        file: String,
        /// Underlying filesystem error.
        source: std::io::Error,
    },
}

impl ArtifactError {
    /// Return the catalogue licence without treating verification as consent or model use.
    pub fn licence_id(&self) -> Option<&str> {
        pinned_profile(self.repo(), None).and_then(|profile| profile.licence.as_deref())
    }

    fn repo(&self) -> &str {
        match self {
            Self::Unknown { repo, .. }
            | Self::Missing { repo, .. }
            | Self::InvalidFile { repo, .. }
            | Self::SizeMismatch { repo, .. }
            | Self::HashMismatch { repo, .. }
            | Self::Io { repo, .. } => repo,
        }
    }
}

impl std::fmt::Display for ArtifactError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unknown { repo, dtype } => write!(formatter, "no pinned local-model profile for {repo} (dtype {dtype:?})"),
            Self::Missing { repo, file } => write!(formatter, "missing local-model artifact {repo} {file}; prepare the pinned file in the model cache"),
            Self::InvalidFile { repo, file } => write!(formatter, "local-model artifact is not a regular file: {repo} {file}"),
            Self::SizeMismatch { repo, file, expected, actual } => write!(formatter, "local-model artifact size mismatch for {repo} {file}: expected {expected}, got {actual}"),
            Self::HashMismatch { repo, file, .. } => write!(formatter, "local-model artifact SHA-256 mismatch for {repo} {file}"),
            Self::Io { repo, file, source } => write!(formatter, "cannot read local-model artifact {repo} {file}: {source}"),
        }
    }
}

impl std::error::Error for ArtifactError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

static CATALOGUE: LazyLock<Vec<Artifact>> = LazyLock::new(catalogue_profiles);

/// Every pinned Node profile, including the explicit EmbeddingGemma 2 dtype variants.
pub fn catalogue() -> &'static [Artifact] {
    CATALOGUE.as_slice()
}

/// Select the default model profile or its exact pinned dtype variant.
pub fn pinned_profile(model: &str, dtype: Option<&str>) -> Option<&'static Artifact> {
    catalogue().iter().find(|profile| {
        profile.repo == model && dtype.is_none_or(|dtype| profile.dtype.as_deref() == Some(dtype))
    })
}

/// Resolve the revision directory using the logical model, as Node does.
pub fn model_cache_revision_dir(profile: &Artifact, cache_dir: &Path) -> PathBuf {
    cache_dir.join(&profile.repo).join(&profile.revision)
}

/// Verify every pinned local file without downloading, creating files, or loading the model.
/// Licence metadata is reported unchanged; verifying bytes does not authorize model use.
pub fn resolve(model: &str, cache_dir: &Path) -> Result<ResolvedArtifact, ArtifactError> {
    resolve_selected(model, None, cache_dir)
}

/// Verify a specific pinned dtype rather than the model's default profile.
pub fn resolve_dtype(
    model: &str,
    dtype: &str,
    cache_dir: &Path,
) -> Result<ResolvedArtifact, ArtifactError> {
    resolve_selected(model, Some(dtype), cache_dir)
}

fn resolve_selected(
    model: &str,
    dtype: Option<&str>,
    cache_dir: &Path,
) -> Result<ResolvedArtifact, ArtifactError> {
    let profile = pinned_profile(model, dtype).ok_or_else(|| ArtifactError::Unknown {
        repo: model.to_owned(),
        dtype: dtype.map(str::to_owned),
    })?;
    let files = verify_files(profile, cache_dir)?;
    Ok(ResolvedArtifact {
        profile,
        directory: model_cache_revision_dir(profile, cache_dir),
        files,
    })
}

fn read_error(
    profile: &Artifact,
    expected: &ArtifactFile,
    source: std::io::Error,
) -> ArtifactError {
    if source.kind() == std::io::ErrorKind::NotFound {
        ArtifactError::Missing {
            repo: profile.repo.clone(),
            file: expected.path.clone(),
        }
    } else {
        ArtifactError::Io {
            repo: profile.repo.clone(),
            file: expected.path.clone(),
            source,
        }
    }
}

fn verify_files(profile: &Artifact, cache_dir: &Path) -> Result<Vec<PathBuf>, ArtifactError> {
    let directory = model_cache_revision_dir(profile, cache_dir);
    let mut paths = Vec::with_capacity(profile.files.len());
    for expected in &profile.files {
        let path = directory.join(&expected.path);
        let mut file = File::open(&path).map_err(|error| read_error(profile, expected, error))?;
        let metadata = file
            .metadata()
            .map_err(|error| read_error(profile, expected, error))?;
        if !metadata.is_file() {
            return Err(ArtifactError::InvalidFile {
                repo: profile.repo.clone(),
                file: expected.path.clone(),
            });
        }
        if metadata.len() != expected.bytes {
            return Err(ArtifactError::SizeMismatch {
                repo: profile.repo.clone(),
                file: expected.path.clone(),
                expected: expected.bytes,
                actual: metadata.len(),
            });
        }
        let mut hash = Sha256::new();
        let mut bytes = 0;
        let mut buffer = [0; 64 * 1024];
        loop {
            let length = file
                .read(&mut buffer)
                .map_err(|error| read_error(profile, expected, error))?;
            if length == 0 {
                break;
            }
            bytes += length as u64;
            hash.update(&buffer[..length]);
        }
        if bytes != expected.bytes {
            return Err(ArtifactError::SizeMismatch {
                repo: profile.repo.clone(),
                file: expected.path.clone(),
                expected: expected.bytes,
                actual: bytes,
            });
        }
        let actual = format!("{:x}", hash.finalize());
        if actual != expected.sha256 {
            return Err(ArtifactError::HashMismatch {
                repo: profile.repo.clone(),
                file: expected.path.clone(),
                expected: expected.sha256.clone(),
                actual,
            });
        }
        paths.push(path);
    }
    Ok(paths)
}

// Generated from the pinned Node catalogue; the recorder fixture checks every original field.
fn catalogue_profiles() -> Vec<Artifact> {
    vec![
        Artifact {
            repo: "intfloat/multilingual-e5-small".to_owned(),
            revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3".to_owned(),
            licence: None,
            role: "embedding".to_owned(),
            runtime: None,
            base_model_revision: None,
            artifact_repository: None,
            artifact_revision: None,
            dtype: None,
            output_dimensions: None,
            matryoshka_dimensions: vec![],
            task_adaptations: vec![],
            max_context_tokens: None,
            default_batch_size: None,
            query_prefix: None,
            passage_prefix: None,
            commercial_use: None,
            files: vec![
                ArtifactFile {
                    path: "config.json".to_owned(),
                    source_path: None,
                    bytes: 655,
                    sha256: "69137736cab8b8903a07fe8afaafdda25aac55415a12a55d1bffa9f581abf959"
                        .to_owned(),
                },
                ArtifactFile {
                    path: "onnx/model.onnx".to_owned(),
                    source_path: None,
                    bytes: 470268510,
                    sha256: "ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665"
                        .to_owned(),
                },
                ArtifactFile {
                    path: "tokenizer.json".to_owned(),
                    source_path: None,
                    bytes: 17082730,
                    sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39"
                        .to_owned(),
                },
                ArtifactFile {
                    path: "tokenizer_config.json".to_owned(),
                    source_path: None,
                    bytes: 443,
                    sha256: "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b"
                        .to_owned(),
                },
            ],
        },
        Artifact {
            repo: "jinaai/jina-embeddings-v3".to_owned(),
            revision: "68ed94909d564380f954be27ae2e133214c1adc9".to_owned(),
            licence: Some("CC-BY-NC-4.0".to_owned()),
            role: "embedding".to_owned(),
            runtime: Some("jina-v3".to_owned()),
            base_model_revision: Some("ab036b023d30b4d1138c4c3bfa9f0c445ab455d6".to_owned()),
            artifact_repository: Some("ldwformat/jina-embeddings-v3-Q8-onnx".to_owned()),
            artifact_revision: Some("68ed94909d564380f954be27ae2e133214c1adc9".to_owned()),
            dtype: Some("q8".to_owned()),
            output_dimensions: Some(1024),
            matryoshka_dimensions: vec![32, 64, 128, 256, 512, 768, 1024],
            task_adaptations: vec![
                "retrieval.query".to_owned(),
                "retrieval.passage".to_owned(),
                "separation".to_owned(),
                "classification".to_owned(),
                "text-matching".to_owned(),
            ],
            max_context_tokens: None,
            default_batch_size: None,
            query_prefix: Some("".to_owned()),
            passage_prefix: Some("".to_owned()),
            commercial_use: Some(false),
            files: vec![
                ArtifactFile {
                    path: "config.json".to_owned(),
                    source_path: None,
                    bytes: 1817,
                    sha256: "9f62014fc8912befc019229c008f750a5059d5f83687b04854971914280c0adb"
                        .to_owned(),
                },
                ArtifactFile {
                    path: "onnx/model_quantized.onnx".to_owned(),
                    source_path: Some("model.onnx".to_owned()),
                    bytes: 563568622,
                    sha256: "69696107398fa52aad80bd38ca4a3972cf6e8293d2e1883231fcf7228fcb1c21"
                        .to_owned(),
                },
                ArtifactFile {
                    path: "special_tokens_map.json".to_owned(),
                    source_path: None,
                    bytes: 964,
                    sha256: "8c785abebea9ae3257b61681b4e6fd8365ceafde980c21970d001e834cf10835"
                        .to_owned(),
                },
                ArtifactFile {
                    path: "tokenizer.json".to_owned(),
                    source_path: None,
                    bytes: 17082734,
                    sha256: "3a56def25aa40facc030ea8b0b87f3688e4b3c39eb8b45d5702b3a1300fe2a20"
                        .to_owned(),
                },
                ArtifactFile {
                    path: "tokenizer_config.json".to_owned(),
                    source_path: None,
                    bytes: 1182,
                    sha256: "06b31b8051d8fe3486a7242fa1039d41ca9d5b69ad314dbf97df4b2ace7621d0"
                        .to_owned(),
                },
            ],
        },
        Artifact {
            repo: "jinaai/jina-embeddings-v5-text-nano-retrieval".to_owned(),
            revision: "ac5d898c8d382b17167c33e5c8af644a3519b47d".to_owned(),
            licence: Some("CC-BY-NC-4.0".to_owned()),
            role: "embedding".to_owned(),
            runtime: Some("jina-v5".to_owned()),
            base_model_revision: None,
            artifact_repository: None,
            artifact_revision: None,
            dtype: Some("q8".to_owned()),
            output_dimensions: Some(768),
            matryoshka_dimensions: vec![32, 64, 128, 256, 512, 768],
            task_adaptations: vec![],
            max_context_tokens: None,
            default_batch_size: None,
            query_prefix: Some("Query: ".to_owned()),
            passage_prefix: Some("Document: ".to_owned()),
            commercial_use: Some(false),
            files: vec![
                ArtifactFile {
                    path: "config.json".to_owned(),
                    source_path: None,
                    bytes: 1361,
                    sha256: "367857e3a726df6f1997bcb8443a4351e68b29c65f996e5874a4b3e7c5661a16"
                        .to_owned(),
                },
                ArtifactFile {
                    path: "onnx/model_quantized.onnx".to_owned(),
                    source_path: None,
                    bytes: 131365,
                    sha256: "ac93a7417c216e5076e37da2b3599f7ef16513934098a477680440c09f735a08"
                        .to_owned(),
                },
                ArtifactFile {
                    path: "onnx/model_quantized.onnx_data".to_owned(),
                    source_path: None,
                    bytes: 247006208,
                    sha256: "ee7870eb143a7353be08b33f79992a51de3e32b41f684ccd82953a710c2f2f9c"
                        .to_owned(),
                },
                ArtifactFile {
                    path: "tokenizer.json".to_owned(),
                    source_path: None,
                    bytes: 17210235,
                    sha256: "98d4a1d32152d6cedf85b5e88f3b205106dca1fe72aaab34e0ac13c238421069"
                        .to_owned(),
                },
                ArtifactFile {
                    path: "tokenizer_config.json".to_owned(),
                    source_path: None,
                    bytes: 487,
                    sha256: "6c4640d432db970b2436a4386d3ee992b99e756b62c37446c3f581c8d09cbb05"
                        .to_owned(),
                },
            ],
        },
        Artifact {
            repo: "google/embeddinggemma-2".to_owned(),
            revision: "daa72c51243991dfcaf9f9137d2c573d8f7790c0".to_owned(),
            licence: Some("Apache-2.0".to_owned()),
            role: "embedding".to_owned(),
            runtime: Some("embeddinggemma-2".to_owned()),
            base_model_revision: Some("914f7f89142e33e77833254d9c9b90c3cef7303b".to_owned()),
            artifact_repository: Some("onnx-community/embeddinggemma-2-ONNX".to_owned()),
            artifact_revision: Some("daa72c51243991dfcaf9f9137d2c573d8f7790c0".to_owned()),
            dtype: Some("q8".to_owned()),
            output_dimensions: Some(768),
            matryoshka_dimensions: vec![128, 256, 512, 768],
            task_adaptations: vec![],
            max_context_tokens: Some(8192),
            default_batch_size: Some(16),
            query_prefix: Some("task: search result | query: ".to_owned()),
            passage_prefix: Some("title: none | text: ".to_owned()),
            commercial_use: None,
            files: vec![
                ArtifactFile {
                    path: "config.json".to_owned(),
                    source_path: None,
                    bytes: 5031,
                    sha256: "8d011bfe08b5e345bbe0b81e5c6fd02c381920b345b986047bc2a33ce7b90d1d"
                        .to_owned(),
                },
                ArtifactFile {
                    path: "onnx/model_quantized.onnx".to_owned(),
                    source_path: None,
                    bytes: 495165,
                    sha256: "d06edd601f851c633a2519304cbeb8dc6170d7ceb61b436625c17fb9b6e74953"
                        .to_owned(),
                },
                ArtifactFile {
                    path: "onnx/model_quantized.onnx_data".to_owned(),
                    source_path: None,
                    bytes: 313724928,
                    sha256: "278a7ff1248c3618e4bd11a607fc54f7bdc7778854230f3956d3f86bd9db4f3b"
                        .to_owned(),
                },
                ArtifactFile {
                    path: "tokenizer.json".to_owned(),
                    source_path: None,
                    bytes: 32170510,
                    sha256: "4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4"
                        .to_owned(),
                },
                ArtifactFile {
                    path: "tokenizer_config.json".to_owned(),
                    source_path: None,
                    bytes: 1599,
                    sha256: "17bd5d6e9364ca49a534e1502076593317c298d4a663623091ed45388f004874"
                        .to_owned(),
                },
            ],
        },
        Artifact {
            repo: "google/embeddinggemma-2".to_owned(),
            revision: "daa72c51243991dfcaf9f9137d2c573d8f7790c0".to_owned(),
            licence: Some("Apache-2.0".to_owned()),
            role: "embedding".to_owned(),
            runtime: Some("embeddinggemma-2".to_owned()),
            base_model_revision: Some("914f7f89142e33e77833254d9c9b90c3cef7303b".to_owned()),
            artifact_repository: Some("onnx-community/embeddinggemma-2-ONNX".to_owned()),
            artifact_revision: Some("daa72c51243991dfcaf9f9137d2c573d8f7790c0".to_owned()),
            dtype: Some("q4".to_owned()),
            output_dimensions: Some(768),
            matryoshka_dimensions: vec![128, 256, 512, 768],
            task_adaptations: vec![],
            max_context_tokens: Some(8192),
            default_batch_size: Some(16),
            query_prefix: Some("task: search result | query: ".to_owned()),
            passage_prefix: Some("title: none | text: ".to_owned()),
            commercial_use: None,
            files: vec![
                ArtifactFile {
                    path: "config.json".to_owned(),
                    source_path: None,
                    bytes: 5031,
                    sha256: "8d011bfe08b5e345bbe0b81e5c6fd02c381920b345b986047bc2a33ce7b90d1d"
                        .to_owned(),
                },
                ArtifactFile {
                    path: "onnx/model_q4.onnx".to_owned(),
                    source_path: None,
                    bytes: 490742,
                    sha256: "f9eeba97acddf139b8ee2ddf04bc30dceafa88de93fadf74d7644e0d61a477a9"
                        .to_owned(),
                },
                ArtifactFile {
                    path: "onnx/model_q4.onnx_data".to_owned(),
                    source_path: None,
                    bytes: 174028800,
                    sha256: "c3975f2d1ab7a1878ae31a7d7a9b7804a827aff3800b60dfceafce21cac3df49"
                        .to_owned(),
                },
                ArtifactFile {
                    path: "tokenizer.json".to_owned(),
                    source_path: None,
                    bytes: 32170510,
                    sha256: "4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4"
                        .to_owned(),
                },
                ArtifactFile {
                    path: "tokenizer_config.json".to_owned(),
                    source_path: None,
                    bytes: 1599,
                    sha256: "17bd5d6e9364ca49a534e1502076593317c298d4a663623091ed45388f004874"
                        .to_owned(),
                },
            ],
        },
        Artifact {
            repo: "google/embeddinggemma-2".to_owned(),
            revision: "daa72c51243991dfcaf9f9137d2c573d8f7790c0".to_owned(),
            licence: Some("Apache-2.0".to_owned()),
            role: "embedding".to_owned(),
            runtime: Some("embeddinggemma-2".to_owned()),
            base_model_revision: Some("914f7f89142e33e77833254d9c9b90c3cef7303b".to_owned()),
            artifact_repository: Some("onnx-community/embeddinggemma-2-ONNX".to_owned()),
            artifact_revision: Some("daa72c51243991dfcaf9f9137d2c573d8f7790c0".to_owned()),
            dtype: Some("fp32".to_owned()),
            output_dimensions: Some(768),
            matryoshka_dimensions: vec![128, 256, 512, 768],
            task_adaptations: vec![],
            max_context_tokens: Some(8192),
            default_batch_size: Some(16),
            query_prefix: Some("task: search result | query: ".to_owned()),
            passage_prefix: Some("title: none | text: ".to_owned()),
            commercial_use: None,
            files: vec![
                ArtifactFile {
                    path: "config.json".to_owned(),
                    source_path: None,
                    bytes: 5031,
                    sha256: "8d011bfe08b5e345bbe0b81e5c6fd02c381920b345b986047bc2a33ce7b90d1d"
                        .to_owned(),
                },
                ArtifactFile {
                    path: "onnx/model.onnx".to_owned(),
                    source_path: None,
                    bytes: 421421,
                    sha256: "bc47de15f81208a5c99e5ab10f746d5e33b51ea228b7dc0bef9c133a94f1c1c3"
                        .to_owned(),
                },
                ArtifactFile {
                    path: "onnx/model.onnx_data".to_owned(),
                    source_path: None,
                    bytes: 1084170240,
                    sha256: "9fd452bfc6916e5a92f080f8dada35598ca4512b21c65897d4c5974d5f9630a2"
                        .to_owned(),
                },
                ArtifactFile {
                    path: "tokenizer.json".to_owned(),
                    source_path: None,
                    bytes: 32170510,
                    sha256: "4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4"
                        .to_owned(),
                },
                ArtifactFile {
                    path: "tokenizer_config.json".to_owned(),
                    source_path: None,
                    bytes: 1599,
                    sha256: "17bd5d6e9364ca49a534e1502076593317c298d4a663623091ed45388f004874"
                        .to_owned(),
                },
            ],
        },
        Artifact {
            repo: "jinaai/jina-reranker-v2-base-multilingual".to_owned(),
            revision: "9cfeff2df7d40d1b78e75e5e9cebec92a99813c9".to_owned(),
            licence: None,
            role: "reranker".to_owned(),
            runtime: None,
            base_model_revision: None,
            artifact_repository: None,
            artifact_revision: None,
            dtype: None,
            output_dimensions: None,
            matryoshka_dimensions: vec![],
            task_adaptations: vec![],
            max_context_tokens: None,
            default_batch_size: None,
            query_prefix: None,
            passage_prefix: None,
            commercial_use: None,
            files: vec![
                ArtifactFile {
                    path: "config.json".to_owned(),
                    source_path: None,
                    bytes: 1102,
                    sha256: "af16fe07e9b623d5a47b42bde0daba1b6510344212c03363145c51a81e9e4572"
                        .to_owned(),
                },
                ArtifactFile {
                    path: "onnx/model_quantized.onnx".to_owned(),
                    source_path: None,
                    bytes: 279577152,
                    sha256: "c5220cf8fe023f8aa0ed2a3eb787d4451a7f17cf53f6b787e35718dd4b8815c3"
                        .to_owned(),
                },
                ArtifactFile {
                    path: "tokenizer.json".to_owned(),
                    source_path: None,
                    bytes: 17082734,
                    sha256: "3a56def25aa40facc030ea8b0b87f3688e4b3c39eb8b45d5702b3a1300fe2a20"
                        .to_owned(),
                },
                ArtifactFile {
                    path: "tokenizer_config.json".to_owned(),
                    source_path: None,
                    bytes: 1148,
                    sha256: "4bf8eb7ce5367af6f7bcef4bef6fa5945c345ee5a7ecbe6464712a7d96f98015"
                        .to_owned(),
                },
            ],
        },
        Artifact {
            repo: "woxpas-ai/bge-reranker-v2-m3-onnx".to_owned(),
            revision: "c44ebc43de724ae8816668bb44d2e728e17faa18".to_owned(),
            licence: None,
            role: "reranker".to_owned(),
            runtime: None,
            base_model_revision: None,
            artifact_repository: None,
            artifact_revision: None,
            dtype: None,
            output_dimensions: None,
            matryoshka_dimensions: vec![],
            task_adaptations: vec![],
            max_context_tokens: None,
            default_batch_size: None,
            query_prefix: None,
            passage_prefix: None,
            commercial_use: None,
            files: vec![
                ArtifactFile {
                    path: "config.json".to_owned(),
                    source_path: None,
                    bytes: 820,
                    sha256: "36282ea6f54579cb2fdb2c64718407ac0c26fde2f9e87e51a6588c48425f8350"
                        .to_owned(),
                },
                ArtifactFile {
                    path: "onnx/model_quantized.onnx".to_owned(),
                    source_path: None,
                    bytes: 569986762,
                    sha256: "1ed01a24f6e639dbd0a18e74e47b394abb78e6adb13dd23f34f94a79623fb3d3"
                        .to_owned(),
                },
                ArtifactFile {
                    path: "tokenizer.json".to_owned(),
                    source_path: None,
                    bytes: 17082900,
                    sha256: "8bf8afbfd11306bd872018c53bfdf2e160a56f8edbcf49933324404791c148d3"
                        .to_owned(),
                },
                ArtifactFile {
                    path: "tokenizer_config.json".to_owned(),
                    source_path: None,
                    bytes: 1203,
                    sha256: "b87c8703482b0300d3da30e201519aa641f6a450f5eb5bf1e624afbf70c74d80"
                        .to_owned(),
                },
            ],
        },
    ]
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch_profile() -> Artifact {
        serde_json::from_value(serde_json::json!({
            "role": "embedding", "model": "test/model", "revision": "revision",
            "artifacts": [
                {"path":"config.json", "size":3, "sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"},
                {"path":"onnx/model.onnx", "size":3, "sha256":"cb8379ac2098aa165029e3938a51da0bcecfc008fd6795f401178647f96c5b34"}
            ]
        })).unwrap()
    }

    #[test]
    fn verification_hashes_the_later_file_after_the_first_file_is_valid() {
        let cache = tempfile::tempdir().unwrap();
        let profile = scratch_profile();
        let directory = model_cache_revision_dir(&profile, cache.path());
        fs::create_dir_all(directory.join("onnx")).unwrap();
        fs::write(directory.join("config.json"), b"abc").unwrap();
        fs::write(directory.join("onnx/model.onnx"), b"bad").unwrap();
        assert!(matches!(verify_files(&profile, cache.path()),
            Err(ArtifactError::HashMismatch { file, .. }) if file == "onnx/model.onnx"));
    }

    #[test]
    fn verification_returns_every_verified_path_without_changing_the_files() {
        let cache = tempfile::tempdir().unwrap();
        let profile = scratch_profile();
        let directory = model_cache_revision_dir(&profile, cache.path());
        fs::create_dir_all(directory.join("onnx")).unwrap();
        fs::write(directory.join("config.json"), b"abc").unwrap();
        fs::write(directory.join("onnx/model.onnx"), b"def").unwrap();
        assert_eq!(
            verify_files(&profile, cache.path()).unwrap(),
            vec![
                directory.join("config.json"),
                directory.join("onnx/model.onnx")
            ]
        );
        assert_eq!(fs::read(directory.join("config.json")).unwrap(), b"abc");
        assert_eq!(fs::read(directory.join("onnx/model.onnx")).unwrap(), b"def");
    }
}
