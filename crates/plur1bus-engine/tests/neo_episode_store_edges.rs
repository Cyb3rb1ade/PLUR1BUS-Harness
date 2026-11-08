//! Episode recovery rejects changed authority, checkpoint state and unsafe files.
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
fn interrupt(f: &Fixture) {
    f.policy.stop_after_first.store(true, Ordering::SeqCst);
    assert!(f
        .journal
        .process(&f.turn, &f.context, &Cancel::never())
        .is_err());
    f.policy.stop_after_first.store(false, Ordering::SeqCst);
    f.policy.allowed.store(true, Ordering::SeqCst);
}
#[test]
fn corrupt_or_foreign_plan_never_rewrites_episodes_or_checkpoint() {
    let f = setup();
    interrupt(&f);
    let path = native_file(&f.directory, "native-episode-pending-");
    let original = fs::read(&path).unwrap();
    let episodes = fs::read(f.directory.join("episodes.jsonl")).unwrap();
    for field in ["owner", "source", "episode", "checkpoint"] {
        let mut value: Value = serde_json::from_slice(&original).unwrap();
        match field {
            "owner" => value["ownership"]["ownerUserId"] = json!(harness_user_principal("two")),
            "source" => value["plan"]["sources"][0]["digest"] = json!("invalid"),
            "episode" => {
                value["plan"]["episodes"][0]["ownerUserId"] = json!(harness_user_principal("two"))
            }
            _ => value["plan"]["previous"] = json!({"unexpected":true}),
        }
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(f
            .journal
            .process(&f.turn, &f.context, &Cancel::never())
            .is_err());
        assert_eq!(
            episodes,
            fs::read(f.directory.join("episodes.jsonl")).unwrap()
        );
    }
    fs::write(&path, original).unwrap();
    f.journal
        .process(&f.turn, &f.context, &Cancel::never())
        .unwrap();
}
#[test]
fn changed_checkpoint_cannot_be_implicitly_rebased_over_pending_episodes() {
    let f = setup();
    interrupt(&f);
    let state = SessionStore::open(f.root.path(), f.host.clone()).unwrap();
    let key = plur1bus_engine::text::js::JsString::from("stable-session");
    state
        .apply(
            &f.turn.principal,
            &f.turn.agent,
            &key,
            plur1bus_engine::neo::session_store::Change::Advance { baseline: 0, to: 9 },
            &Cancel::never(),
        )
        .unwrap();
    let file = native_file(&f.directory, "native-hook-state-");
    let before = fs::read(&file).unwrap();
    assert!(f
        .journal
        .process(&f.turn, &f.context, &Cancel::never())
        .is_err());
    assert_eq!(fs::read(file).unwrap(), before);
}
#[test]
fn torn_episode_tail_is_replayed_from_frozen_uuid_without_extra_revision() {
    let f = setup();
    interrupt(&f);
    let path = f.directory.join("episodes.jsonl");
    let original = fs::read(&path).unwrap();
    fs::write(&path, &original[..original.len() / 2]).unwrap();
    assert_eq!(
        f.journal
            .process(&f.turn, &f.context, &Cancel::never())
            .unwrap(),
        1
    );
    assert_eq!(fs::read(path).unwrap(), original);
}
#[test]
fn modified_predecessor_is_not_overwritten_by_a_frozen_continuation() {
    let mut f = setup();
    let all = f.turn.messages.clone();
    f.turn.messages.truncate(3);
    f.journal
        .process(&f.turn, &f.context, &Cancel::never())
        .unwrap();
    f.turn.messages = all;
    // A real writer would revise under the Neo lease; simulate an edited predecessor before next call.
    let path = f.directory.join("episodes.jsonl");
    let mut previous = rows(&f.directory, "episodes.jsonl");
    previous[0]["revision"] = json!(2);
    fs::write(&path, format!("{}\n", previous[0])).unwrap();
    let before = fs::read(&path).unwrap();
    assert!(f
        .journal
        .process(&f.turn, &f.context, &Cancel::never())
        .is_err());
    assert_eq!(fs::read(path).unwrap(), before);
}
#[cfg(unix)]
#[test]
fn linked_episode_file_is_never_followed() {
    let f = setup();
    interrupt(&f);
    let path = f.directory.join("episodes.jsonl");
    let target = f.root.path().join("outside-episodes");
    fs::rename(&path, &target).unwrap();
    let original = fs::read(&target).unwrap();
    std::os::unix::fs::symlink(&target, &path).unwrap();
    assert!(f
        .journal
        .process(&f.turn, &f.context, &Cancel::never())
        .is_err());
    assert_eq!(fs::read(target).unwrap(), original);
}
