//! Real-model vector and score parity, isolated behind the real-models feature.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]
// Missing required models/goldens are failures, never ignored or skipped tests.
#![cfg_attr(test, allow(clippy::panic))]

#[path = "common/onnx_runtime.rs"]
mod onnx_runtime;
use plur1bus_engine::embedding::local_ort::{build_local_embedding, initialize_runtime};
use plur1bus_engine::embedding::local_rerank::build_local_reranker;
use plur1bus_engine::embedding::normalize::normalize_embedding_config;
use plur1bus_engine::embedding::{Cancel, EmbedKind, EmbeddingProvider};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/vectors")
}
fn read(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap_or_else(|error|panic!("required real-model parity fixture {} unavailable ({error}); run the pinned Node recorder, never skip this check",path.display()))).unwrap()
}
fn chunks(directory: &Path, name: &str) -> Value {
    let stem = name.strip_suffix(".json").unwrap();
    let index = directory.join(format!("{stem}.index.json"));
    if !index.is_file() {
        return read(&directory.join(name));
    }
    let mut result = read(&index);
    let parts = result["parts"].as_array().unwrap().clone();
    let mut cases = vec![];
    for part in parts {
        let name = part.as_str().unwrap();
        assert!(
            !name.contains(['/', '\\']) && !name.starts_with('.'),
            "invalid fixture part"
        );
        cases.extend(
            read(&directory.join(name))["cases"]
                .as_array()
                .unwrap()
                .clone(),
        );
    }
    result["cases"] = json!(cases);
    result
}
fn model_cache() -> PathBuf {
    std::env::var_os("PLUR1BUS_MODELS_CACHE").map(PathBuf::from).unwrap_or_else(||panic!("PLUR1BUS_MODELS_CACHE is required and must contain the SHA-verified pinned model files"))
}
fn provider(golden: &Value, cache: &Path, nc: bool) -> Box<dyn EmbeddingProvider> {
    provider_with_batch(golden, cache, nc, true)
}
fn provider_with_batch(
    golden: &Value,
    cache: &Path,
    nc: bool,
    singleton: bool,
) -> Box<dyn EmbeddingProvider> {
    let mut local = json!({"model":golden["model"],"dimensions":golden["dimensions"],"revision":golden["revision"],"cacheDir":cache});
    if let Some(dtype) = golden["dtype"].as_str().filter(|s| *s != "float32") {
        local["dtype"] = json!(dtype);
    }
    if singleton && golden["model"] == "google/embeddinggemma-2" {
        local["maxBatchSize"] = json!(1);
    }
    let config =
        normalize_embedding_config(&json!({"provider":"local-transformers","local":local}))
            .unwrap();
    build_local_embedding(&config, cache, nc).unwrap()
}
fn vectors(directory: &Path, name: &str, nc: bool) {
    let golden = chunks(directory, name);
    let cache = model_cache();
    initialize_runtime(&onnx_runtime::ensure_runtime()).unwrap();
    let provider = provider(&golden, &cache, nc);
    let sentences = read(&fixtures().join("sentences.json"));
    assert_eq!(
        golden["cases"].as_array().unwrap().len(),
        sentences["cases"].as_array().unwrap().len(),
        "all 53 sentences must have real vectors"
    );
    let (mut minimum_cosine, mut maximum_delta) = (1.0_f64, 0.0_f64);
    for case in golden["cases"].as_array().unwrap() {
        let text = sentences["cases"][case["id"].as_u64().unwrap() as usize]["text"]
            .as_str()
            .unwrap()
            .to_owned();
        for (name, kind) in [("query", EmbedKind::Query), ("passage", EmbedKind::Passage)] {
            let actual = provider
                .embed(std::slice::from_ref(&text), kind, &Cancel::never())
                .unwrap();
            let expected: Vec<f32> = serde_json::from_value(case[name].clone()).unwrap();
            assert_eq!(actual.len(), 1);
            assert_eq!(actual[0].len(), expected.len());
            let dot = actual[0]
                .iter()
                .zip(&expected)
                .map(|(a, b)| f64::from(*a) * f64::from(*b))
                .sum::<f64>();
            let norm = |v: &[f32]| v.iter().map(|n| f64::from(*n).powi(2)).sum::<f64>().sqrt();
            let cosine = dot / (norm(&actual[0]) * norm(&expected));
            let delta = actual[0]
                .iter()
                .zip(&expected)
                .map(|(a, b)| (f64::from(*a) - f64::from(*b)).abs())
                .fold(0.0, f64::max);
            minimum_cosine = minimum_cosine.min(cosine);
            maximum_delta = maximum_delta.max(delta);
            assert!(cosine>=0.9999 && delta<=1e-4,"vector parity outside tolerance for model {}, sentence {}, purpose {name}: cosine={cosine}, delta={delta}",golden["model"],case["id"]);
        }
    }
    // A default Gemma batch of seventeen crosses the production sixteen-row sub-batch boundary.
    // Keep the very long over-cap input in the singleton loop above to bound attention memory.
    let batched = provider_with_batch(&golden, &cache, nc, false);
    let inputs: Vec<String> = sentences["cases"]
        .as_array()
        .unwrap()
        .iter()
        .take(17)
        .map(|row| row["text"].as_str().unwrap().to_owned())
        .collect();
    // A padding-invariant model (e5, EmbeddingGemma 2) must batch to its one-by-one goldens. The quantized jina
    // conversions are not padding-invariant in Node either, so their live recording carries Node's own batch.
    let node_batch = nc.then(|| read(&directory.join(name.replace(".json", "-batched.json"))));
    for (name, kind) in [("query", EmbedKind::Query), ("passage", EmbedKind::Passage)] {
        let actual = batched.embed(&inputs, kind, &Cancel::never()).unwrap();
        assert_eq!(actual.len(), inputs.len());
        for (index, row) in actual.iter().enumerate() {
            let recorded = match &node_batch {
                Some(batch) => batch[name][index].clone(),
                None => golden["cases"][index][name].clone(),
            };
            let expected: Vec<f32> = serde_json::from_value(recorded).unwrap();
            assert_eq!(row.len(), expected.len());
            let dot = row
                .iter()
                .zip(&expected)
                .map(|(a, b)| f64::from(*a) * f64::from(*b))
                .sum::<f64>();
            let norm = |v: &[f32]| v.iter().map(|n| f64::from(*n).powi(2)).sum::<f64>().sqrt();
            let cosine = dot / (norm(row) * norm(&expected));
            let delta = row
                .iter()
                .zip(&expected)
                .map(|(a, b)| (f64::from(*a) - f64::from(*b)).abs())
                .fold(0.0, f64::max);
            assert!(cosine >= 0.9999 && delta <= 1e-4, "batched vector parity outside tolerance, model {}, purpose {name}: cosine={cosine}, delta={delta}", golden["model"]);
            minimum_cosine = minimum_cosine.min(cosine);
            maximum_delta = maximum_delta.max(delta);
        }
    }
    println!("model={} revision={} dtype={} min_cosine={minimum_cosine:.10} max_abs_delta={maximum_delta:.10}",golden["model"],golden["revision"],golden["dtype"]);
}

#[test]
fn e5_vectors_match_the_node_engine() {
    vectors(&fixtures(), "e5-small.json", false);
}
#[test]
fn gemma_vectors_match_the_node_engine() {
    vectors(&fixtures(), "embeddinggemma-2.json", false);
}

fn reranker(directory: &Path, name: &str, nc: bool) {
    let golden = read(&directory.join(name));
    let cache = model_cache();
    initialize_runtime(&onnx_runtime::ensure_runtime()).unwrap();
    let ranker = build_local_reranker(
        &json!({"model":golden["model"],"revision":golden["revision"],"dtype":"q8"}),
        &cache,
        nc,
    )
    .unwrap();
    let sentences = read(&fixtures().join("sentences.json"));
    assert_eq!(
        golden["pairs"].as_array().unwrap().len(),
        50,
        "all fifty rerank pairs must be recorded"
    );
    let mut scores = vec![];
    let mut maximum_delta = 0.0_f64;
    for pair in golden["pairs"].as_array().unwrap() {
        let query = sentences["cases"][pair["queryId"].as_u64().unwrap() as usize]["text"]
            .as_str()
            .unwrap();
        let doc = sentences["cases"][pair["docId"].as_u64().unwrap() as usize]["text"]
            .as_str()
            .unwrap();
        let cap = golden["docWordCap"].as_u64().unwrap_or(150) as usize;
        let document = doc
            .split_whitespace()
            .take(cap)
            .collect::<Vec<_>>()
            .join(" ");
        let hits = ranker
            .rerank(query, &[document], 1, &Cancel::never())
            .unwrap();
        assert_eq!(hits.len(), 1);
        let score = hits[0].score.as_f64().unwrap();
        let delta = (score - pair["score"].as_f64().unwrap()).abs();
        maximum_delta = maximum_delta.max(delta);
        assert!(
            delta <= 1e-3,
            "rerank parity outside tolerance, model {}, pair {}, delta={delta}",
            golden["model"],
            pair["id"]
        );
        scores.push((pair["id"].as_u64().unwrap(), score));
    }
    scores.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let actual: Vec<u64> = scores.iter().map(|row| row.0).collect();
    let expected: Vec<u64> = serde_json::from_value(golden["order"].clone()).unwrap();
    assert_eq!(actual, expected);
    let rankings = golden["rankingCases"].as_array().expect(
        "required Node multi-document ranking cases missing; regenerate the pinned recorder output",
    );
    assert!(rankings.len() >= 2);
    for case in rankings {
        let query = sentences["cases"][case["queryId"].as_u64().unwrap() as usize]["text"]
            .as_str()
            .unwrap();
        let documents = case["docIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|id| {
                sentences["cases"][id.as_u64().unwrap() as usize]["text"]
                    .as_str()
                    .unwrap()
                    .split_whitespace()
                    .take(150)
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .collect::<Vec<_>>();
        let hits = ranker
            .rerank(
                query,
                &documents,
                case["topN"].as_u64().unwrap() as usize,
                &Cancel::never(),
            )
            .unwrap();
        let expected = case["hits"].as_array().unwrap();
        assert_eq!(hits.len(), expected.len());
        for (hit, expected) in hits.iter().zip(expected) {
            assert_eq!(
                hit.index.as_u64(),
                expected["index"].as_u64(),
                "multi-document ranking index differs"
            );
            let delta = (hit.score.as_f64().unwrap() - expected["score"].as_f64().unwrap()).abs();
            assert!(
                delta <= 1e-3,
                "multi-document score parity outside tolerance: delta={delta}"
            );
            maximum_delta = maximum_delta.max(delta);
        }
    }
    println!(
        "model={} revision={} max_abs_score_delta={maximum_delta:.10}",
        golden["model"], golden["revision"]
    );
}
#[test]
fn bge_scores_order_matches_the_node_engine() {
    reranker(&fixtures(), "bge-scores.json", false);
}

#[test]
fn jina_vectors_and_reranking_match_live_node_without_repository_goldens() {
    assert!(std::env::var("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref()==Ok("1") && std::env::var("PLUR1BUS_TEST_ACCEPT_NC_MODELS").as_deref()==Ok("1"),"jina real-model tests require explicit noncommercial test consent: PLUR1BUS_ALLOW_TEST_INTERNALS=1 and PLUR1BUS_TEST_ACCEPT_NC_MODELS=1");
    let directory = tempfile::tempdir().unwrap();
    let output = Command::new("node")
        .arg(fixtures().join("record.mjs"))
        .arg("--jina")
        .arg("--output-dir")
        .arg(directory.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "live Node jina recorder failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    vectors(directory.path(), "jina-v3.json", true);
    vectors(directory.path(), "jina-v5.json", true);
    reranker(directory.path(), "jina-reranker.json", true);
    jina_token_ids(directory.path());
    jina_identities_and_purposes(directory.path());
}

fn jina_identities_and_purposes(directory: &Path) {
    use plur1bus_engine::embedding::identity::{identity_from_value, identity_id};
    let recorded = read(&directory.join("identities-jina.json"));
    let cache = model_cache();
    for (model, file) in [
        ("jinaai/jina-embeddings-v3", "jina-v3.json"),
        (
            "jinaai/jina-embeddings-v5-text-nano-retrieval",
            "jina-v5.json",
        ),
    ] {
        let row = recorded["identities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["model"] == model)
            .expect("live identity record missing");
        let expected = identity_from_value(&row["identity"]).unwrap();
        let actual = provider(&chunks(directory, file), &cache, true);
        assert!(
            identity_id(actual.identity()) == identity_id(&expected),
            "live identity differs for {model}"
        );
    }
    let adaptations = recorded["taskAdaptations"].as_array().unwrap();
    let observed = recorded["taskIds"].as_array().unwrap();
    assert_eq!(observed.len(), 53 * 2);
    for row in observed {
        let purpose = format!("retrieval.{}", row["kind"].as_str().unwrap());
        let expected = adaptations
            .iter()
            .position(|value| value == &purpose)
            .unwrap();
        assert!(
            row["task_id"] == json!([expected]),
            "live Node task_id differs from the pinned purpose table"
        );
    }
    assert!(recorded["prefixChecks"]
        .as_array()
        .unwrap()
        .iter()
        .any(
            |row| row["model"] == "jinaai/jina-embeddings-v5-text-nano-retrieval"
                && row["nonProfilePrefixRejected"] == true
        ));
}

fn jina_token_ids(directory: &Path) {
    use plur1bus_engine::embedding::artifacts::{pinned_profile, resolve};
    use plur1bus_engine::embedding::local_ort::tokenizer::ModelTokenizer;
    let recorded = read(&directory.join("token-ids-jina.json"));
    let models = recorded["models"].as_array().unwrap();
    let sentences = read(&fixtures().join("sentences.json"));
    let cache = model_cache();
    for model in [
        "jinaai/jina-embeddings-v3",
        "jinaai/jina-embeddings-v5-text-nano-retrieval",
        "jinaai/jina-reranker-v2-base-multilingual",
    ] {
        let golden = models
            .iter()
            .find(|entry| entry["model"] == model)
            .unwrap_or_else(|| panic!("required live tokenizer record missing for {model}"));
        let profile = pinned_profile(model, None).unwrap();
        let resolved = resolve(model, &cache).unwrap();
        let cap = golden["truncationLen"].as_u64().unwrap() as usize;
        let tokenizer =
            ModelTokenizer::from_artifact(profile, &resolved.directory, Some(cap)).unwrap();
        let mut saw_truncation = false;
        for case in golden["cases"].as_array().unwrap() {
            let id = case["id"].as_u64().unwrap() as usize;
            let kind = case["kind"].as_str().unwrap();
            let ids = if kind == "pair" {
                let query_id = case["queryId"].as_u64().unwrap() as usize;
                let doc_id = case["docId"].as_u64().unwrap() as usize;
                let query = sentences["cases"][query_id]["text"].as_str().unwrap();
                let text = sentences["cases"][doc_id]["text"].as_str().unwrap();
                let document = if sentences["cases"][doc_id]["kind"] == "over-cap" {
                    text.to_owned()
                } else {
                    text.split_whitespace()
                        .take(150)
                        .collect::<Vec<_>>()
                        .join(" ")
                };
                tokenizer.encode_ids(query, Some(&document)).unwrap()
            } else {
                let text = sentences["cases"][id]["text"].as_str().unwrap();
                let prefix = golden[if kind == "query" {
                    "queryPrefix"
                } else {
                    "passagePrefix"
                }]
                .as_str()
                .unwrap_or("");
                tokenizer
                    .encode_ids(&format!("{prefix}{text}"), None)
                    .unwrap()
            };
            let expected: Vec<u32> = serde_json::from_value(case["input_ids"].clone()).unwrap();
            assert!(
                ids == expected,
                "live token IDs differ for {model}, case {id}, purpose {kind}"
            );
            if case["truncated"] == true {
                assert_eq!(ids.len(), cap);
                assert!(
                    case["closingTokenLost"] == true,
                    "the closing special token must be lost after Node truncation"
                );
                saw_truncation = true;
            }
        }
        assert!(
            saw_truncation,
            "required over-cap tokenizer case absent for {model}"
        );
        if model == "jinaai/jina-embeddings-v5-text-nano-retrieval" {
            jina_padding_pooling(golden);
        }
    }
}

fn jina_padding_pooling(golden: &Value) {
    use plur1bus_engine::embedding::local_ort::{pool_hidden, Pooling};
    let cases = golden["paddingCases"].as_array().unwrap();
    assert_eq!(cases.len(), 2);
    for side in ["left", "right"] {
        let case = cases
            .iter()
            .find(|case| case["paddingSide"] == side)
            .unwrap();
        let masks: Vec<Vec<i64>> = serde_json::from_value(case["attention_mask"].clone()).unwrap();
        let last: Vec<usize> = serde_json::from_value(case["lastAttendedIndices"].clone()).unwrap();
        assert_eq!(masks.len(), 2);
        let sequence = masks[0].len();
        let mut hidden = Vec::with_capacity(masks.len() * sequence * 2);
        for _ in &masks {
            for position in 0..sequence {
                hidden.extend([1.0, position as f32]);
            }
        }
        let mask = masks.into_iter().flatten().collect::<Vec<_>>();
        let actual =
            pool_hidden(&hidden, &[2, sequence, 2], &mask, 2, Pooling::LastAttended).unwrap();
        for (vector, last) in actual.iter().zip(last) {
            let norm = (1.0 + (last as f64).powi(2)).sqrt();
            assert!(
                (f64::from(vector[0]) - 1.0 / norm).abs() < 1e-6
                    && (f64::from(vector[1]) - last as f64 / norm).abs() < 1e-6,
                "last-attended pooling differs for live Node {side}-padding mask"
            );
        }
    }
}
