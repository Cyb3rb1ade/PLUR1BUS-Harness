//! F8 native model requirements from the constructed providers, independent of
//! the frozen ModelsService readiness/warm interface. No inference or downloads.
use crate::{
    contract::{Cancel, Cancelled, EngineError, StoreError},
    embedding::{
        artifacts::{pinned_profile, Artifact},
        model_selection::{ModelLocation, ModelRole, ModelSelection},
        EmbeddingProvider, Reranker,
    },
    store::directory::TrustedDirectory,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{io::Read, path::Path};

/// Read-only evidence about the configured artifact, not runtime readiness.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ArtifactStatus {
    /// Every pinned artifact has the expected size and digest.
    Verified,
    /// The host cache or a required file is absent.
    Missing,
    /// A required file has a different size or digest.
    Invalid,
    /// No complete catalogue/location description can be inspected safely (including links/special files).
    Unresolved,
    /// A read failed for another reason (for example access or device errors).
    Unavailable,
    /// The model is served remotely; local artifacts do not apply.
    Remote,
}
/// One runtime model need, without cache paths, credentials or endpoint URLs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRequirement {
    /// Embedding, primary reranker or an actual enabled fallback.
    pub role: ModelRole,
    /// The constructed provider label.
    pub provider: String,
    /// Actual model name; null for a custom service that has no configured name.
    pub model: Option<String>,
    /// Exact selected local revision, where applicable.
    pub revision: Option<String>,
    /// Catalogue graph dtype, where declared.
    pub dtype: Option<String>,
    /// Catalogue SPDX value, never inferred for an unknown/remote model.
    pub license: Option<String>,
    /// Current read-only artifact evidence.
    pub artifact_status: ArtifactStatus,
    /// Number of required pinned files, absent without a matching local catalogue entry.
    pub artifact_files: Option<usize>,
    /// Total required pinned bytes, absent without a matching local catalogue entry.
    pub artifact_bytes: Option<u64>,
}
/// Additive in-process access; deliberately separate from Engine::models().
pub trait ModelInventory: Send + Sync {
    /// Inspect the current configured model needs without preparing models.
    fn inventory(&self, cancel: &Cancel) -> Result<Vec<ModelRequirement>, EngineError>;
}
/// A borrowing view over the same provider instances used by the engine.
pub struct ProviderModelInventory<'a> {
    embedding: &'a dyn EmbeddingProvider,
    reranker: Option<&'a dyn Reranker>,
}
impl<'a> ProviderModelInventory<'a> {
    /// Bind the actual host-created embedding provider and optional reranker chain.
    pub fn new(embedding: &'a dyn EmbeddingProvider, reranker: Option<&'a dyn Reranker>) -> Self {
        Self {
            embedding,
            reranker,
        }
    }
}
impl ModelInventory for ProviderModelInventory<'_> {
    fn inventory(&self, cancel: &Cancel) -> Result<Vec<ModelRequirement>, EngineError> {
        inventory(self.embedding, self.reranker, cancel)
    }
}
/// Return embedding, primary reranker and enabled fallback in runtime chain order.
/// Missing/unresolved host caches are data, not operation failures. Cancellation
/// discards the partial result; no file or model-preparation state is mutated.
pub fn inventory(
    embedding: &dyn EmbeddingProvider,
    reranker: Option<&dyn Reranker>,
    cancel: &Cancel,
) -> Result<Vec<ModelRequirement>, EngineError> {
    cancel.check().map_err(EngineError::Cancelled)?;
    let mut selections = vec![embedding.model_selection()];
    if let Some(reranker) = reranker {
        selections.extend(reranker.model_selections());
    }
    selections
        .into_iter()
        .map(|selection| inspect(selection, cancel).map_err(EngineError::Cancelled))
        .collect()
}
fn inspect(selection: ModelSelection, cancel: &Cancel) -> Result<ModelRequirement, Cancelled> {
    cancel.check()?;
    let profile = if matches!(selection.location, ModelLocation::Local(_)) {
        selection
            .model
            .as_deref()
            .and_then(|model| pinned_profile(model, selection.dtype.as_deref()))
            .filter(|p| selection.revision.as_deref() == Some(p.revision.as_str()))
            .filter(|p| {
                p.role
                    == if selection.role == ModelRole::Embedding {
                        "embedding"
                    } else {
                        "reranker"
                    }
            })
    } else {
        None
    };
    let artifact_status = match &selection.location {
        ModelLocation::Remote => ArtifactStatus::Remote,
        ModelLocation::Unresolved => ArtifactStatus::Unresolved,
        ModelLocation::Local(cache) => match profile {
            Some(profile) => inspect_artifacts(profile, cache.as_deref(), cancel)?,
            None => ArtifactStatus::Unresolved,
        },
    };
    cancel.check()?;
    Ok(ModelRequirement {
        role: selection.role,
        provider: selection.provider,
        model: selection.model,
        revision: selection.revision,
        dtype: selection.dtype,
        license: profile.and_then(|p| p.licence.clone()),
        artifact_status,
        artifact_files: profile.map(|p| p.files.len()),
        artifact_bytes: profile.map(|p| p.files.iter().map(|f| f.bytes).sum()),
    })
}
fn path_error(error: &StoreError) -> ArtifactStatus {
    match error {
        StoreError::Io {
            kind: std::io::ErrorKind::NotFound,
        } => ArtifactStatus::Missing,
        StoreError::UntrustedPath | StoreError::InvalidInput => ArtifactStatus::Unresolved,
        _ => ArtifactStatus::Unavailable,
    }
}
fn inspect_artifacts(
    profile: &Artifact,
    cache: Option<&Path>,
    cancel: &Cancel,
) -> Result<ArtifactStatus, Cancelled> {
    cancel.check()?;
    let Some(cache) = cache.filter(|p| !p.as_os_str().is_empty()) else {
        return Ok(ArtifactStatus::Unresolved);
    };
    let root = match TrustedDirectory::open(&cache.join(&profile.repo).join(&profile.revision)) {
        Ok(root) => root,
        Err(e) => return Ok(path_error(&e)),
    };
    for expected in &profile.files {
        cancel.check()?;
        let mut components = expected.path.split('/').peekable();
        let mut held = Vec::new();
        let mut parent = &root;
        while let Some(name) = components.next() {
            if components.peek().is_some() {
                match parent.open_child(name) {
                    Ok(child) => held.push(child),
                    Err(e) => return Ok(path_error(&e)),
                }
                let Some(last) = held.last() else {
                    return Ok(ArtifactStatus::Unresolved);
                };
                parent = last;
                continue;
            }
            let mut file = match parent.open_file(name) {
                Ok(file) => file,
                Err(e) => return Ok(path_error(&e)),
            };
            let metadata = match file.metadata() {
                Ok(m) => m,
                Err(_) => return Ok(ArtifactStatus::Unavailable),
            };
            if metadata.len() != expected.bytes {
                return Ok(ArtifactStatus::Invalid);
            }
            let mut hash = Sha256::new();
            let mut bytes = 0_u64;
            let mut buffer = [0; 64 * 1024];
            loop {
                cancel.check()?;
                let n = match file.read(&mut buffer) {
                    Ok(n) => n,
                    Err(_) => return Ok(ArtifactStatus::Unavailable),
                };
                if n == 0 {
                    break;
                }
                bytes += n as u64;
                hash.update(&buffer[..n]);
                if bytes > expected.bytes {
                    return Ok(ArtifactStatus::Invalid);
                }
            }
            if bytes != expected.bytes || format!("{:x}", hash.finalize()) != expected.sha256 {
                return Ok(ArtifactStatus::Invalid);
            }
            if held.iter().any(|p| p.assert_unchanged().is_err()) {
                return Ok(ArtifactStatus::Unresolved);
            }
        }
        if root.assert_unchanged().is_err() {
            return Ok(ArtifactStatus::Unresolved);
        }
    }
    cancel.check()?;
    Ok(ArtifactStatus::Verified)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "synthetic artifact fixture")]
    use super::*;
    use crate::embedding::artifacts::ArtifactFile;
    use std::fs;
    #[test]
    fn artifact_hashes_are_checked_and_no_bytes_are_repaired() {
        let root = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let mut profile = pinned_profile("intfloat/multilingual-e5-small", None)
            .unwrap()
            .clone();
        profile.repo = "synthetic/model".into();
        profile.revision = "fixture-revision".into();
        profile.files = vec![ArtifactFile {
            path: "nested/model.bin".into(),
            source_path: None,
            bytes: 3,
            sha256: format!("{:x}", Sha256::digest(b"abc")),
        }];
        let cache = root.path();
        let file = cache
            .join(&profile.repo)
            .join(&profile.revision)
            .join(&profile.files[0].path);
        assert_eq!(
            inspect_artifacts(&profile, Some(cache), &Cancel::never()).unwrap(),
            ArtifactStatus::Missing
        );
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, b"abc").unwrap();
        assert_eq!(
            inspect_artifacts(&profile, Some(cache), &Cancel::never()).unwrap(),
            ArtifactStatus::Verified
        );
        fs::write(&file, b"abd").unwrap();
        assert_eq!(
            inspect_artifacts(&profile, Some(cache), &Cancel::never()).unwrap(),
            ArtifactStatus::Invalid
        );
        assert_eq!(fs::read(&file).unwrap(), b"abd");
        fs::write(&file, b"a").unwrap();
        assert_eq!(
            inspect_artifacts(&profile, Some(cache), &Cancel::never()).unwrap(),
            ArtifactStatus::Invalid
        );
        #[cfg(unix)]
        {
            fs::remove_file(&file).unwrap();
            let outside = root.path().join("outside");
            fs::write(&outside, b"abc").unwrap();
            std::os::unix::fs::symlink(&outside, &file).unwrap();
            assert_eq!(
                inspect_artifacts(&profile, Some(cache), &Cancel::never()).unwrap(),
                ArtifactStatus::Unresolved
            );
            assert_eq!(fs::read(outside).unwrap(), b"abc");
        }
        let cancel = Cancel::never();
        cancel.cancel();
        assert!(inspect_artifacts(&profile, Some(cache), &cancel).is_err());
    }
}
