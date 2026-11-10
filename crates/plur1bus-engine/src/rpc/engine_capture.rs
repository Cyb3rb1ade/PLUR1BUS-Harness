//! Capture over the process writer pool, the shared mood and the RE-05 runtime (RE-D154).
//!
//! The runtime is composed once, lazily, behind the S5 startup check. Its construction
//! recovers durable admissions, the capture WAL and prepared Neo plans before the first
//! new turn is accepted. Composition runs outside the state lock and is bound to the
//! shutdown signal, so `close()` stays within its budget. Node assembler behavior the
//! library does not provide stays absent.

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
        Cancel, CaptureHandle, CaptureOptions, Degraded, EngineError, HostError, HostServices,
        LlmParams, LlmPort, LlmResult, TurnRecord,
    },
    neo::capture_hook::NativeNeoCaptureHook,
    ops::reembedding::state::MigrationStateStore,
};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant},
};

/// The pin's close budget when the caller supplies none (`closeEngine`).
const DEFAULT_CLOSE_BUDGET: Duration = Duration::from_secs(30);
/// Status reason while retained capture input cannot be completed (or composition failed).
const RECOVERY_INCOMPLETE: &str = "startup-recovery-incomplete";
/// Status reason for a configuration the capture composition rejects; nothing to recover.
const COMPOSITION_INVALID: &str = "composition-invalid";

#[derive(Clone)]
struct Composed {
    runtime: Arc<CaptureRuntime>,
    pipeline: Arc<CapturePipeline>,
}

enum Slot {
    Idle,
    Composing,
    Ready(Composed),
    Failed(&'static str),
}

struct State {
    slot: Slot,
    closed: bool,
}

/// The process's single capture runtime, its composition state and its shutdown signal.
pub(super) struct ProcessCapture {
    state: Mutex<State>,
    changed: Condvar,
    shutdown: Cancel,
}

impl Default for ProcessCapture {
    fn default() -> Self {
        Self {
            state: Mutex::new(State {
                slot: Slot::Idle,
                closed: false,
            }),
            changed: Condvar::new(),
            // A fresh, independent flag: only this engine's close() raises it.
            shutdown: Cancel::never(),
        }
    }
}

/// Resets an abandoned `Composing` slot (for example after a panic) so waiters can retry.
struct ComposingGuard<'a> {
    owner: &'a ProcessCapture,
    armed: bool,
}
impl Drop for ComposingGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            let mut state = self.owner.lock();
            if matches!(state.slot, Slot::Composing) {
                state.slot = Slot::Idle;
            }
            self.owner.changed.notify_all();
        }
    }
}

fn unavailable(reason: &str) -> EngineError {
    EngineError::NotAvailable {
        reason: reason.into(),
    }
}

impl ProcessCapture {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The capture degradation the status reports, if capture is not (fully) served:
    /// a failed composition, or an owner whose retained input cannot be completed.
    pub(super) fn degradation(&self) -> Option<Degraded> {
        let reason = match &self.lock().slot {
            Slot::Failed(reason) => *reason,
            Slot::Ready(composed) if composed.pipeline.any_recovery_blocked() => {
                RECOVERY_INCOMPLETE
            }
            _ => return None,
        };
        super::degradation(reason, "capture").ok()
    }

    /// Compose the runtime once (recovery before admission), then return a receipt.
    pub(super) fn accept(
        engine: &ProcessEngine,
        base: &Path,
        turn: TurnRecord,
        options: CaptureOptions,
    ) -> Result<CaptureHandle, EngineError> {
        let agent = turn.agent_id.to_string();
        Self::runtime(engine, base, Some(&agent))?.accept(turn, options)
    }

    /// Compose (and thereby recover) the runtime without accepting a turn; idempotent.
    pub(super) fn open(engine: &ProcessEngine, base: &Path) -> Result<(), EngineError> {
        Self::runtime(engine, base, None).map(|_| ())
    }

    fn runtime(
        engine: &ProcessEngine,
        base: &Path,
        agent: Option<&str>,
    ) -> Result<Arc<CaptureRuntime>, EngineError> {
        let this = &engine.capture;
        let served = |composed: &Composed| match agent {
            // Only the owner whose retained input is unfinished is refused (RE-D155 scope).
            Some(agent) if composed.pipeline.recovery_blocked(agent) => {
                Err(unavailable(RECOVERY_INCOMPLETE))
            }
            _ => Ok(composed.runtime.clone()),
        };
        let mut state = this.lock();
        loop {
            if state.closed {
                return Err(unavailable("closed"));
            }
            match &state.slot {
                Slot::Ready(composed) => return served(composed),
                // Concurrent first callers wait for the one recovery in progress.
                Slot::Composing => {
                    state = this
                        .changed
                        .wait(state)
                        .unwrap_or_else(PoisonError::into_inner);
                }
                Slot::Idle | Slot::Failed(_) => break,
            }
        }
        state.slot = Slot::Composing;
        drop(state);
        let mut guard = ComposingGuard {
            owner: this,
            armed: true,
        };
        let outcome = compose(engine, base, &this.shutdown);
        let mut state = this.lock();
        guard.armed = false;
        let result = match outcome {
            Ok(composed) if state.closed => {
                state.slot = Slot::Idle;
                // Closed while composing: the fresh runtime never admits a turn.
                composed.runtime.close(Duration::ZERO);
                Err(unavailable("closed"))
            }
            Ok(composed) => {
                state.slot = Slot::Ready(composed.clone());
                served(&composed)
            }
            Err(error) => {
                let (slot, error) = classify_failure(error, state.closed);
                if slot.is_some() {
                    log::warn!("capture: startup composition incomplete");
                }
                state.slot = slot.map_or(Slot::Idle, Slot::Failed);
                Err(error)
            }
        };
        this.changed.notify_all();
        drop(state);
        result
    }

    /// Refuse new turns, stop a running composition and drain admitted capture work, all
    /// within one budget (`None`: the pin's 30 seconds). False when work is still settling.
    pub(super) fn close(&self, budget: Option<Duration>) -> bool {
        let started = Instant::now();
        let budget = budget.unwrap_or(DEFAULT_CLOSE_BUDGET);
        // Recovery observes this signal; admitted turns keep their own cancellation.
        self.shutdown.cancel();
        let mut state = self.lock();
        state.closed = true;
        self.changed.notify_all();
        while matches!(state.slot, Slot::Composing) {
            let left = budget.saturating_sub(started.elapsed());
            if left.is_zero() {
                log::warn!("capture: close budget exceeded during composition");
                return false;
            }
            state = self
                .changed
                .wait_timeout(state, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        let composed = match std::mem::replace(&mut state.slot, Slot::Idle) {
            Slot::Ready(composed) => Some(composed),
            _ => None,
        };
        drop(state);
        let Some(composed) = composed else {
            return true;
        };
        let drained = composed
            .runtime
            .close(budget.saturating_sub(started.elapsed()));
        if !drained {
            log::warn!("capture: close budget exceeded; work still settling");
        }
        drained
    }
}

/// Map a composition failure to its status slot and the caller's typed error.
/// Shutdown and cancellation are no failure state: the next open composes again.
fn classify_failure(error: EngineError, closed: bool) -> (Option<&'static str>, EngineError) {
    match error {
        _ if closed => (None, unavailable("closed")),
        error @ EngineError::Cancelled(_) => (None, error),
        error @ EngineError::Invalid { .. } => (Some(COMPOSITION_INVALID), error),
        error @ EngineError::NotAvailable { .. } => (Some(RECOVERY_INCOMPLETE), error),
        _ => (Some(RECOVERY_INCOMPLETE), unavailable(RECOVERY_INCOMPLETE)),
    }
}

fn compose(
    engine: &ProcessEngine,
    base: &Path,
    shutdown: &Cancel,
) -> Result<Composed, EngineError> {
    shutdown.check()?;
    let host = engine.operations.host_handle();
    let raw = serde_json::to_value(host.config()).map_err(|_| super::composition_invalid())?;
    let config = crate::config::effective_config(&raw).map_err(|_| super::composition_invalid())?;
    // S5 tombstone reconciliation and the one active writer route shared with forget/import.
    let pools = engine.live_stores.recall_pools()?;
    shutdown.check()?;
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
    let mut pipeline = CapturePipeline::new(
        host.clone(),
        writer,
        embedder.clone(),
        classifier,
        policy.clone(),
    )?
    .with_recovery_cancel(shutdown.clone())
    .with_owner_scoped_recovery();
    // As at the pin, Neo state exists only when Neo is enabled. Opening the hook recovers
    // prepared Neo capture/episode plans before any admission; the pin creates the root on
    // its first write, the native hook pins an existing one.
    if config["neo"]["enabled"] != false {
        let neo_root = engine_warm::neo_root(&raw["neo"], base);
        crate::store::paths::secure_dir(&neo_root)?;
        let hook = NativeNeoCaptureHook::open_with_cancel(
            &neo_root,
            host.clone(),
            policy,
            mood,
            shutdown,
        )?
        .with_embedder(embedder)?;
        pipeline = pipeline.with_neo(Arc::new(UserScopedNeo {
            hook,
            host: host.clone(),
        }));
    }
    let pipeline = Arc::new(pipeline);
    let queue = Arc::new(CaptureQueue::new(
        RuntimeConfig::from_value(&config["runtime"]),
        // No process sampler is composed; the pin's disabled gate value.
        Arc::new(PressureSnapshot::disabled),
    )?);
    let clock = host.clone();
    let replay = ReplayGuard::durable(turns_root(base), Arc::new(move || clock.now_ms()))?;
    // `scheduled = false`: no post-turn-refine job runs in RX; deferral falls back inline.
    let runtime = CaptureRuntime::new(host, pipeline.clone(), queue, replay, false)?;
    Ok(Composed {
        runtime: Arc::new(runtime),
        pipeline,
    })
}

/// The pin's `<baseDbPath>/_capture-turns` replay root.
fn turns_root(base: &Path) -> PathBuf {
    base.join("_capture-turns")
}

/// The native Neo journal binds only user-owned callers with a logical workspace key and a
/// host workspace directory (`CaptureJournal::bind`). For any other owner it has no partition:
/// pre-store work is skipped, and the post-store step reports the terminal refusal
/// `neo-owner-not-applicable`, which closes the step instead of keeping the admission pending
/// (RE-D155). Pin difference (KNOWN-GAP, RY-A): the pin writes Neo for every owner.
struct UserScopedNeo {
    hook: NativeNeoCaptureHook,
    host: Arc<dyn HostServices>,
}
impl UserScopedNeo {
    fn applies(&self, turn: &TurnRecord, context: &RequestContext) -> bool {
        is_user_principal(&context.owner_user_id)
            && !context.workspace_key.is_empty()
            && self
                .host
                .workspace_dir(&turn.principal.agent_id)
                .is_ok_and(|dir| dir.is_some_and(|dir| !dir.as_os_str().is_empty()))
    }
    fn not_applicable() -> EngineError {
        EngineError::NotAvailable {
            reason: "neo-owner-not-applicable".into(),
        }
    }
}
impl NeoCaptureHook for UserScopedNeo {
    fn record_turn(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        if !self.applies(turn, context) {
            return Ok(());
        }
        self.hook.record_turn(turn, context, cancel)
    }
    fn post_store(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        options: &CaptureOptions,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        if !self.applies(turn, context) {
            return Err(Self::not_applicable());
        }
        self.hook.post_store(turn, context, options, cancel)
    }
    fn post_store_recoverable(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        options: &CaptureOptions,
        resuming: bool,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        if !self.applies(turn, context) {
            return Err(Self::not_applicable());
        }
        self.hook
            .post_store_recoverable(turn, context, options, resuming, cancel)
    }
    fn after_capture(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        if !self.applies(turn, context) {
            return Ok(());
        }
        self.hook.after_capture(turn, context, cancel)
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
