//! Actual Node capture/Lance oracle exercised by the native classifier and real capture runtime.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "integration oracle assertions"
)]
#[allow(
    dead_code,
    reason = "shared fixture also provides summary host binding"
)]
mod capture_pipeline_support;
use plur1bus_engine::{
    capture::{
        accept::CaptureRuntime,
        classify::{CaptureEmotionRoutes, NativeCaptureClassifier},
        emotion_pool::EmotionalPool,
        pipeline::{CaptureClassifier, CapturePipeline, ClassificationRequest},
        queue::{CaptureQueue, PressureSnapshot, RuntimeConfig},
        reminder_store::ReminderStore,
        replay_guard::ReplayGuard,
        shared_scope::WorkspaceCapturePolicy,
    },
    config,
    context::RequestContext,
    contract::{
        Cancel, CaptureOptions, EngineError, HostError, HostServices, LlmParams, LlmPort,
        LlmResult, TurnRecord,
    },
    embedding::EmbeddingProvider,
    store::{OpenMode, RowFilter, StorePool},
    text::js::JsString,
};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
const NOW: i64 = 1_710_000_000_000;
fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/capture/golden/classifier.json")).unwrap()
}
struct Routes {
    provider: String,
    answer: String,
    calls: Arc<Mutex<Vec<Value>>>,
    live: Arc<AtomicUsize>,
    bindings: AtomicUsize,
}
struct Port {
    provider: String,
    answer: String,
    calls: Arc<Mutex<Vec<Value>>>,
    live: Arc<AtomicUsize>,
}
impl Drop for Port {
    fn drop(&mut self) {
        self.live.fetch_sub(1, Ordering::SeqCst);
    }
}
impl CaptureEmotionRoutes for Routes {
    fn bind(
        &self,
        turn: &TurnRecord,
        cancel: &Cancel,
    ) -> Result<Option<Arc<dyn LlmPort>>, EngineError> {
        cancel.check()?;
        assert_eq!(turn.agent_id, turn.principal.agent_id);
        self.bindings.fetch_add(1, Ordering::SeqCst);
        if self.provider.is_empty() {
            return Ok(None);
        }
        self.live.fetch_add(1, Ordering::SeqCst);
        Ok(Some(Arc::new(Port {
            provider: self.provider.clone(),
            answer: self.answer.clone(),
            calls: self.calls.clone(),
            live: self.live.clone(),
        })))
    }
}
impl LlmPort for Port {
    fn complete(&self, params: LlmParams, cancel: &Cancel) -> Result<LlmResult, HostError> {
        cancel.check().map_err(|_| HostError::Failed)?;
        assert!(params.temperature.is_none());
        assert!(params.model.is_none());
        self.calls.lock().unwrap().push(
            serde_json::from_str(
                &plur1bus_engine::capture::pipeline::HostCaptureSummary::contract_params_json(
                    &params,
                )
                .unwrap(),
            )
            .unwrap(),
        );
        if self.provider == "throw" {
            return Err(HostError::Unavailable);
        }
        Ok(LlmResult {
            text: if self.provider == "malformed" {
                "invalid fixture answer".into()
            } else {
                self.answer.clone()
            },
            model: None,
            usage: None,
        })
    }
}
struct Rig {
    root: tempfile::TempDir,
    host: Arc<dyn HostServices>,
    stores: Arc<StorePool>,
    embedder: Arc<dyn EmbeddingProvider>,
    classifier: Arc<NativeCaptureClassifier>,
    routes: Arc<Routes>,
    mood: Arc<EmotionalPool>,
}
impl Rig {
    fn new(scenario: &Value) -> Self {
        let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let workspace = root.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let base = root.path().join("stores");
        let mut config = scenario["config"].clone();
        for (key,value) in json!({"baseDbPath":base,"embedding":{"provider":"local-transformers","local":{"dimensions":384}},"autoCapture":true,"autoRecall":false,"captureChunking":false,"duplicateThreshold":1.01,"neo":{"enabled":false},"metaCognition":{"enabled":false},"merging":{"enabled":false},"runtime":{"llmResultCacheEnabled":false,"llmResultCachePersist":false}}).as_object().unwrap(){config[key]=value.clone();}
        let host: Arc<dyn HostServices> = Arc::new(capture_pipeline_support::Host::new(
            root.path().join("state"),
            workspace,
            serde_json::from_value(config.clone()).unwrap(),
        ));
        let embedder: Arc<dyn EmbeddingProvider> =
            Arc::new(capture_pipeline_support::HashEmbedder::new(false));
        let stores = Arc::new(
            StorePool::open(&base, OpenMode::ReadWrite, Some(embedder.identity()), 50).unwrap(),
        );
        let routes = Arc::new(Routes {
            provider: scenario["provider"].as_str().unwrap_or("").into(),
            answer: fixture()["answer"].as_str().unwrap().into(),
            calls: Arc::new(Mutex::new(Vec::new())),
            live: Arc::new(AtomicUsize::new(0)),
            bindings: AtomicUsize::new(0),
        });
        let effective = config::effective_config(&config).unwrap();
        let mood = Arc::new(EmotionalPool::new(
            host.clone(),
            effective["emotion"].clone(),
        ));
        let reminders = Arc::new(ReminderStore::new(
            host.clone(),
            stores.clone(),
            embedder.clone(),
        ));
        let classifier = Arc::new(
            NativeCaptureClassifier::new(host.clone(), routes.clone(), mood.clone(), reminders)
                .unwrap(),
        );
        Self {
            root,
            host,
            stores,
            embedder,
            classifier,
            routes,
            mood,
        }
    }
    fn turn(&self, index: usize, text: &str) -> TurnRecord {
        serde_json::from_value(json!({"agentId":"capture-agent","principal":{"agentId":"capture-agent","workspace":format!("workspace-dir:v1:{}",self.root.path().join("workspace").canonicalize().unwrap().display()),"channel":"telegram","accountId":"default","chat":{"id":"capture-chat","kind":"direct"},"trust":"proved"},"agent":{"origin":"user","background":false},"messages":[{"role":if index%2==1{"assistant"}else{"user"},"content":text}],"runId":format!("classifier-{index}"),"sessionKey":"classification-session","incognito":false})).unwrap()
    }
}
fn compare_columns(actual: &Value, expected: &Value, name: &str) {
    for (key, value) in expected.as_object().unwrap() {
        if let Some(number) = value.as_f64() {
            assert_eq!(actual[key].as_f64(), Some(number), "{name}/{key}");
        } else {
            assert_eq!(&actual[key], value, "{name}/{key}");
        }
    }
}
#[test]
fn real_capture_classification_and_reminders_match_node_lance_rows() {
    let fixture = fixture();
    for case in fixture["recordings"].as_array().unwrap() {
        let scenario = &case["scenario"];
        let name = scenario["name"].as_str().unwrap();
        let rig = Rig::new(scenario);
        let base = rig.root.path().join("stores");
        let worker = CapturePipeline::new(
            rig.host.clone(),
            rig.stores.clone(),
            rig.embedder.clone(),
            rig.classifier.clone(),
            Arc::new(WorkspaceCapturePolicy::new(base.clone())),
        )
        .unwrap();
        let queue = Arc::new(
            CaptureQueue::new(
                RuntimeConfig::from_value(&json!({})),
                Arc::new(PressureSnapshot::disabled),
            )
            .unwrap(),
        );
        let replay = ReplayGuard::durable(base.join("_capture-turns"), Arc::new(|| NOW)).unwrap();
        let runtime = capture_pipeline_support::RuntimeGuard(
            CaptureRuntime::new(rig.host.clone(), Arc::new(worker), queue, replay, false).unwrap(),
        );
        let default_texts = json!([
            "The release planning meeting takes place every Thursday morning.",
            "I am very happy and grateful that the public fixture project is finally ready!",
            "I am sad and worried about the public fixture release schedule.",
            "I trust the team and appreciate their reliable work on the public fixture."
        ]);
        let texts = scenario
            .get("texts")
            .unwrap_or(&default_texts)
            .as_array()
            .unwrap();
        for (index, text) in texts.iter().enumerate() {
            let turn = rig.turn(index, text.as_str().unwrap());
            let handle = runtime
                .0
                .accept(
                    turn,
                    serde_json::from_value::<CaptureOptions>(json!({})).unwrap(),
                )
                .unwrap();
            let outcome = handle.done.recv_timeout(Duration::from_secs(15)).unwrap();
            let value = serde_json::to_value(outcome).unwrap();
            assert_eq!(value, case["outcomes"][index], "{name} outcome {index}");
        }
        let rows = rig
            .stores
            .get("capture-agent")
            .unwrap()
            .scan(&RowFilter::default(), 100)
            .unwrap();
        assert_eq!(
            rows.len(),
            case["rows"].as_array().unwrap().len(),
            "{name} row count"
        );
        for expected in case["rows"].as_array().unwrap() {
            let row = rows
                .iter()
                .find(|row| {
                    row.text == expected["text"].as_str().unwrap()
                        && row.memory_kind == expected["memoryKind"].as_str().unwrap()
                })
                .expect("recorded row text must exist");
            compare_columns(&serde_json::to_value(row).unwrap(), expected, name);
        }
        let calls = rig.routes.calls.lock().unwrap();
        let expected = case["calls"].as_array().unwrap();
        assert_eq!(calls.len(), expected.len(), "{name} provider call count");
        for (actual, expected) in calls.iter().zip(expected) {
            let params: Value = serde_json::from_str(expected["line"].as_str().unwrap()).unwrap();
            assert_eq!(actual, &params, "{name} complete provider parameters");
            assert_eq!(params["maxTokens"], 300);
            assert_eq!(expected["cancel"], true);
        }
        assert_eq!(
            rig.routes.live.load(Ordering::SeqCst),
            0,
            "no request callback retained by private emotional history"
        );
    }
}
#[test]
fn forged_context_cancel_and_foreign_mood_refuse_before_route_binding() {
    let rig = Rig::new(&json!({"config":{},"provider":"valid"}));
    let turn = rig.turn(0, "A public fixture sentence for caller isolation.");
    let context = RequestContext::build(&turn.principal, &turn.agent, rig.host.as_ref()).unwrap();
    let mut forged = context.clone();
    forged.owner_user_id = "foreign-fixture".into();
    let input = JsString::from("A public fixture sentence for caller isolation.");
    assert!(rig
        .classifier
        .classify(ClassificationRequest {
            text: &input,
            role: "user",
            turn: &turn,
            context: &forged,
            now: NOW,
            cancel: &Cancel::never()
        })
        .is_err());
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(rig
        .classifier
        .classify(ClassificationRequest {
            text: &input,
            role: "user",
            turn: &turn,
            context: &context,
            now: NOW,
            cancel: &cancel
        })
        .is_err());
    std::fs::write(
        rig.root.path().join("workspace/.emotional-state.json"),
        r#"{"agentId":"foreign-fixture","state":{}}"#,
    )
    .unwrap();
    assert!(rig
        .classifier
        .classify(ClassificationRequest {
            text: &input,
            role: "user",
            turn: &turn,
            context: &context,
            now: NOW,
            cancel: &Cancel::never()
        })
        .is_err());
    assert_eq!(rig.routes.bindings.load(Ordering::SeqCst), 0);
}
#[test]
fn media_without_host_ownership_fails_closed_but_independent_reminder_is_stored() {
    let rig = Rig::new(&json!({"config":{}}));
    let turn=rig.turn(0,"<!-- media-output-id: abcd -->\nRemind me in 5 minutes to check the public fixture release checklist.");
    let context = RequestContext::build(&turn.principal, &turn.agent, rig.host.as_ref()).unwrap();
    assert!(rig
        .classifier
        .post_store(&turn, &context, &[], &Cancel::never())
        .is_err());
    let rows = rig
        .stores
        .get("capture-agent")
        .unwrap()
        .scan(&RowFilter::default(), 100)
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].memory_kind, "reminder");
}
#[test]
fn capture_reads_the_same_owned_mood_state_that_recall_updates() {
    let rig = Rig::new(&json!({"config":{}}));
    let turn = rig.turn(
        0,
        "I feel happy and grateful about the public fixture release.",
    );
    let context = RequestContext::build(&turn.principal, &turn.agent, rig.host.as_ref()).unwrap();
    let input = JsString::from(turn.messages[0].content.as_str());
    let before = rig
        .classifier
        .classify(ClassificationRequest {
            text: &input,
            role: "user",
            turn: &turn,
            context: &context,
            now: NOW,
            cancel: &Cancel::never(),
        })
        .unwrap();
    rig.mood
        .update(
            &turn.principal,
            &turn.agent,
            &Cancel::never(),
            |state, now| state.update_messages(&turn.messages, now),
        )
        .unwrap();
    let after = rig
        .classifier
        .classify(ClassificationRequest {
            text: &input,
            role: "user",
            turn: &turn,
            context: &context,
            now: NOW,
            cancel: &Cancel::never(),
        })
        .unwrap();
    assert_ne!(
        before.mood_context_at_capture,
        after.mood_context_at_capture
    );
    assert_eq!(rig.routes.live.load(Ordering::SeqCst), 0);
}

#[test]
#[allow(
    clippy::panic,
    reason = "deliberately panicking host verifies callback lease unwinding"
)]
fn a_panicking_host_does_not_leave_its_callback_in_emotional_history() {
    use plur1bus_engine::{
        capture::emotion_engine::{AnalysisOptions, EmotionEngine},
        text::json::parse_json,
    };
    struct PanickingPort;
    impl LlmPort for PanickingPort {
        fn complete(&self, _: LlmParams, _: &Cancel) -> Result<LlmResult, HostError> {
            panic!("synthetic host panic")
        }
    }
    let mut engine = EmotionEngine::new(
        &parse_json(r#"{"tier3":{"enabled":true}}"#).unwrap(),
        None,
        Arc::new(|| NOW),
    )
    .unwrap();
    let port = Arc::new(PanickingPort);
    let weak = Arc::downgrade(&port);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        engine.analyze_with_completion(
            &JsString::from("Public fixture sentence"),
            "user",
            AnalysisOptions {
                force_tier: Some(3),
                skip_tier3: false,
            },
            &Cancel::never(),
            Some(port),
        )
    }));
    assert!(result.is_err());
    assert!(weak.upgrade().is_none());
    assert!(engine
        .analyze(
            &JsString::from("Public fixture sentence"),
            "user",
            AnalysisOptions::default(),
            &Cancel::never()
        )
        .is_ok());
}

struct WithoutWorkspace(Arc<dyn HostServices>);
impl HostServices for WithoutWorkspace {
    fn state_dir(&self) -> &std::path::Path {
        self.0.state_dir()
    }
    fn config(&self) -> plur1bus_engine::contract::EngineConfig {
        self.0.config()
    }
    fn workspace_dir(
        &self,
        _: &plur1bus_engine::contract::AgentId,
    ) -> Result<Option<std::path::PathBuf>, HostError> {
        Ok(None)
    }
    fn llm(&self) -> Option<&dyn LlmPort> {
        self.0.llm()
    }
    fn secrets(&self) -> Option<&dyn plur1bus_engine::contract::SecretPort> {
        self.0.secrets()
    }
    fn egress(&self) -> &dyn plur1bus_engine::contract::EgressGate {
        self.0.egress()
    }
    fn emit(&self, event: &str, payload: Value) {
        self.0.emit(event, payload);
    }
    fn now_ms(&self) -> i64 {
        self.0.now_ms()
    }
    fn platform(&self) -> &plur1bus_engine::contract::PlatformCapabilities {
        self.0.platform()
    }
    fn journal_backlog(&self) -> Option<plur1bus_engine::contract::JournalBacklog> {
        self.0.journal_backlog()
    }
}
#[test]
fn no_workspace_mood_is_transient_and_isolated_by_agent_and_owner() {
    let rig = Rig::new(&json!({"config":{}}));
    let host: Arc<dyn HostServices> = Arc::new(WithoutWorkspace(rig.host.clone()));
    let pool = EmotionalPool::new(
        host.clone(),
        json!({"temperaments":{"default":{"baseline":{"joy":0.3}}}}),
    );
    let mut value = serde_json::to_value(rig.turn(
        0,
        "I feel happy and grateful about the public fixture release.",
    ))
    .unwrap();
    value["principal"]["workspace"] = json!("workspace:v1:fixture-a");
    value["principal"]["user"] = json!(plur1bus_engine::context::harness_user_principal(
        "fixture-owner-a"
    ));
    let turn: TurnRecord = serde_json::from_value(value.clone()).unwrap();
    let read = |turn: &TurnRecord| {
        pool.read(
            &turn.principal,
            &turn.agent,
            &Cancel::never(),
            |state, now| state.snapshot(now),
        )
        .unwrap()
    };
    let initial = read(&turn);
    let result = pool
        .update(
            &turn.principal,
            &turn.agent,
            &Cancel::never(),
            |state, now| state.update_messages(&turn.messages, now),
        )
        .unwrap();
    assert!(!result.display_written);
    assert_ne!(read(&turn), initial);
    value["principal"]["user"] = json!(plur1bus_engine::context::harness_user_principal(
        "fixture-owner-b"
    ));
    let other: TurnRecord = serde_json::from_value(value.clone()).unwrap();
    assert_ne!(
        RequestContext::build(&turn.principal, &turn.agent, host.as_ref())
            .unwrap()
            .owner_user_id,
        RequestContext::build(&other.principal, &other.agent, host.as_ref())
            .unwrap()
            .owner_user_id
    );
    assert_eq!(read(&other), initial);
    let mut other_workspace = serde_json::to_value(&turn).unwrap();
    other_workspace["principal"]["workspace"] = json!("workspace:v1:fixture-b");
    assert_eq!(
        read(&serde_json::from_value(other_workspace).unwrap()),
        initial
    );
    value["agentId"] = json!("other-agent");
    value["principal"]["agentId"] = json!("other-agent");
    assert_eq!(read(&serde_json::from_value(value).unwrap()), initial);
    assert!(!rig
        .root
        .path()
        .join("workspace/.emotional-state.json")
        .exists());
}
