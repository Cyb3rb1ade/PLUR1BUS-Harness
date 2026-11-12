//! F13 job scopes. A catalog entry, the cron context, an agent ID or a row owner never
//! grants a body access to private owner or workspace rows; RX has no binding source.
use crate::contract::JobName;

/// Fixed refusal for jobs over private owner or workspace rows without a bound authority.
pub const AUTHORITY_UNBOUND: &str = "job-authority-unbound";
/// Fixed refusal for LLM job bodies, which RX does not port (RE-06 T2–T7).
pub const LLM_UNPORTED: &str = "not-implemented";

/// What a catalog job's full body reads or writes, independent of any installed owner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobScope {
    /// Private owner or workspace rows (memories, Neo, reminders, proposals, knowledge).
    OwnerData,
    /// An LLM body over owner data (RE-06 T2–T7).
    Llm,
}

/// Every catalog job reads or writes private rows; LLM bodies are classified separately.
#[must_use]
pub fn scope(job: JobName) -> JobScope {
    if super::catalog()
        .iter()
        .any(|spec| spec.name == job && spec.needs_llm)
    {
        JobScope::Llm
    } else {
        JobScope::OwnerData
    }
}

/// The fixed refusal for a job without an installed body.
#[must_use]
pub fn refusal(job: JobName) -> &'static str {
    match scope(job) {
        JobScope::OwnerData => AUTHORITY_UNBOUND,
        JobScope::Llm => LLM_UNPORTED,
    }
}
