//! Actual authorized EpisodeStore name reads against pinned Node files and explicit exceptions.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    capture::shared_scope::CapturePolicy,
    context::{harness_user_principal, RequestContext},
    contract::{Cancel, EngineError, TurnRecord},
    neo::{episode_store::EpisodeStore, merged::Layout},
    text::{
        js::JsString,
        json::{parse_json, TolerantJsonValue as Json},
    },
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
fn field<'a>(value: &'a Json, key: &str) -> Option<&'a Json> {
    let Json::Object(fields) = value else {
        return None;
    };
    fields
        .iter()
        .find(|(k, _)| k == &JsString::from(key))
        .map(|(_, v)| v)
}
fn text(value: &Json) -> String {
    let Json::String(value) = value else {
        panic!("string")
    };
    value.to_utf8_lossy()
}
fn array(value: &Json) -> &[Json] {
    let Json::Array(value) = value else {
        panic!("array")
    };
    value
}
fn bytes(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
}
#[test]
fn actual_node_names_reach_the_durable_episode_with_explicit_unicode_and_cache_exceptions() {
    use sha2::{Digest, Sha256};
    let raw = include_bytes!("fixtures/capture/golden/neo-names.json");
    let golden = parse_json(std::str::from_utf8(raw).unwrap()).unwrap();
    let exceptions =
        parse_json(include_str!("fixtures/capture/neo-names-exceptions.json")).unwrap();
    assert_eq!(
        text(field(&exceptions, "nodeGoldenSha256").unwrap()),
        format!("{:x}", Sha256::digest(raw))
    );
    for case in array(field(&golden, "cases").unwrap()) {
        let mut f = setup();
        let Json::Object(files) = field(case, "files").unwrap() else {
            panic!("files")
        };
        for (file, value) in files {
            fs::write(
                f.root.path().join(file.to_utf8_lossy()),
                bytes(&text(value)),
            )
            .unwrap();
        }
        let exception = array(field(&exceptions, "cases").unwrap())
            .iter()
            .find(|e| field(e, "name") == field(case, "name"));
        let expected = exception
            .and_then(|e| field(e, "output"))
            .unwrap_or_else(|| field(case, "output").unwrap());
        f.journal
            .process(&f.turn, &f.context, &Cancel::never())
            .unwrap();
        let episodes = rows(&f.directory, "episodes.jsonl");
        assert_eq!(
            episodes.last().unwrap()["participants"],
            json!([
                text(field(expected, "user").unwrap()),
                text(field(expected, "assistant").unwrap())
            ]),
            "{}",
            text(field(case, "name").unwrap())
        );
        if let Some(cache) = field(case, "cache").filter(|v| **v != Json::Null) {
            let path = f.root.path().join("USER.md");
            let mtime = fs::metadata(&path).unwrap().modified().unwrap();
            fs::write(&path, bytes(&text(field(cache, "replacement").unwrap()))).unwrap();
            fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(mtime))
                .unwrap();
            assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), mtime);
            f.turn.messages.push(
                serde_json::from_value(json!({"role":"user","content":"Another synthetic turn"}))
                    .unwrap(),
            );
            f.journal
                .process(&f.turn, &f.context, &Cancel::never())
                .unwrap();
            let after = field(exception.unwrap(), "after").unwrap();
            assert_eq!(
                rows(&f.directory, "episodes.jsonl").last().unwrap()["participants"],
                json!([
                    text(field(after, "user").unwrap()),
                    text(field(after, "assistant").unwrap())
                ])
            );
        }
    }
}
#[cfg(unix)]
#[test]
fn linked_name_files_never_enter_episode_or_checkpoint() {
    for hard in [false, true] {
        let f = setup();
        let outside = support::canonical_tempdir();
        let name = outside.path().join("other-user");
        fs::write(&name, "**Name:** Other user's private name").unwrap();
        let path = f.root.path().join("USER.md");
        if hard {
            fs::hard_link(&name, &path).unwrap();
        } else {
            std::os::unix::fs::symlink(&name, &path).unwrap();
        }
        assert!(f
            .journal
            .process(&f.turn, &f.context, &Cancel::never())
            .is_err());
        assert!(!f.directory.join("episodes.jsonl").exists());
    }
}
#[test]
fn revoked_policy_and_cancel_prevent_new_names_and_new_episodes() {
    let f = setup();
    fs::write(
        f.root.path().join("USER.md"),
        "**Name:** Synthetic private name",
    )
    .unwrap();
    f.policy.allowed.store(false, Ordering::SeqCst);
    assert!(f
        .journal
        .process(&f.turn, &f.context, &Cancel::never())
        .is_err());
    f.policy.allowed.store(true, Ordering::SeqCst);
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(f.journal.process(&f.turn, &f.context, &cancel).is_err());
    assert!(!f.directory.join("episodes.jsonl").exists());
}

#[test]
fn prepared_episodes_recover_the_saved_names_without_reading_new_files() {
    let f = setup();
    fs::write(f.root.path().join("USER.md"), "**Name:** Before").unwrap();
    f.policy.stop_after_first.store(true, Ordering::SeqCst);
    assert!(f
        .journal
        .process(&f.turn, &f.context, &Cancel::never())
        .is_err());
    let pending = native_file(&f.directory, "native-episode-pending-");
    let state: Value = serde_json::from_slice(&fs::read(pending).unwrap()).unwrap();
    assert_eq!(
        state["plan"]["episodes"][0]["participants"],
        json!(["Before", "alpha"])
    );
    fs::write(f.root.path().join("USER.md"), "**Name:** After").unwrap();
    f.policy.stop_after_first.store(false, Ordering::SeqCst);
    f.policy.allowed.store(true, Ordering::SeqCst);
    let mood = Arc::new(plur1bus_engine::capture::emotion_pool::EmotionalPool::new(
        f.host.clone(),
        json!({}),
    ));
    let reopened =
        EpisodeStore::open(f.root.path(), f.host.clone(), f.policy.clone(), mood).unwrap();
    reopened.recover_pending(&Cancel::never()).unwrap();
    assert_eq!(
        rows(&f.directory, "episodes.jsonl").last().unwrap()["participants"],
        json!(["Before", "alpha"])
    );
}

#[cfg(unix)]
#[test]
fn completed_watermark_does_not_read_names_again() {
    let f = setup();
    fs::write(f.root.path().join("USER.md"), "**Name:** Before").unwrap();
    f.journal
        .process(&f.turn, &f.context, &Cancel::never())
        .unwrap();
    let original = fs::read(f.directory.join("episodes.jsonl")).unwrap();
    fs::remove_file(f.root.path().join("USER.md")).unwrap();
    std::os::unix::fs::symlink("missing-name", f.root.path().join("USER.md")).unwrap();
    assert_eq!(
        f.journal
            .process(&f.turn, &f.context, &Cancel::never())
            .unwrap(),
        0
    );
    assert_eq!(
        fs::read(f.directory.join("episodes.jsonl")).unwrap(),
        original
    );
}
