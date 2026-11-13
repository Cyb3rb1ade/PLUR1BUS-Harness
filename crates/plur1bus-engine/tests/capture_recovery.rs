//! Original native classifier/reminder effects survive process death without host redelivery.
#![allow(clippy::unwrap_used, clippy::panic, reason = "integration assertions")]
#[allow(dead_code)]
mod capture_pipeline_support;
use plur1bus_engine::{
    capture::{
        accept::{CaptureRuntime, CaptureWorker},
        classify::{CaptureEmotionRoutes, NativeCaptureClassifier},
        emotion_pool::EmotionalPool,
        pipeline::{
            CaptureClassification, CaptureClassifier, CapturePipeline, CapturePostStore,
            ClassificationRequest, ReminderEffect,
        },
        queue::{CaptureQueue, PressureSnapshot, RuntimeConfig},
        reminder_store::ReminderStore,
        replay_guard::{turn_key_of, ReplayGuard},
        shared_scope::WorkspaceCapturePolicy,
    },
    config,
    context::{harness_user_principal, RequestContext},
    contract::{Cancel, EngineError, HostServices, LlmPort, MemoryRow, TurnRecord},
    embedding::EmbeddingProvider,
    store::{OpenMode, RowFilter, StorePool},
};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
const NOW: i64 = 1_710_000_000_000;
const TEXT: &str = "Bitte Testbericht in 2 Minuten prüfen.";
struct Routes;
impl CaptureEmotionRoutes for Routes {
    fn bind(&self, _: &TurnRecord, _: &Cancel) -> Result<Option<Arc<dyn LlmPort>>, EngineError> {
        Ok(None)
    }
}
fn stop(root: &Path, phase: &str, wanted: &str) {
    if phase == wanted {
        std::fs::write(root.join("checkpoint"), phase).unwrap();
        loop {
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
struct Classified {
    inner: NativeCaptureClassifier,
    root: PathBuf,
    phase: String,
}
struct Journal<'a> {
    inner: &'a mut dyn CapturePostStore,
    root: &'a Path,
    phase: &'a str,
}
impl CapturePostStore for Journal<'_> {
    fn reference_time(&self) -> i64 {
        self.inner.reference_time()
    }
    fn reminder(&self, position: usize) -> Option<ReminderEffect> {
        self.inner.reminder(position)
    }
    fn plan_reminder(
        &mut self,
        position: usize,
        effect: ReminderEffect,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        self.inner.plan_reminder(position, effect, cancel)?;
        stop(self.root, self.phase, "reminder-plan");
        Ok(())
    }
    fn check(&self, cancel: &Cancel) -> Result<(), EngineError> {
        self.inner.check(cancel)
    }
}
impl CaptureClassifier for Classified {
    fn classify(&self, r: ClassificationRequest<'_>) -> Result<CaptureClassification, EngineError> {
        self.inner.classify(r)
    }
    fn post_store(
        &self,
        t: &TurnRecord,
        c: &RequestContext,
        r: &[MemoryRow],
        x: &Cancel,
    ) -> Result<(), EngineError> {
        self.inner.post_store(t, c, r, x)
    }
    fn post_store_recoverable(
        &self,
        t: &TurnRecord,
        c: &RequestContext,
        r: &[MemoryRow],
        j: &mut dyn CapturePostStore,
        resuming: bool,
        x: &Cancel,
    ) -> Result<(), EngineError> {
        self.inner.post_store_recoverable(
            t,
            c,
            r,
            &mut Journal {
                inner: j,
                root: &self.root,
                phase: &self.phase,
            },
            resuming,
            x,
        )?;
        stop(&self.root, &self.phase, "reminder-row");
        Ok(())
    }
}
struct Rig {
    host: Arc<dyn HostServices>,
    stores: Arc<StorePool>,
    worker: CapturePipeline,
    replay: ReplayGuard,
    turn: TurnRecord,
}
impl Rig {
    fn new(root: &Path, phase: &str, now: i64) -> Self {
        let workspace = root.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let base = root.join("stores");
        let cfg = serde_json::json!({"baseDbPath":base,"embedding":{"provider":"local-transformers","local":{"dimensions":384}},"neo":{"enabled":false},"captureChunking":false,"duplicateThreshold":1.01,"emotion":{"t3":{"enabled":false}}});
        let host: Arc<dyn HostServices> = Arc::new(
            capture_pipeline_support::Host::new(
                root.join("state"),
                workspace.clone(),
                serde_json::from_value(cfg.clone()).unwrap(),
            )
            .with_now(now),
        );
        let embedder: Arc<dyn EmbeddingProvider> =
            Arc::new(capture_pipeline_support::HashEmbedder::new(false));
        let stores = Arc::new(
            StorePool::open(&base, OpenMode::ReadWrite, Some(embedder.identity()), 8).unwrap(),
        );
        let mood = Arc::new(EmotionalPool::new(
            host.clone(),
            config::effective_config(&cfg).unwrap()["emotion"].clone(),
        ));
        let reminders = Arc::new(ReminderStore::new(
            host.clone(),
            stores.clone(),
            embedder.clone(),
        ));
        let classifier = Classified {
            inner: NativeCaptureClassifier::new(host.clone(), Arc::new(Routes), mood, reminders)
                .unwrap(),
            root: root.to_owned(),
            phase: phase.into(),
        };
        let worker = CapturePipeline::new(
            host.clone(),
            stores.clone(),
            embedder,
            Arc::new(classifier),
            Arc::new(WorkspaceCapturePolicy::new(base.clone())),
        )
        .unwrap();
        let replay =
            ReplayGuard::durable(base.join("_capture-turns"), Arc::new(move || now)).unwrap();
        let turn=serde_json::from_value(serde_json::json!({"agentId":"agent","principal":{"agentId":"agent","workspace":format!("workspace-dir:v1:{}",workspace.display()),"user":harness_user_principal("fixture-owner"),"channel":"telegram","accountId":"fixture","chat":{"id":"original-chat","kind":"direct"},"trust":"proved"},"agent":{"origin":"user","background":false},"messages":[{"role":"user","content":TEXT}],"runId":"original-turn","sessionKey":"original-session","incognito":false})).unwrap();
        Self {
            host,
            stores,
            worker,
            replay,
            turn,
        }
    }
    fn run(&self) {
        let ctx = RequestContext::build(&self.turn.principal, &self.turn.agent, self.host.as_ref())
            .unwrap();
        self.replay
            .run(
                "agent",
                &turn_key_of(&self.turn).unwrap(),
                &Cancel::never(),
                |rows| {
                    self.worker.capture(
                        &self.turn,
                        &ctx,
                        &serde_json::from_value(serde_json::json!({})).unwrap(),
                        rows,
                        &Cancel::never(),
                    )
                },
            )
            .unwrap();
    }
}
#[test]
fn native_reminder_child() {
    let Ok(root) = std::env::var("PLUR1BUS_RX_NATIVE_REMINDER_ROOT") else {
        return;
    };
    let phase = std::env::var("PLUR1BUS_RX_NATIVE_REMINDER_PHASE").unwrap();
    Rig::new(Path::new(&root), &phase, NOW).run();
}
struct Child(std::process::Child);
impl Drop for Child {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[test]
fn actual_native_post_store_recovers_after_sigkill_with_original_time_id_and_terminal_state() {
    for (phase, terminal) in [
        ("reminder-plan", "scheduled"),
        ("reminder-row", "scheduled"),
        ("reminder-row", "acknowledged"),
        ("reminder-row", "cancelled"),
    ] {
        let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let mut child = Child(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    std::any::type_name_of_val(&native_reminder_child)
                        .split_once("::")
                        .map_or("", |(_, name)| name),
                    "--nocapture",
                ])
                .env("PLUR1BUS_RX_NATIVE_REMINDER_ROOT", root.path())
                .env("PLUR1BUS_RX_NATIVE_REMINDER_PHASE", phase)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        );
        let end = Instant::now() + Duration::from_secs(20);
        while !root.path().join("checkpoint").exists() {
            assert!(child.0.try_wait().unwrap().is_none(), "{phase}");
            assert!(Instant::now() < end);
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
        // RE-D162: a record lives in its owner scope's directory.
        let plan = std::fs::read_dir(root.path().join("stores/_capture-admissions"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.is_dir() && !p.ends_with(".leases"))
            .flat_map(|scope| std::fs::read_dir(scope).unwrap())
            .map(|e| e.unwrap().path())
            .find(|p| p.extension().is_some_and(|x| x == "json"))
            .unwrap();
        let payload: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&plan).unwrap()).unwrap();
        let expected = &payload["record"]["reminders"]["0"]["row"];
        let rig = Rig::new(root.path(), "", NOW + 3_600_000);
        let stores = rig.stores.clone();
        let store = stores.get("agent").unwrap();
        if phase == "reminder-row" {
            let mut row = store
                .get(expected["id"].as_str().unwrap())
                .unwrap()
                .unwrap();
            row.reminder_status = terminal.into();
            if terminal == "acknowledged" {
                row.acknowledged_at = (NOW + 1000).into();
            }
            if terminal == "cancelled" {
                row.cancelled_at = (NOW + 1000).into();
            }
            store.upsert(&[row]).unwrap();
        }
        let queue = Arc::new(
            CaptureQueue::new(
                RuntimeConfig::default(),
                Arc::new(PressureSnapshot::disabled),
            )
            .unwrap(),
        );
        let runtime = capture_pipeline_support::RuntimeGuard(
            CaptureRuntime::new(rig.host, Arc::new(rig.worker), queue, rig.replay, false).unwrap(),
        );
        let rows = store.scan(&RowFilter::default(), 20).unwrap();
        assert_eq!(rows.len(), 2, "{phase}/{terminal}");
        let reminder = rows.iter().find(|r| r.memory_kind == "reminder").unwrap();
        assert_eq!(reminder.id, expected["id"].as_str().unwrap());
        assert_eq!(reminder.remind_at.as_f64(), Some((NOW + 120_000) as f64));
        assert_eq!(reminder.reminder_status, terminal);
        // RE-D159: the completed admission is removed, not rewritten.
        assert!(!plan.exists(), "{phase}/{terminal}");
        assert!(runtime.0.close(Duration::from_secs(5)));
    }
}
