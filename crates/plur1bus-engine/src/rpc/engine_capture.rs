//! Capture over the process writer pool, the shared mood and the RE-05 runtime (RE-D154).
//!
//! The runtime is composed once, lazily, behind the S5 startup check. Its construction
//! recovers durable admissions, the capture WAL and prepared Neo plans before the first
//! new turn is accepted. Node assembler behavior the library does not provide stays absent.

use super::{engine_warm, ProcessEngine};
use crate::{
    capture::{
        accept::CaptureRuntime,
        classify::{CaptureEmotionRoutes, NativeCaptureClassifier},
        pipeline::{CapturePipeline, NeoCaptureHook},
        queue::{CaptureQueue, PressureSnapshot, RuntimeConfig},
        reminder_store::ReminderStore,
        replay_guard::ReplayGuard,
        shared_scope::{CapturePolicy, WorkspaceCapturePolicy},
    },
    context::{is_user_principal, RequestContext},
    contract::{
        Cancel, CaptureHandle, CaptureOptions, EngineError, HostError, HostServices, LlmParams,
        LlmPort, LlmResult, TurnRecord,
    },
    neo::capture_hook::NativeNeoCaptureHook,
    ops::reembedding::state::MigrationStateStore,
};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, PoisonError,
    },
    time::Duration,
};

/// The pin's close budget when the caller supplies none (`closeEngine`).
const DEFAULT_CLOSE_BUDGET: Duration = Duration::from_secs(30);

#[derive(Default)]
struct State {
    runtime: Option<Arc<CaptureRuntime>>,
    closed: bool,
}

/// The process's single capture runtime and whether its startup recovery last failed.
#[derive(Default)]
pub(super) struct ProcessCapture {
    state: Mutex<State>,
    recovery_failed: AtomicBool,
}

impl ProcessCapture {
    /// True after a composition attempt failed and no runtime has been composed since.
    pub(super) fn recovery_failed(&self) -> bool {
        self.recovery_failed.load(Ordering::Acquire)
    }

    /// Compose the runtime once (recovery before admission), then return a receipt.
    pub(super) fn accept(
        engine: &ProcessEngine,
        base: &Path,
        turn: TurnRecord,
        options: CaptureOptions,
    ) -> Result<CaptureHandle, EngineError> {
        Self::runtime(engine, base)?.accept(turn, options)
    }

    /// Compose (and thereby recover) the runtime without accepting a turn; idempotent.
    pub(super) fn open(engine: &ProcessEngine, base: &Path) -> Result<(), EngineError> {
        Self::runtime(engine, base).map(|_| ())
    }

    fn runtime(engine: &ProcessEngine, base: &Path) -> Result<Arc<CaptureRuntime>, EngineError> {
        let this = &engine.capture;
        // The lock is held through composition: concurrent first captures wait for one recovery.
        let mut state = this.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.closed {
            return Err(EngineError::NotAvailable {
                reason: "closed".into(),
            });
        }
        if let Some(runtime) = &state.runtime {
            return Ok(runtime.clone());
        }
        match compose(engine, base) {
            Ok(runtime) => {
                let runtime = Arc::new(runtime);
                state.runtime = Some(runtime.clone());
                this.recovery_failed.store(false, Ordering::Release);
                Ok(runtime)
            }
            Err(error) => {
                this.recovery_failed.store(true, Ordering::Release);
                log::warn!("capture: startup composition incomplete");
                Err(match error {
                    error @ (EngineError::Cancelled(_)
                    | EngineError::NotAvailable { .. }
                    | EngineError::Invalid { .. }) => error,
                    _ => EngineError::NotAvailable {
                        reason: "startup-recovery-incomplete".into(),
                    },
                })
            }
        }
    }

    /// Refuse new turns and drain admitted capture work within the caller's budget.
    pub(super) fn close(&self, budget: Option<Duration>) {
        let runtime = {
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            state.closed = true;
            state.runtime.take()
        };
        if let Some(runtime) = runtime {
            let budget = budget
                .filter(|budget| !budget.is_zero())
                .unwrap_or(DEFAULT_CLOSE_BUDGET);
            if !runtime.close(budget) {
                log::warn!("capture: close budget exceeded; work still settling");
            }
        }
    }
}

fn compose(engine: &ProcessEngine, base: &Path) -> Result<CaptureRuntime, EngineError> {
    let host = engine.operations.host_handle();
    let raw = serde_json::to_value(host.config()).map_err(|_| super::composition_invalid())?;
    let config = crate::config::effective_config(&raw).map_err(|_| super::composition_invalid())?;
    // S5 tombstone reconciliation and the one active writer route shared with forget/import.
    let pools = engine.live_stores.recall_pools()?;
    let writer = pools.writer_pool();
    let embedder = engine.embedding.pipeline_embedder();
    let switching_base = base.to_path_buf();
    let policy: Arc<dyn CapturePolicy> = Arc::new(
        WorkspaceCapturePolicy::new(base.to_path_buf()).with_maintenance(Arc::new(move || {
            // An unreadable migration state is a switching store: fail closed.
            MigrationStateStore::new(&switching_base)
                .and_then(|store| store.switching())
                .unwrap_or(true)
        })),
    );
    let mood = engine.mood.pool();
    let reminders = Arc::new(ReminderStore::new(
        host.clone(),
        writer.clone(),
        embedder.clone(),
    ));
    let classifier = Arc::new(
        NativeCaptureClassifier::new(
            host.clone(),
            Arc::new(HostEmotionRoute(host.clone())),
            mood.clone(),
            reminders,
        )?
        .with_engines(engine.mood.engines()),
    );
    // Recovers prepared Neo capture/episode plans before any admission. The pin creates
    // the Neo root recursively on its first write; the native hook pins an existing one.
    let neo_root = engine_warm::neo_root(&raw["neo"], base);
    crate::store::paths::secure_dir(&neo_root)?;
    let neo = Arc::new(UserScopedNeo(
        NativeNeoCaptureHook::open(&neo_root, host.clone(), policy.clone(), mood)?
            .with_embedder(embedder.clone())?,
    ));
    let pipeline =
        CapturePipeline::new(host.clone(), writer, embedder, classifier, policy)?.with_neo(neo);
    let queue = Arc::new(CaptureQueue::new(
        RuntimeConfig::from_value(&config["runtime"]),
        // No process sampler is composed; the pin's disabled gate value.
        Arc::new(PressureSnapshot::disabled),
    )?);
    let clock = host.clone();
    let replay = ReplayGuard::durable(turns_root(base), Arc::new(move || clock.now_ms()))?;
    // `scheduled = false`: no post-turn-refine job runs in RX; deferral falls back inline.
    CaptureRuntime::new(host, Arc::new(pipeline), queue, replay, false)
}

/// The pin's `<baseDbPath>/_capture-turns` replay root.
fn turns_root(base: &Path) -> PathBuf {
    base.join("_capture-turns")
}

/// The native Neo journal binds only user-owned callers (`CaptureJournal::bind`). For any
/// other owner it has no partition to write, so the hook has nothing to do: reporting that
/// as a failure would leave the admission pending and every restart's recovery refusing.
struct UserScopedNeo(NativeNeoCaptureHook);
impl UserScopedNeo {
    fn applies(context: &RequestContext) -> bool {
        is_user_principal(&context.owner_user_id)
    }
}
impl NeoCaptureHook for UserScopedNeo {
    fn record_turn(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        if !Self::applies(context) {
            return Ok(());
        }
        self.0.record_turn(turn, context, cancel)
    }
    fn post_store(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        options: &CaptureOptions,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        if !Self::applies(context) {
            return Ok(());
        }
        self.0.post_store(turn, context, options, cancel)
    }
    fn post_store_recoverable(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        options: &CaptureOptions,
        resuming: bool,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        if !Self::applies(context) {
            return Ok(());
        }
        self.0
            .post_store_recoverable(turn, context, options, resuming, cancel)
    }
    fn after_capture(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        if !Self::applies(context) {
            return Ok(());
        }
        self.0.after_capture(turn, context, cancel)
    }
}

/// Tier-3 emotion through the host's guarded completion port, when the host has one.
/// Effective config keeps tier 3 off unless enabled; deferred mode makes no call at capture.
struct HostEmotionRoute(Arc<dyn HostServices>);
impl CaptureEmotionRoutes for HostEmotionRoute {
    fn bind(
        &self,
        _turn: &TurnRecord,
        cancel: &Cancel,
    ) -> Result<Option<Arc<dyn LlmPort>>, EngineError> {
        cancel.check()?;
        Ok(self
            .0
            .llm()
            .is_some()
            .then(|| Arc::new(HostCompletion(self.0.clone())) as Arc<dyn LlmPort>))
    }
}

struct HostCompletion(Arc<dyn HostServices>);
impl LlmPort for HostCompletion {
    fn complete(&self, params: LlmParams, cancel: &Cancel) -> Result<LlmResult, HostError> {
        self.0
            .llm()
            .ok_or(HostError::Unavailable)?
            .complete(params, cancel)
    }
}
