//! The catalogue is checked against metadata recorded from the pinned Node engine.
#![cfg_attr(test, allow(clippy::unwrap_used))]

use plur1bus_engine::embedding::artifacts::{
    catalogue, model_cache_revision_dir, pinned_profile, resolve, ArtifactError,
};
use serde_json::Value;
use std::fs;

#[test]
fn the_catalogue_lists_every_node_entry_with_the_same_sha256_and_licence() {
    let node: Value =
        serde_json::from_str(include_str!("fixtures/vectors/catalogue.json")).unwrap();
    assert_eq!(serde_json::to_value(catalogue()).unwrap(), node["profiles"]);
}

#[test]
fn resolve_refuses_a_file_with_the_wrong_digest() {
    let cache = tempfile::tempdir().unwrap();
    let profile = pinned_profile("intfloat/multilingual-e5-small", None).unwrap();
    let file = &profile.files[0];
    let directory = model_cache_revision_dir(profile, cache.path());
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join(&file.path), vec![0; file.bytes as usize]).unwrap();
    assert!(matches!(
        resolve(&profile.repo, cache.path()),
        Err(ArtifactError::HashMismatch { repo, file: name, .. })
            if repo == profile.repo && name == file.path
    ));
}

#[test]
fn resolve_reports_the_nc_licence_id_for_the_two_nc_entries() {
    let cache = tempfile::tempdir().unwrap();
    let nc: Vec<_> = catalogue()
        .iter()
        .filter(|profile| profile.commercial_use == Some(false))
        .collect();
    assert_eq!(nc.len(), 2);
    for profile in nc {
        let error = resolve(&profile.repo, cache.path()).unwrap_err();
        assert_eq!(error.licence_id(), Some("CC-BY-NC-4.0"));
        assert_eq!(profile.licence.as_deref(), Some("CC-BY-NC-4.0"));
    }
}

#[test]
fn resolve_uses_the_logical_model_revision_cache_and_never_creates_files() {
    let cache = tempfile::tempdir().unwrap();
    let profile = pinned_profile("google/embeddinggemma-2", None).unwrap();
    assert_eq!(
        model_cache_revision_dir(profile, cache.path()),
        cache
            .path()
            .join("google/embeddinggemma-2")
            .join(&profile.revision)
    );
    assert!(matches!(
        resolve(&profile.repo, cache.path()),
        Err(ArtifactError::Missing { repo, file })
            if repo == profile.repo && file == "config.json"
    ));
    assert_eq!(fs::read_dir(cache.path()).unwrap().count(), 0);
}

#[test]
fn all_embeddinggemma_dtypes_and_original_license_gaps_are_preserved() {
    for dtype in ["q8", "q4", "fp32"] {
        let profile = pinned_profile("google/embeddinggemma-2", Some(dtype)).unwrap();
        assert_eq!(profile.dtype.as_deref(), Some(dtype));
        assert_eq!(profile.licence.as_deref(), Some("Apache-2.0"));
    }
    assert!(pinned_profile("google/embeddinggemma-2", Some("fp16")).is_none());
    for repo in [
        "intfloat/multilingual-e5-small",
        "jinaai/jina-reranker-v2-base-multilingual",
        "woxpas-ai/bge-reranker-v2-m3-onnx",
    ] {
        assert!(pinned_profile(repo, None).unwrap().licence.is_none());
    }
}
