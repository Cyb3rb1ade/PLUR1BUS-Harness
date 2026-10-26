//! SHA-256-pinned tokenizer sources pending RE-03's ArtifactCatalogue (RE-D25); no file is fetched here.

use super::{ArtifactState, FamilyInfo, TokenError, TokenMethod};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path};
use tokenizers::Tokenizer;

const MANIFEST: &str = include_str!("artifacts.json");

/// One immutable, reviewed tokenizer file. The file is fetched separately and never bundled.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TokenizerArtifact {
    /// The cache-profile tokenizer family this exact raw-text encoding belongs to.
    pub family: String,
    /// Safe directory component below the supplied tokenizer root.
    pub id: String,
    /// Upstream source repository.
    pub repository: String,
    /// Immutable upstream revision.
    pub revision: String,
    /// Safe relative path below the artifact directory.
    pub file: String,
    /// Immutable upstream download URL, used by setup tooling only.
    pub url: String,
    /// Lowercase hexadecimal SHA-256 of the exact file bytes.
    pub sha256: String,
    /// SPDX license expression reviewed for this file.
    pub license: String,
    /// `permissive` only for files already covered by repository license policy.
    pub license_status: String,
    /// Optional pinned source representation when setup builds the canonical tokenizer JSON.
    #[serde(default)]
    pub source_format: Option<String>,
    /// Digest of the original source bytes before a deterministic representation conversion.
    #[serde(default)]
    pub source_sha256: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u32,
    artifacts: Vec<TokenizerArtifact>,
}

pub(super) struct LoadedFamily {
    pub info: FamilyInfo,
    pub tokenizer: Option<Tokenizer>,
}

pub(super) fn manifest(families: &BTreeSet<String>) -> Result<Vec<TokenizerArtifact>, TokenError> {
    let manifest: Manifest =
        serde_json::from_str(MANIFEST).map_err(|error| TokenError::Manifest(error.to_string()))?;
    if manifest.version != 1 {
        return Err(TokenError::Manifest(
            "unsupported artifact manifest version".to_owned(),
        ));
    }
    let mut ids = BTreeSet::new();
    let mut listed_families = BTreeSet::new();
    for artifact in &manifest.artifacts {
        if !families.contains(&artifact.family)
            || !safe_path(&artifact.id)
            || Path::new(&artifact.id).components().count() != 1
            || !safe_path(&artifact.file)
            || !lower_hex(&artifact.sha256, 64)
            || !lower_hex(&artifact.revision, 40)
            || !immutable_https_url(artifact)
            || !valid_source_format(artifact)
            || artifact.license.is_empty()
            || !ids.insert(&artifact.id)
            || !listed_families.insert(&artifact.family)
        {
            return Err(TokenError::Manifest(format!(
                "invalid or duplicate artifact {}",
                artifact.id
            )));
        }
    }
    Ok(manifest.artifacts)
}

fn safe_path(value: &str) -> bool {
    !value.is_empty()
        && !value.contains('\\')
        && Path::new(value)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}

fn lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn immutable_https_url(artifact: &TokenizerArtifact) -> bool {
    url::Url::parse(&artifact.url).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url
                .path_segments()
                .is_some_and(|mut segments| segments.any(|part| part == artifact.revision))
    })
}

fn valid_source_format(artifact: &TokenizerArtifact) -> bool {
    match artifact.source_format.as_deref() {
        None | Some("tokenizer-json") => artifact
            .source_sha256
            .as_ref()
            .is_none_or(|digest| lower_hex(digest, 64)),
        Some("tiktoken-ranks") => artifact
            .source_sha256
            .as_ref()
            .is_some_and(|digest| lower_hex(digest, 64)),
        Some(_) => false,
    }
}

fn permissive_license(artifact: &TokenizerArtifact) -> bool {
    artifact.license_status == "permissive"
        && matches!(
            artifact.license.as_str(),
            "MIT" | "Apache-2.0" | "MIT OR Apache-2.0" | "Apache-2.0 OR MIT"
        )
}

pub(super) fn load(
    families: BTreeSet<String>,
    artifacts: &[TokenizerArtifact],
    root: Option<&Path>,
) -> BTreeMap<String, LoadedFamily> {
    families
        .into_iter()
        .map(|family| {
            let artifact = artifacts.iter().find(|artifact| artifact.family == family);
            let blocked = family == "gemma3" || family.starts_with("grok");
            let state = if blocked {
                ArtifactState::LicensePending
            } else if artifact.is_some() {
                ArtifactState::Missing
            } else {
                ArtifactState::NotConfigured
            };
            let mut loaded = LoadedFamily {
                info: FamilyInfo {
                    family: family.clone(),
                    method: TokenMethod::Heuristic,
                    artifact_state: state,
                    artifact_id: artifact.map(|entry| entry.id.clone()),
                    sha256: artifact.map(|entry| entry.sha256.clone()),
                },
                tokenizer: None,
            };
            if !blocked {
                if let Some(artifact) = artifact {
                    if !permissive_license(artifact) {
                        loaded.info.artifact_state = ArtifactState::LicensePending;
                    } else if let Some(root) = root {
                        match read(root, artifact) {
                            Ok(tokenizer) => {
                                loaded.info.artifact_state = ArtifactState::Present;
                                loaded.info.method = TokenMethod::Exact;
                                loaded.tokenizer = Some(tokenizer);
                            }
                            Err(state) => loaded.info.artifact_state = state,
                        }
                    }
                }
            }
            (family, loaded)
        })
        .collect()
}

fn read(root: &Path, artifact: &TokenizerArtifact) -> Result<Tokenizer, ArtifactState> {
    let path = root.join(&artifact.id).join(&artifact.file);
    let bytes = fs::read(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ArtifactState::Missing
        } else {
            ArtifactState::Invalid
        }
    })?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    if digest != artifact.sha256 {
        return Err(ArtifactState::HashMismatch);
    }
    let mut tokenizer = Tokenizer::from_bytes(&bytes).map_err(|_| ArtifactState::Invalid)?;
    tokenizer
        .with_truncation(None)
        .map_err(|_| ArtifactState::Invalid)?;
    tokenizer.with_padding(None);
    Ok(tokenizer)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;
    use tokenizers::models::bpe::{Vocab, BPE};
    use tokenizers::utils::padding::{PaddingParams, PaddingStrategy};
    use tokenizers::utils::truncation::TruncationParams;

    fn tiny_tokenizer() -> Tokenizer {
        let vocab: Vocab = [("a", 0), ("b", 1), ("ab", 2), ("[UNK]", 3)]
            .into_iter()
            .map(|(text, id)| (text.to_owned(), id))
            .collect();
        Tokenizer::new(
            BPE::builder()
                .vocab_and_merges(vocab, vec![("a".to_owned(), "b".to_owned())])
                .unk_token("[UNK]".to_owned())
                .build()
                .unwrap(),
        )
    }

    fn write_artifact(root: &Path) -> TokenizerArtifact {
        let mut tokenizer = tiny_tokenizer();
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: 1,
                ..TruncationParams::default()
            }))
            .unwrap();
        tokenizer.with_padding(Some(PaddingParams {
            strategy: PaddingStrategy::Fixed(8),
            ..PaddingParams::default()
        }));
        let directory = root.join("unit-fixture");
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("tokenizer.json");
        tokenizer.save(&path, false).unwrap();
        TokenizerArtifact {
            family: "o200k".to_owned(),
            id: "unit-fixture".to_owned(),
            repository: "unit-test-only".to_owned(),
            revision: "unit-test-only".to_owned(),
            file: "tokenizer.json".to_owned(),
            url: "unit-test-only".to_owned(),
            sha256: format!("{:x}", Sha256::digest(fs::read(path).unwrap())),
            license: "MIT".to_owned(),
            license_status: "permissive".to_owned(),
            source_format: None,
            source_sha256: None,
        }
    }

    #[test]
    fn verifies_before_loading_and_disables_file_truncation_and_padding() {
        let scratch = tempfile::tempdir().unwrap();
        let artifact = write_artifact(scratch.path());
        let tokenizer = read(scratch.path(), &artifact).unwrap();
        assert_eq!(
            tokenizer.encode("ababa", false).unwrap().get_ids(),
            [2, 2, 0]
        );
        let mut mismatched = artifact.clone();
        mismatched.sha256 = "0".repeat(64);
        assert!(matches!(
            read(scratch.path(), &mismatched),
            Err(ArtifactState::HashMismatch)
        ));
        let missing = tempfile::tempdir().unwrap();
        assert!(matches!(
            read(missing.path(), &artifact),
            Err(ArtifactState::Missing)
        ));
        fs::write(scratch.path().join("unit-fixture/tokenizer.json"), "{}").unwrap();
        assert!(matches!(
            read(scratch.path(), &artifact),
            Err(ArtifactState::HashMismatch)
        ));
        let mut invalid = artifact;
        invalid.sha256 = format!("{:x}", Sha256::digest(b"{}"));
        assert!(matches!(
            read(scratch.path(), &invalid),
            Err(ArtifactState::Invalid)
        ));
    }

    #[test]
    fn conditional_families_never_load_even_when_a_manifest_claims_permissive() {
        let scratch = tempfile::tempdir().unwrap();
        for family in ["gemma3", "grok-unpublished"] {
            let mut artifact = write_artifact(scratch.path());
            artifact.family = family.to_owned();
            let families = BTreeSet::from([family.to_owned()]);
            let loaded = load(families, &[artifact], Some(scratch.path()));
            assert_eq!(
                loaded[family].info.artifact_state,
                ArtifactState::LicensePending
            );
            assert_eq!(loaded[family].info.method, TokenMethod::Heuristic);
            assert!(loaded[family].tokenizer.is_none());
        }
    }

    #[test]
    fn a_source_with_pending_license_is_an_explicit_estimator() {
        let scratch = tempfile::tempdir().unwrap();
        let mut artifact = write_artifact(scratch.path());
        artifact.license_status = "pending".to_owned();
        let loaded = load(
            BTreeSet::from(["o200k".to_owned()]),
            &[artifact],
            Some(scratch.path()),
        );
        assert_eq!(
            loaded["o200k"].info.artifact_state,
            ArtifactState::LicensePending
        );
        assert!(loaded["o200k"].tokenizer.is_none());
    }

    #[test]
    fn loaded_counter_needs_no_files_and_never_merges_across_message_boundaries() {
        let scratch = tempfile::tempdir().unwrap();
        let artifact = write_artifact(scratch.path());
        let mut counter = super::super::TokenCounter::heuristic().unwrap();
        counter.families.extend(load(
            BTreeSet::from(["o200k".to_owned()]),
            &[artifact],
            Some(scratch.path()),
        ));
        scratch.close().unwrap();
        let request = serde_json::from_value(serde_json::json!({
            "family":"o200k","cumulative":true,"items":[
                {"id":"one", "messages":[{"role":"user","segments":[{"text":"a"},{"text":"b"}]}]},
                {"id":"two", "messages":[{"role":"user","segments":[{"text":"a"}]},{"role":"assistant","segments":[{"text":"b"}]}]}
            ]
        })).unwrap();
        let result = counter.count(&request).unwrap();
        assert_eq!(result.method, TokenMethod::TokenizerText);
        assert_eq!(result.items[0].tokens, 1);
        assert_eq!(result.items[1].tokens, 2);
        let prefixes = result.cumulative.unwrap();
        assert_eq!(
            prefixes[0]
                .counts
                .iter()
                .map(|count| count.tokens)
                .collect::<Vec<_>>(),
            [1, 1]
        );
        assert_eq!(prefixes[1].counts[0].tokens, 1);
        assert_eq!(prefixes[2].counts[0].tokens, 1);
    }
}
