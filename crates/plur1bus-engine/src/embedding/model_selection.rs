//! Native-only metadata from constructed providers. No credentials, transport URLs or
//! provider requests are part of this description; cache paths stay out of wire results.
use super::artifacts::Artifact;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// The place this model occupies in the actual runtime provider chain.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelRole {
    /// The configured vector-space provider.
    Embedding,
    /// The first reranking provider.
    Reranker,
    /// An enabled fallback in the constructed reranker chain.
    RerankerFallback,
}
/// Local lookup information, deliberately not serializable.
#[derive(Clone, Debug)]
pub enum ModelLocation {
    /// A remote service; no local artifact requirement is inferred.
    Remote,
    /// A host-selected cache, or an unresolved host cache path.
    Local(Option<PathBuf>),
    /// A custom provider has not supplied artifact metadata.
    Unresolved,
}
/// Metadata captured from the same provider instance that performs inference.
/// This native descriptor is not a readiness result or authority to load a model.
#[derive(Clone, Debug)]
pub struct ModelSelection {
    /// Actual provider label, excluding endpoint and secret references.
    pub provider: String,
    /// The model actually selected by the provider; custom remote endpoints may omit it.
    pub model: Option<String>,
    /// Exact local catalogue revision, when applicable.
    pub revision: Option<String>,
    /// Selected graph dtype, when declared by the catalogue.
    pub dtype: Option<String>,
    /// Actual runtime role, including the fallback distinction.
    pub role: ModelRole,
    /// Native-only artifact lookup location.
    pub location: ModelLocation,
}
impl ModelSelection {
    pub(crate) fn local(profile: &Artifact, cache: &Path, role: ModelRole) -> Self {
        Self {
            provider: "local-transformers".into(),
            model: Some(profile.repo.clone()),
            revision: Some(profile.revision.clone()),
            dtype: profile.dtype.clone(),
            role,
            location: ModelLocation::Local(
                (!cache.as_os_str().is_empty()).then(|| cache.to_owned()),
            ),
        }
    }
}
