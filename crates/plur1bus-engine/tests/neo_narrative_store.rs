//! Provider composition behind original source/current policy and durable episode plans.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    capture::shared_scope::CapturePolicy,
    context::{harness_user_principal, RequestContext},
    contract::{Cancel, EngineError, HostError, LlmParams, LlmPort, LlmResult, TurnRecord},
    neo::{episode_store::EpisodeStore, merged::Layout},
};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
#[path = "support/neo_episode.rs"]
mod fixtures;
use fixtures::*;
struct Model {
    calls: Mutex<Vec<LlmParams>>,
    policy: Option<Arc<Policy>>,
    source: Option<PathBuf>,
    fail: bool,
}
impl LlmPort for Model {
    fn complete(&self, params: LlmParams, _: &Cancel) -> Result<LlmResult, HostError> {
        self.calls.lock().unwrap().push(params);
        if let Some(policy) = &self.policy {
            policy.allowed.store(false, Ordering::SeqCst);
        }
        if let Some(source) = &self.source {
            let old = fs::read_to_string(source).unwrap();
            let mut rows = old
                .lines()
                .map(|v| serde_json::from_str::<Value>(v).unwrap())
                .collect::<Vec<_>>();
            rows[0]["content"] = json!("Changed synthetic source");
            fs::write(
                source,
                rows.iter()
                    .map(|v| v.to_string() + "\n")
                    .collect::<String>(),
            )
            .unwrap();
        }
        if self.fail {
            return Err(HostError::Unavailable);
        }
        Ok(LlmResult{text:json!({"title":"Narrative title","summary":"Synthetic narrative summary","narrativeArc":"decision","topics":["Architecture"],"people":["Ada","Grace"],"emotion":"joy","emotionIntensity":"hoch","id":"forged","ownerUserId":"other","scope":"global_user"}).to_string(),usage:None,model:None})
    }
}
fn model() -> Arc<Model> {
    Arc::new(Model {
        calls: Mutex::new(vec![]),
        policy: None,
        source: None,
        fail: false,
    })
}
#[test]
fn authorized_narrative_is_durable_and_concurrent_retries_do_not_call_again() {
    let mut f = setup();
    let model = model();
    fs::write(f.root.path().join("USER.md"), "**Name:** Ada").unwrap();
    f.journal = f.journal.with_narrative(model.clone());
    std::thread::scope(|scope| {
        let handles = (0..4)
            .map(|_| scope.spawn(|| f.journal.process(&f.turn, &f.context, &Cancel::never())))
            .collect::<Vec<_>>();
        for h in handles {
            h.join().unwrap().unwrap();
        }
    });
    let calls = model.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert!(calls[0].messages[0].content.contains("Ada (Mensch)"));
    drop(calls);
    let episodes = rows(&f.directory, "episodes.jsonl");
    assert_eq!(episodes.len(), 1);
    let episode = &episodes[0];
    assert_eq!(episode["title"], "Narrative title");
    assert_eq!(episode["summary"], "Synthetic narrative summary");
    assert_eq!(episode["mentioned"], json!(["Grace"]));
    assert_eq!(episode["emotionalIntensity"], 0.8);
    assert_ne!(episode["id"], "forged");
    assert_eq!(episode["scope"], "agent_private");
    assert_ne!(episode["ownerUserId"], "other");
}
#[test]
fn prepared_narrative_recovers_without_another_provider_or_new_name_read() {
    let mut f = setup();
    let model = model();
    f.journal = f.journal.with_narrative(model.clone());
    f.policy.stop_after_first.store(true, Ordering::SeqCst);
    assert!(f
        .journal
        .process(&f.turn, &f.context, &Cancel::never())
        .is_err());
    let pending = native_file(&f.directory, "native-episode-pending-");
    let plan: Value = serde_json::from_slice(&fs::read(pending).unwrap()).unwrap();
    assert_eq!(plan["plan"]["episodes"][0]["title"], "Narrative title");
    f.policy.stop_after_first.store(false, Ordering::SeqCst);
    f.policy.allowed.store(true, Ordering::SeqCst);
    let mood = Arc::new(plur1bus_engine::capture::emotion_pool::EmotionalPool::new(
        f.host.clone(),
        json!({}),
    ));
    let reopened =
        EpisodeStore::open(f.root.path(), f.host.clone(), f.policy.clone(), mood).unwrap();
    reopened.recover_pending(&Cancel::never()).unwrap();
    assert_eq!(rows(&f.directory, "episodes.jsonl").len(), 1);
    assert_eq!(
        rows(&f.directory, "episodes.jsonl")[0]["title"],
        "Narrative title"
    );
    assert_eq!(model.calls.lock().unwrap().len(), 1);
}
#[test]
fn policy_or_source_changes_during_inference_prevent_publication() {
    for revoke in [false, true] {
        let mut f = setup();
        let model = Arc::new(Model {
            calls: Mutex::new(vec![]),
            policy: revoke.then(|| f.policy.clone()),
            source: (!revoke).then(|| f.directory.join("turn-journal.jsonl")),
            fail: false,
        });
        f.journal = f.journal.with_narrative(model.clone());
        assert!(f
            .journal
            .process(&f.turn, &f.context, &Cancel::never())
            .is_err());
        assert_eq!(model.calls.lock().unwrap().len(), 1);
        assert!(!f.directory.join("episodes.jsonl").exists());
    }
}
#[test]
fn incognito_revoked_and_single_turn_sources_never_call_the_model() {
    for mode in ["incognito", "revoked", "single"] {
        let mut f = setup();
        let model = model();
        f.journal = f.journal.with_narrative(model.clone());
        match mode {
            "incognito" => f.turn.incognito = true,
            "revoked" => f.policy.allowed.store(false, Ordering::SeqCst),
            _ => f.turn.messages.truncate(1),
        }
        let result = f.journal.process(&f.turn, &f.context, &Cancel::never());
        if mode == "revoked" {
            assert!(result.is_err());
        } else {
            result.unwrap();
        }
        assert!(model.calls.lock().unwrap().is_empty());
    }
}
#[test]
fn optional_provider_failure_keeps_a_real_episode_and_advances_once() {
    let mut f = setup();
    let model = Arc::new(Model {
        calls: Mutex::new(vec![]),
        policy: None,
        source: None,
        fail: true,
    });
    f.journal = f.journal.with_narrative(model.clone());
    f.journal
        .process(&f.turn, &f.context, &Cancel::never())
        .unwrap();
    f.journal
        .process(&f.turn, &f.context, &Cancel::never())
        .unwrap();
    let episodes = rows(&f.directory, "episodes.jsonl");
    assert_eq!(episodes.len(), 1);
    assert_ne!(episodes[0]["title"], "Narrative title");
    assert_eq!(model.calls.lock().unwrap().len(), 1);
}

#[test]
fn continuation_uses_saved_prefixes_and_handles_only_the_proven_split_pair() {
    let mut f = setup();
    let model = model();
    f.turn.messages.truncate(2);
    f.turn.messages[0].content = "x".repeat(599) + "𠀀old-tail";
    f.journal = f.journal.with_narrative(model.clone());
    f.journal
        .process(&f.turn, &f.context, &Cancel::never())
        .unwrap();
    f.turn.messages.push(
        serde_json::from_value(json!({"role":"user","content":"Latest synthetic turn"})).unwrap(),
    );
    f.journal
        .process(&f.turn, &f.context, &Cancel::never())
        .unwrap();
    let calls = model.calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert!(!calls[1].messages[0].content.contains("old-tail"));
    assert!(calls[1].messages[0]
        .content
        .contains(&format!("[Nutzer] {}\n", "x".repeat(599))));
    assert!(calls[1].messages[0]
        .content
        .contains("Latest synthetic turn"));
    let episodes = rows(&f.directory, "episodes.jsonl");
    assert_eq!(episodes.len(), 2);
    assert_eq!(episodes[0]["id"], episodes[1]["id"]);
    assert_eq!(episodes[1]["revision"], 1);
}

#[test]
fn a_foreign_actual_source_is_refused_before_provider_disclosure() {
    let mut f = setup();
    let model = model();
    f.journal = f.journal.with_narrative(model.clone());
    f.journal
        .record(&f.turn, &f.context, &Cancel::never())
        .unwrap();
    let source = f.directory.join("turn-journal.jsonl");
    let old = fs::read_to_string(&source).unwrap();
    let mut entries = old
        .lines()
        .map(|v| serde_json::from_str::<Value>(v).unwrap())
        .collect::<Vec<_>>();
    entries[0]["ownerUserId"] = json!("foreign-owner");
    fs::write(
        source,
        entries
            .iter()
            .map(|v| v.to_string() + "\n")
            .collect::<String>(),
    )
    .unwrap();
    assert!(f
        .journal
        .process(&f.turn, &f.context, &Cancel::never())
        .is_err());
    assert!(model.calls.lock().unwrap().is_empty());
    assert!(!f.directory.join("episodes.jsonl").exists());
}
