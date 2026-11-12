//! Actual Neo stages at the existing CapturePipeline hook boundaries.
use super::{
    embedding_drain::{DrainOptions, EmbeddingDrain, Impact},
    episode_store::EpisodeStore,
};
use crate::embedding::EmbeddingProvider;
use crate::{
    capture::{
        emotion_pool::EmotionalPool,
        pipeline::NeoCaptureHook,
        retained::{Bounds, Retained},
        shared_scope::CapturePolicy,
    },
    context::RequestContext,
    contract::{
        Cancel, CaptureOptions, EngineError, HostServices, LlmPort, StoreError, TurnRecord,
    },
};
use std::{
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

/// Optional journal recording plus required session completion, using the shared host configuration.
/// Embedding maintenance is synchronous and uses only the remaining capture budget.
pub struct NativeNeoCaptureHook {
    episodes: Arc<EpisodeStore>,
    enabled: bool,
    auto_drain: bool,
    options: DrainOptions,
    drain: Option<EmbeddingDrain>,
    /// Owner bindings (`<workspace directory>/<binding digest>`) whose prepared plans wait
    /// or are being recovered (RE-D162).
    retained: Arc<Retained>,
    /// Plan files the last inventory could not read or attribute.
    unreadable: std::sync::atomic::AtomicUsize,
}
/// How long the pass waits beyond a binding's budget for its attempt to return.
const ATTEMPT_GRACE: Duration = Duration::from_secs(1);
impl NativeNeoCaptureHook {
    /// Bind the same effective configuration/policy and recover prepared Neo plans before
    /// returning: every owner binding once, each under its own budget.
    pub fn open(
        root: &Path,
        host: Arc<dyn HostServices>,
        policy: Arc<dyn CapturePolicy>,
        mood: Arc<EmotionalPool>,
    ) -> Result<Self, EngineError> {
        Self::open_bound(root, host, policy, mood, None, &Cancel::never())
    }
    /// As [`Self::open`], with the prepared-plan recovery bound to a shutdown signal.
    pub fn open_with_cancel(
        root: &Path,
        host: Arc<dyn HostServices>,
        policy: Arc<dyn CapturePolicy>,
        mood: Arc<EmotionalPool>,
        cancel: &Cancel,
    ) -> Result<Self, EngineError> {
        Self::open_bound(root, host, policy, mood, None, cancel)
    }
    /// Bind configuration and policy only (RE-D162): nothing is read below the root, no
    /// host is asked and nothing is recovered. The composition takes the inventory
    /// (`NeoCaptureHook::inventory`) and recovers bindings behind it.
    pub fn open_deferred(
        root: &Path,
        host: Arc<dyn HostServices>,
        policy: Arc<dyn CapturePolicy>,
        mood: Arc<EmotionalPool>,
    ) -> Result<Self, EngineError> {
        Self::bound(root, host, policy, mood, None)
    }
    /// Bind an already authorized narrative provider. Prepared startup recovery still performs
    /// no inference. Disabled Neo and background captures never invoke this optional provider.
    pub fn open_with_narrative(
        root: &Path,
        host: Arc<dyn HostServices>,
        policy: Arc<dyn CapturePolicy>,
        mood: Arc<EmotionalPool>,
        narrative: Arc<dyn LlmPort>,
    ) -> Result<Self, EngineError> {
        Self::open_bound(root, host, policy, mood, Some(narrative), &Cancel::never())
    }
    fn open_bound(
        root: &Path,
        host: Arc<dyn HostServices>,
        policy: Arc<dyn CapturePolicy>,
        mood: Arc<EmotionalPool>,
        narrative: Option<Arc<dyn LlmPort>>,
        cancel: &Cancel,
    ) -> Result<Self, EngineError> {
        let hook = Self::bound(root, host, policy, mood, narrative)?;
        // Recover prepared native work before exposing the hook to new capture admissions.
        // Each owner binding stands alone; what stays is reported in the status.
        NeoCaptureHook::inventory(&hook, cancel)?;
        hook.recover_retained(&Bounds::new(cancel.clone()));
        cancel.check()?;
        Ok(hook)
    }
    fn bound(
        root: &Path,
        host: Arc<dyn HostServices>,
        policy: Arc<dyn CapturePolicy>,
        mood: Arc<EmotionalPool>,
        narrative: Option<Arc<dyn LlmPort>>,
    ) -> Result<Self, EngineError> {
        let raw = serde_json::to_value(host.config()).map_err(|_| StoreError::InvalidInput)?;
        let config = crate::config::effective_config(&raw).map_err(|_| StoreError::InvalidInput)?;
        let drain = &config["neo"]["embeddingDrain"];
        let configured_max = match drain.get("maxItems") {
            None | Some(serde_json::Value::Null) => 250,
            Some(value) => value.as_u64().ok_or(StoreError::InvalidInput)?,
        };
        let max_items = if configured_max == 0 {
            250
        } else {
            configured_max
        };
        if max_items > 1000 {
            return Err(StoreError::InvalidInput.into());
        }
        let impact = match drain["impact"]
            .as_str()
            .filter(|value| !value.is_empty())
            .unwrap_or("low")
            .to_lowercase()
            .as_str()
        {
            "low" => Impact::Low,
            "medium" => Impact::Medium,
            "high" => Impact::High,
            "critical" => Impact::Critical,
            "all" => Impact::All,
            _ => return Err(StoreError::InvalidInput.into()),
        };
        let episodes = EpisodeStore::open(root, host, policy, mood)?;
        let episodes = Arc::new(match narrative {
            Some(port) => episodes.with_narrative(port),
            None => episodes,
        });
        Ok(Self {
            retained: Arc::default(),
            unreadable: std::sync::atomic::AtomicUsize::new(0),
            enabled: config["neo"]["enabled"] != false,
            episodes,
            auto_drain: drain["enabled"] != false,
            options: DrainOptions {
                max_items: max_items as usize,
                impact,
            },
            drain: None,
        })
    }
    /// Whether prepared Neo plans wait, are being recovered, or could not be read at the
    /// last inventory.
    #[must_use]
    pub fn has_deferred_plans(&self) -> bool {
        self.unreadable.load(std::sync::atomic::Ordering::Acquire) > 0 || self.retained.waiting()
    }
    /// Bind the capture composition's existing embedding provider; no model is constructed
    /// and nothing is recovered here.
    pub fn with_embedder(
        mut self,
        provider: Arc<dyn EmbeddingProvider>,
    ) -> Result<Self, EngineError> {
        self.drain = Some(EmbeddingDrain::bind(self.episodes.clone(), Some(provider))?);
        Ok(self)
    }
    /// Start the one attempt for a waiting binding; true when one is in flight afterwards.
    fn start(&self, key: &str, bounds: &Bounds) -> bool {
        let (episodes, bounds, binding) = (self.episodes.clone(), bounds.clone(), key.to_owned());
        self.retained.start(key, "neo-recovery", move || {
            let budget = bounds
                .shutdown
                .limited_to(Instant::now() + episodes.plan_budget());
            episodes.recover_key(&binding, &budget, &bounds)
        })
    }
    /// The pre-store journal step; `at_ms` is the turn's own time when it is resumed.
    fn record(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        at_ms: Option<i64>,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        if self.enabled {
            self.episodes.record_at(turn, context, at_ms, cancel)?;
            if !turn.incognito {
                self.settle(turn, cancel);
            }
        }
        Ok(())
    }
    /// Remove whole plans that interrupted writes left under a temporary name more than an
    /// hour ago (RE-D163); what was removed is logged with its count.
    fn remove_stale(&self, cancel: &Cancel) {
        if let Ok(removed @ 1..) = self.episodes.remove_stale_temporaries(cancel) {
            log::warn!("neo: {removed} stale temporary plan files removed");
        }
    }
    /// After the owner's own journal write: its binding no longer waits once no plan of it
    /// is left (the journal replays a prepared plan before a new one).
    fn settle(&self, turn: &TurnRecord, cancel: &Cancel) {
        if !self.retained.waiting() {
            return;
        }
        if let Ok(Some(key)) = self.episodes.binding_key(&turn.principal, &turn.agent) {
            if !self.episodes.has_plans(&key, cancel) {
                self.retained.settle(&key);
            }
        }
    }
}
impl NeoCaptureHook for NativeNeoCaptureHook {
    fn record_turn(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        self.record(turn, context, None, cancel)
    }
    fn record_resumed_turn(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        at_ms: i64,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        self.record(turn, context, Some(at_ms), cancel)
    }
    fn inventory(&self, cancel: &Cancel) -> Result<(), EngineError> {
        let (keys, unreadable, settled) = self.episodes.plan_keys(cancel)?;
        self.unreadable
            .store(unreadable, std::sync::atomic::Ordering::Release);
        if settled > 0 {
            // Settled plan files hold no rows and no caller: nothing to recover, nothing
            // is lost by leaving them out (RE-D163).
            log::info!("neo: {settled} settled plan bindings hold no work and are not listed");
        }
        self.retained.replace(keys);
        self.remove_stale(cancel);
        Ok(())
    }
    fn expire_retained(&self, bounds: &Bounds) {
        let shutdown = &bounds.shutdown;
        self.remove_stale(shutdown);
        // The sweep reads the directories again, so a plan that a failed turn left behind
        // while the engine ran is found too. Only bindings past the age bound get an
        // attempt, and that attempt discards them without resuming anything.
        let Ok(keys) = self.episodes.expired_keys(shutdown) else {
            return;
        };
        for key in keys {
            if shutdown.is_cancelled() {
                return;
            }
            if !self.retained.concerns(&key) {
                self.retained.mark(&key);
            }
            if self.start(&key, bounds) {
                let patience = Instant::now() + self.episodes.plan_budget() + ATTEMPT_GRACE;
                let patience = shutdown.limited_to(patience);
                self.retained.join(&key, &patience, shutdown);
            }
        }
    }
    fn has_retained(&self) -> bool {
        self.retained.waiting()
    }
    fn recover_retained(&self, bounds: &Bounds) {
        let shutdown = &bounds.shutdown;
        // Bindings one after the other. The pass only waits; each attempt has its own
        // thread and budget, and holds the workspace leases no longer than a turn's own
        // Neo step would.
        for key in self.retained.keys() {
            if shutdown.is_cancelled() {
                return;
            }
            if self.start(&key, bounds) {
                let patience = Instant::now() + self.episodes.plan_budget() + ATTEMPT_GRACE;
                let patience = shutdown.limited_to(patience);
                self.retained.join(&key, &patience, shutdown);
            }
        }
    }
    fn recover_owner(
        &self,
        turn: &TurnRecord,
        _context: &RequestContext,
        cancel: &Cancel,
        bounds: &Bounds,
    ) {
        if !self.enabled || turn.incognito || !self.retained.waiting() {
            return;
        }
        // The caller's own binding needs the host. The lookup has a deadline that ends only
        // this wait, it takes one of the agent's places for outstanding host lookups, and
        // none starts once recovery has ended (RE-D163).
        let budget = self.episodes.plan_budget();
        let (episodes, principal, agent) = (
            self.episodes.clone(),
            turn.principal.clone(),
            turn.agent.clone(),
        );
        let key = bounds.host_call(
            turn.agent_id.as_str(),
            "neo-identity",
            cancel,
            budget,
            move || episodes.binding_key(&principal, &agent),
        );
        let Some(Ok(Some(key))) = key else {
            return;
        };
        if self.retained.concerns(&key) {
            self.start(&key, bounds);
            let wait = cancel.limited_to(Instant::now() + budget);
            self.retained.join(&key, &wait, &bounds.shutdown);
        }
    }
    fn close_retained(&self, budget: Duration) -> bool {
        self.retained.close();
        self.retained.drained(budget)
    }
    fn post_store_recoverable(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        options: &CaptureOptions,
        _resuming: bool,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        self.post_store(turn, context, options, cancel)
    }

    fn post_store(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        _options: &CaptureOptions,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        // CaptureRuntime reports the inline fallback when deferred scheduling is unavailable.
        // Optional narrative enrichment uses that same inline path; no job is scheduled here.
        self.episodes
            .finish(turn, context, cancel, self.enabled && !context.background())?;
        self.settle(turn, cancel);
        Ok(())
    }
    fn after_capture(
        &self,
        turn: &TurnRecord,
        _context: &RequestContext,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        if !self.enabled
            || !self.auto_drain
            || turn.incognito
            || cancel.is_cancelled()
            || turn.cancel.is_cancelled()
        {
            return Ok(());
        }
        // Node reserves 10 seconds for an in-flight embedding and requires 3 seconds of usable
        // maintenance budget. An unbounded direct call must not manufacture a fresh capture budget.
        let Some(remaining) = cancel
            .remaining()
            .and_then(|v| v.checked_sub(Duration::from_secs(10)))
        else {
            return Ok(());
        };
        if remaining < Duration::from_secs(3) {
            return Ok(());
        }
        let drain = self
            .drain
            .as_ref()
            .ok_or_else(|| EngineError::NotAvailable {
                reason: "neo-embedding-provider-unavailable".into(),
            })?;
        let budget = cancel.limited_to(Instant::now() + remaining);
        drain.drain(&turn.principal, &turn.agent, &self.options, &budget)?;
        Ok(())
    }
}
