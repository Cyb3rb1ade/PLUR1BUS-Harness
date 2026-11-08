//! Durable private episodes coupled to their session checkpoint, with exact pending replay.
use super::{
    capture_journal::{CaptureJournal, JournalResult},
    derived_fields::str_field,
    episode_io::{self, Publication},
    episode_plan::{self, Build},
    session_store::SessionStore,
};
use crate::{
    capture::{emotion_pool::EmotionalPool, shared_scope::CapturePolicy},
    context::RequestContext,
    contract::{Cancel, EngineError, HostServices, StoreError, TurnRecord},
    text::js::JsString,
};
use chrono::{SecondsFormat, TimeZone, Utc};
use std::{
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

#[path = "episode_embedding.rs"]
mod embedding;
#[path = "episode_recovery.rs"]
mod recovery;
pub use recovery::RecoveryReport;

/// Composition-owned root, actual host/policy and the shared capture/recall mood pool.
pub struct EpisodeStore {
    journal: CaptureJournal,
    sessions: SessionStore,
    host: Arc<dyn HostServices>,
    mood: Arc<EmotionalPool>,
}
impl EpisodeStore {
    /// Opening holds physical roots but creates no state, episode, lease or provider work.
    pub fn open(
        root: &Path,
        host: Arc<dyn HostServices>,
        policy: Arc<dyn CapturePolicy>,
        mood: Arc<EmotionalPool>,
    ) -> Result<Self, StoreError> {
        Ok(Self {
            journal: CaptureJournal::open(root, host.clone(), policy)?,
            sessions: SessionStore::open(root, host.clone())?,
            host,
            mood,
        })
    }
    /// Pre-store capture writes the authenticated source journals idempotently.
    pub fn record(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        cancel: &Cancel,
    ) -> Result<JournalResult, EngineError> {
        self.journal.record(turn, context, cancel)
    }
    /// Complete ordinary deterministic episodes. No background model job or vault publication.
    /// A pending publication is recovered before newer work can advance any session checkpoint.
    pub fn process(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        cancel: &Cancel,
    ) -> Result<usize, EngineError> {
        self.finish(turn, context, cancel, true)
    }
    pub(super) fn finish(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        cancel: &Cancel,
        episodes: bool,
    ) -> Result<usize, EngineError> {
        if turn.incognito {
            return Ok(0);
        }
        let cancel = cancel.limited_to(Instant::now() + Duration::from_secs(300));
        if episodes {
            self.record(turn, context, &cancel)?;
        }
        let session = JsString::from(
            turn.session_key
                .as_deref()
                .filter(|s| !s.is_empty())
                .or(turn.run_id.as_deref())
                .unwrap_or(""),
        );
        self.journal
            .transaction(turn, context, &cancel, |dir, proof, name, check| {
                let publication = Publication {
                    dir,
                    proof,
                    name,
                    ctx: context,
                    check,
                };
                let recovered = self.resume_episode(dir, proof, name, check, &cancel)?;
                self.sessions.transaction(
                    &turn.principal,
                    &turn.agent,
                    &session,
                    &cancel,
                    check,
                    |checkpoint| {
                        let now = Utc
                            .timestamp_millis_opt(self.host.now_ms())
                            .single()
                            .ok_or(StoreError::InvalidInput)?
                            .to_rfc3339_opts(SecondsFormat::Millis, true);
                        let now = JsString::from(now.as_str());
                        let plan = if episodes {
                            let mood = self.mood.read(
                                &turn.principal,
                                &turn.agent,
                                &cancel,
                                |state, time| state.describe(time),
                            )?;
                            let input = Build {
                                turn,
                                ctx: context,
                                dir,
                                session: &session,
                                now: &now,
                                mood: &mood,
                            };
                            episode_plan::build(&input, checkpoint.state(), &cancel)?
                        } else {
                            episode_plan::checkpoint_only(turn, checkpoint.state(), &session, &now)?
                        };
                        let Some(mut plan) = plan else {
                            return Ok(recovered);
                        };
                        super::derived_fields::set(
                            &mut plan,
                            "caller",
                            super::caller::encode(&turn.principal, &turn.agent)?,
                        )?;
                        let next =
                            super::merged_order::field(&plan, "next").ok_or(StoreError::Corrupt)?;
                        checkpoint.validate(next)?;
                        episode_io::preflight(dir, &plan, context, &cancel)?;
                        check()?;
                        episode_io::write(dir, name, proof, plan.clone())?;
                        Ok(recovered
                            + episode_io::replay(&publication, &plan, checkpoint, &cancel)?)
                    },
                )
            })
    }
}
