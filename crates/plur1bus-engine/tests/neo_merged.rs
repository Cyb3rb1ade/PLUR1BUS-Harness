//! Actual C4 Node files against native caller-bound metadata reads.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    context::RequestContext,
    contract::{AgentContext, Principal},
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
const KINDS: [(RecordKind, &str); 5] = [
    (RecordKind::Patterns, "patterns"),
    (RecordKind::Graph, "graph"),
    (RecordKind::Dreams, "dreams"),
    (RecordKind::Episodes, "episodes"),
    (RecordKind::Candidates, "candidates"),
];
#[test]
fn real_files_match_twice_recorded_node_with_explicit_security_exceptions() {
    use sha2::{Digest, Sha256};
    let f: Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/neo-merged.json")).unwrap();
    let exceptions: Value =
        serde_json::from_str(include_str!("fixtures/capture/neo-merged-exceptions.json")).unwrap();
    assert_eq!(
        format!(
            "{:x}",
            Sha256::digest(include_bytes!("fixtures/capture/golden/neo-merged.json"))
        ),
        exceptions["nodeGoldenSha256"]
    );
    for c in f["cases"].as_array().unwrap() {
        let root = support::canonical_tempdir();
        let host = support::TestHost::new(root.path().join("state"));
        let ctx = context(&host);
        let key = c["key"].as_str().unwrap();
        let layout = Layout::for_key(key);
        let workspaces = root.path().join("workspaces");
        let canonical = workspaces.join(&layout.canonical);
        fs::create_dir_all(&canonical).unwrap();
        // Reproduce the observed old layout, including the two unsafe aliases in this scratch tree.
        let old = if key == "tenant/a" { "tenant_a" } else { key };
        let legacy = workspaces.join(old);
        fs::create_dir_all(&legacy).unwrap();
        for (kind, name) in KINDS {
            for (dir, field) in [(&canonical, "canonicalLines"), (&legacy, "legacyLines")] {
                let lines = c[field]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap())
                    .collect::<Vec<_>>()
                    .join("\n");
                fs::write(dir.join(kind.file_name()), lines).unwrap();
            }
            let reader = MetadataReader::open(root.path(), key).unwrap();
            let out = reader
                .read_metadata(kind, c["limit"].as_u64().unwrap() as usize, &ctx)
                .unwrap();
            let actual: Vec<Value> = out
                .iter()
                .map(|v| serde_json::from_str(&write_json(v)).unwrap())
                .collect();
            let expected = exceptions["cases"]
                .get(c["name"].as_str().unwrap())
                .unwrap_or(&c["outputs"][name]);
            assert_eq!(json!(actual), *expected, "{} / {name}", c["name"]);
        }
    }
}
#[test]
fn layout_keeps_hashes_and_refuses_ambiguous_legacy_aliases() {
    let f: Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/neo-merged.json")).unwrap();
    for case in f["layouts"].as_array().unwrap() {
        let layout = Layout::for_key(case["key"].as_str().unwrap());
        assert_eq!(layout.canonical, case["canonical"]);
        if let Some(legacy) = layout.legacy {
            assert_eq!(legacy, case["legacy"]);
            assert!(![".", ".."].contains(&legacy.as_str()));
        }
    }
    for key in [".", "..", "tenant/a", "   ", "Ä🙂 Team", &"x".repeat(130)] {
        assert!(Layout::for_key(key).legacy.is_none());
    }
    assert_eq!(Layout::for_key("").legacy.as_deref(), Some("default"));
    assert!(Layout::for_key("tenant_a").legacy.is_some());
}

fn visible_row(id: &str, statement: &str) -> Value {
    json!({"id":id,"agentId":"alpha","createdAt":1,"statement":statement})
}
fn setup(root: &std::path::Path) -> std::path::PathBuf {
    let dir = root
        .join("workspaces")
        .join(Layout::for_key("workspace").canonical);
    fs::create_dir_all(&dir).unwrap();
    dir
}
#[test]
fn warm_reads_never_create_state_and_bounds_are_explicit() {
    use plur1bus_engine::contract::StoreError;
    let root = support::canonical_tempdir();
    let host = support::TestHost::new(root.path().join("state"));
    let ctx = context(&host);
    let reader = MetadataReader::open(root.path(), "workspace").unwrap();
    assert!(reader
        .read_metadata(RecordKind::Patterns, 10, &ctx)
        .unwrap()
        .is_empty());
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    assert_eq!(
        reader.read_metadata(RecordKind::Patterns, 50_001, &ctx),
        Err(StoreError::InvalidInput)
    );
    let dir = setup(root.path());
    assert!(reader
        .read_metadata(RecordKind::Patterns, 10, &ctx)
        .unwrap()
        .is_empty());
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
    let file = fs::File::create(dir.join(RecordKind::Patterns.file_name())).unwrap();
    file.set_len(64 * 1024 * 1024 + 1).unwrap();
    assert_eq!(
        reader.read_metadata(RecordKind::Patterns, 1, &ctx),
        Err(StoreError::InvalidInput)
    );
}
#[test]
fn backward_chunks_keep_unicode_long_lines_empty_runs_and_crlf() {
    let root = support::canonical_tempdir();
    let host = support::TestHost::new(root.path().join("state"));
    let ctx = context(&host);
    let dir = setup(root.path());
    let old = visible_row("old", "not selected");
    let huge = visible_row("huge", &"🙂".repeat(40_000));
    let latest = visible_row("latest", "boundary 🙂 Ä");
    for trailing in ["", "\n", "\n\n\n"] {
        fs::write(
            dir.join(RecordKind::Patterns.file_name()),
            format!("{old}\n\n{huge}\r\n\n{latest}{trailing}"),
        )
        .unwrap();
        let reader = MetadataReader::open(root.path(), "workspace").unwrap();
        let rows = reader.read_metadata(RecordKind::Patterns, 2, &ctx).unwrap();
        let actual: Vec<Value> = rows
            .iter()
            .map(|v| serde_json::from_str(&write_json(v)).unwrap())
            .collect();
        assert_eq!(actual, vec![huge.clone(), latest.clone()]);
    }
}
#[test]
fn scan_stops_at_fifty_thousand_lines_without_exposing_foreign_tail() {
    let root = support::canonical_tempdir();
    let host = support::TestHost::new(root.path().join("state"));
    let ctx = context(&host);
    let dir = setup(root.path());
    let hidden = json!({"id":"foreign","agentId":"other","createdAt":2});
    let contents = format!(
        "{}\n{}",
        visible_row("too-old", "outside bounded scan"),
        format!("{hidden}\n").repeat(50_000)
    );
    fs::write(dir.join(RecordKind::Patterns.file_name()), contents).unwrap();
    let reader = MetadataReader::open(root.path(), "workspace").unwrap();
    assert!(reader
        .read_metadata(RecordKind::Patterns, 1, &ctx)
        .unwrap()
        .is_empty());
}
#[cfg(unix)]
#[test]
fn links_special_files_and_directory_replacement_fail_closed() {
    use std::os::unix::fs::symlink;
    let root = support::canonical_tempdir();
    let host = support::TestHost::new(root.path().join("state"));
    let ctx = context(&host);
    let dir = setup(root.path());
    let reader = MetadataReader::open(root.path(), "workspace").unwrap();
    let outside = root.path().join("outside.jsonl");
    fs::write(&outside, visible_row("outside", "not a ledger").to_string()).unwrap();
    let file = dir.join(RecordKind::Patterns.file_name());
    symlink(&outside, &file).unwrap();
    assert!(reader.read_metadata(RecordKind::Patterns, 1, &ctx).is_err());
    fs::remove_file(&file).unwrap();
    fs::hard_link(&outside, &file).unwrap();
    assert!(reader.read_metadata(RecordKind::Patterns, 1, &ctx).is_err());
    fs::remove_file(&file).unwrap();
    fs::create_dir(&file).unwrap();
    assert!(reader.read_metadata(RecordKind::Patterns, 1, &ctx).is_err());
    fs::remove_dir(&file).unwrap();
    let old = root.path().with_extension("replaced");
    fs::rename(root.path(), &old).unwrap();
    fs::create_dir(root.path()).unwrap();
    assert!(reader.read_metadata(RecordKind::Patterns, 1, &ctx).is_err());
    fs::remove_dir_all(old).unwrap();
}
#[test]
fn utf16_identifiers_do_not_alias_replacement_characters() {
    let root = support::canonical_tempdir();
    let host = support::TestHost::new(root.path().join("state"));
    let ctx = context(&host);
    let dir = setup(root.path());
    fs::write(
        dir.join(RecordKind::Patterns.file_name()),
        concat!(
            r#"{"id":"\ud800","agentId":"alpha","createdAt":1}"#,
            "\n",
            r#"{"id":"�","agentId":"other","createdAt":2}"#
        ),
    )
    .unwrap();
    let reader = MetadataReader::open(root.path(), "workspace").unwrap();
    let rows = reader.read_metadata(RecordKind::Patterns, 2, &ctx).unwrap();
    assert_eq!(rows.len(), 1);
    assert!(write_json(&rows[0]).contains("\\ud800"));
}
