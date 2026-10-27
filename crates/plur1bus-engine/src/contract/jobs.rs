//! Persistent background-job registration, execution and history.

use super::{AgentId, Cancel, EngineError, HistoryFilter, JobName, JobRun, JobSpec, RunOptions};

/// The engine's persistent background-job registry.
pub trait JobRegistry: Send + Sync {
    /// List every public job specification.
    fn list(&self) -> Vec<JobSpec>;
    /// Run the selected job, observing cancellation at stage boundaries.
    fn run(
        &self,
        job: JobName,
        agent: &AgentId,
        opts: RunOptions,
        cancel: &Cancel,
    ) -> Result<JobRun, EngineError>;
    /// Return persisted runs for the agent, filtered by job, time and limit.
    fn history(&self, agent: &AgentId, filter: HistoryFilter) -> Result<Vec<JobRun>, EngineError>;
}
