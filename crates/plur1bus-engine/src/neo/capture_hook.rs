//! Actual deterministic Neo stages at the existing CapturePipeline hook boundaries.
use super::episode_store::EpisodeStore;
use crate::{
    capture::{emotion_pool::EmotionalPool, pipeline::NeoCaptureHook, shared_scope::CapturePolicy},
    context::RequestContext,
    contract::{Cancel, CaptureOptions, EngineError, HostServices, StoreError, TurnRecord},
};
use std::{path::Path, sync::Arc};

/// Optional journal recording plus required session completion, using the shared host configuration.
/// This composes deterministic work only; it creates no model job or detached worker.
pub struct NativeNeoCaptureHook {
    episodes: EpisodeStore,
    enabled: bool,
}
impl NativeNeoCaptureHook {
    /// Bind the same effective configuration/policy and recover prepared Neo plans before admission.
    pub fn open(
        root: &Path,
        host: Arc<dyn HostServices>,
        policy: Arc<dyn CapturePolicy>,
        mood: Arc<EmotionalPool>,
    ) -> Result<Self, EngineError> {
        let raw = serde_json::to_value(host.config()).map_err(|_| StoreError::InvalidInput)?;
        let config = crate::config::effective_config(&raw).map_err(|_| StoreError::InvalidInput)?;
        let episodes = EpisodeStore::open(root, host, policy, mood)?;
        // Recover prepared native work before exposing the hook to new capture admissions.
        episodes.recover_pending(&Cancel::never())?;
        Ok(Self {
            enabled: config["neo"]["enabled"] != false,
            episodes,
        })
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
        }
        Ok(())
    }
    fn post_store(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        _options: &CaptureOptions,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        // CaptureRuntime reports the inline fallback when deferred scheduling is unavailable.
        // This deterministic stage needs no LLM, regardless of the requested scheduling mode.
        self.episodes
            .finish(turn, context, cancel, self.enabled && !context.background())?;
        Ok(())
    }
}
