//! Actual acceptance-to-Lance capture parity with narrow injected classification metadata.
#![allow(clippy::unwrap_used, clippy::expect_used)]

pub use plur1bus_engine::capture::{
    accept, chunking, failure as pipeline_failure, pipeline, queue, replay_guard, result,
    row_builder, shared_scope,
};
// Re-exports for the support modules below; as a mounted module not every one is used in every configuration.
#[allow(unused_imports)]
pub use plur1bus_engine::{config, context, contract, embedding, store, text, transport};
mod capture_pipeline_support;

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use contract::{Cancel, CaptureOptions, EngineError, MemoryRow, TurnRecord};
use pipeline::{
    CaptureChunkDecider, CaptureClassification, CaptureClassifier, CaptureDynamics, NeoCaptureHook,
};
use sha2::{Digest, Sha256};
use text::js::JsString;

struct RecordedLlm(serde_json::Value, Arc<AtomicUsize>);
impl contract::LlmPort for RecordedLlm {
    fn complete(
        &self,
        params: contract::LlmParams,
        cancel: &Cancel,
    ) -> Result<contract::LlmResult, contract::HostError> {
        cancel.check().map_err(|_| contract::HostError::Failed)?;
        self.1.fetch_add(1, Ordering::SeqCst);
        #[derive(serde::Serialize)]
        struct NodeMessage<'a> {
            role: &'a contract::MessageRole,
            content: &'a str,
        }
        let messages: Vec<_> = params
            .messages
            .iter()
            .map(|message| NodeMessage {
                role: &message.role,
                content: &message.content,
            })
            .collect();
        let messages_json = serde_json::to_string(&messages).unwrap();
        let hash = format!("{:x}", Sha256::digest(messages_json.as_bytes()));
        let fixture = self
            .0
            .get(hash)
            .expect("actual Node message prompt hash must exist");
        assert_eq!(messages_json, fixture["messagesJson"].as_str().unwrap());
        assert_eq!(
            pipeline::HostCaptureSummary::contract_params_json(&params).unwrap(),
            fixture["contractParamsJson"].as_str().unwrap()
        );
        if !fixture["error"].is_null() {
            return Err(contract::HostError::Failed);
        }
        let result: serde_json::Value =
            serde_json::from_str(fixture["resultJson"].as_str().unwrap()).unwrap();
        Ok(contract::LlmResult {
            text: result["text"].as_str().unwrap().to_string(),
            model: None,
            usage: None,
        })
    }
}

struct ClassificationFixture(BTreeMap<String, CaptureClassification>);
impl CaptureClassifier for ClassificationFixture {
    fn classify(
        &self,
        request: pipeline::ClassificationRequest<'_>,
    ) -> Result<CaptureClassification, EngineError> {
        request.cancel.check()?;
        let text = request.text;
        self.0
            .get(&text.to_utf8_lossy())
            .cloned()
            .ok_or_else(|| EngineError::NotAvailable {
                reason: "classification-fixture-missing".into(),
            })
    }
    fn post_store(
        &self,
        _: &TurnRecord,
        _: &context::RequestContext,
        _: &[MemoryRow],
        _: &Cancel,
    ) -> Result<(), EngineError> {
        Ok(())
    }
}

struct WholeDecision;
impl CaptureChunkDecider for WholeDecision {
    fn decide(
        &self,
        _text: &JsString,
        _context: &context::RequestContext,
        cancel: &Cancel,
    ) -> Result<chunking::StorageDecision, EngineError> {
        cancel.check()?;
        Ok(chunking::StorageDecision::Whole)
    }
}

struct NeoFixture;
impl NeoCaptureHook for NeoFixture {
    fn record_turn(
        &self,
        _turn: &TurnRecord,
        _context: &context::RequestContext,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        cancel.check()?;
        Ok(())
    }
    fn post_store(
        &self,
        _: &TurnRecord,
        _: &context::RequestContext,
        _: &CaptureOptions,
        _: &Cancel,
    ) -> Result<(), EngineError> {
        Ok(())
    }
}

fn classification(row: &MemoryRow) -> CaptureClassification {
    CaptureClassification {
        category: row.category.clone(),
        emotional_valence: row.emotional_valence.clone(),
        emotional_intensity: row.emotional_intensity.as_f64().unwrap(),
        emotional_dominant: row.emotional_dominant.clone(),
        mood_context_at_capture: row.mood_context_at_capture.clone(),
        emotion_status: row.emotion_status.clone(),
        dynamics: CaptureDynamics {
            memory_strength: row.memory_strength.as_f64().unwrap(),
            half_life_days: row.half_life_days.as_f64().unwrap(),
            last_strengthened_at: row.last_strengthened_at.as_f64().unwrap(),
            last_dynamics_at: row.last_dynamics_at.as_f64().unwrap(),
            memory_class: row.memory_class.clone(),
            never_forget: row.never_forget.as_f64().unwrap(),
            core_memory_score: row.core_memory_score.as_f64().unwrap(),
            core_memory_reason: row.core_memory_reason.clone(),
        },
    }
}

#[test]
fn the_actual_worker_is_available_for_acceptance_to_lance_composition() {
    fn worker<T: accept::CaptureWorker>() {}
    worker::<pipeline::CapturePipeline>();
}

#[test]
fn actual_acceptance_to_lance_rows_equal_node_without_replaying_fixture_rows() {
    let golden: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/rows.json")).unwrap();
    let inputs: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/capture/scenarios/rows.json")).unwrap();
    let d125: serde_json::Value = serde_json::from_str(include_str!(
        "fixtures/capture/d125-no-jev-native-exceptions.json"
    ))
    .unwrap();
    assert_eq!(
        format!(
            "{:x}",
            Sha256::digest(include_bytes!("fixtures/capture/golden/rows.json"))
        ),
        d125["nodeRowsSha256"]
    );
    assert_eq!(
        format!(
            "{:x}",
            Sha256::digest(include_bytes!("fixtures/capture/golden/chunk-decider.json"))
        ),
        d125["nodeDeciderSha256"]
    );
    let mut scenarios = inputs.as_array().unwrap().clone();
    // Explicit D125 native variant: automatic without a composed model is the same
    // whole-plus-parts path as the unchanged recorded "beides" scenario.
    let mut no_model = scenarios
        .iter()
        .find(|s| s["name"] == d125["nativeNoModelReference"])
        .unwrap()
        .clone();
    no_model["config"]["captureChunkingMode"] = "automatisch".into();
    scenarios.push(no_model);
    for scenario in &scenarios {
        let expected = golden["recordings"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["name"] == scenario["name"])
            .unwrap();
        let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let workspace = directory.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let base = directory.path().join("stores");
        let mut config = scenario["config"].clone();
        config["baseDbPath"] = base.to_string_lossy().to_string().into();
        config["embedding"] =
            serde_json::json!({"provider":"local-transformers","local":{"dimensions":384}});
        config["autoCapture"] = true.into();
        config["autoRecall"] = false.into();
        let mut fixture_host = capture_pipeline_support::Host::new(
            directory.path().join("state"),
            workspace.clone(),
            serde_json::from_value(config).unwrap(),
        )
        .with_now(1_710_000_000_000);
        let llm_calls = Arc::new(AtomicUsize::new(0));
        if scenario["llm"] == true {
            let fixtures: serde_json::Value =
                serde_json::from_str(include_str!("fixtures/capture/llm/rows.json")).unwrap();
            fixture_host = fixture_host.with_llm(Arc::new(RecordedLlm(
                fixtures["scopes"][scenario["name"].as_str().unwrap()].clone(),
                llm_calls.clone(),
            )));
        }
        let secret_reads = Arc::new(CaptureSecrets(AtomicUsize::new(0)));
        fixture_host = fixture_host.with_secrets(secret_reads.clone());
        let egress_calls = fixture_host.egress_calls.clone();
        let host: Arc<dyn contract::HostServices> = Arc::new(fixture_host);
        let embedder: Arc<dyn embedding::EmbeddingProvider> = Arc::new(
            capture_pipeline_support::HashEmbedder::new(scenario["embedder"] == "flat"),
        );
        let stores = Arc::new(
            store::StorePool::open(
                &base,
                store::OpenMode::ReadWrite,
                Some(embedder.identity()),
                50,
            )
            .unwrap(),
        );
        let mut metadata = BTreeMap::new();
        for line in expected["rowLines"].as_array().unwrap() {
            let row: MemoryRow = serde_json::from_str(line.as_str().unwrap()).unwrap();
            metadata.insert(row.text.clone(), classification(&row));
        }
        let policy = Arc::new(shared_scope::WorkspaceCapturePolicy::new(base.clone()));
        if scenario["workspaceEnabled"] == false {
            std::fs::create_dir_all(base.join("control")).unwrap();
            let identity = format!(
                "workspace-dir:v1:{}",
                workspace.canonicalize().unwrap().display()
            );
            let state = serde_json::json!({"schemaVersion":1,"revision":1,"policies":{
                format!("capture-agent\0{identity}"):{"agentId":"capture-agent","workspaceIdentity":identity,"enabled":false,
                "revision":1,"updatedAt":1710000000000i64,"actorId":"capture-recorder"}}});
            std::fs::write(
                base.join("control/workspace-policy.json"),
                serde_json::to_vec(&state).unwrap(),
            )
            .unwrap();
        }
        let mut worker = pipeline::CapturePipeline::new(
            host.clone(),
            stores.clone(),
            embedder,
            Arc::new(ClassificationFixture(metadata)),
            policy,
        )
        .unwrap()
        .with_neo(Arc::new(NeoFixture));
        if scenario["choice"] == "coherent" {
            worker = worker.with_decider(Arc::new(WholeDecision));
        }
        let queue = Arc::new(
            queue::CaptureQueue::new(
                queue::RuntimeConfig::from_value(&serde_json::json!({})),
                Arc::new(queue::PressureSnapshot::disabled),
            )
            .unwrap(),
        );
        let replay = replay_guard::ReplayGuard::durable(
            base.join("_capture-turns"),
            Arc::new(|| 1_710_000_000_000),
        )
        .unwrap();
        let runtime = capture_pipeline_support::RuntimeGuard(
            accept::CaptureRuntime::new(host, Arc::new(worker), queue, replay, false).unwrap(),
        );
        let mut outcomes = Vec::new();
        for (index, messages) in scenario["turns"].as_array().unwrap().iter().enumerate() {
            let turn: TurnRecord = serde_json::from_value(serde_json::json!({"agentId":"capture-agent",
                "principal":{"agentId":"capture-agent","workspace":format!("workspace-dir:v1:{}", workspace.canonicalize().unwrap().display()),"channel":"telegram","accountId":"default","chat":{"id":"capture-chat","kind":"direct"},"trust":"proved"},
                "agent":{"origin":"user","background":false},"messages":messages,"runId":format!("capture-{index}"),
                "sessionKey":"capture-session","incognito":false})).unwrap();
            let options: CaptureOptions = serde_json::from_value(
                scenario
                    .get("options")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({})),
            )
            .unwrap();
            let receipt = runtime.0.accept(turn, options).unwrap();
            outcomes.push(
                result::result_json(&receipt.done.recv_timeout(Duration::from_secs(10)).unwrap())
                    .unwrap(),
            );
            if scenario["patchFirstRowAfterTurn"].as_u64() == Some(index as u64) {
                let store = stores.get("capture-agent").unwrap();
                let rows = store.scan(&store::RowFilter::default(), 1000).unwrap();
                let patch = store::RowPatch {
                    status: scenario["patch"]["status"].as_str().map(str::to_string),
                    epistemic_status: scenario["patch"]["epistemicStatus"]
                        .as_str()
                        .map(str::to_string),
                    ..store::RowPatch::default()
                };
                store.patch(&rows[0].id, &patch).unwrap();
            }
        }
        assert_eq!(
            secret_reads.0.load(Ordering::SeqCst),
            0,
            "D125: no Jev secret lookup"
        );
        assert_eq!(
            egress_calls.load(Ordering::SeqCst),
            0,
            "D125: no capture decision HTTP attempt"
        );
        assert_eq!(
            format!("[{}]", outcomes.join(",")),
            expected["outcomesJson"].as_str().unwrap(),
            "{} outcomes",
            scenario["name"]
        );
        if scenario["llm"] == true {
            assert_eq!(
                llm_calls.load(Ordering::SeqCst),
                expected["requestHashes"].as_array().unwrap().len(),
                "native summary cache bypass: {}",
                scenario["name"]
            );
        }
        let rows = if expected["rowLines"].as_array().unwrap().is_empty() {
            Vec::new()
        } else {
            stores
                .get("capture-agent")
                .unwrap()
                .scan(&store::RowFilter::default(), 1000)
                .unwrap()
        };
        let mut ids = HashMap::<String, String>::new();
        let mut actual_lines = Vec::new();
        for mut row in rows {
            let next = format!("volatile-id-{}", ids.len() + 1);
            row.id = ids.entry(row.id).or_insert(next).clone();
            if !row.chunk_group_id.is_empty() {
                let next = format!("volatile-id-{}", ids.len() + 1);
                row.chunk_group_id = ids.entry(row.chunk_group_id).or_insert(next).clone();
            }
            actual_lines.push(row_builder::to_node_json(&row).unwrap());
        }
        let expected_lines = expected["rowLines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|line| line.as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            actual_lines, expected_lines,
            "{} row bytes",
            scenario["name"]
        );
        assert!(runtime.0.close(Duration::from_secs(3)));
    }
}

const FIRST_TEXT: &str = "The release planning meeting takes place every Thursday morning.";
const SECOND_TEXT: &str = "The staging database uses a dedicated replica for backups.";
const OWN_ROW: &str = "11111111-1111-4111-8111-111111111111";
const OTHER_ROW: &str = "22222222-2222-4222-8222-222222222222";

struct BoundaryClassifier {
    root: std::path::PathBuf,
    phase: String,
    calls: AtomicUsize,
    effects: Arc<AtomicUsize>,
}
impl BoundaryClassifier {
    fn checkpoint(&self, phase: &str) {
        if self.phase == phase {
            std::fs::write(self.root.join("checkpoint"), phase).unwrap();
            loop {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}
impl CaptureClassifier for BoundaryClassifier {
    fn classify(
        &self,
        request: pipeline::ClassificationRequest<'_>,
    ) -> Result<CaptureClassification, EngineError> {
        let index = self.calls.fetch_add(1, Ordering::SeqCst);
        if self.phase == "expire-recovery" {
            assert!(request.cancel.remaining().is_some());
            while !request.cancel.is_cancelled() {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        if self.phase == "abort-after-first-row" && index == 1 {
            request.cancel.cancel();
        }
        self.checkpoint(if index == 0 {
            "after-plan"
        } else {
            "after-first-row"
        });
        if self.phase == "break-settlement" && index == 1 {
            let file = self.root.join("stores/_capture-turns/capture-agent.json");
            std::fs::remove_file(&file).unwrap();
            std::fs::create_dir(&file).unwrap();
        }
        Ok(classification(&row_builder::schema_defaults(vec![
            1.0;
            384
        ])))
    }
    fn post_store_recoverable(
        &self,
        turn: &TurnRecord,
        context: &context::RequestContext,
        rows: &[MemoryRow],
        _: &mut dyn pipeline::CapturePostStore,
        _: bool,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        self.post_store(turn, context, rows, cancel)
    }
    fn post_store(
        &self,
        _: &TurnRecord,
        _: &context::RequestContext,
        _: &[MemoryRow],
        _: &Cancel,
    ) -> Result<(), EngineError> {
        self.effects.fetch_add(1, Ordering::SeqCst);
        self.checkpoint("after-settle");
        // RE-D155: a deterministic refusal versus a failure that succeeds when repeated.
        if self.phase == "terminal-post" {
            return Err(EngineError::NotAvailable {
                reason: "speaker-media-authority-unavailable".into(),
            });
        }
        if self.phase == "transient-post-always" {
            return Err(contract::StoreError::Unavailable.into());
        }
        let marker = self.root.join("transient-failed");
        if self.phase == "transient-post-once" && !marker.exists() {
            std::fs::write(marker, b"").unwrap();
            return Err(contract::StoreError::Unavailable.into());
        }
        Ok(())
    }
}
struct BoundaryFixture {
    host: Arc<dyn contract::HostServices>,
    stores: Arc<store::StorePool>,
    worker: pipeline::CapturePipeline,
    replay: replay_guard::ReplayGuard,
    turn: TurnRecord,
    context: context::RequestContext,
    effects: Arc<AtomicUsize>,
    wal_root: std::path::PathBuf,
}
impl BoundaryFixture {
    fn new(root: &std::path::Path, phase: &str) -> Self {
        Self::configured(root, phase, serde_json::json!({}), None)
    }
    fn configured(
        root: &std::path::Path,
        phase: &str,
        extra: serde_json::Value,
        llm: Option<Arc<dyn contract::LlmPort>>,
    ) -> Self {
        let workspace = root.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let base = root.join("stores");
        let mut config = serde_json::json!({
            "baseDbPath":base,"embedding":{"provider":"local-transformers","local":{"dimensions":384}},
            "neo":{"enabled":false},"captureChunking":false,"duplicateThreshold":1.01,
        });
        let serde_json::Value::Object(extra) = extra else {
            unreachable!()
        };
        config.as_object_mut().unwrap().extend(extra);
        let mut host = capture_pipeline_support::Host::new(
            root.join("state"),
            workspace.clone(),
            serde_json::from_value(config).unwrap(),
        )
        .with_now(1_710_000_000_000);
        if let Some(llm) = llm {
            host = host.with_llm(llm);
        }
        let host: Arc<dyn contract::HostServices> = Arc::new(host);
        let embedder: Arc<dyn embedding::EmbeddingProvider> =
            Arc::new(capture_pipeline_support::HashEmbedder::new(false));
        let stores = Arc::new(
            store::StorePool::open(
                &base,
                store::OpenMode::ReadWrite,
                Some(embedder.identity()),
                50,
            )
            .unwrap(),
        );
        let effects = Arc::new(AtomicUsize::new(0));
        let worker = pipeline::CapturePipeline::new(
            host.clone(),
            stores.clone(),
            embedder,
            Arc::new(BoundaryClassifier {
                root: root.to_owned(),
                phase: phase.into(),
                calls: AtomicUsize::new(0),
                effects: effects.clone(),
            }),
            Arc::new(shared_scope::WorkspaceCapturePolicy::new(base.clone())),
        )
        .unwrap();
        let wal_root = base.join("_capture-turns");
        let replay =
            replay_guard::ReplayGuard::durable(wal_root.clone(), Arc::new(|| 1_710_000_000_000))
                .unwrap();
        let turn: TurnRecord = serde_json::from_value(serde_json::json!({"agentId":"capture-agent",
            "principal":{"agentId":"capture-agent","workspace":format!("workspace-dir:v1:{}", workspace.display()),
                "channel":"telegram","accountId":"default","chat":{"id":"capture-chat","kind":"direct"},"trust":"proved"},
            "agent":{"origin":"user","background":false},"messages":[{"role":"user","content":FIRST_TEXT},{"role":"user","content":SECOND_TEXT}],
            "runId":"capture-boundary","sessionKey":"capture-session","incognito":false})).unwrap();
        let context =
            context::RequestContext::build(&turn.principal, &turn.agent, host.as_ref()).unwrap();
        Self {
            host,
            stores,
            worker,
            replay,
            turn,
            context,
            effects,
            wal_root,
        }
    }
    fn run(&self) -> Result<contract::CaptureResult, EngineError> {
        use accept::CaptureWorker;
        self.replay.run(
            "capture-agent",
            &replay_guard::turn_key_of(&self.turn).unwrap(),
            &Cancel::never(),
            |rows| {
                self.worker.capture(
                    &self.turn,
                    &self.context,
                    &serde_json::from_value(serde_json::json!({})).unwrap(),
                    rows,
                    &Cancel::never(),
                )
            },
        )
    }
    fn rows(&self) -> Vec<MemoryRow> {
        self.stores
            .get("capture-agent")
            .unwrap()
            .scan(&store::RowFilter::default(), 100)
            .unwrap()
    }
    fn pending(&self, ids: &[String]) {
        use plur1bus_engine::capture::wal::{Admission, CaptureWal};
        let wal = CaptureWal::new(self.wal_root.clone(), Arc::new(|| 1_710_000_000_000)).unwrap();
        let Admission::Pending(ticket) = wal
            .begin(
                "capture-agent",
                &replay_guard::turn_key_of(&self.turn).unwrap(),
                &Cancel::never(),
            )
            .unwrap()
        else {
            unreachable!()
        };
        ticket.plan(ids, &Cancel::never()).unwrap();
    }
}
fn physical_temp() -> tempfile::TempDir {
    tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap()
}

#[test]
fn replay_refuses_foreign_changed_or_unattributable_rows_before_any_delete() {
    for kind in [
        "foreign-agent",
        "foreign-turn",
        "shared",
        "owner",
        "workspace",
        "missing-run",
    ] {
        let root = physical_temp();
        let mut fixture = BoundaryFixture::new(root.path(), "");
        let mut row = row_builder::schema_defaults(vec![1.0; 384]);
        row.id = OWN_ROW.into();
        row.stored_by = "capture-agent".into();
        row.source_turn_id = "capture-boundary".into();
        let mut other = row.clone();
        other.id = OTHER_ROW.into();
        match kind {
            "foreign-agent" => other.stored_by = "foreign".into(),
            "foreign-turn" => other.source_turn_id = "different-turn".into(),
            "shared" => other.scope = "user".into(),
            "owner" => other.owner_user_id = "different-owner".into(),
            "workspace" => other.workspace_id = "different-workspace".into(),
            "missing-run" => {
                fixture.turn.run_id = None;
                other.source_turn_id.clear();
                row.source_turn_id.clear();
            }
            _ => unreachable!(),
        }
        fixture
            .stores
            .get("capture-agent")
            .unwrap()
            .upsert(&[row, other])
            .unwrap();
        fixture.pending(&[OWN_ROW.into(), OTHER_ROW.into()]);
        let before = std::fs::read(fixture.wal_root.join("capture-agent.json")).unwrap();
        assert!(fixture.run().is_err(), "{kind}");
        assert_eq!(fixture.rows().len(), 2, "{kind}");
        assert_eq!(
            std::fs::read(fixture.wal_root.join("capture-agent.json")).unwrap(),
            before
        );
        assert_eq!(fixture.effects.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn failed_wal_plan_writes_no_rows_and_failed_settlement_runs_no_effects() {
    for phase in ["break-plan", "break-settlement"] {
        let root = physical_temp();
        let fixture = BoundaryFixture::new(root.path(), phase);
        if phase == "break-plan" {
            std::fs::create_dir_all(fixture.wal_root.join("capture-agent.json")).unwrap();
        }
        assert!(fixture.run().is_err());
        assert_eq!(
            fixture.rows().len(),
            if phase == "break-plan" { 0 } else { 2 }
        );
        assert_eq!(fixture.effects.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn committed_tombstone_skips_the_blocked_row_and_settles_the_turn() {
    use store::tombstone::{content_fingerprint, TombstoneRegistry};
    let root = physical_temp();
    let fixture = BoundaryFixture::new(root.path(), "");
    let registry = TombstoneRegistry::new(&root.path().join("stores"), "capture-agent").unwrap();
    let value = serde_json::json!({"schemaVersion":1,"memoryId":OWN_ROW,"agentId":"capture-agent",
        "scope":"agent-private","status":"committed","contentFingerprint":content_fingerprint(FIRST_TEXT)});
    registry
        .append(&text::json::parse_json(&value.to_string()).unwrap())
        .unwrap();
    let outcome = serde_json::to_value(fixture.run().unwrap()).unwrap();
    assert_eq!(outcome, serde_json::json!({"stored":1,"skipped":1}));
    assert_eq!(fixture.rows()[0].text, SECOND_TEXT);
    let repeated = serde_json::to_value(fixture.run().unwrap()).unwrap();
    assert_eq!(repeated["reason"], "duplicate-turn");
    assert_eq!(fixture.rows().len(), 1);
}

#[test]
fn pipeline_crash_child() {
    let Ok(root) = std::env::var("PLUR1BUS_RX_CAPTURE_CRASH_ROOT") else {
        return;
    };
    let phase = std::env::var("PLUR1BUS_RX_CAPTURE_CRASH_PHASE").unwrap();
    let extra = if std::env::var_os("PLUR1BUS_RX_CAPTURE_SHORT_DEADLINE").is_some() {
        serde_json::json!({"runtime":{"captureTimeoutMs":20}})
    } else {
        serde_json::json!({})
    };
    let mut fixture = BoundaryFixture::configured(std::path::Path::new(&root), &phase, extra, None);
    if std::env::var_os("PLUR1BUS_RX_CAPTURE_WITHOUT_RUN").is_some() {
        fixture.turn.run_id = None;
    }
    fixture.run().unwrap();
}

#[test]
fn actual_lance_rows_and_wal_recover_after_process_kill_at_three_commit_boundaries() {
    struct Child(std::process::Child);
    impl Drop for Child {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    for phase in ["after-plan", "after-first-row", "after-settle"] {
        let root = physical_temp();
        let mut child = Child(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    std::any::type_name_of_val(&pipeline_crash_child)
                        .split_once("::")
                        .map_or("", |(_, name)| name),
                    "--nocapture",
                ])
                .env("PLUR1BUS_RX_CAPTURE_CRASH_ROOT", root.path())
                .env("PLUR1BUS_RX_CAPTURE_CRASH_PHASE", phase)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        );
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while !root.path().join("checkpoint").exists() {
            assert!(child.0.try_wait().unwrap().is_none(), "{phase}");
            assert!(std::time::Instant::now() < deadline, "{phase}");
            std::thread::sleep(Duration::from_millis(10));
        }
        child.0.kill().unwrap();
        let status = child.0.wait().unwrap();
        assert!(!status.success());
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            assert_eq!(status.signal(), Some(libc::SIGKILL));
        }
        let fixture = BoundaryFixture::new(root.path(), "");
        let before = fixture.rows();
        assert_eq!(
            before.len(),
            match phase {
                "after-plan" => 0,
                "after-first-row" => 1,
                _ => 2,
            }
        );
        let result = serde_json::to_value(fixture.run().unwrap()).unwrap();
        assert_eq!(
            result["stored"],
            if phase == "after-settle" { 0 } else { 2 }
        );
        let after = fixture.rows();
        assert_eq!(after.len(), 2);
        assert!(after.iter().any(|row| row.text == FIRST_TEXT));
        assert!(after.iter().any(|row| row.text == SECOND_TEXT));
        if phase == "after-first-row" {
            assert!(after.iter().all(|row| row.id != before[0].id));
        }
        if phase == "after-settle" {
            assert_eq!(
                after.iter().map(|r| &r.id).collect::<Vec<_>>(),
                before.iter().map(|r| &r.id).collect::<Vec<_>>()
            );
        }
        assert_eq!(
            serde_json::to_value(fixture.run().unwrap()).unwrap()["reason"],
            "duplicate-turn"
        );
    }
}

struct BoundaryLlm {
    node_messages_json: String,
    calls: Arc<AtomicUsize>,
}
impl contract::LlmPort for BoundaryLlm {
    fn complete(
        &self,
        params: contract::LlmParams,
        _: &Cancel,
    ) -> Result<contract::LlmResult, contract::HostError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let safe: serde_json::Value =
            serde_json::from_str(&self.node_messages_json.replace("\\ud83d", "")).unwrap();
        assert_eq!(params.messages[0].content, safe[0]["content"]);
        assert_eq!(params.max_tokens.unwrap().as_u64(), Some(11));
        Ok(contract::LlmResult {
            text: "A synthetic summary with sufficient length.".into(),
            model: None,
            usage: None,
        })
    }
}

#[test]
fn capture_external_unicode_obeys_f3_while_original_node_boundaries_remain_evidence() {
    let golden: serde_json::Value = serde_json::from_str(include_str!(
        "fixtures/capture/golden/pipeline-boundaries.json"
    ))
    .unwrap();
    for case in golden["ownership"].as_array().unwrap() {
        assert_eq!(case["deleted"], serde_json::json!([OWN_ROW]));
        assert_eq!(
            case["rustException"],
            "refuse-without-deletion-or-wal-replacement"
        );
    }
    for case in golden["unicode"].as_array().unwrap() {
        let kind = case["kind"].as_str().unwrap();
        let root = physical_temp();
        let calls = Arc::new(AtomicUsize::new(0));
        let llm = (kind == "prompt-cut").then(|| {
            Arc::new(BoundaryLlm {
                node_messages_json: case["messagesJson"].as_str().unwrap().into(),
                calls: calls.clone(),
            }) as Arc<dyn contract::LlmPort>
        });
        let max_chars = if matches!(kind, "row-cut" | "prompt-cut") {
            32
        } else {
            15_000
        };
        let mut fixture = BoundaryFixture::configured(
            root.path(),
            "",
            serde_json::json!({
                "captureMaxChars":max_chars,"merging":{"enabled":kind == "prompt-cut"},
            }),
            llm,
        );
        let input = case["input"].as_str().unwrap();
        fixture.turn.messages.truncate(1);
        fixture.turn.messages[0].content = input.into();
        assert_eq!(
            serde_json::to_value(fixture.run().unwrap()).unwrap(),
            case["result"]
        );
        let rows = fixture.rows();
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        for (field, actual) in [
            ("text", &row.text),
            ("evidenceQuote", &row.evidence_quote),
            ("sourceUrl", &row.source_url),
        ] {
            let node = case["row"][field].as_str().unwrap();
            // These recorded inputs contain no replacement characters: only the exact
            // dangling budget unit emitted by Node's Lance boundary may differ.
            let cut = matches!(
                (kind, field),
                ("row-cut", "text") | ("quote-cut", "evidenceQuote") | ("url-cut", "sourceUrl")
            );
            if cut {
                assert!(node.ends_with('\u{fffd}'));
            }
            assert_eq!(
                actual,
                if cut {
                    node.strip_suffix('\u{fffd}').unwrap()
                } else {
                    node
                },
                "{kind} {field}"
            );
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            usize::from(kind == "prompt-cut")
        );
        if kind == "prompt-cut" {
            // The hash/reference projection still carries Node's unpaired high unit.
            assert_eq!(
                pipeline::HostCaptureSummary::messages_json(&JsString::from(input), max_chars),
                case["messagesJson"]
            );
        }
    }
}

#[path = "support/capture_open_recovery.rs"]
mod open_recovery;

struct CaptureSecrets(AtomicUsize);
impl contract::SecretPort for CaptureSecrets {
    fn get(&self, _: &str) -> Result<Option<contract::SecretValue>, contract::HostError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(Some(contract::SecretValue::new("synthetic-capture-choice")))
    }
}
#[test]
fn d125_automatic_capture_never_resolves_a_jev_secret() {
    let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let workspace = directory.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let base = directory.path().join("stores");
    let secret = Arc::new(CaptureSecrets(AtomicUsize::new(0)));
    let config = serde_json::from_value(serde_json::json!({
        "baseDbPath":base,"captureChunking":true,"captureChunkingMode":"automatisch",
        "captureChunkingJev":{"apiKeyEnv":"SYNTHETIC_CAPTURE_CHOICE"},
        "embedding":{"provider":"local-transformers","local":{"dimensions":384}}
    }))
    .unwrap();
    let host = Arc::new(
        capture_pipeline_support::Host::new(directory.path().join("state"), workspace, config)
            .with_secrets(secret.clone()),
    );
    let embedder: Arc<dyn embedding::EmbeddingProvider> =
        Arc::new(capture_pipeline_support::HashEmbedder::new(false));
    let stores = Arc::new(
        store::StorePool::open(
            &base,
            store::OpenMode::ReadWrite,
            Some(embedder.identity()),
            50,
        )
        .unwrap(),
    );
    let _worker = pipeline::CapturePipeline::new(
        host,
        stores,
        embedder,
        Arc::new(ClassificationFixture(BTreeMap::new())),
        Arc::new(shared_scope::WorkspaceCapturePolicy::new(base)),
    )
    .unwrap();
    assert_eq!(
        secret.0.load(Ordering::SeqCst),
        0,
        "D125 forbids constructing the Jev content decision route"
    );
}
