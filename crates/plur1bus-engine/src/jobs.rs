//! Engine-owned job catalog. A listed specification does not grant execution authority.
pub mod authority;
pub(crate) mod classify_recent;
pub(crate) mod consolidate_daily;
pub mod content_guard;
pub(crate) mod critical_expiry;
pub mod dream_diary;
pub(crate) mod emotion_refine;
pub(crate) mod garbage_collection;
pub(crate) mod lance_scope;
pub mod ledger;
pub mod llm;
pub mod llm_cache_key;
pub mod maintenance_gate;
pub mod metadata;
pub mod migration;
pub mod outcome;
pub mod persona_locale;
pub mod prompts;
pub mod rate_limit;
pub mod registry;
pub(crate) mod reminder_dispatch;
pub mod review_approval;
pub mod skill_decisions;
use crate::contract::{
    JobName, JobSpec, JobSpecDefaultSchedule, JobSpecDefaultScheduleKind, JobSpecPhase,
};

/// All twenty A1 jobs in their frozen public order, with the shipped host cron defaults.
/// This does not start a scheduler or imply that a job body is available.
#[must_use]
pub fn catalog() -> Vec<JobSpec> {
    use JobName as J;
    [
        (J::PersonaEvolve, true),
        (J::Afterthought, true),
        (J::ConsolidateDaily, true),
        (J::AutoAcceptStale, false),
        (J::EmbeddingDrain, false),
        (J::EmotionRefine, true),
        (J::PostTurnRefine, true),
        (J::ClassifyRecent, true),
        (J::RemDream, true),
        (J::SkillMiner, true),
        (J::DiscoverSemanticLinks, false),
        (J::GcRun, false),
        (J::ReminderDispatch, false),
        (J::FeedbackReport, false),
        (J::ProactiveCheck, false),
        (J::MetaReflect, true),
        (J::SkillBenefitBackfill, true),
        (J::EpisodesRebuild, true),
        (J::LightDream, true),
        (J::KnowledgeUpdate, false),
    ]
    .into_iter()
    .map(|(name, needs_llm)| JobSpec {
        name,
        needs_llm,
        singleton: matches!(name, J::GcRun | J::KnowledgeUpdate),
        phase: match name {
            J::ConsolidateDaily => Some(JobSpecPhase::Deep),
            J::RemDream => Some(JobSpecPhase::Rem),
            J::LightDream => Some(JobSpecPhase::Light),
            _ => None,
        },
        default_schedule: schedule(name),
    })
    .collect()
}

fn schedule(job: JobName) -> Option<JobSpecDefaultSchedule> {
    use JobName as J;
    use JobSpecDefaultScheduleKind::{Cron, Every};
    let (kind, expr, timezone) = match job {
        J::PersonaEvolve => (Cron, "15 4 * * *", None),
        J::Afterthought | J::ClassifyRecent => (Every, "10800000", None),
        J::EmotionRefine => (Every, "3600000", None),
        J::PostTurnRefine => (Every, "1200000", None),
        J::ConsolidateDaily => (Cron, "0 4 * * *", Some("Europe/Berlin")),
        J::AutoAcceptStale => (Cron, "50 4 * * *", Some("Europe/Berlin")),
        J::EmbeddingDrain => (Cron, "20 3 * * *", Some("Europe/Berlin")),
        J::RemDream => (Cron, "15 1 * * *", Some("Europe/Berlin")),
        J::SkillMiner => (Cron, "0 5 * * *", Some("Europe/Berlin")),
        J::DiscoverSemanticLinks => (Cron, "0 2 * * *", Some("Europe/Berlin")),
        J::GcRun => (Cron, "45 4 * * *", Some("Europe/Berlin")),
        J::ReminderDispatch
        | J::FeedbackReport
        | J::ProactiveCheck
        | J::MetaReflect
        | J::SkillBenefitBackfill
        | J::EpisodesRebuild
        | J::LightDream
        | J::KnowledgeUpdate => return None,
    };
    Some(JobSpecDefaultSchedule {
        kind,
        expr: expr.into(),
        timezone: timezone.map(str::to_owned),
    })
}
