//! Publication edges: retained global history, collision ownership and filesystem redirection.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    capture::shared_scope::CapturePolicy,
    context::{harness_user_principal, RequestContext},
    contract::{Cancel, EngineError, TurnRecord},
    neo::{capture_journal::CaptureJournal, merged::Layout},
};
use serde_json::{json, Value};
use std::{fs, io::Write, path::PathBuf, sync::Arc};
struct Allow;
impl CapturePolicy for Allow {
    fn allowed(&self, _: &RequestContext) -> Result<bool, EngineError> {
        Ok(true)
    }
}
fn setup() -> (
    tempfile::TempDir,
    Arc<support::TestHost>,
    CaptureJournal,
    TurnRecord,
    RequestContext,
    PathBuf,
) {
    let root = support::canonical_tempdir();
    let host = Arc::new(support::TestHost::new(root.path().join("state")));
    host.set_workspace("alpha", root.path().into());
    let turn: TurnRecord = serde_json::from_value(json!({"agentId":"alpha",
        "principal":{"agentId":"alpha","workspace":format!("workspace-dir:v1:{}",root.path().display()),
            "user":harness_user_principal("one"),"channel":"telegram","accountId":"fixture",
            "chat":{"id":"fixture","kind":"direct"},"trust":"proved"},
        "agent":{"origin":"user","background":false},"runId":"run","sessionKey":"session",
        "incognito":false,"messages":[{"role":"user","content":"Architecture decision chosen"}]})).unwrap();
    let ctx = RequestContext::build(&turn.principal, &turn.agent, host.as_ref()).unwrap();
    let directory = root
        .path()
        .join("workspaces")
        .join(Layout::for_key(&ctx.workspace_key).canonical);
    let journal = CaptureJournal::open(root.path(), host.clone(), Arc::new(Allow)).unwrap();
    journal.record(&turn, &ctx, &Cancel::never()).unwrap();
    (root, host, journal, turn, ctx, directory)
}
fn rows(path: &std::path::Path) -> Vec<Value> {
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}
fn append(path: &std::path::Path, row: &Value) {
    writeln!(
        fs::OpenOptions::new().append(true).open(path).unwrap(),
        "{row}"
    )
    .unwrap();
}
#[test]
fn publication_retains_global_history_and_newer_status_and_old_dedupe_keys() {
    let (_root, _host, journal, mut turn, ctx, dir) = setup();
    let index = dir.join("candidate-index.jsonl");
    let original = rows(&index)[0].clone();
    let mut retained = original.clone();
    retained["id"] = json!("retained-history");
    append(&index, &retained);
    let mut tombstone = original.clone();
    tombstone["status"] = json!("tombstoned");
    tombstone["updatedAt"] = json!("2099-01-01T00:00:00.000Z");
    append(&index, &tombstone);
    let record_index = dir.join("record-index.json");
    let mut old: Value = serde_json::from_slice(&fs::read(&record_index).unwrap()).unwrap();
    old["ids"]["turns"]
        .as_array_mut()
        .unwrap()
        .push(json!("pruned-history-id"));
    fs::write(&record_index, serde_json::to_vec(&old).unwrap()).unwrap();
    turn.messages[0].content = "another unique project fact".into();
    journal.record(&turn, &ctx, &Cancel::never()).unwrap();
    let final_rows = rows(&index);
    assert!(final_rows.iter().any(|r| r["id"] == retained["id"]));
    assert_eq!(
        final_rows
            .iter()
            .find(|r| r["id"] == original["id"])
            .unwrap()["status"],
        "tombstoned"
    );
    let final_index: Value = serde_json::from_slice(&fs::read(&record_index).unwrap()).unwrap();
    assert!(final_index["ids"]["turns"]
        .as_array()
        .unwrap()
        .contains(&json!("pruned-history-id")));
}
#[test]
fn distinct_principals_keep_separate_content_and_the_shared_index_keeps_both() {
    let (root, host, journal, mut turn, _, dir) = setup();
    let first = rows(&dir.join("memory-candidates.jsonl"));
    turn.principal.user =
        Some(serde_json::from_value(json!(harness_user_principal("two"))).unwrap());
    turn.session_key = Some("other-session".into());
    let ctx = RequestContext::build(&turn.principal, &turn.agent, host.as_ref()).unwrap();
    assert_eq!(
        journal
            .record(&turn, &ctx, &Cancel::never())
            .unwrap()
            .candidates,
        1
    );
    let candidates = rows(&dir.join("memory-candidates.jsonl"));
    assert_eq!(candidates.len(), 2);
    assert_eq!(candidates[0], first[0]);
    assert_ne!(candidates[0]["ownerUserId"], candidates[1]["ownerUserId"]);
    assert_eq!(rows(&dir.join("candidate-index.jsonl")).len(), 2);
    drop(root);
}
#[cfg(unix)]
#[test]
fn replaced_journal_links_never_write_outside_the_trusted_root() {
    let (_root, _host, journal, mut turn, ctx, dir) = setup();
    let outside = support::canonical_tempdir();
    let target = outside.path().join("target");
    fs::write(&target, b"outside sentinel\n").unwrap();
    let leaf = dir.join("turn-journal.jsonl");
    let original = fs::read(&leaf).unwrap();
    turn.messages[0].content = "another unique message".into();
    for hard in [false, true] {
        fs::remove_file(&leaf).unwrap();
        if hard {
            fs::hard_link(&target, &leaf).unwrap();
        } else {
            std::os::unix::fs::symlink(&target, &leaf).unwrap();
        }
        assert!(journal.record(&turn, &ctx, &Cancel::never()).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"outside sentinel\n");
        fs::remove_file(&leaf).unwrap();
        fs::write(&leaf, &original).unwrap();
    }
}
