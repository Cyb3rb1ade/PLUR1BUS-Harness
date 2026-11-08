//! Actual Node vectors with explicit source and integrity exceptions.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    context::RequestContext,
    contract::{AgentContext, Principal, StoreError},
    neo::merged::{Layout, MetadataReader, RecordKind},
    text::json::write_json,
};
use serde_json::{json, Value};
use std::fs;
fn context(host: &support::TestHost) -> RequestContext {
    let p: Principal=serde_json::from_value(json!({"agentId":"alpha","workspace":"workspace:v1:one","channel":"telegram","accountId":"fixture-account","chat":{"id":"fixture-chat","kind":"direct"},"trust":"proved"})).unwrap();
    let a: AgentContext =
        serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
    RequestContext::build(&p, &a, host).unwrap()
}

#[test]
fn actual_sidecar_bytes_match_node_or_the_explicit_integrity_exception() {
    use sha2::{Digest, Sha256};
    let f: Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/neo-vectors.json")).unwrap();
    let e: Value =
        serde_json::from_str(include_str!("fixtures/capture/neo-vectors-exceptions.json")).unwrap();
    assert_eq!(
        format!(
            "{:x}",
            Sha256::digest(include_bytes!("fixtures/capture/golden/neo-vectors.json"))
        ),
        e["nodeGoldenSha256"]
    );
    for c in f["cases"].as_array().unwrap() {
        let root = support::canonical_tempdir();
        let host = support::TestHost::new(root.path().join("state"));
        let ctx = context(&host);
        let layout = Layout::for_key("workspace");
        for file in c["files"].as_array().unwrap() {
            let name = if file["source"] == "canonical" {
                &layout.canonical
            } else {
                layout.legacy.as_ref().unwrap()
            };
            let dir = root.path().join("workspaces").join(name);
            fs::create_dir_all(&dir).unwrap();
            let bytes = file["text"]
                .as_str()
                .map(|s| s.as_bytes().to_vec())
                .unwrap_or_else(|| {
                    file["bytes"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| v.as_u64().unwrap() as u8)
                        .collect()
                });
            fs::write(dir.join(file["name"].as_str().unwrap()), bytes).unwrap();
        }
        let reader = MetadataReader::open(root.path(), "workspace").unwrap();
        let out = reader.read_records(RecordKind::Candidates, 10, &ctx);
        let exception = &e["cases"][c["name"].as_str().unwrap()];
        if exception["error"] == "Corrupt" {
            assert!(matches!(out, Err(StoreError::Corrupt)), "{}", c["name"]);
            continue;
        }
        let expected = exception
            .get("output")
            .unwrap_or(&c["output"])
            .as_array()
            .unwrap();
        let actual = out.unwrap();
        assert_eq!(actual.len(), expected.len(), "{}", c["name"]);
        for (record, wanted) in actual.iter().zip(expected) {
            assert_eq!(
                serde_json::from_str::<Value>(&write_json(&record.metadata)).unwrap(),
                wanted["metadata"],
                "{}",
                c["name"]
            );
            // JavaScript has one Number type; compare exact f64 values rather than
            // serde_json's lexical integer-versus-float representation (3 versus 3.0).
            let embedding: Option<Vec<f64>> =
                serde_json::from_value(wanted["embedding"].clone()).unwrap();
            assert_eq!(record.embedding, embedding, "{}", c["name"]);
        }
    }
}
fn setup(root: &std::path::Path) -> std::path::PathBuf {
    let dir = root
        .join("workspaces")
        .join(Layout::for_key("workspace").canonical);
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("memory-candidates.jsonl"),
        r#"{"id":"a","agentId":"alpha","createdAt":1}"#,
    )
    .unwrap();
    dir
}
fn index(length: usize) -> Value {
    json!({"version":1,"endian":"LE","file":"vectors.7.f32","entries":{"a":{"offset":0,"length":length,"dims":length/4}}})
}
#[test]
fn vector_and_manifest_memory_bounds_are_explicit() {
    let root = support::canonical_tempdir();
    let host = support::TestHost::new(root.path().join("state"));
    let ctx = context(&host);
    let dir = setup(root.path());
    let reader = MetadataReader::open(root.path(), "workspace").unwrap();
    let file = fs::File::create(dir.join("vector-index.json")).unwrap();
    file.set_len(64 * 1024 * 1024 + 1).unwrap();
    assert!(matches!(
        reader.read_records(RecordKind::Candidates, 2, &ctx),
        Err(StoreError::InvalidInput)
    ));
    fs::write(
        dir.join("vector-index.json"),
        index(64 * 1024 * 1024 + 4).to_string(),
    )
    .unwrap();
    let file = fs::File::create(dir.join("vectors.7.f32")).unwrap();
    file.set_len(64 * 1024 * 1024 + 4).unwrap();
    assert!(matches!(
        reader.read_records(RecordKind::Candidates, 2, &ctx),
        Err(StoreError::InvalidInput)
    ));
}
#[test]
fn invalid_generation_paths_and_ambiguous_entries_are_rejected() {
    let root = support::canonical_tempdir();
    let host = support::TestHost::new(root.path().join("state"));
    let ctx = context(&host);
    let dir = setup(root.path());
    let reader = MetadataReader::open(root.path(), "workspace").unwrap();
    let mut manifest = index(4);
    manifest["file"] = json!("../outside.f32");
    fs::write(dir.join("vector-index.json"), manifest.to_string()).unwrap();
    assert!(matches!(
        reader.read_records(RecordKind::Candidates, 2, &ctx),
        Err(StoreError::Corrupt)
    ));
    fs::write(dir.join("vector-index.json"),r#"{"version":1,"endian":"LE","file":"vectors.7.f32","entries":{"a":{"offset":0,"length":4,"dims":1},"a":{"offset":4,"length":4,"dims":1}}}"#).unwrap();
    assert!(matches!(
        reader.read_records(RecordKind::Candidates, 2, &ctx),
        Err(StoreError::Corrupt)
    ));
}
#[cfg(unix)]
#[test]
fn link_targets_are_never_opened_for_vectors_and_acl_precedes_index_reads() {
    use std::os::unix::fs::symlink;
    let root = support::canonical_tempdir();
    let host = support::TestHost::new(root.path().join("state"));
    let ctx = context(&host);
    let dir = setup(root.path());
    let reader = MetadataReader::open(root.path(), "workspace").unwrap();
    let outside = root.path().join("outside");
    fs::write(&outside, index(4).to_string()).unwrap();
    symlink(&outside, dir.join("vector-index.json")).unwrap();
    assert!(reader
        .read_records(RecordKind::Candidates, 2, &ctx)
        .is_err());
    fs::write(
        dir.join("memory-candidates.jsonl"),
        r#"{"id":"a","agentId":"foreign","createdAt":1}"#,
    )
    .unwrap();
    assert!(reader
        .read_records(RecordKind::Candidates, 2, &ctx)
        .unwrap()
        .is_empty());
    fs::write(
        dir.join("memory-candidates.jsonl"),
        r#"{"id":"a","agentId":"alpha","createdAt":1}"#,
    )
    .unwrap();
    fs::remove_file(dir.join("vector-index.json")).unwrap();
    fs::write(dir.join("vector-index.json"), index(4).to_string()).unwrap();
    fs::write(&outside, 1f32.to_le_bytes()).unwrap();
    symlink(&outside, dir.join("vectors.7.f32")).unwrap();
    assert!(reader
        .read_records(RecordKind::Candidates, 2, &ctx)
        .is_err());
    fs::remove_file(dir.join("vectors.7.f32")).unwrap();
    fs::hard_link(&outside, dir.join("vectors.7.f32")).unwrap();
    assert!(reader
        .read_records(RecordKind::Candidates, 2, &ctx)
        .is_err());
}
