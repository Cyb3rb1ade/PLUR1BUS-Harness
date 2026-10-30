//! Local provider construction and deterministic pooling without model downloads.
#![allow(clippy::unwrap_used)]

use plur1bus_engine::embedding::local_ort::{build_local_embedding, pool_hidden, Pooling};
use plur1bus_engine::embedding::local_rerank::build_local_reranker;
use plur1bus_engine::embedding::normalize::normalize_embedding_config;
use plur1bus_engine::embedding::{Cancel, EmbedKind};
use serde_json::json;
use std::path::Path;

fn config(
    model: &str,
    width: usize,
) -> plur1bus_engine::embedding::normalize::NormalizedEmbeddingConfig {
    normalize_embedding_config(&json!({"provider":"local-transformers","local":{
        "model":model,"dimensions":width,"cacheDir":"/fixture/models"
    }}))
    .unwrap()
}

#[test]
fn local_factories_are_lazy_and_preserve_the_pinned_vector_identity() {
    let e5 = build_local_embedding(
        &config("intfloat/multilingual-e5-small", 384),
        Path::new("/missing-model-cache"),
        false,
    )
    .unwrap();
    let identity = serde_json::to_value(e5.identity()).unwrap();
    let expected: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/store-v1/identity.json")).unwrap();
    assert_eq!(identity, expected);
    assert!(e5
        .embed(&["hello".into()], EmbedKind::Query, &Cancel::never())
        .is_err());
    assert!(e5
        .embed(&[], EmbedKind::Passage, &Cancel::never())
        .unwrap()
        .is_empty());
    let gemma = build_local_embedding(
        &config("google/embeddinggemma-2", 128),
        Path::new("/missing-model-cache"),
        false,
    )
    .unwrap();
    assert_eq!(gemma.identity().dimension.as_u64(), Some(128));
    assert_eq!(gemma.identity().dtype, "q8");
    assert!(build_local_reranker(
        &json!({"model":"woxpas-ai/bge-reranker-v2-m3-onnx"}),
        Path::new("/missing-model-cache"),
        false
    )
    .is_ok());
}

#[test]
fn all_noncommercial_profiles_require_explicit_consent_before_loading() {
    for (model, width) in [
        ("jinaai/jina-embeddings-v3", 64),
        ("jinaai/jina-embeddings-v5-text-nano-retrieval", 768),
    ] {
        let cfg = config(model, width);
        assert!(build_local_embedding(&cfg, Path::new("/missing"), false).is_err());
        assert!(build_local_embedding(&cfg, Path::new("/missing"), true).is_ok());
    }
    let reranker = json!({"model":"jinaai/jina-reranker-v2-base-multilingual"});
    assert!(build_local_reranker(&reranker, Path::new("/missing"), false).is_err());
    assert!(build_local_reranker(&reranker, Path::new("/missing"), true).is_ok());
}

#[test]
fn gemma_refuses_non_profile_prefixes_and_revisions_before_loading() {
    for extra in [
        json!({"queryPrefix":"query: "}),
        json!({"passagePrefix":"passage: "}),
        json!({"revision":"wrong"}),
    ] {
        let mut raw = json!({"provider":"local-transformers","local":{"model":"google/embeddinggemma-2","dimensions":768,"cacheDir":"/fixture/models"}});
        raw["local"]
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let cfg = normalize_embedding_config(&raw).unwrap();
        assert!(build_local_embedding(&cfg, Path::new("/missing"), false).is_err());
    }
}

#[test]
fn masked_mean_excludes_padding_then_projects_and_renormalizes() {
    let vectors = pool_hidden(
        &[3.0, 4.0, 0.0, 99.0, 99.0, 99.0],
        &[1, 2, 3],
        &[1, 0],
        2,
        Pooling::Mean,
    )
    .unwrap();
    assert!((vectors[0][0] - 0.6).abs() < 1e-6);
    assert!((vectors[0][1] - 0.8).abs() < 1e-6);
    assert!(pool_hidden(&[0.0, 0.0], &[1, 1, 2], &[1], 2, Pooling::Mean).is_err());
    assert!(pool_hidden(&[1.0, 2.0], &[1, 2, 2], &[1, 1], 2, Pooling::Mean).is_err());
    assert!(pool_hidden(&[1.0, 2.0], &[1, 1, 2], &[0], 2, Pooling::Mean).is_err());
}

#[test]
fn last_attended_pooling_handles_both_padding_sides() {
    let rows = pool_hidden(
        &[
            99.0, 99.0, 3.0, 4.0, 6.0, 8.0, 3.0, 4.0, 6.0, 8.0, 99.0, 99.0,
        ],
        &[2, 3, 2],
        &[0, 1, 1, 1, 1, 0],
        2,
        Pooling::LastAttended,
    )
    .unwrap();
    assert_eq!(rows[0], rows[1]);
    assert!((rows[0][0] - 0.6).abs() < 1e-6);
    assert!((rows[0][1] - 0.8).abs() < 1e-6);
}

#[test]
fn gemma_float32_mean_matches_node_accumulation_before_matryoshka_projection() {
    // Synthetic attended states, padded to the pinned native/output widths. Node's
    // Float32Array rounds each addition; a double accumulator gives another vector.
    let mut hidden = vec![0.0; 3 * 768];
    hidden[0] = 1.0;
    hidden[1] = 1e-7;
    hidden[768] = 1e-7;
    hidden[2 * 768] = -1.0;
    let rows = pool_hidden(&hidden, &[1, 3, 768], &[1, 1, 1], 128, Pooling::MeanFloat32).unwrap();
    assert!((rows[0][0] - 0.766_134_56).abs() < 1e-7);
    assert!((rows[0][1] - 0.642_680_2).abs() < 1e-7);
    assert!(rows[0][2..].iter().all(|value| *value == 0.0));
    let double = pool_hidden(&hidden, &[1, 3, 768], &[1, 1, 1], 128, Pooling::Mean).unwrap();
    assert!((double[0][0] - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-7);
    assert!((double[0][1] - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-7);
}
