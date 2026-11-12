//! F8: model needs come from real factory-built providers, with no model preparation.
#![allow(clippy::unwrap_used, reason = "inventory fixtures fail immediately")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    contract::{Cancel, EngineConfig, EngineError},
    embedding::{
        artifacts::{model_cache_revision_dir, pinned_profile},
        build_embedding_owned, build_reranker_owned,
        local_ort::build_local_embedding,
        model_selection::ModelRole,
        normalize::normalize_embedding_config,
    },
    ops::models::{inventory, ArtifactStatus, ModelInventory, ProviderModelInventory},
};
use serde_json::{json, Value};
use std::{fs, path::Path, sync::Arc};

#[test]
fn actual_host_defaults_include_only_embedding_and_enabled_rerankers() {
    for reranker in [
        json!(null),
        json!({"provider":"disabled"}),
        json!({"provider":"local-transformers"}),
        json!({"provider":"local-transformers","enabled":false}),
    ] {
        let root = support::canonical_tempdir();
        let config: EngineConfig = serde_json::from_value(if reranker.is_null() {
            json!({})
        } else {
            json!({"reranker":reranker})
        })
        .unwrap();
        let host = Arc::new(support::TestHost::new(root.path().to_owned()));
        let embedding = build_embedding_owned(&config, host.clone()).unwrap();
        let reranking = build_reranker_owned(&config, host).unwrap();
        let rows = ProviderModelInventory::new(embedding.as_ref(), reranking.as_deref())
            .inventory(&Cancel::never())
            .unwrap();
        assert_eq!(
            rows.len(),
            if reranker["provider"] == "local-transformers" && reranker["enabled"] != false {
                2
            } else {
                1
            }
        );
        assert_eq!(
            rows[0].model.as_deref(),
            Some("intfloat/multilingual-e5-small")
        );
        assert_eq!(rows[0].role, ModelRole::Embedding);
        assert_eq!(rows[0].artifact_status, ArtifactStatus::Missing);
        assert_eq!(
            rows[0].license, None,
            "do not infer absent catalogue licences"
        );
        if rows.len() == 2 {
            assert_eq!(
                rows[1].model.as_deref(),
                Some("woxpas-ai/bge-reranker-v2-m3-onnx")
            );
            assert_eq!(rows[1].role, ModelRole::Reranker);
            assert_eq!(rows[1].artifact_status, ArtifactStatus::Missing);
        }
        assert_eq!(
            fs::read_dir(root.path()).unwrap().count(),
            0,
            "no cache/model download or preparation"
        );
    }
}
#[test]
fn inferred_remote_defaults_and_actual_fallback_chain_are_reported_without_credentials() {
    for (reranker, provider, model) in [
        (
            json!({"apiKeyRef":"fixture/reranker"}),
            "cohere",
            Some("rerank-v3.5"),
        ),
        (
            json!({"provider":"voyage","apiKeyRef":"fixture/reranker"}),
            "voyage",
            Some("rerank-2.5"),
        ),
        (json!({"baseUrl":"http://127.0.0.1:1/v1"}), "remote", None),
        (
            json!({"provider":"cohere","apiKeyRef":"fixture/reranker","model":"custom-reranker"}),
            "cohere",
            Some("custom-reranker"),
        ),
    ] {
        for fallback in [false, true] {
            let root = support::canonical_tempdir();
            let mut reranker = reranker.clone();
            if fallback {
                reranker["fallbackProvider"] = json!("local-transformers");
            }
            let config:EngineConfig=serde_json::from_value(json!({"embedding":{"provider":"openai-compatible","model":"custom-embedding","dimensions":3,"baseUrl":"http://127.0.0.1:1/v1"},"reranker":reranker})).unwrap();
            let host = Arc::new(support::TestHost::new(root.path().to_owned()));
            let embedding = build_embedding_owned(&config, host.clone()).unwrap();
            let reranker = build_reranker_owned(&config, host.clone())
                .unwrap()
                .unwrap();
            let rows = inventory(
                embedding.as_ref(),
                Some(reranker.as_ref()),
                &Cancel::never(),
            )
            .unwrap();
            assert_eq!(rows.len(), if fallback { 3 } else { 2 });
            assert_eq!(rows[0].provider, "openai-compatible");
            assert_eq!(rows[0].model.as_deref(), Some("custom-embedding"));
            assert_eq!(rows[0].artifact_status, ArtifactStatus::Remote);
            assert_eq!(rows[1].provider, provider);
            assert_eq!(rows[1].model.as_deref(), model);
            assert_eq!(rows[1].artifact_status, ArtifactStatus::Remote);
            if fallback {
                assert_eq!(rows[2].role, ModelRole::RerankerFallback);
                assert_eq!(
                    rows[2].model.as_deref(),
                    Some("woxpas-ai/bge-reranker-v2-m3-onnx")
                );
                assert_eq!(rows[2].artifact_status, ArtifactStatus::Missing);
            }
            let encoded = serde_json::to_string(&rows).unwrap();
            for private in [
                "fixture/reranker",
                "127.0.0.1",
                root.path().to_str().unwrap(),
                "apiKeyRef",
                "cacheDir",
            ] {
                assert!(!encoded.contains(private));
            }
            assert!(host.events.lock().unwrap().is_empty());
            assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
        }
    }
}
#[test]
fn actual_custom_cache_and_catalogue_licence_are_read_only_and_current() {
    let root = support::canonical_tempdir();
    let cache = root.path().join("selected-cache");
    let config:EngineConfig=serde_json::from_value(json!({"embedding":{"provider":"local-transformers","local":{"model":"google/embeddinggemma-2","cacheDir":cache,"dtype":"q8"}},"reranker":{"provider":"local-transformers","local":{"cacheDir":cache}}})).unwrap();
    let host = Arc::new(support::TestHost::new(root.path().to_owned()));
    let embedding = build_embedding_owned(&config, host.clone()).unwrap();
    let reranker = build_reranker_owned(&config, host).unwrap().unwrap();
    let view = ProviderModelInventory::new(embedding.as_ref(), Some(reranker.as_ref()));
    let rows = view.inventory(&Cancel::never()).unwrap();
    assert_eq!(rows[0].license.as_deref(), Some("Apache-2.0"));
    assert_eq!(rows[0].dtype.as_deref(), Some("q8"));
    assert_eq!(rows[0].artifact_status, ArtifactStatus::Missing);
    let profile = pinned_profile("google/embeddinggemma-2", Some("q8")).unwrap();
    assert_eq!(rows[0].revision.as_deref(), Some(profile.revision.as_str()));
    assert_eq!(rows[0].artifact_files, Some(profile.files.len()));
    let first = model_cache_revision_dir(profile, &cache).join(&profile.files[0].path);
    fs::create_dir_all(first.parent().unwrap()).unwrap();
    fs::write(&first, b"deliberately short synthetic bytes").unwrap();
    let before = fs::read(&first).unwrap();
    let rows = view.inventory(&Cancel::never()).unwrap();
    assert_eq!(rows[0].artifact_status, ArtifactStatus::Invalid);
    assert_eq!(rows[1].artifact_status, ArtifactStatus::Missing);
    assert_eq!(fs::read(&first).unwrap(), before);
    assert!(
        !root.path().join("models").exists(),
        "inspect the actual host override"
    );
}
#[test]
fn missing_host_cache_is_unresolved_and_cancel_never_prepares_models() {
    let normalized = normalize_embedding_config(
        &json!({"provider":"local-transformers","local":{"model":"intfloat/multilingual-e5-small","cacheDir":"/fixture/unused"}}),
    )
    .unwrap();
    let embedding = build_local_embedding(&normalized, Path::new(""), false).unwrap();
    let rows = inventory(embedding.as_ref(), None, &Cancel::never()).unwrap();
    assert_eq!(rows[0].artifact_status, ArtifactStatus::Unresolved);
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(matches!(
        inventory(embedding.as_ref(), None, &cancel),
        Err(EngineError::Cancelled(_))
    ));
}
#[test]
fn local_fallback_disabled_by_factory_does_not_appear_in_inventory() {
    let root = support::canonical_tempdir();
    // The same local model would be refused if the fallback were enabled.
    let config:EngineConfig=serde_json::from_value(json!({"reranker":{"provider":"local-transformers","fallbackOnError":false,"fallbackProvider":"local-transformers","fallbackModel":"woxpas-ai/bge-reranker-v2-m3-onnx"}})).unwrap();
    let host = Arc::new(support::TestHost::new(root.path().to_owned()));
    let embedding = build_embedding_owned(&config, host.clone()).unwrap();
    let reranker = build_reranker_owned(&config, host).unwrap().unwrap();
    let rows = inventory(
        embedding.as_ref(),
        Some(reranker.as_ref()),
        &Cancel::never(),
    )
    .unwrap();
    assert_eq!(rows.len(), 2);
    assert!(!rows.iter().any(|r| r.role == ModelRole::RerankerFallback));
    let value: Value = serde_json::to_value(rows).unwrap();
    assert_eq!(value[1]["artifactStatus"], "missing");
}

#[test]
fn process_engine_native_inventory_preserves_the_frozen_models_service_and_close_boundary() {
    use plur1bus_engine::{contract::Engine, rpc::engine::ProcessEngine};
    let root = support::canonical_tempdir();
    let host = Arc::new(support::TestHost::new(root.path().to_owned()));
    let engine = ProcessEngine::new(host, None).unwrap();
    let before = serde_json::to_value(engine.models().status()).unwrap();
    let rows = engine.inventory(&Cancel::never()).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].artifact_status, ArtifactStatus::Missing);
    assert_eq!(
        serde_json::to_value(engine.models().status()).unwrap(),
        before,
        "inventory never warms or probes"
    );
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    engine.close(None).unwrap();
    assert!(
        matches!(engine.inventory(&Cancel::never()),Err(EngineError::NotAvailable{reason}) if reason=="closed")
    );
}
