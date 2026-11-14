//! Authorized, synchronous Neo embedding work with a frozen replay plan. No detached jobs.
use super::{embedding_plan, embedding_publication, episode_store::EpisodeStore};
use crate::{
    context::RequestContext,
    contract::{AgentContext, Cancel, EngineError, JobName, Principal, StoreError},
    embedding::{identity::try_identity_id, EmbeddingProvider},
    jobs::authority::JobAuthority,
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

/// Queue impact selection, using the Node low-impact default.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Impact {
    /// Ordinary low-impact work.
    #[default]
    Low,
    /// Medium-impact work explicitly requested by the composition.
    Medium,
    /// High-impact work explicitly requested by the composition.
    High,
    /// Critical-impact work explicitly requested by the composition.
    Critical,
    /// All impacts, with the same caller authorization.
    All,
}
impl Impact {
    pub(crate) fn from_config(value: Option<&str>) -> Result<Self, StoreError> {
        match value
            .filter(|value| !value.is_empty())
            .unwrap_or("low")
            .to_ascii_lowercase()
            .as_str()
        {
            "low" => Ok(Self::Low),
            "medium" => Ok(Self::Medium),
            "high" => Ok(Self::High),
            "critical" => Ok(Self::Critical),
            "all" => Ok(Self::All),
            _ => Err(StoreError::InvalidInput),
        }
    }

    pub(super) fn accepts(self, value: &str) -> bool {
        self == Self::All
            || value
                == match self {
                    Self::Low => "low",
                    Self::Medium => "medium",
                    Self::High => "high",
                    Self::Critical => "critical",
                    Self::All => "all",
                }
    }
}
/// Bounded native work options; failed attempts consume the same budget as successes.
#[derive(Clone, Debug)]
pub struct DrainOptions {
    /// Maximum attempts, 1..=1000. Zero uses Node's default of 100.
    pub max_items: usize,
    /// Requested impact; defaults to low.
    pub impact: Impact,
}
impl Default for DrainOptions {
    fn default() -> Self {
        Self {
            max_items: 100,
            impact: Impact::Low,
        }
    }
}
/// Counts include only this caller's visible queue. Recovered work is not counted twice.
#[derive(Default, Debug, PartialEq, Eq)]
pub struct DrainResult {
    /// Newly embedded targets.
    pub processed: usize,
    /// Visible entries whose current status remains pending.
    pub pending: usize,
    /// Missing, unavailable or unsupported targets skipped in this attempt.
    pub skipped: usize,
    /// Attempts deferred because the provider was unavailable or returned invalid output.
    pub deferred: usize,
}
/// Composition-owned provider and durable source store. Construction replays prepared work only.
pub struct EmbeddingDrain {
    episodes: Arc<EpisodeStore>,
    provider: Option<Arc<dyn EmbeddingProvider>>,
    space: Option<String>,
}
impl EmbeddingDrain {
    /// Validate provider identity and finish already-prepared Neo publications before admission.
    /// Recovery uses saved vectors; it never calls the provider.
    pub fn new(
        episodes: Arc<EpisodeStore>,
        provider: Option<Arc<dyn EmbeddingProvider>>,
    ) -> Result<Self, EngineError> {
        let drain = Self::bind(episodes, provider)?;
        drain.episodes.recover_pending(&Cancel::never())?;
        Ok(drain)
    }
    /// Validate provider identity only. For a composition that recovers prepared plans on
    /// its own, per owner binding and outside its construction (RE-D162).
    pub fn bind(
        episodes: Arc<EpisodeStore>,
        provider: Option<Arc<dyn EmbeddingProvider>>,
    ) -> Result<Self, EngineError> {
        let space = provider
            .as_ref()
            .map(|p| try_identity_id(p.identity()))
            .transpose()?;
        Ok(Self {
            episodes,
            provider,
            space,
        })
    }
    /// Drain synchronously under both native and interoperable Node workspace writer leases.
    pub fn drain(
        &self,
        principal: &Principal,
        agent: &AgentContext,
        options: &DrainOptions,
        cancel: &Cancel,
    ) -> Result<DrainResult, EngineError> {
        self.drain_inner(principal, agent, None, options, cancel)
    }

    /// Drain only the live workspace binding covered by the native job authority.
    pub(crate) fn drain_for_job(
        &self,
        authority: &JobAuthority,
        options: &DrainOptions,
        cancel: &Cancel,
    ) -> Result<DrainResult, EngineError> {
        if !matches!(
            authority.job(),
            JobName::EmbeddingDrain | JobName::PostTurnRefine
        ) {
            return Err(crate::jobs::authority::unbound());
        }
        let (principal, agent) = authority.caller();
        self.drain_inner(principal, agent, Some(authority.request()), options, cancel)
    }

    fn drain_inner(
        &self,
        principal: &Principal,
        agent: &AgentContext,
        expected: Option<&RequestContext>,
        options: &DrainOptions,
        cancel: &Cancel,
    ) -> Result<DrainResult, EngineError> {
        if options.max_items > 1000 {
            return Err(StoreError::InvalidInput.into());
        }
        let cancel = cancel.limited_to(Instant::now() + Duration::from_secs(300));
        self.episodes
            .embedding_transaction(principal, agent, expected, &cancel, |session| {
                super::revision_io::guard_pending(session.dir, &cancel)?;
                embedding_publication::resume(&session, &cancel)?;
                embedding_publication::guard_other_pending(session.dir, &session.name, &cancel)?;
                let (plan, result) = embedding_plan::build(
                    &session,
                    self.provider.as_deref(),
                    self.space.as_deref(),
                    options,
                    &cancel,
                )?;
                if let Some(plan) = plan {
                    (session.check)()?;
                    super::episode_io::write(session.dir, &session.name, session.proof, plan)?;
                    embedding_publication::resume(&session, &cancel)?;
                }
                Ok(result)
            })
    }
}
