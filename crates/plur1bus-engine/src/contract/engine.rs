//! The host-neutral memory engine surface.

use std::time::Duration;

use super::{
    AdminOps, AgentId, AgentStoreHandle, Cancel, Capabilities, CaptureHandle, CaptureOptions,
    ChannelRegistry, CheckpointReason, CheckpointResult, ContractVersion, EmbeddingService,
    EngineError, EngineStatus, EventReceiver, JobRegistry, MemoryOps, ModelsService, RecallOptions,
    RecallQuery, RecallResult, StoreOps, TurnRecord,
};

/// The complete engine contract consumed by the harness and later engine stages.
pub trait Engine: Send + Sync {
    /// Return the frozen contract version implemented by this engine.
    fn contract(&self) -> ContractVersion;
    /// Return the frozen feature flags a host can test before using optional surfaces.
    fn capabilities(&self) -> &Capabilities;
    /// Open an agent's store and return its closeable lifetime handle.
    fn open(&self, agent: &AgentId) -> Result<AgentStoreHandle, EngineError>;
    /// Close idempotently within the supplied budget, defaulting to 30 seconds.
    fn close(&self, budget: Option<Duration>) -> Result<(), EngineError>;
    /// Return store, job, journal and model readiness status.
    fn status(&self) -> EngineStatus;
    /// Return the stable, cached system-context prefix.
    fn system_supplement(&self) -> Vec<String>;
    /// Recall context, reporting stage failures as structured degradation in the result.
    fn recall(
        &self,
        query: RecallQuery,
        options: RecallOptions,
        cancel: &Cancel,
    ) -> Result<RecallResult, EngineError>;
    /// Accept a turn without waiting for its background capture work to finish.
    fn capture(
        &self,
        turn: TurnRecord,
        options: CaptureOptions,
    ) -> Result<CaptureHandle, EngineError>;
    /// Persist the agent's checkpoint for the stated lifecycle boundary.
    fn checkpoint(
        &self,
        agent: &AgentId,
        reason: CheckpointReason,
    ) -> Result<CheckpointResult, EngineError>;
    /// Access the persistent background-job registry.
    fn jobs(&self) -> &dyn JobRegistry;
    /// Access embedding, reranking, probes and the in-process identity envelope.
    fn embedding(&self) -> &dyn EmbeddingService;
    /// Access model readiness and coalesced warm-up.
    fn models(&self) -> &dyn ModelsService;
    /// Access ACL-filtered memory operations.
    fn memory(&self) -> &dyn MemoryOps;
    /// Access administrative operations.
    fn admin(&self) -> &dyn AdminOps;
    /// Inspect a copied store before the host adopts it.
    fn stores(&self) -> &dyn StoreOps;
    /// Access the open channel vocabulary declared by the host.
    fn channels(&self) -> &dyn ChannelRegistry;
    /// Subscribe to the engine's typed event stream.
    fn events(&self) -> EventReceiver;
}
