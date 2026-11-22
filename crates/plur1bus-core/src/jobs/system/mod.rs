//! `packages/core/src/system-jobs/{index,ledger}.ts` and `armApprovalsIntegrity` of `approvals/integrity-job.ts` (P4-K K7a).
//! See [`crate::jobs`] for the rule; the ledger file is `state/system-jobs/ledger.jsonl`.
pub mod arm;
pub mod ledger;
pub mod registry;

#[cfg(test)]
mod testing;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod vectors;

pub use arm::{IntegrityArm, IntegrityTimers};
pub use ledger::{SystemJobsLedger, SystemRunRecord};
pub use registry::{
    CreateSystemJobsOptions, HistoryQuery, RunContext, RunOptions, SystemJobEntry,
    SystemJobHandler, SystemJobOutcome, SystemJobSpec, SystemJobs, SystemOutcome,
};
