//! Actual Neo stages at the existing CapturePipeline hook boundaries.
use super::{
    embedding_drain::{DrainOptions, EmbeddingDrain, Impact},
    episode_store::EpisodeStore,
};
use crate::embedding::EmbeddingProvider;
use crate::{
    capture::{emotion_pool::EmotionalPool, pipeline::NeoCaptureHook, shared_scope::CapturePolicy},
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
    /// Owner bindings (`agent`, `owner`) whose prepared plans were deferred at open; an
    /// owner leaves the set once its next journal write (which replays them first) succeeds.
    deferred: std::sync::Mutex<std::collections::BTreeSet<(String, String)>>,
    /// Plan files found at open that could not be read or attributed.
    unreadable: usize,
}
impl NativeNeoCaptureHook {
    /// Bind the same effective configuration/policy and recover prepared Neo plans before admission.
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
        // Recover prepared native work before exposing the hook to new capture admissions.
        // Each owner binding stands alone (RE-D159); deferred ones are reported in the status.
        let report = episodes.recover_pending(cancel)?;
        Ok(Self {
            deferred: std::sync::Mutex::new(report.deferred),
            unreadable: report.unreadable,
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
    /// Whether prepared Neo plans are still deferred or unreadable since open (RE-D159).
    #[must_use]
    pub fn has_deferred_plans(&self) -> bool {
        self.unreadable > 0
            || !self
                .deferred
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .is_empty()
    }
    /// Bind the capture composition's existing embedding provider; no model is constructed here.
    pub fn with_embedder(
        mut self,
        provider: Arc<dyn EmbeddingProvider>,
    ) -> Result<Self, EngineError> {
        self.drain = Some(EmbeddingDrain::new(self.episodes.clone(), Some(provider))?);
        Ok(self)
    }
}
impl NeoCaptureHook for NativeNeoCaptureHook {
    fn record_turn(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        if self.enabled {
            self.episodes.record(turn, context, cancel)?;
            if !turn.incognito {
                // The journal replays this owner's prepared plans before its new one.
                self.deferred
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .remove(&(context.agent_id.to_string(), context.owner_user_id.clone()));
            }
        }
        Ok(())
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
