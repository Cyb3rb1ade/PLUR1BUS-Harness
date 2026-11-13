//! Capture over the process writer pool, the shared mood and the RE-05 runtime (RE-D154).
//!
//! The runtime is composed once, lazily, behind the S5 startup check. The composition only
//! takes an inventory of retained work (admission records and prepared Neo plans, from
//! directory entries); their recovery runs behind it, one owner at a time, and before a
//! turn only for that turn's own owner (RE-D162). Composition runs outside the state lock;
//! composition and recovery are bound to the shutdown signal, so `close()` stays within
//! its budget. Node assembler behavior the library does not provide stays absent.

use super::{engine_warm, ProcessEngine};
use crate::{
    capture::{
        accept::CaptureRuntime,
        classify::{CaptureEmotionRoutes, NativeCaptureClassifier},
        pipeline::{CapturePipeline, NeoCaptureHook},
        queue::{CaptureQueue, PressureSnapshot, RuntimeConfig},
        reminder_store::ReminderStore,
        replay_guard::ReplayGuard,
        retained::Bounds,
        shared_scope::{CapturePolicy, WorkspaceCapturePolicy},
    },
    context::{is_user_principal, RequestContext},
    contract::{
        Cancel, CaptureHandle, CaptureOptions, Degraded, EngineError, HostError, HostServices,
        LlmParams, LlmPort, LlmResult, TurnRecord,
    },
    neo::capture_hook::NativeNeoCaptureHook,
    ops::reembedding::state::MigrationStateStore,
    store::fragment_compactor::FragmentCompactor,
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
/// Status reason while capture is served but some owner's retained work waits or is being
/// recovered (after the composition, maintenance, a transient failure or its own budget),
/// or a file is owned by nobody (RE-D159, RE-D162).
const RECOVERY_DEFERRED: &str = "capture-recovery-deferred";

/// How far capture is served, for the status priority (RE-D159).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Served {
    /// The configuration is rejected; an operator must act.
    Invalid,
    /// The composition failed; every capture is refused until it succeeds.
    No,
    /// Capture is served; some retained work waits or is being recovered.
    Deferred,
}

#[derive(Clone)]
struct Composed {
    runtime: Arc<CaptureRuntime>,
    pipeline: Arc<CapturePipeline>,
    neo: Option<Arc<NativeNeoCaptureHook>>,
    /// Compacts agent tables after capture, detached from every turn (RE-D161).
    compactor: Arc<FragmentCompactor>,
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
    /// Test support: the background recovery does not start by itself.
    #[cfg(test)]
    held: std::sync::atomic::AtomicBool,
    /// Test support: the agent tables the fragment compactor works on.
    #[cfg(test)]
    tables: Mutex<Option<Arc<dyn crate::store::fragment_compactor::FragmentTables>>>,
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
            #[cfg(test)]
            held: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            tables: Mutex::new(None),
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

    /// The capture degradation the status reports, if capture is not (fully) served: a
    /// failed or rejected composition, or retained work deferred to its owners' next turns.
    pub(super) fn degradation(&self) -> Option<(Degraded, Served)> {
        let (reason, served) = match &self.lock().slot {
            Slot::Failed(reason) if *reason == COMPOSITION_INVALID => (*reason, Served::Invalid),
            Slot::Failed(reason) => (*reason, Served::No),
            Slot::Ready(composed)
                if composed.pipeline.has_unfinished_recovery()
                    || composed
                        .neo
                        .as_ref()
                        .is_some_and(|hook| hook.has_deferred_plans()) =>
            {
                (RECOVERY_DEFERRED, Served::Deferred)
            }
            _ => return None,
        };
        super::degradation(reason, "capture")
            .ok()
            .map(|degraded| (degraded, served))
    }

    /// Test support: the composed pipeline.
    #[cfg(test)]
    pub(super) fn pipeline_for_test(&self) -> Arc<CapturePipeline> {
        match &self.lock().slot {
            Slot::Ready(composed) => composed.pipeline.clone(),
            _ => unreachable!("capture is not composed"),
        }
    }
    /// Test support: keep the background recovery from starting after the composition.
    #[cfg(test)]
    pub(super) fn hold_recovery(&self) {
        self.held.store(true, std::sync::atomic::Ordering::Release);
    }
    /// Test support: start the held background recovery.
    #[cfg(test)]
    pub(super) fn release_recovery(&self) {
        if let Slot::Ready(composed) = &self.lock().slot {
            composed.runtime.start_recovery();
        }
    }
    /// Test support: wait until the first background recovery pass has finished.
    #[cfg(test)]
    pub(super) fn recovered_for_test(&self, budget: Duration) -> bool {
        let runtime = match &self.lock().slot {
            Slot::Ready(composed) => composed.runtime.clone(),
            _ => return true,
        };
        runtime.wait_recovered(Some(budget))
    }
    /// Test support: have the recovery pass look at the host's clock now; whether it swept.
    #[cfg(test)]
    pub(super) fn look_at_clock_for_test(&self, budget: Duration) -> Option<bool> {
        let runtime = match &self.lock().slot {
            Slot::Ready(composed) => composed.runtime.clone(),
            _ => return None,
        };
        runtime.look_at_clock_for_test(budget)
    }
    /// Test support: compact through these tables instead of the writer pool's.
    #[cfg(test)]
    pub(super) fn compact_with_for_test(
        &self,
        tables: Arc<dyn crate::store::fragment_compactor::FragmentTables>,
    ) {
        *self.tables.lock().unwrap_or_else(PoisonError::into_inner) = Some(tables);
    }
    /// Test support: tracked agents and checks queued or running.
    #[cfg(test)]
    pub(super) fn compaction_load_for_test(&self) -> (usize, usize) {
        match &self.lock().slot {
            Slot::Ready(composed) => composed.compactor.load(),
            _ => (0, 0),
        }
    }
    fn compactor(
        &self,
        config: &serde_json::Value,
        pool: Arc<crate::store::StorePool>,
    ) -> FragmentCompactor {
        #[cfg(test)]
        if let Some(tables) = self
            .tables
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
        {
            // Fixture tables report the count after a compaction, as `check` does.
            return FragmentCompactor::new(
                crate::store::fragment_compactor::CompactorCore::from_config(config),
                tables,
                self.shutdown.clone(),
            )
            .with_recount();
        }
        FragmentCompactor::for_pool(config, pool, self.shutdown.clone())
    }
    fn holds_recovery(&self) -> bool {
        #[cfg(test)]
        return self.held.load(std::sync::atomic::Ordering::Acquire);
        #[cfg(not(test))]
        false
    }

    /// Compose the runtime once (inventory before admission), then return a receipt.
    pub(super) fn accept(
        engine: &ProcessEngine,
        base: &Path,
        turn: TurnRecord,
        options: CaptureOptions,
    ) -> Result<CaptureHandle, EngineError> {
        let agent = turn.agent_id.to_string();
        Self::runtime(engine, base, Some(&agent))?.accept(turn, options)
    }

    /// Compose the runtime (and thereby start its recovery) without accepting a turn;
    /// idempotent.
    pub(super) fn open(engine: &ProcessEngine, base: &Path) -> Result<(), EngineError> {
        Self::runtime(engine, base, None).map(|_| ())
    }

    fn runtime(
        engine: &ProcessEngine,
        base: &Path,
        agent: Option<&str>,
    ) -> Result<Arc<CaptureRuntime>, EngineError> {
        let this = &engine.capture;
        // An owner's retained work is recovered behind the composition and joined by that
        // owner's own next turn; nobody else waits for it (RE-D162).
        let _ = agent;
        let served = |composed: &Composed| -> Result<Arc<CaptureRuntime>, EngineError> {
            Ok(composed.runtime.clone())
        };
        let mut state = this.lock();
        loop {
            if state.closed {
                return Err(unavailable("closed"));
            }
            match &state.slot {
                Slot::Ready(composed) => return served(composed),
                // Concurrent first callers wait for the one composition in progress; it takes
                // an inventory only, so the wait depends on nobody's retained work.
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
        let outcome = compose(engine, base, this);
        let mut state = this.lock();
        guard.armed = false;
        let result = match outcome {
            Ok(composed) if state.closed => {
                state.slot = Slot::Idle;
                // Closed while composing: the fresh runtime never admits a turn.
                composed.compactor.close();
                composed.runtime.close(Duration::ZERO);
                Err(unavailable("closed"))
            }
            Ok(composed) => {
                state.slot = Slot::Ready(composed.clone());
                if !this.holds_recovery() {
                    composed.runtime.start_recovery();
                }
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
        // RE-D161: no check starts any more; a running one already sees the shutdown signal
        // and ends at its next cancellation check. Turns drained below note nothing.
        composed.compactor.close();
        let drained = composed
            .runtime
            .close(budget.saturating_sub(started.elapsed()));
        let drained = composed
            .compactor
            .join(budget.saturating_sub(started.elapsed()))
            && drained;
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
        // The composition recovers nothing (RE-D162), so a cancellation here is shutdown
        // and no failure state.
        error @ EngineError::Cancelled(_) => (None, error),
        error @ EngineError::Invalid { .. } => (Some(COMPOSITION_INVALID), error),
        error @ EngineError::NotAvailable { .. } => (Some(RECOVERY_INCOMPLETE), error),
        _ => (Some(RECOVERY_INCOMPLETE), unavailable(RECOVERY_INCOMPLETE)),
    }
}

pub(super) fn workspace_capture_policy(base: &Path) -> Arc<dyn CapturePolicy> {
    let switching_base = base.to_path_buf();
    Arc::new(
        WorkspaceCapturePolicy::new(base.to_path_buf()).with_maintenance(Arc::new(move || {
            // An unreadable migration state is a switching store: fail closed.
            MigrationStateStore::new(&switching_base)
                .and_then(|store| store.switching())
                .unwrap_or(true)
        })),
    )
}

fn compose(
    engine: &ProcessEngine,
    base: &Path,
    capture: &ProcessCapture,
) -> Result<Composed, EngineError> {
    let shutdown = &capture.shutdown;
    shutdown.check()?;
    let host = engine.operations.host_handle();
    let raw = serde_json::to_value(host.config()).map_err(|_| super::composition_invalid())?;
    let config = crate::config::effective_config(&raw).map_err(|_| super::composition_invalid())?;
    // S5 tombstone reconciliation and the one active writer route shared with forget/import.
    let pools = engine.live_stores.recall_pools()?;
    shutdown.check()?;
    let writer = pools.writer_pool();
    let embedder = engine.embedding.pipeline_embedder();
    let policy = workspace_capture_policy(base);
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
    // RE-D161: the compactor counts the stored rows of every turn and compacts an agent
    // table detached from the turn, on its own handle; it works only after composition.
    let compactor = Arc::new(capture.compactor(&config, writer.clone()));
    let mut pipeline = CapturePipeline::new(
        host.clone(),
        writer,
        embedder.clone(),
        classifier,
        policy.clone(),
    )?
    .with_compactor(compactor.clone());
    // As at the pin, Neo state exists only when Neo is enabled. The pin creates the root on
    // its first write, the native hook pins an existing one. Opening the hook recovers
    // nothing; its prepared plans are inventoried with the admissions below.
    let mut neo = None;
    let neo_root = engine_warm::neo_root(&raw["neo"], base);
    if config["neo"]["enabled"] == false {
        // Neo is switched off: nothing of Neo is written or resumed, and no Neo state is
        // created. A plan that an earlier run with Neo left prepared still holds turn
        // text, so the age bound applies to it all the same (RE-D163). A root that cannot
        // be opened is left alone.
        if neo_root.is_dir() {
            if let Ok(hook) =
                NativeNeoCaptureHook::open_deferred(&neo_root, host.clone(), policy, mood)
            {
                pipeline = pipeline.with_neo(Arc::new(ExpiringNeo(hook)));
            }
        }
    } else {
        crate::store::paths::secure_dir(&neo_root)?;
        let hook = Arc::new(
            NativeNeoCaptureHook::open_deferred(&neo_root, host.clone(), policy, mood)?
                .with_embedder(embedder)?,
        );
        pipeline = pipeline.with_neo(Arc::new(UserScopedNeo {
            hook: hook.clone(),
            host: host.clone(),
        }));
        neo = Some(hook);
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
    // Composing takes the inventory of retained admissions and Neo plans: directory entries
    // only, no host callback, no provider, no waiting for a lease (RE-D162). Only shutdown,
    // the admission root or the Neo root itself can fail it.
    let runtime = CaptureRuntime::compose(
        host,
        pipeline.clone(),
        queue,
        replay,
        false,
        shutdown.clone(),
    )?;
    Ok(Composed {
        runtime: Arc::new(runtime),
        pipeline,
        neo,
        compactor,
    })
}

/// The pin's `<baseDbPath>/_capture-turns` replay root.
fn turns_root(base: &Path) -> PathBuf {
    base.join("_capture-turns")
}

/// Neo switched off: no Neo step runs and no plan is resumed. Only the age bound is applied
/// to what an earlier run with Neo left prepared (RE-D163): plans older than seven days and
/// temporary files older than an hour are discarded, by the first pass and by every sweep.
struct ExpiringNeo(NativeNeoCaptureHook);
impl NeoCaptureHook for ExpiringNeo {
    fn record_turn(
        &self,
        _turn: &TurnRecord,
        _context: &RequestContext,
        _cancel: &Cancel,
    ) -> Result<(), EngineError> {
        Ok(())
    }
    fn post_store(
        &self,
        _turn: &TurnRecord,
        _context: &RequestContext,
        _options: &CaptureOptions,
        _cancel: &Cancel,
    ) -> Result<(), EngineError> {
        Ok(())
    }
    fn post_store_recoverable(
        &self,
        _turn: &TurnRecord,
        _context: &RequestContext,
        _options: &CaptureOptions,
        _resuming: bool,
        _cancel: &Cancel,
    ) -> Result<(), EngineError> {
        Ok(())
    }
    fn has_retained(&self) -> bool {
        self.0.has_retained()
    }
    fn recover_retained(&self, bounds: &Bounds) {
        self.0.expire_retained(bounds);
    }
    fn expire_retained(&self, bounds: &Bounds) {
        self.0.expire_retained(bounds);
    }
    fn close_retained(&self, budget: Duration) -> bool {
        self.0.close_retained(budget)
    }
}

/// The native Neo journal binds only user-owned callers with a logical workspace key and a
/// host workspace directory (`CaptureJournal::bind`). For any other owner it has no partition:
/// pre-store work is skipped, and the post-store step reports the terminal refusal
/// `neo-owner-not-applicable`, which closes the step instead of keeping the admission pending
/// (RE-D155). Pin difference (KNOWN-GAP, RY-A): the pin writes Neo for every owner.
struct UserScopedNeo {
    hook: Arc<NativeNeoCaptureHook>,
    host: Arc<dyn HostServices>,
}
impl UserScopedNeo {
    fn applies(&self, turn: &TurnRecord, context: &RequestContext) -> Result<bool, EngineError> {
        neo_applies(self.host.as_ref(), turn, context)
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
        if !self.applies(turn, context)? {
            return Ok(());
        }
        self.hook.record_turn(turn, context, cancel)
    }
    fn record_resumed_turn(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        at_ms: i64,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        if !self.applies(turn, context)? {
            return Ok(());
        }
        self.hook.record_resumed_turn(turn, context, at_ms, cancel)
    }
    fn post_store(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        options: &CaptureOptions,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        if !self.applies(turn, context)? {
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
        if !self.applies(turn, context)? {
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
        if !self.applies(turn, context)? {
            return Ok(());
        }
        self.hook.after_capture(turn, context, cancel)
    }
    fn inventory(&self, cancel: &Cancel) -> Result<(), EngineError> {
        self.hook.inventory(cancel)
    }
    fn has_retained(&self) -> bool {
        self.hook.has_retained()
    }
    fn recover_retained(&self, bounds: &Bounds) {
        self.hook.recover_retained(bounds);
    }
    fn expire_retained(&self, bounds: &Bounds) {
        self.hook.expire_retained(bounds);
    }
    fn recover_owner(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        cancel: &Cancel,
        bounds: &Bounds,
    ) {
        // Only a caller the journal can bind has a binding; that needs no host here.
        if is_user_principal(&context.owner_user_id) && !context.workspace_key.is_empty() {
            self.hook.recover_owner(turn, context, cancel, bounds);
        }
    }
    fn close_retained(&self, budget: Duration) -> bool {
        self.hook.close_retained(budget)
    }
}

/// Whether the native Neo journal has a partition for this owner. A host failure while
/// resolving the workspace is transient and propagates (RE-D156); only a missing user
/// principal, an empty logical key or a host answer of "no workspace" is not applicable.
pub(super) fn neo_applies(
    host: &dyn HostServices,
    turn: &TurnRecord,
    context: &RequestContext,
) -> Result<bool, EngineError> {
    if !is_user_principal(&context.owner_user_id) || context.workspace_key.is_empty() {
        return Ok(false);
    }
    Ok(host
        .workspace_dir(&turn.principal.agent_id)?
        .is_some_and(|dir| !dir.as_os_str().is_empty()))
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
