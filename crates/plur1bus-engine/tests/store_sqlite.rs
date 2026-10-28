//! SQLite format parity against databases written by the pinned Node engine (RE-02/T4).
#![cfg_attr(test, allow(clippy::unwrap_used))]

use std::{fs, path::Path, process::Command};

use plur1bus_engine::store::sqlite::{
    CacheKey, CachedLlmResult, EmbeddingCache, LlmResultCache, LlmResultKey, SpeakerMapping,
    SpeakerMappings, EMBEDDINGS_DDL, LLM_RESULTS_DDL, SPEAKER_MAPPINGS_DDL,
};
use rusqlite::{types::Value, Connection};
use serde_json::Value as Json;

fn fixtures() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sqlite")
}

fn metadata() -> Json {
    serde_json::from_slice(&fs::read(fixtures().join("rows.json")).unwrap()).unwrap()
}

fn key(text: &str) -> CacheKey {
    CacheKey::new("fixture", "fixture-embedding", 3, "a1", "legacy", text)
}

fn schema(path: &Path, table: &str) -> Vec<Vec<Value>> {
    let db = Connection::open(path).unwrap();
    let mut result = Vec::new();
    for pragma in ["table_info", "index_list"] {
        let mut statement = db.prepare(&format!("PRAGMA {pragma}({table})")).unwrap();
        let width = statement.column_count();
        let rows = statement
            .query_map([], |row| (0..width).map(|i| row.get(i)).collect())
            .unwrap();
        result.extend(rows.map(|row| row.unwrap()));
    }
    result
}

#[test]
fn rust_creates_the_same_tables_and_indexes() {
    let recorded = metadata();
    for (name, ddl) in [
        ("embeddings", EMBEDDINGS_DDL),
        ("llm_results", LLM_RESULTS_DDL),
        ("speaker_mappings", SPEAKER_MAPPINGS_DDL),
    ] {
        assert_eq!(recorded["ddl"][name].as_str().unwrap(), ddl);
    }
    // The store refuses symlinked paths, and macOS temp directories sit under /var, a symlink to /private/var.
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().canonicalize().unwrap();
    let embedding = dir.join("embeddings.sqlite");
    let llm = dir.join("llm_results.sqlite");
    let speaker = dir.join("speaker_mappings.sqlite");
    drop(EmbeddingCache::open(&embedding).unwrap());
    drop(LlmResultCache::open(&llm).unwrap());
    drop(SpeakerMappings::open(&speaker).unwrap());
    for (actual, name) in [
        (embedding, "embeddings"),
        (llm, "llm_results"),
        (speaker, "speaker_mappings"),
    ] {
        assert_eq!(
            schema(&actual, name),
            schema(&fixtures().join(format!("{name}.sqlite")), name)
        );
    }
}

#[test]
fn rust_reads_node_rows_and_node_reads_rust_rows() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().canonicalize().unwrap();
    for name in ["embeddings", "llm_results", "speaker_mappings"] {
        fs::copy(
            fixtures().join(format!("{name}.sqlite")),
            dir.join(format!("{name}.sqlite")),
        )
        .unwrap();
    }
    let rows = metadata();
    let now = rows["now"].as_i64().unwrap();
    let expires = now + 300_000;
    let embeddings = EmbeddingCache::open(&dir.join("embeddings.sqlite")).unwrap();
    for row in rows["embeddings"].as_array().unwrap() {
        let cache_key = key(row["text"].as_str().unwrap());
        assert_eq!(cache_key.key_hash(), row["keyHash"].as_str().unwrap());
        let vector = embeddings.get_at(&cache_key, now).unwrap().unwrap();
        let expected: Vec<f32> = serde_json::from_value(row["vector"].clone()).unwrap();
        assert_eq!(vector.vector, expected);
    }
    embeddings
        .put_at(&key("  ÄPFEL\u{feff}"), &[0.25, -0.5, 1.0], expires, now)
        .unwrap();

    let llm = LlmResultCache::open(&dir.join("llm_results.sqlite")).unwrap();
    let first = &rows["llm"][0];
    let llm_key = LlmResultKey {
        key_hash: first["keyHash"].as_str().unwrap().into(),
        purpose: first["request"]["purpose"].as_str().unwrap().into(),
        model: first["request"]["model"].as_str().unwrap().into(),
    };
    let cached = llm.get_at(&llm_key, now).unwrap().unwrap();
    assert_eq!(cached.text.as_deref(), first["value"]["text"].as_str());
    llm.put_at(
        &llm_key,
        &CachedLlmResult {
            text: Some("Antwort aus Rust 🚀".into()),
            input_tokens: Some(11),
            output_tokens: Some(7),
            provider_cached_input_tokens: Some(3),
            expires_at: expires,
        },
        now,
    )
    .unwrap();

    let speakers = SpeakerMappings::open(&dir.join("speaker_mappings.sqlite")).unwrap();
    let mappings = speakers.list("a1").unwrap();
    assert_eq!(mappings.len(), 2);
    assert_eq!(mappings[0].speaker_label, "speaker-1");
    let mut mapping: SpeakerMapping = serde_json::from_value(rows["speakers"][0].clone()).unwrap();
    mapping.speaker_display_name = "Rust speaker".into();
    speakers.upsert(&mapping).unwrap();
    assert!(speakers
        .confirm("a1", &mapping.speaker_label, now + 5)
        .unwrap());
    assert!(!speakers
        .confirm("a1", &mapping.speaker_label, now + 6)
        .unwrap());
    drop((embeddings, llm, speakers));

    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = Command::new("node")
        .arg(root.join("crates/plur1bus-engine/tests/node/roundtrip-check.mjs"))
        .arg("--sqlite")
        .arg(&dir)
        .current_dir(root.join("packages/core"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let actual: Json = serde_json::from_slice(&output.stdout).unwrap();
    let vector = actual["embeddings"][0]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_f64().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(vector, vec![0.25, -0.5, 1.0]);
    assert_eq!(actual["llm"][0]["text"], "Antwort aus Rust 🚀");
    assert_eq!(actual["llm"][0]["usage"]["providerCachedInputTokens"], 3);
    assert_eq!(actual["speakers"][0]["speakerDisplayName"], "Rust speaker");
    assert_eq!(actual["speakers"][0]["confirmedAt"], now + 5);
}

#[test]
fn sweep_expired_removes_only_expired_rows() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().canonicalize().unwrap();
    let embeddings = EmbeddingCache::open(&dir.join("embeddings.sqlite")).unwrap();
    for (text, expiry) in [("past", 99), ("boundary", 100), ("future", 101)] {
        embeddings
            .put_at(&key(text), &[1.0, 0.0, 0.0], expiry, 0)
            .unwrap();
    }
    assert_eq!(embeddings.sweep_expired(100).unwrap(), 2);
    assert!(embeddings.get_at(&key("future"), 100).unwrap().is_some());

    let llm = LlmResultCache::open(&dir.join("llm_results.sqlite")).unwrap();
    let make_key = |hash: &str| LlmResultKey {
        key_hash: hash.into(),
        purpose: "capture-summary".into(),
        model: "fixture-llm".into(),
    };
    for (hash, expiry) in [("past", 99), ("boundary", 100), ("future", 101)] {
        llm.put_at(
            &make_key(hash),
            &CachedLlmResult {
                text: Some(hash.into()),
                input_tokens: None,
                output_tokens: None,
                provider_cached_input_tokens: None,
                expires_at: expiry,
            },
            0,
        )
        .unwrap();
    }
    assert_eq!(llm.sweep_expired(100).unwrap(), 2);
    assert!(llm.get_at(&make_key("future"), 100).unwrap().is_some());
}

#[test]
fn expired_reads_delete_the_row_and_embedding_blob_is_node_json() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().canonicalize().unwrap();
    let path = dir.join("embeddings.sqlite");
    let cache = EmbeddingCache::open(&path).unwrap();
    cache
        .put_at(&key("expired"), &[0.25, -0.5, 1.0], 10, 0)
        .unwrap();
    let raw: Vec<u8> = Connection::open(&path)
        .unwrap()
        .query_row("SELECT vector FROM embeddings", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Json>(&raw).unwrap(),
        serde_json::json!([0.25, -0.5, 1.0])
    );
    assert!(cache.get_at(&key("expired"), 10).unwrap().is_none());
    let count: i64 = Connection::open(&path)
        .unwrap()
        .query_row("SELECT count(*) FROM embeddings", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
}
