//! Actual Node global candidate-index search through real native files.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    context::RequestContext,
    contract::{AgentContext, Cancel, Principal},
    neo::{
        global::Options,
        merged::{Layout, MetadataReader},
    },
    text::{
        js::JsString,
        json::{parse_json, write_json},
    },
};
use serde_json::{json, Value};
use std::fs;
fn context(host: &support::TestHost) -> RequestContext {
    let p: Principal=serde_json::from_value(json!({"agentId":"alpha","workspace":"workspace:v1:one","channel":"telegram","accountId":"fixture-account","chat":{"id":"fixture-chat","kind":"direct"},"trust":"proved"})).unwrap();
    let a: AgentContext =
        serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
    RequestContext::build(&p, &a, host).unwrap()
}

// Preserve Node's shortest decimal round-trip. serde_json without float_roundtrip
// rounds some 17-digit golden decimals to the adjacent f64 during initial parsing.
fn exact_json(raw: &str) -> Value {
    use plur1bus_engine::text::json::TolerantJsonValue as J;
    fn convert(v: J) -> Value {
        match v {
            J::Null => Value::Null,
            J::Bool(v) => json!(v),
            J::String(v) => json!(v.to_utf8_lossy()),
            J::Number(n) => {
                if let Ok(v) = n.parse::<i64>() {
                    return json!(v);
                }
                if let Ok(v) = n.parse::<u64>() {
                    return json!(v);
                }
                json!(n.parse::<f64>().unwrap())
            }
            J::Array(v) => Value::Array(v.into_iter().map(convert).collect()),
            J::Object(v) => Value::Object(
                v.into_iter()
                    .map(|(k, v)| (k.to_utf8_lossy(), convert(v)))
                    .collect(),
            ),
        }
    }
    convert(parse_json(raw).unwrap())
}

#[test]
fn actual_index_and_fallback_search_match_node_with_explicit_acl_exceptions() {
    use sha2::{Digest, Sha256};
    let f = exact_json(include_str!("fixtures/capture/golden/neo-global.json"));
    let e: Value =
        serde_json::from_str(include_str!("fixtures/capture/neo-global-exceptions.json")).unwrap();
    assert_eq!(
        format!(
            "{:x}",
            Sha256::digest(include_bytes!("fixtures/capture/golden/neo-global.json"))
        ),
        e["nodeGoldenSha256"]
    );
    for c in f["cases"].as_array().unwrap() {
        let root = support::canonical_tempdir();
        let host = support::TestHost::new(root.path().join("state"));
        let ctx = context(&host);
        let dir = root
            .path()
            .join("workspaces")
            .join(Layout::for_key("workspace").canonical);
        fs::create_dir_all(&dir).unwrap();
        for file in c["files"].as_array().unwrap() {
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
        let query: Vec<f64> = serde_json::from_value(c["options"]["queryVector"].clone()).unwrap();
        let ids: Vec<JsString> = c["options"]["excludeIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| JsString::from(v.as_str().unwrap()))
            .collect();
        let options = Options {
            query_vector: &query,
            top_k: c["options"]["topK"].as_u64().unwrap() as usize,
            min_similarity: c["options"]["minSimilarity"].as_f64().unwrap(),
            half_life_days: 30.,
            max_candidates: c["options"]["maxCandidates"].as_u64().unwrap() as usize,
            exclude_ids: &ids,
            now_ms: c["options"]["now"].as_f64().unwrap(),
        };
        let out = MetadataReader::open(root.path(), "workspace")
            .unwrap()
            .search_global(&options, &ctx, &Cancel::never())
            .unwrap();
        let expected = if e["authorizedSourceCases"]
            .as_array()
            .unwrap()
            .contains(&c["name"])
        {
            &c["authorizedOutput"]
        } else {
            &c["output"]
        };
        for (name, count) in [
            ("scanned", out.scanned),
            ("unique", out.unique),
            ("eligible", out.eligible),
            ("withVector", out.with_vector),
        ] {
            assert_eq!(
                count,
                expected[name].as_u64().unwrap() as usize,
                "{} / {name}",
                c["name"]
            );
        }
        assert_eq!(
            out.from_index,
            expected["index"] != "missing",
            "{}",
            c["name"]
        );
        assert_eq!(
            out.hits.len(),
            expected["hits"].as_array().unwrap().len(),
            "{}",
            c["name"]
        );
        for (hit, want) in out.hits.iter().zip(expected["hits"].as_array().unwrap()) {
            let mut metadata = exact_json(&write_json(&hit.record.metadata));
            metadata.as_object_mut().unwrap().remove("embedding");
            let mut wanted = want["item"].clone();
            wanted.as_object_mut().unwrap().remove("embedding");
            assert_eq!(metadata, wanted, "{}", c["name"]);
            let vector: Vec<f64> =
                serde_json::from_value(want["item"]["embedding"].clone()).unwrap();
            assert_eq!(
                hit.record.embedding.as_ref().unwrap(),
                &vector,
                "{}",
                c["name"]
            );
            assert_eq!(
                hit.similarity,
                want["similarity"].as_f64().unwrap(),
                "{}",
                c["name"]
            );
            assert_eq!(hit.score, want["score"].as_f64().unwrap(), "{}", c["name"]);
            assert_eq!(
                hit.age_days,
                want["ageDays"].as_f64().unwrap(),
                "{}",
                c["name"]
            );
        }
    }
}
fn setup(root: &std::path::Path) -> std::path::PathBuf {
    let dir = root
        .join("workspaces")
        .join(Layout::for_key("workspace").canonical);
    fs::create_dir_all(&dir).unwrap();
    dir
}
fn options() -> Options<'static> {
    Options {
        query_vector: &[1., 0.],
        top_k: 30,
        min_similarity: 0.35,
        half_life_days: 30.,
        max_candidates: 20000,
        exclude_ids: &[],
        now_ms: 1700000000000.,
    }
}
#[test]
fn incomplete_tail_is_consumed_only_after_lf_and_rewrites_do_not_leave_stale_entries() {
    use std::io::Write;
    let root = support::canonical_tempdir();
    let host = support::TestHost::new(root.path().join("state"));
    let ctx = context(&host);
    let dir = setup(root.path());
    let reader = MetadataReader::open(root.path(), "workspace").unwrap();
    let path = dir.join("candidate-index.jsonl");
    fs::write(
        &path,
        r#"{"id":"a","agentId":"alpha","statement":"visible"}"#,
    )
    .unwrap();
    assert_eq!(
        reader
            .search_global(&options(), &ctx, &Cancel::never())
            .unwrap()
            .unique,
        0
    );
    fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"\n")
        .unwrap();
    assert_eq!(
        reader
            .search_global(&options(), &ctx, &Cancel::never())
            .unwrap()
            .unique,
        1
    );
    fs::write(&path, "").unwrap();
    assert_eq!(
        reader
            .search_global(&options(), &ctx, &Cancel::never())
            .unwrap()
            .unique,
        0
    );
    fs::remove_file(&path).unwrap();
    fs::write(&path, "{\"id\":\"b\",\"agentId\":\"beta\"}\n").unwrap();
    let out = reader
        .search_global(&options(), &ctx, &Cancel::never())
        .unwrap();
    assert_eq!(out.scanned, 0);
    assert_eq!(out.unique, 0);
    assert_eq!(fs::read_dir(dir).unwrap().count(), 1);
}
#[test]
fn cancellation_invalid_options_and_index_size_are_explicit_errors() {
    use plur1bus_engine::contract::{EngineError, StoreError};
    let root = support::canonical_tempdir();
    let host = support::TestHost::new(root.path().join("state"));
    let ctx = context(&host);
    let dir = setup(root.path());
    let reader = MetadataReader::open(root.path(), "workspace").unwrap();
    let cancelled = Cancel::never();
    cancelled.cancel();
    assert!(matches!(
        reader.search_global(&options(), &ctx, &cancelled),
        Err(EngineError::Cancelled(_))
    ));
    let mut opts = options();
    opts.max_candidates = 50_001;
    assert!(matches!(
        reader.search_global(&opts, &ctx, &Cancel::never()),
        Err(EngineError::Store(StoreError::InvalidInput))
    ));
    let file = fs::File::create(dir.join("candidate-index.jsonl")).unwrap();
    file.set_len(64 * 1024 * 1024 + 1).unwrap();
    assert!(matches!(
        reader.search_global(&options(), &ctx, &Cancel::never()),
        Err(EngineError::Store(StoreError::InvalidInput))
    ));
    opts.query_vector = &[];
    assert!(reader
        .search_global(&opts, &ctx, &Cancel::never())
        .unwrap()
        .hits
        .is_empty());
}
#[test]
fn too_many_index_identities_fail_instead_of_silently_truncating() {
    use plur1bus_engine::contract::{EngineError, StoreError};
    use std::io::Write;
    let root = support::canonical_tempdir();
    let host = support::TestHost::new(root.path().join("state"));
    let ctx = context(&host);
    let dir = setup(root.path());
    let reader = MetadataReader::open(root.path(), "workspace").unwrap();
    let mut file =
        std::io::BufWriter::new(fs::File::create(dir.join("candidate-index.jsonl")).unwrap());
    for i in 0..50_001 {
        writeln!(file, "{{\"id\":\"{i}\",\"agentId\":\"alpha\"}}").unwrap();
    }
    file.flush().unwrap();
    assert!(matches!(
        reader.search_global(&options(), &ctx, &Cancel::never()),
        Err(EngineError::Store(StoreError::InvalidInput))
    ));
}
#[cfg(unix)]
#[test]
fn index_links_fail_and_hidden_or_ineligible_rows_never_open_sidecars() {
    use std::os::unix::fs::symlink;
    let root = support::canonical_tempdir();
    let host = support::TestHost::new(root.path().join("state"));
    let ctx = context(&host);
    let dir = setup(root.path());
    let reader = MetadataReader::open(root.path(), "workspace").unwrap();
    let outside = root.path().join("outside");
    fs::write(&outside, "private").unwrap();
    let index = dir.join("candidate-index.jsonl");
    symlink(&outside, &index).unwrap();
    assert!(reader
        .search_global(&options(), &ctx, &Cancel::never())
        .is_err());
    fs::remove_file(&index).unwrap();
    fs::hard_link(&outside, &index).unwrap();
    assert!(reader
        .search_global(&options(), &ctx, &Cancel::never())
        .is_err());
    fs::remove_file(&index).unwrap();
    symlink(&outside, dir.join("vector-index.json")).unwrap();
    for row in [
        json!({"id":"hidden","agentId":"beta"}),
        json!({"id":"inactive","agentId":"alpha","status":"pruned"}),
    ] {
        fs::write(&index, format!("{row}\n")).unwrap();
        let out = reader
            .search_global(&options(), &ctx, &Cancel::never())
            .unwrap();
        assert_eq!(out.eligible, 0);
        assert!(out.hits.is_empty());
    }
}

#[test]
fn cached_index_rechecks_callers_and_rewrites_even_with_restored_mtime() {
    let root = support::canonical_tempdir();
    let host = support::TestHost::new(root.path().join("state"));
    let ctx = context(&host);
    let principal: Principal = serde_json::from_value(json!({"agentId":"beta","workspace":"workspace:v1:one","channel":"telegram","accountId":"fixture-account","chat":{"id":"fixture-chat","kind":"direct"},"trust":"proved"})).unwrap();
    let agent: AgentContext =
        serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
    let other = RequestContext::build(&principal, &agent, &host).unwrap();
    let dir = setup(root.path());
    let path = dir.join("candidate-index.jsonl");
    let reader = MetadataReader::open(root.path(), "workspace").unwrap();
    let original = "{\"id\":\"a\",\"agentId\":\"alpha\"}\n";
    fs::write(&path, original).unwrap();
    let stamp = fs::metadata(&path).unwrap().modified().unwrap();
    assert_eq!(
        reader
            .search_global(&options(), &ctx, &Cancel::never())
            .unwrap()
            .unique,
        1
    );
    assert_eq!(
        reader
            .search_global(&options(), &other, &Cancel::never())
            .unwrap()
            .unique,
        0
    );
    // Same length and exact mtime, but the old principal has lost access.
    fs::write(&path, "{\"id\":\"a\",\"agentId\":\"gamma\"}\n").unwrap();
    fs::File::open(&path).unwrap().set_modified(stamp).unwrap();
    assert_eq!(fs::metadata(&path).unwrap().len(), original.len() as u64);
    assert_eq!(
        reader
            .search_global(&options(), &ctx, &Cancel::never())
            .unwrap()
            .unique,
        0
    );
    // A larger rewritten file is not an append of the cached prefix.
    fs::write(
        &path,
        "{\"id\":\"b\",\"agentId\":\"alpha\"}\n{\"id\":\"c\",\"agentId\":\"alpha\"}\n",
    )
    .unwrap();
    assert_eq!(
        reader
            .search_global(&options(), &ctx, &Cancel::never())
            .unwrap()
            .unique,
        2
    );
    // Missing means journal fallback, never the previous cached index.
    fs::remove_file(&path).unwrap();
    let missing = reader
        .search_global(&options(), &ctx, &Cancel::never())
        .unwrap();
    assert!(!missing.from_index);
    assert_eq!(missing.unique, 0);
    fs::write(&path, original).unwrap();
    assert_eq!(
        reader
            .search_global(&options(), &ctx, &Cancel::never())
            .unwrap()
            .unique,
        1
    );
}
