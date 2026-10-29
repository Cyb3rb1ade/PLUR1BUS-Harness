//! Exact pinned-tokenizer parity without ONNX graphs or a native runtime.
#![allow(clippy::unwrap_used)]
// Missing required goldens/cache files must fail these tests with a preparation diagnostic.
#![cfg_attr(test, allow(clippy::panic))]

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/vectors")
}
fn recorded(name: &str) -> Value {
    let path = fixtures().join(name);
    let bytes=fs::read(&path).unwrap_or_else(|error|panic!("required Node parity fixture {} is missing ({error}); run record.mjs --token-ids after fetching the pinned tokenizer files; never substitute goldens",path.display()));
    serde_json::from_slice(&bytes).unwrap()
}

#[test]
fn token_ids_match_the_node_engine_for_every_committed_tokenizer() {
    let fixture = recorded("token-ids.json");
    let sentences = recorded("sentences.json");
    let manifest = recorded("tokenizer-artifacts.json");
    let directory=std::env::var_os("PLUR1BUS_TOKENIZER_DIR").map(PathBuf::from).unwrap_or_else(||panic!("PLUR1BUS_TOKENIZER_DIR is required; run node scripts/tokens/setup-tokenizers.mjs --directory <cache>"));
    let models = fixture["models"].as_array().unwrap();
    for (model, id) in [
        ("intfloat/multilingual-e5-small", "embedding-e5-small"),
        ("google/embeddinggemma-2", "embeddinggemma-2"),
    ] {
        let golden = models
            .iter()
            .find(|row| row["model"] == model)
            .unwrap_or_else(|| panic!("required tokenizer golden missing for {model}"));
        let artifact = manifest["artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == id)
            .unwrap();
        let path = directory.join(id).join("tokenizer.json");
        let bytes=fs::read(&path).unwrap_or_else(|error|panic!("required pinned tokenizer {} unavailable ({error}); run scripts/tokens/setup-tokenizers.mjs",path.display()));
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            artifact["sha256"].as_str().unwrap(),
            "tokenizer bytes changed for {model}"
        );
        assert_eq!(artifact["sha256"], golden["tokenizerSha256"]);
        let mut tokenizer = tokenizers::Tokenizer::from_file(path).unwrap();
        tokenizer.with_truncation(None).unwrap();
        tokenizer.with_padding(None);
        let cap = golden["truncationLen"].as_u64().unwrap() as usize;
        assert_eq!(
            golden["cases"].as_array().unwrap().len(),
            sentences["cases"].as_array().unwrap().len() * 2,
            "every query and passage must be recorded for {model}"
        );
        let mut saw_closing_loss = false;
        for case in golden["cases"].as_array().unwrap() {
            let id = case["id"].as_u64().unwrap() as usize;
            let text = sentences["cases"][id]["text"].as_str().unwrap();
            let kind = case["kind"].as_str().unwrap();
            let prefix = golden[if kind == "query" {
                "queryPrefix"
            } else {
                "passagePrefix"
            }]
            .as_str()
            .unwrap_or("");
            let prefixed = format!("{prefix}{text}");
            let full = tokenizer.encode(prefixed.as_str(), true).unwrap();
            let ids = &full.get_ids()[..full.len().min(cap)];
            let expected: Vec<u32> = serde_json::from_value(case["input_ids"].clone()).unwrap();
            assert_eq!(
                ids, expected,
                "token IDs differ: {model}, sentence {id}, {kind}"
            );
            let expected_mask: Vec<u32> =
                serde_json::from_value(case["attention_mask"].clone()).unwrap();
            assert_eq!(
                &full.get_attention_mask()[..full.len().min(cap)],
                expected_mask,
                "attention mask differs for {model}, sentence {id}, {kind}"
            );
            assert_eq!(full.len(), case["fullLength"].as_u64().unwrap() as usize);
            if case["truncated"] == true {
                assert_eq!(ids.len(), cap);
                assert_eq!(case["closingTokenLost"], true);
                assert_ne!(ids.last(), full.get_ids().last());
                saw_closing_loss = true;
            }
        }
        assert!(
            saw_closing_loss,
            "over-cap closing-token parity case absent for {model}"
        );
    }
}

#[test]
fn bge_token_ids_match_the_node_engine() {
    let fixture = recorded("token-ids-bge.json");
    let sentences = recorded("sentences.json");
    let manifest = recorded("tokenizer-artifacts.json");
    let model = "woxpas-ai/bge-reranker-v2-m3-onnx";
    let golden = fixture["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["model"] == model)
        .unwrap();
    // This entry may only be added with the verified pinned BGE licence receipt.
    let artifact = manifest["artifacts"].as_array().unwrap().iter()
        .find(|row| row["repository"] == model)
        .unwrap_or_else(|| panic!("required BGE tokenizer manifest entry is absent: verify its pinned repository licence before generating/committing BGE-derived goldens"));
    let directory = std::env::var_os("PLUR1BUS_TOKENIZER_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| panic!("PLUR1BUS_TOKENIZER_DIR is required for BGE tokenizer parity"));
    let path = directory
        .join(artifact["id"].as_str().unwrap())
        .join("tokenizer.json");
    let bytes = fs::read(&path).unwrap_or_else(|error| {
        panic!(
            "required BGE tokenizer {} is unavailable ({error})",
            path.display()
        )
    });
    assert_eq!(
        format!("{:x}", Sha256::digest(&bytes)),
        golden["tokenizerSha256"].as_str().unwrap()
    );
    let mut tokenizer = tokenizers::Tokenizer::from_bytes(bytes).unwrap();
    tokenizer.with_truncation(None).unwrap();
    tokenizer.with_padding(None);
    let cap = golden["truncationLen"].as_u64().unwrap() as usize;
    let cases = golden["cases"].as_array().unwrap();
    assert_eq!(
        cases.len(),
        51,
        "fifty summary pairs plus the over-cap pair are required"
    );
    let mut closing_lost = false;
    for case in cases {
        let query = sentences["cases"][case["queryId"].as_u64().unwrap() as usize]["text"]
            .as_str()
            .unwrap();
        let doc_id = case["docId"].as_u64().unwrap() as usize;
        let text = sentences["cases"][doc_id]["text"].as_str().unwrap();
        let document = if sentences["cases"][doc_id]["kind"] == "over-cap" {
            text.to_owned()
        } else {
            text.split_whitespace()
                .take(150)
                .collect::<Vec<_>>()
                .join(" ")
        };
        // Node (Transformers.js) encodes an empty document as the query alone, not as a pair.
        let full = if document.is_empty() {
            tokenizer.encode(query, true).unwrap()
        } else {
            tokenizer.encode((query, document.as_str()), true).unwrap()
        };
        let retained = full.len().min(cap);
        let expected: Vec<u32> = serde_json::from_value(case["input_ids"].clone()).unwrap();
        let mask: Vec<u32> = serde_json::from_value(case["attention_mask"].clone()).unwrap();
        assert_eq!(&full.get_ids()[..retained], expected);
        assert_eq!(&full.get_attention_mask()[..retained], mask);
        assert_eq!(full.len(), case["fullLength"].as_u64().unwrap() as usize);
        if case["truncated"] == true {
            assert_eq!(retained, cap);
            assert_eq!(case["closingTokenLost"], true);
            assert_ne!(
                full.get_ids()[retained - 1],
                *full.get_ids().last().unwrap()
            );
            closing_lost = true;
        }
    }
    assert!(
        closing_lost,
        "the over-cap BGE pair must lose its closing separator"
    );
}
