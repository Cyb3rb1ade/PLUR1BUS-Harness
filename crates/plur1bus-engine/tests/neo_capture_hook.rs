//! Real CaptureRuntime/classifier/Lance/Neo composition with offline host boundaries.
#![allow(clippy::unwrap_used, reason = "integration fixture assertions")]
#[allow(dead_code, reason = "shared offline host and embedding fixtures")]
mod capture_pipeline_support;
use plur1bus_engine::{
    capture::{
        accept::CaptureRuntime,
        classify::{CaptureEmotionRoutes, NativeCaptureClassifier},
        emotion_pool::EmotionalPool,
        pipeline::CapturePipeline,
        queue::{CaptureQueue, PressureSnapshot, RuntimeConfig},
        reminder_store::ReminderStore,
        replay_guard::ReplayGuard,
        shared_scope::WorkspaceCapturePolicy,
    },
    context::{harness_user_principal, RequestContext},
    contract::{Cancel, EngineError, HostServices, LlmPort, TurnRecord},
    embedding::EmbeddingProvider,
    neo::{capture_hook::NativeNeoCaptureHook, merged::Layout, session_store::SessionStore},
    store::{OpenMode, RowFilter, StorePool},
    text::js::JsString,
};
use serde_json::{json, Value};
use std::{fs, sync::Arc, time::Duration};
struct NoModel;
impl CaptureEmotionRoutes for NoModel {
    fn bind(
        &self,
        _: &TurnRecord,
        cancel: &Cancel,
    ) -> Result<Option<Arc<dyn LlmPort>>, EngineError> {
        cancel.check()?;
        Ok(None)
    }
}
#[test]
fn actual_capture_hook_publishes_private_sources_episodes_and_session_checkpoint() {
    for (enabled, background, deferred) in [
        (true, false, false),
        (false, false, false),
        (true, true, false),
        (true, false, true),
    ] {
        let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let workspace = root.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let neo = root.path().join("neo");
        fs::create_dir(&neo).unwrap();
        let base = root.path().join("stores");
        let config = json!({"baseDbPath":base,"embedding":{"provider":"local-transformers","local":{"dimensions":384}},
            "autoCapture":true,"autoRecall":false,"captureChunking":false,"duplicateThreshold":1.01,
            "neo":{"enabled":enabled},"metaCognition":{"enabled":false},"merging":{"enabled":false},
            "runtime":{"llmResultCacheEnabled":false,"llmResultCachePersist":false}});
        let host: Arc<dyn HostServices> = Arc::new(capture_pipeline_support::Host::new(
            root.path().join("state"),
            workspace.clone(),
            serde_json::from_value(config).unwrap(),
        ));
        let embedder: Arc<dyn EmbeddingProvider> =
            Arc::new(capture_pipeline_support::HashEmbedder::new(false));
        let stores = Arc::new(
            StorePool::open(&base, OpenMode::ReadWrite, Some(embedder.identity()), 50).unwrap(),
        );
        let mood = Arc::new(EmotionalPool::new(host.clone(), json!({})));
        let reminders = Arc::new(ReminderStore::new(
            host.clone(),
            stores.clone(),
            embedder.clone(),
        ));
        let classifier = Arc::new(
            NativeCaptureClassifier::new(host.clone(), Arc::new(NoModel), mood.clone(), reminders)
                .unwrap(),
        );
        let policy = Arc::new(WorkspaceCapturePolicy::new(base.clone()));
        let hook =
            Arc::new(NativeNeoCaptureHook::open(&neo, host.clone(), policy.clone(), mood).unwrap());
        let worker =
            CapturePipeline::new(host.clone(), stores.clone(), embedder, classifier, policy)
                .unwrap()
                .with_neo(hook);
        let queue = Arc::new(
            CaptureQueue::new(
                RuntimeConfig::from_value(&json!({})),
                Arc::new(PressureSnapshot::disabled),
            )
            .unwrap(),
        );
        let replay =
            ReplayGuard::durable(base.join("_capture-turns"), Arc::new(|| 1_710_000_000_000))
                .unwrap();
        let runtime = capture_pipeline_support::RuntimeGuard(
            CaptureRuntime::new(host.clone(), Arc::new(worker), queue, replay, false).unwrap(),
        );
        let make_turn = |count: usize| -> TurnRecord {
            let mut value = json!({"agentId":"alpha",
            "principal":{"agentId":"alpha","workspace":format!("workspace-dir:v1:{}",workspace.display()),
                "user":harness_user_principal("fixture-user"),"channel":"telegram","accountId":"fixture",
                "chat":{"id":"fixture-chat","kind":"direct"},"trust":"proved"},
            "agent":{"origin":"user","background":background},"runId":format!("run-{count}"),"sessionKey":"fixture-session",
            "incognito":false,"messages":[
                {"role":"user","content":"The release planning meeting takes place every Thursday morning."},
                {"role":"assistant","content":"The team records technical decisions in the project documentation."},
                {"role":"user","content":"Every new service requires a documented recovery procedure."},
                {"role":"assistant","content":"The project review covers the latest development milestones."},
                {"role":"user","content":"The next release includes offline migration tests for the local database."}
            ]});
            value["messages"].as_array_mut().unwrap().truncate(count);
            serde_json::from_value(value).unwrap()
        };
        for count in [3, 5] {
            let receipt = runtime
                .0
                .accept(
                    make_turn(count),
                    serde_json::from_value(json!({"deferPostTurnLlm":deferred})).unwrap(),
                )
                .unwrap();
            let result =
                serde_json::to_value(receipt.done.recv_timeout(Duration::from_secs(20)).unwrap())
                    .unwrap();
            assert!(result["stored"].as_u64().unwrap() > 0, "{result}");
            if deferred {
                assert_eq!(
                    result["diagnostics"][0]["reason"],
                    "post-turn-refine-unscheduled"
                );
            }
        }
        let turn = make_turn(5);
        let context = RequestContext::build(&turn.principal, &turn.agent, host.as_ref()).unwrap();
        let directory = neo
            .join("workspaces")
            .join(Layout::for_key(&context.workspace_key).canonical);
        let state = SessionStore::open(&neo, host).unwrap();
        assert_eq!(
            state
                .read(
                    &turn.principal,
                    &turn.agent,
                    &JsString::from("fixture-session"),
                    &Cancel::never()
                )
                .unwrap()
                .count,
            5.
        );
        assert!(!stores
            .get("alpha")
            .unwrap()
            .scan(&RowFilter::default(), 100)
            .unwrap()
            .is_empty());
        if enabled && !background {
            let rows: Vec<Value> = fs::read_to_string(directory.join("episodes.jsonl"))
                .unwrap()
                .lines()
                .map(|s| serde_json::from_str(s).unwrap())
                .collect();
            assert_eq!(rows.len(), 2);
            assert_eq!(rows[0]["id"], rows[1]["id"]);
            assert_eq!(rows[1]["revision"], 1);
            assert_eq!(rows[1]["memoryIds"].as_array().unwrap().len(), 5);
            assert_eq!(rows[1]["ownerUserId"], context.owner_user_id);
            assert_eq!(rows[1]["scope"], "agent_private");
        } else {
            assert!(!directory.join("episodes.jsonl").exists());
        }
        assert_eq!(directory.join("turn-journal.jsonl").exists(), enabled);
    }
}
