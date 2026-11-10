//! Startup discovers and replays only physically bound native Neo plans, without new turns.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    capture::shared_scope::CapturePolicy,
    context::{harness_user_principal, RequestContext},
    contract::{Cancel, EngineError, TurnRecord},
    neo::{episode_store::EpisodeStore, merged::Layout, session_store::SessionStore},
};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

#[path = "support/neo_episode.rs"]
mod fixtures;
use fixtures::*;
fn reopen(f: &Fixture) -> EpisodeStore {
    let mood = Arc::new(plur1bus_engine::capture::emotion_pool::EmotionalPool::new(
        f.host.clone(),
        json!({}),
    ));
    EpisodeStore::open(f.root.path(), f.host.clone(), f.policy.clone(), mood).unwrap()
}
#[test]
fn startup_finishes_prepared_episode_checkpoint_without_a_new_message() {
    let f = setup();
    assert_eq!(
        reopen(&f)
            .recover_pending(&Cancel::never())
            .unwrap()
            .bindings,
        0
    );
    assert!(!f.directory.exists());
    f.policy.stop_after_first.store(true, Ordering::SeqCst);
    assert!(f
        .journal
        .process(&f.turn, &f.context, &Cancel::never())
        .is_err());
    let original = fs::read(f.directory.join("episodes.jsonl")).unwrap();
    f.policy.stop_after_first.store(false, Ordering::SeqCst);
    f.policy.allowed.store(true, Ordering::SeqCst);
    let recovery = reopen(&f);
    let report = recovery.recover_pending(&Cancel::never()).unwrap();
    assert_eq!(report.bindings, 1);
    assert_eq!(report.capture_records, 0);
    assert_eq!(report.episode_revisions, 0);
    assert_eq!(
        original,
        fs::read(f.directory.join("episodes.jsonl")).unwrap()
    );
    let state = SessionStore::open(f.root.path(), f.host.clone()).unwrap();
    assert_eq!(
        state
            .read(
                &f.turn.principal,
                &f.turn.agent,
                &plur1bus_engine::text::js::JsString::from("stable-session"),
                &Cancel::never()
            )
            .unwrap()
            .count,
        5.
    );
    assert_eq!(
        recovery.recover_pending(&Cancel::never()).unwrap().bindings,
        0
    );
}
#[test]
fn startup_replays_capture_rows_but_does_not_invent_unprepared_episodes() {
    let f = setup();
    let policy = Arc::new(Policy {
        allowed: AtomicBool::new(true),
        stop_after_first: AtomicBool::new(true),
        journal: f.directory.join("turn-journal.jsonl"),
    });
    let journal = plur1bus_engine::neo::capture_journal::CaptureJournal::open(
        f.root.path(),
        f.host.clone(),
        policy,
    )
    .unwrap();
    assert!(journal
        .record(&f.turn, &f.context, &Cancel::never())
        .is_err());
    let report = reopen(&f).recover_pending(&Cancel::never()).unwrap();
    assert_eq!(report.bindings, 1);
    assert_eq!(report.capture_records, 25);
    assert_eq!(report.episode_revisions, 0);
    assert_eq!(rows(&f.directory, "turn-journal.jsonl").len(), 5);
    assert!(!f.directory.join("episodes.jsonl").exists());
}
/// Journal files of the workspace directory and their bytes, excluding prepared plans.
fn journals(directory: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out: Vec<_> = fs::read_dir(directory)
        .unwrap()
        .flatten()
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "jsonl"))
        .map(|entry| {
            (
                entry.file_name().to_string_lossy().into_owned(),
                fs::read(entry.path()).unwrap(),
            )
        })
        .collect();
    out.sort();
    out
}
/// RE-D159: a revoked policy closes the binding's prepared plans; journals stay as written.
#[test]
fn revoked_startup_policy_closes_pending_plans_and_keeps_written_journals() {
    let f = setup();
    f.policy.stop_after_first.store(true, Ordering::SeqCst);
    assert!(f
        .journal
        .process(&f.turn, &f.context, &Cancel::never())
        .is_err());
    let path = native_file(&f.directory, "native-episode-pending-");
    let written = journals(&f.directory);
    let report = reopen(&f).recover_pending(&Cancel::never()).unwrap();
    assert_eq!((report.bindings, report.closed), (1, 1));
    assert!(report.deferred.is_empty());
    assert!(!path.exists());
    assert_eq!(written, journals(&f.directory));
    f.policy.stop_after_first.store(false, Ordering::SeqCst);
    f.policy.allowed.store(true, Ordering::SeqCst);
    assert_eq!(
        reopen(&f)
            .recover_pending(&Cancel::never())
            .unwrap()
            .bindings,
        0
    );
}
/// A plan under another binding's name replays nothing: it is closed as a changed binding.
#[test]
fn renamed_pending_file_does_not_authorize_another_binding() {
    let f = setup();
    f.policy.stop_after_first.store(true, Ordering::SeqCst);
    assert!(f
        .journal
        .process(&f.turn, &f.context, &Cancel::never())
        .is_err());
    f.policy.stop_after_first.store(false, Ordering::SeqCst);
    f.policy.allowed.store(true, Ordering::SeqCst);
    let path = native_file(&f.directory, "native-episode-pending-");
    let renamed = f
        .directory
        .join(format!("native-episode-pending-{}.json", "0".repeat(64)));
    fs::rename(&path, &renamed).unwrap();
    let written = journals(&f.directory);
    let report = reopen(&f).recover_pending(&Cancel::never()).unwrap();
    assert_eq!((report.bindings, report.closed), (1, 1));
    assert_eq!(report.episode_revisions, 0);
    assert!(!renamed.exists());
    assert_eq!(written, journals(&f.directory));
}
#[test]
fn incomplete_atomic_write_siblings_are_ignored_without_being_deleted() {
    let f = setup();
    f.policy.stop_after_first.store(true, Ordering::SeqCst);
    assert!(f
        .journal
        .process(&f.turn, &f.context, &Cancel::never())
        .is_err());
    f.policy.stop_after_first.store(false, Ordering::SeqCst);
    f.policy.allowed.store(true, Ordering::SeqCst);
    let pending = native_file(&f.directory, "native-episode-pending-");
    let temporary = pending.with_file_name(format!(
        "{}.17.000000000001.tmp",
        pending.file_name().unwrap().to_string_lossy()
    ));
    fs::write(&temporary, b"{incomplete").unwrap();
    assert_eq!(
        reopen(&f)
            .recover_pending(&Cancel::never())
            .unwrap()
            .bindings,
        1
    );
    assert_eq!(fs::read(temporary).unwrap(), b"{incomplete");
}
#[test]
fn startup_waits_for_existing_writer_and_respects_its_cancellation_deadline() {
    use std::time::{Duration, Instant};
    let f = setup();
    f.policy.stop_after_first.store(true, Ordering::SeqCst);
    assert!(f
        .journal
        .process(&f.turn, &f.context, &Cancel::never())
        .is_err());
    f.policy.stop_after_first.store(false, Ordering::SeqCst);
    f.policy.allowed.store(true, Ordering::SeqCst);
    let path = native_file(&f.directory, "native-episode-pending-");
    let before = fs::read(&path).unwrap();
    let lease = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(f.directory.join(".native-capture-leases/workspace.lock"))
        .unwrap();
    lease.lock().unwrap();
    let cancel = Cancel::with_deadline(Instant::now() + Duration::from_millis(40));
    assert!(reopen(&f).recover_pending(&cancel).is_err());
    assert_eq!(before, fs::read(path).unwrap());
    drop(lease);
    assert_eq!(
        reopen(&f)
            .recover_pending(&Cancel::never())
            .unwrap()
            .bindings,
        1
    );
}
#[test]
fn startup_restores_two_original_principals_without_borrowing_either_identity() {
    let f = setup();
    f.host.set_workspace("beta", f.root.path().into());
    struct StopEachAgent(PathBuf);
    impl CapturePolicy for StopEachAgent {
        fn allowed(&self, ctx: &RequestContext) -> Result<bool, EngineError> {
            let already = fs::read_to_string(&self.0)
                .unwrap_or_default()
                .lines()
                .any(|line| {
                    serde_json::from_str::<Value>(line)
                        .is_ok_and(|row| row["agentId"] == ctx.agent_id.as_str())
                });
            Ok(!already)
        }
    }
    let writer = plur1bus_engine::neo::capture_journal::CaptureJournal::open(
        f.root.path(),
        f.host.clone(),
        Arc::new(StopEachAgent(f.directory.join("turn-journal.jsonl"))),
    )
    .unwrap();
    assert!(writer
        .record(&f.turn, &f.context, &Cancel::never())
        .is_err());
    let mut value = serde_json::to_value(&f.turn).unwrap();
    value["agentId"] = json!("beta");
    value["principal"]["agentId"] = json!("beta");
    value["principal"]["user"] = json!(harness_user_principal("second-owner"));
    let other: TurnRecord = serde_json::from_value(value).unwrap();
    let ctx = RequestContext::build(&other.principal, &other.agent, f.host.as_ref()).unwrap();
    assert!(writer.record(&other, &ctx, &Cancel::never()).is_err());
    assert_eq!(rows(&f.directory, "turn-journal.jsonl").len(), 2);
    let report = reopen(&f).recover_pending(&Cancel::never()).unwrap();
    assert_eq!(report.bindings, 2);
    assert_eq!(report.capture_records, 50);
    let actual = rows(&f.directory, "turn-journal.jsonl");
    assert_eq!(actual.len(), 10);
    for row in actual {
        assert_eq!(
            row["ownerUserId"],
            if row["agentId"] == "alpha" {
                f.context.owner_user_id.as_str()
            } else {
                ctx.owner_user_id.as_str()
            }
        );
        assert_eq!(row["scope"], "agent_private");
    }
    assert_eq!(
        reopen(&f)
            .recover_pending(&Cancel::never())
            .unwrap()
            .bindings,
        0
    );
}
#[test]
fn opening_capture_hook_recovers_before_it_accepts_new_work() {
    let f = setup();
    f.policy.stop_after_first.store(true, Ordering::SeqCst);
    assert!(f
        .journal
        .process(&f.turn, &f.context, &Cancel::never())
        .is_err());
    f.policy.stop_after_first.store(false, Ordering::SeqCst);
    f.policy.allowed.store(true, Ordering::SeqCst);
    let mood = Arc::new(plur1bus_engine::capture::emotion_pool::EmotionalPool::new(
        f.host.clone(),
        json!({}),
    ));
    let _hook = plur1bus_engine::neo::capture_hook::NativeNeoCaptureHook::open(
        f.root.path(),
        f.host.clone(),
        f.policy.clone(),
        mood,
    )
    .unwrap();
    let state = SessionStore::open(f.root.path(), f.host.clone()).unwrap();
    assert_eq!(
        state
            .read(
                &f.turn.principal,
                &f.turn.agent,
                &plur1bus_engine::text::js::JsString::from("stable-session"),
                &Cancel::never()
            )
            .unwrap()
            .count,
        5.
    );
    assert_eq!(rows(&f.directory, "episodes.jsonl").len(), 1);
}
