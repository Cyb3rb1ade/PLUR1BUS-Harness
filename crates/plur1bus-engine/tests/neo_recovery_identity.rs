//! Recovery preserves original caller policy across later requests from other chats.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    capture::shared_scope::CapturePolicy,
    context::{harness_user_principal, RequestContext},
    contract::{Cancel, EngineError, TurnRecord},
    neo::{episode_store::EpisodeStore, merged::Layout},
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

#[allow(
    dead_code,
    reason = "shared real-file setup includes the default writer and policy"
)]
#[path = "support/neo_episode.rs"]
mod fixtures;
use fixtures::*;
struct OriginalPolicy {
    block_original: AtomicBool,
    boundary: PathBuf,
    chats: std::sync::Mutex<Vec<String>>,
}
impl CapturePolicy for OriginalPolicy {
    fn allowed(&self, ctx: &RequestContext) -> Result<bool, EngineError> {
        self.chats.lock().unwrap().push(ctx.chat_id().to_owned());
        Ok(!(self.block_original.load(Ordering::SeqCst)
            && ctx.chat_id() == "fixture"
            && fs::metadata(&self.boundary).is_ok_and(|m| m.len() > 0)))
    }
}
fn later(turn: &TurnRecord) -> TurnRecord {
    let mut value = serde_json::to_value(turn).unwrap();
    value["principal"]["chat"]["id"] = json!("later-chat");
    serde_json::from_value(value).unwrap()
}
#[test]
fn a_later_chat_cannot_bypass_revoked_original_capture_policy() {
    let f = setup();
    let policy = Arc::new(OriginalPolicy {
        block_original: AtomicBool::new(true),
        boundary: f.directory.join("turn-journal.jsonl"),
        chats: Default::default(),
    });
    let journal = plur1bus_engine::neo::capture_journal::CaptureJournal::open(
        f.root.path(),
        f.host.clone(),
        policy.clone(),
    )
    .unwrap();
    assert!(journal
        .record(&f.turn, &f.context, &Cancel::never())
        .is_err());
    let pending = native_file(&f.directory, "native-capture-pending-");
    let original = fs::read(&pending).unwrap();
    let next = later(&f.turn);
    assert!(journal
        .recover(&next.principal, &next.agent, &Cancel::never())
        .is_err());
    assert_eq!(fs::read(&pending).unwrap(), original);
    assert_eq!(rows(&f.directory, "turn-journal.jsonl").len(), 1);
    let value: Value = serde_json::from_slice(&original).unwrap();
    assert_eq!(
        value["caller"]["principal"],
        serde_json::to_value(&f.turn.principal).unwrap()
    );
    assert_eq!(
        value["caller"]["agent"],
        serde_json::to_value(&f.turn.agent).unwrap()
    );
    policy.block_original.store(false, Ordering::SeqCst);
    assert!(
        journal
            .recover(&next.principal, &next.agent, &Cancel::never())
            .unwrap()
            > 0
    );
    assert_eq!(rows(&f.directory, "turn-journal.jsonl").len(), 5);
}
#[test]
fn a_later_chat_cannot_acknowledge_an_episode_from_a_revoked_original_caller() {
    let f = setup();
    let policy = Arc::new(OriginalPolicy {
        block_original: AtomicBool::new(true),
        boundary: f.directory.join("episodes.jsonl"),
        chats: Default::default(),
    });
    let mood = Arc::new(plur1bus_engine::capture::emotion_pool::EmotionalPool::new(
        f.host.clone(),
        json!({}),
    ));
    let store = EpisodeStore::open(f.root.path(), f.host.clone(), policy.clone(), mood).unwrap();
    assert!(store
        .process(&f.turn, &f.context, &Cancel::never())
        .is_err());
    let pending = native_file(&f.directory, "native-episode-pending-");
    let original = fs::read(&pending).unwrap();
    let next = later(&f.turn);
    let ctx = RequestContext::build(&next.principal, &next.agent, f.host.as_ref()).unwrap();
    assert!(store.process(&next, &ctx, &Cancel::never()).is_err());
    assert_eq!(fs::read(&pending).unwrap(), original);
    let value: Value = serde_json::from_slice(&original).unwrap();
    assert_eq!(
        value["plan"]["caller"]["principal"],
        serde_json::to_value(&f.turn.principal).unwrap()
    );
    policy.block_original.store(false, Ordering::SeqCst);
    store.process(&next, &ctx, &Cancel::never()).unwrap();
    assert_eq!(rows(&f.directory, "episodes.jsonl").len(), 1);
    assert!(policy.chats.lock().unwrap().iter().any(|c| c == "fixture"));
}
#[test]
fn missing_malformed_or_foreign_original_identity_keeps_episode_pending() {
    let f = setup();
    f.policy.stop_after_first.store(true, Ordering::SeqCst);
    assert!(f
        .journal
        .process(&f.turn, &f.context, &Cancel::never())
        .is_err());
    f.policy.stop_after_first.store(false, Ordering::SeqCst);
    f.policy.allowed.store(true, Ordering::SeqCst);
    let path = native_file(&f.directory, "native-episode-pending-");
    let original = fs::read(&path).unwrap();
    let episodes = fs::read(f.directory.join("episodes.jsonl")).unwrap();
    for mode in ["missing", "invalid", "foreign", "oversized"] {
        let mut value: Value = serde_json::from_slice(&original).unwrap();
        match mode {
            "missing" => {
                value["plan"].as_object_mut().unwrap().remove("caller");
            }
            "invalid" => value["plan"]["caller"] = json!({"principal":null,"agent":null}),
            "foreign" => {
                value["plan"]["caller"]["principal"]["user"] =
                    json!(harness_user_principal("other"))
            }
            _ => value["plan"]["caller"]["principal"]["chat"]["id"] = json!("x".repeat(65_537)),
        }
        let altered = serde_json::to_vec(&value).unwrap();
        fs::write(&path, &altered).unwrap();
        assert!(
            f.journal
                .process(&f.turn, &f.context, &Cancel::never())
                .is_err(),
            "{mode}"
        );
        assert_eq!(fs::read(&path).unwrap(), altered);
        assert_eq!(
            fs::read(f.directory.join("episodes.jsonl")).unwrap(),
            episodes
        );
    }
    fs::write(&path, original).unwrap();
    f.journal
        .process(&f.turn, &f.context, &Cancel::never())
        .unwrap();
    let settled: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(settled["plan"], Value::Null);
}
