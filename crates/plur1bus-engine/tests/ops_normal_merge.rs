//! Actual host decision/embedding composition over private Lance and the durable merge writer.
#![cfg(feature = "testkit")]
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    dead_code,
    reason = "offline fixture assertions"
)]
#[path = "support/interference.rs"]
mod fixture;
use fixture::support;
use plur1bus_engine::{
    context::RequestContext,
    contract::*,
    embedding::{EmbedError, EmbedKind, EmbeddingProvider},
    neo::capture_journal::CaptureJournal,
    ops::{
        context::OperationContext,
        durable_merge::NativeMerge,
        memory::{MemoryReader, ReadSource, ReadStores, SourceKind},
    },
    store::{RowPatch, Store},
    text::json::parse_json,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
const SOURCE: &str = "00000000-0000-4000-8000-000000000001";
type Effect = Arc<dyn Fn() + Send + Sync>;
struct Host {
    inner: support::TestHost,
    config: Mutex<Value>,
    calls: AtomicUsize,
    answer: Mutex<Result<String, HostError>>,
    effect: Mutex<Option<Effect>>,
    route: AtomicBool,
    params: Mutex<Vec<LlmParams>>,
}
impl HostServices for Host {
    fn state_dir(&self) -> &Path {
        self.inner.state_dir()
    }
    fn config(&self) -> EngineConfig {
        serde_json::from_value(self.config.lock().unwrap().clone()).unwrap()
    }
    fn workspace_dir(&self, a: &AgentId) -> Result<Option<PathBuf>, HostError> {
        self.inner.workspace_dir(a)
    }
    fn llm(&self) -> Option<&dyn LlmPort> {
        self.route
            .load(Ordering::SeqCst)
            .then_some(self as &dyn LlmPort)
    }
    fn secrets(&self) -> Option<&dyn SecretPort> {
        None
    }
    fn egress(&self) -> &dyn EgressGate {
        self.inner.egress()
    }
    fn emit(&self, e: &str, v: Value) {
        self.inner.emit(e, v)
    }
    fn now_ms(&self) -> i64 {
        self.inner.now_ms()
    }
    fn platform(&self) -> &PlatformCapabilities {
        self.inner.platform()
    }
    fn journal_backlog(&self) -> Option<JournalBacklog> {
        None
    }
}
impl LlmPort for Host {
    fn complete(&self, p: LlmParams, c: &Cancel) -> Result<LlmResult, HostError> {
        c.check()?;
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.params.lock().unwrap().push(p);
        if let Some(f) = self.effect.lock().unwrap().as_ref() {
            f();
        }
        match &*self.answer.lock().unwrap() {
            Ok(text) => Ok(serde_json::from_value(json!({"text":text})).unwrap()),
            Err(_) => Err(HostError::Unavailable),
        }
    }
}
struct Embed {
    identity: VectorSpaceIdentity,
    calls: AtomicUsize,
    effect: Mutex<Option<Effect>>,
    vector: Mutex<Vec<f32>>,
}
impl EmbeddingProvider for Embed {
    fn identity(&self) -> &VectorSpaceIdentity {
        &self.identity
    }
    fn embed(
        &self,
        texts: &[String],
        kind: EmbedKind,
        c: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        c.check().map_err(EmbedError::Cancelled)?;
        assert_eq!(texts.len(), 1);
        assert!(!texts[0].is_empty());
        assert!(matches!(kind, EmbedKind::Passage));
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(f) = self.effect.lock().unwrap().as_ref() {
            f();
        }
        Ok(vec![self.vector.lock().unwrap().clone()])
    }
}
struct Sources(Arc<Store>);
impl ReadStores for Sources {
    fn sources(&self, _: &RequestContext) -> Result<Vec<ReadSource>, StoreError> {
        Ok(vec![ReadSource {
            store: self.0.clone(),
            kind: SourceKind::Private,
            optional: false,
        }])
    }
}
struct Fixture {
    base: fixture::Fixture,
    host: Arc<Host>,
    embed: Arc<Embed>,
    policy: Arc<fixture::Policy>,
    merge: NativeMerge,
    reader: Arc<MemoryReader>,
    journal: Arc<CaptureJournal>,
}
fn setup() -> Fixture {
    let base = fixture::setup();
    std::fs::create_dir_all(base.root.path().join("state")).unwrap();
    let inner = support::TestHost::new(base.root.path().join("state"));
    inner.set_workspace("alpha", base.root.path().join("workspace"));
    inner.time.store(1735689600000, Ordering::SeqCst);
    let host=Arc::new(Host{inner,config:Mutex::new(json!({"merging":{"enabled":true,"autoApply":true,"model":"synthetic/model"}})),calls:AtomicUsize::new(0),answer:Mutex::new(Ok(r#"{"merge":true,"reason":"fixture","mergedText":"A synthetic decision with additional context"}"#.into())),effect:Mutex::new(None),route:AtomicBool::new(true),params:Mutex::new(vec![])});
    let embed = Arc::new(Embed {
        identity: base.store.identity().unwrap().clone(),
        calls: AtomicUsize::new(0),
        effect: Mutex::new(None),
        vector: Mutex::new(vec![1., 0., 0., 0.]),
    });
    let policy = Arc::new(fixture::Policy {
        allowed: AtomicBool::new(true),
    });
    let journal = Arc::new(
        CaptureJournal::open(&base.root.path().join("neo"), host.clone(), policy.clone()).unwrap(),
    );
    let reader = Arc::new(MemoryReader::new(
        Arc::new(OperationContext::new(host.clone())),
        Arc::new(Sources(base.store.clone())),
        embed.clone(),
        base.root.path().join("store"),
    ));
    Fixture {
        base,
        host,
        embed,
        policy,
        merge: NativeMerge::new(reader.clone(), journal.clone()),
        reader,
        journal,
    }
}
fn run(
    f: &Fixture,
    c: &Cancel,
) -> Result<Option<plur1bus_engine::ops::durable_merge::MergeResult>, EngineError> {
    f.merge.merge_normal(
        SOURCE,
        &parse_json(r#"{"text":"A synthetic decision","category":"decision","ttl":"session"}"#)
            .unwrap(),
        &f.base.principal,
        &f.base.agent,
        c,
    )
}
#[test]
fn host_decision_and_embedding_commit_one_archived_merge() {
    let f = setup();
    let result = run(&f, &Cancel::never()).unwrap().unwrap();
    assert!(f.base.store.get(SOURCE).unwrap().is_none());
    let row = f.base.store.get(&result.replacement_id).unwrap().unwrap();
    assert_eq!(row.text, "A synthetic decision with additional context");
    assert_eq!(row.owner_user_id, f.base.request.source.row.owner_user_id);
    assert_eq!(f.host.calls.load(Ordering::SeqCst), 1);
    assert_eq!(f.embed.calls.load(Ordering::SeqCst), 1);
    let p = f.host.params.lock().unwrap();
    assert_eq!(p[0].model.as_deref(), Some("synthetic/model"));
    assert!(p[0].temperature.is_none());
    assert_eq!(p[0].max_tokens.as_ref().unwrap().as_u64(), Some(300));
    assert!(result.archive_path.is_file());
}
#[test]
fn policy_config_and_source_changes_around_providers_prevent_mutation() {
    for stage in ["before", "llm", "embedding"] {
        for change in ["policy", "source", "config"] {
            if stage == "before" && change == "source" {
                continue;
            }
            let f = setup();
            let effect: Effect = match change {
                "policy" => {
                    let policy = f.policy.clone();
                    Arc::new(move || policy.allowed.store(false, Ordering::SeqCst))
                }
                "source" => {
                    let store = f.base.store.clone();
                    Arc::new(move || {
                        store
                            .patch(
                                SOURCE,
                                &RowPatch {
                                    text: Some("Changed concurrently".into()),
                                    ..Default::default()
                                },
                            )
                            .unwrap();
                    })
                }
                _ => {
                    let host = f.host.clone();
                    Arc::new(move || {
                        host.config.lock().unwrap()["merging"]["autoApply"] = false.into();
                    })
                }
            };
            if stage == "before" {
                effect();
            } else if stage == "llm" {
                *f.host.effect.lock().unwrap() = Some(effect);
            } else {
                *f.embed.effect.lock().unwrap() = Some(effect);
            }
            let result = run(&f, &Cancel::never());
            if stage == "before" && change != "policy" {
                // fresh authoritative source/config is allowed to differ before admission
                assert!(result.unwrap().is_none());
            } else {
                assert!(result.is_err(), "{stage}/{change}");
            }
            assert!(f.base.store.get(SOURCE).unwrap().is_some());
            assert!(!f
                .base
                .root
                .path()
                .join("workspace/.adaptive-learning/destructive-ops.jsonl")
                .exists());
            assert_eq!(
                f.host.calls.load(Ordering::SeqCst),
                usize::from(stage != "before"),
                "{stage}/{change}"
            );
            assert_eq!(
                f.embed.calls.load(Ordering::SeqCst),
                usize::from(stage == "embedding"),
                "{stage}/{change}"
            );
        }
    }
}
#[test]
fn declined_disabled_unavailable_and_invalid_vectors_do_not_write() {
    for mode in [
        "disabled",
        "manual",
        "missing",
        "declined",
        "invalid",
        "failure",
        "empty-vector",
        "wrong-dimension",
        "nan",
    ] {
        let f = setup();
        match mode {
            "disabled" => f.host.config.lock().unwrap()["merging"]["enabled"] = false.into(),
            "manual" => f.host.config.lock().unwrap()["merging"]["autoApply"] = false.into(),
            "missing" => f.host.route.store(false, Ordering::SeqCst),
            "declined" => {
                *f.host.answer.lock().unwrap() = Ok(r#"{"merge":false,"reason":"separate"}"#.into())
            }
            "invalid" => *f.host.answer.lock().unwrap() = Ok("invalid".into()),
            "failure" => *f.host.answer.lock().unwrap() = Err(HostError::Unavailable),
            "empty-vector" => *f.embed.vector.lock().unwrap() = vec![],
            "wrong-dimension" => *f.embed.vector.lock().unwrap() = vec![1.],
            _ => *f.embed.vector.lock().unwrap() = vec![f32::NAN; 4],
        };
        let result = run(&f, &Cancel::never());
        if ["empty-vector", "wrong-dimension", "nan"].contains(&mode) {
            assert!(result.is_err(), "{mode}");
        } else {
            assert!(result.unwrap().is_none(), "{mode}");
        }
        assert!(f.base.store.get(SOURCE).unwrap().is_some());
    }
}

#[test]
fn cancellation_and_physical_rebinding_refuse_after_provider_without_embedding() {
    for mode in ["cancel", "workspace", "state", "store"] {
        let f = setup();
        let cancel = Cancel::never();
        let effect: Effect = if mode == "cancel" {
            let flag = cancel.clone();
            Arc::new(move || flag.cancel())
        } else {
            let path = match mode {
                "workspace" => f.base.root.path().join("workspace"),
                "state" => f.base.root.path().join("state"),
                _ => f.base.root.path().join("store/alpha"),
            };
            Arc::new(move || {
                std::fs::rename(&path, path.with_extension("original")).unwrap();
                std::fs::create_dir(&path).unwrap();
            })
        };
        *f.host.effect.lock().unwrap() = Some(effect);
        assert!(run(&f, &cancel).is_err(), "{mode}");
        assert_eq!(f.host.calls.load(Ordering::SeqCst), 1);
        assert_eq!(f.embed.calls.load(Ordering::SeqCst), 0);
        assert!(!f
            .base
            .root
            .path()
            .join("workspace/.adaptive-learning/destructive-ops.jsonl")
            .exists());
    }
}
#[test]
fn host_route_selection_is_explicit_and_direct_options_never_fall_back() {
    for (mode, wanted) in [
        ("feature", Some("synthetic/model")),
        ("agent", Some("synthetic/agent")),
        ("agent-default", Some("synthetic/agent-default")),
        ("global", Some("synthetic/global")),
        ("direct", None),
        ("thinking", None),
    ] {
        let f = setup();
        {
            let mut config = f.host.config.lock().unwrap();
            match mode {
                "agent" => {
                    config["llmRouter"] = json!({"agentModels":{"alpha":{"merging":"synthetic/agent","*":"synthetic/agent-default"}}})
                }
                "agent-default" => {
                    config["llmRouter"] =
                        json!({"agentModels":{"alpha":{"*":"synthetic/agent-default"}}})
                }
                "global" => {
                    config["merging"].as_object_mut().unwrap().remove("model");
                    config["llmRouter"] = json!({"defaultModel":"synthetic/global"});
                }
                "direct" => config["merging"]["baseUrl"] = "https://fixture.invalid".into(),
                "thinking" => config["merging"]["disableThinking"] = true.into(),
                _ => (),
            }
        }
        let result = run(&f, &Cancel::never());
        if let Some(wanted) = wanted {
            assert!(result.unwrap().is_some(), "{mode}");
            assert_eq!(
                f.host.params.lock().unwrap()[0].model.as_deref(),
                Some(wanted)
            );
        } else {
            assert!(result.is_err(), "{mode}");
            assert_eq!(f.host.calls.load(Ordering::SeqCst), 0);
            assert_eq!(f.embed.calls.load(Ordering::SeqCst), 0);
        }
    }
}
#[test]
fn foreign_missing_and_inactive_sources_are_not_disclosed() {
    for mode in ["foreign", "missing", "inactive"] {
        let f = setup();
        if mode == "missing" {
            f.base.store.delete(&[SOURCE]).unwrap();
        } else {
            let mut row = f.base.store.get(SOURCE).unwrap().unwrap();
            if mode == "foreign" {
                row.owner_user_id =
                    plur1bus_engine::context::harness_user_principal("someone-else");
            } else {
                row.status = "superseded".into();
            }
            f.base.store.upsert(&[row]).unwrap();
        }
        assert!(run(&f, &Cancel::never()).is_err(), "{mode}");
        assert_eq!(f.host.calls.load(Ordering::SeqCst), 0);
        assert_eq!(f.embed.calls.load(Ordering::SeqCst), 0);
    }
}
#[test]
fn interrupted_composed_merge_recovers_frozen_vector_and_time_without_providers() {
    let mut f = setup();
    let host = f.host.clone();
    *f.embed.effect.lock().unwrap() = Some(Arc::new(move || {
        host.inner.time.store(1735689604321, Ordering::SeqCst)
    }));
    f.merge = f.merge.with_observer(Arc::new(|stage| {
        if stage == "replacement-write" {
            Err(StoreError::Unavailable.into())
        } else {
            Ok(())
        }
    }));
    assert!(run(&f, &Cancel::never()).is_err());
    assert_eq!(f.host.calls.load(Ordering::SeqCst), 1);
    assert_eq!(f.embed.calls.load(Ordering::SeqCst), 1);
    // A provider is no longer available; original durable intent supplies the vector and timestamp.
    f.host.route.store(false, Ordering::SeqCst);
    f.host
        .inner
        .time
        .store(1735689600000 + 3600000, Ordering::SeqCst);
    f.merge = f.merge.with_observer(Arc::new(|_| Ok(())));
    assert_eq!(f.merge.recover_pending(&Cancel::never()).unwrap(), 1);
    assert_eq!(f.host.calls.load(Ordering::SeqCst), 1);
    assert_eq!(f.embed.calls.load(Ordering::SeqCst), 1);
    assert!(f.base.store.get(SOURCE).unwrap().is_none());
    // The canonical audit is independent of any subsequent provider clock.
    let audit = std::fs::read_to_string(
        f.base
            .root
            .path()
            .join("workspace/.adaptive-learning/destructive-ops.jsonl"),
    )
    .unwrap();
    assert_eq!(audit.lines().count(), 1);
    assert!(audit.contains("2025-01-01T00:00:04.321Z"));
    let event: Value = serde_json::from_str(audit.trim()).unwrap();
    let archived: Value =
        serde_json::from_slice(&std::fs::read(event["archivePath"].as_str().unwrap()).unwrap())
            .unwrap();
    assert_eq!(archived["id"], SOURCE);
    let params =
        parse_json(r#"{"text":"A synthetic decision","category":"decision","ttl":"session"}"#)
            .unwrap();
    let source = &f.base.request.source.row;
    let assessed = plur1bus_engine::capture::normal_store::assess(
        &params,
        plur1bus_engine::capture::normal_store::StoreOwner {
            agent_id: "alpha",
            owner_user_id: &source.owner_user_id,
            workspace_key: &source.workspace_key,
        },
        1735689600000,
        &Cancel::never(),
    )
    .unwrap();
    let id = plur1bus_engine::capture::durable_merge::identity(
        "alpha",
        SOURCE,
        assessed.write_key(),
        &Cancel::never(),
    )
    .unwrap();
    let row = f.base.store.get(&id.replacement_id).unwrap().unwrap();
    assert_eq!(row.created_at.as_f64(), Some(1735689604321.));
    assert_eq!(row.expires_at.as_f64(), Some(1735689600000. + 86400000.));
}

#[test]
fn expired_pending_replacement_requires_explicit_repair_before_deleting_source() {
    let mut f = setup();
    f.merge = f.merge.with_observer(Arc::new(|stage| {
        if stage == "replacement-write" {
            Err(StoreError::Unavailable.into())
        } else {
            Ok(())
        }
    }));
    assert!(run(&f, &Cancel::never()).is_err());
    f.host
        .inner
        .time
        .store(1735689600000 + 2 * 86400000, Ordering::SeqCst);
    f.merge = f.merge.with_observer(Arc::new(|_| Ok(())));
    assert!(f.merge.recover_pending(&Cancel::never()).is_err());
    assert!(f.base.store.get(SOURCE).unwrap().is_some());
    assert_eq!(f.host.calls.load(Ordering::SeqCst), 1);
    assert_eq!(f.embed.calls.load(Ordering::SeqCst), 1);
    assert!(!f
        .base
        .root
        .path()
        .join("workspace/.adaptive-learning/destructive-ops.jsonl")
        .exists());
}

#[test]
fn committed_tombstones_before_and_during_decision_stop_provider_or_embedding() {
    for stage in ["before", "llm"] {
        let f = setup();
        let base = f.base.root.path().join("store");
        let effect: Effect = Arc::new(move || {
            let registry =
                plur1bus_engine::store::tombstone::TombstoneRegistry::new(&base, "alpha").unwrap();
            let tombstone = json!({"schemaVersion":1,"agentId":"alpha","memoryId":SOURCE,"canonicalOriginId":SOURCE,"scope":"agent-private","status":"committed","contentFingerprint":plur1bus_engine::store::tombstone::content_fingerprint("A synthetic decision")});
            registry
                .append(&parse_json(&tombstone.to_string()).unwrap())
                .unwrap();
        });
        if stage == "before" {
            effect();
        } else {
            *f.host.effect.lock().unwrap() = Some(effect);
        }
        assert!(run(&f, &Cancel::never()).is_err(), "{stage}");
        assert_eq!(
            f.host.calls.load(Ordering::SeqCst),
            usize::from(stage == "llm")
        );
        assert_eq!(f.embed.calls.load(Ordering::SeqCst), 0);
        assert!(f.base.store.get(SOURCE).unwrap().is_some());
    }
}

#[test]
fn lexical_and_validity_guards_run_before_the_next_provider_disclosure() {
    for mode in ["meaningful", "short", "lost-facts", "disjoint"] {
        let f = setup();
        let mut params = json!({"text":"A synthetic decision","category":"decision"});
        match mode {
            "meaningful" => {
                f.base
                    .store
                    .patch(
                        SOURCE,
                        &RowPatch {
                            text: Some("Use version 2".into()),
                            ..Default::default()
                        },
                    )
                    .unwrap();
                params["text"] = "Use version 3".into();
            }
            "short" => {
                *f.host.answer.lock().unwrap() =
                    Ok(r#"{"merge":true,"reason":"fixture","mergedText":"short"}"#.into())
            }
            "lost-facts" => {
                f.base
                    .store
                    .patch(
                        SOURCE,
                        &RowPatch {
                            text: Some("The system uses port 5432 for PostgreSQL".into()),
                            ..Default::default()
                        },
                    )
                    .unwrap();
                params["text"] = "The system uses port 5432 for PostgreSQL".into();
                *f.host.answer.lock().unwrap()=Ok(r#"{"merge":true,"reason":"fixture","mergedText":"The system has a database with a sufficiently long generic description that omits the port number"}"#.into());
            }
            _ => {
                let mut row = f.base.store.get(SOURCE).unwrap().unwrap();
                row.valid_from = 1.into();
                row.valid_until = 10.into();
                f.base.store.upsert(&[row]).unwrap();
                params["validFrom"] = 11.into();
                params["validUntil"] = 20.into();
            }
        }
        let result = f
            .merge
            .merge_normal(
                SOURCE,
                &parse_json(&params.to_string()).unwrap(),
                &f.base.principal,
                &f.base.agent,
                &Cancel::never(),
            )
            .unwrap();
        assert!(result.is_none(), "{mode}");
        assert_eq!(
            f.host.calls.load(Ordering::SeqCst),
            usize::from(mode != "meaningful")
        );
        assert_eq!(f.embed.calls.load(Ordering::SeqCst), 0);
        assert!(f.base.store.get(SOURCE).unwrap().is_some());
    }
}

#[path = "support/normal_selection.rs"]
mod selection_tests;

#[path = "support/normal_insert.rs"]
mod insert_tests;

#[path = "support/normal_duplicate.rs"]
mod duplicate_tests;
