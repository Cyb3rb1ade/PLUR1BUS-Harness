//! `approvals/integrity-job.ts` (D109 §9.7): the start and daily check of the approval chain (HMAC and Ed25519), as a
//! system-job handler: its spec, when it runs next (a day after the last run, jittered by up to a tenth), its argument check
//! and one run. Scheduling it (the system-jobs registry and the timer that re-arms it, `armApprovalsIntegrity`) is the host's;
//! the registry is K7's, and nothing here starts a timer.
use super::chain::VerifyResult;
use super::{ApprovalError, Clock};
use serde_json::Value;
use std::sync::Arc;

/// `APPROVALS_INTEGRITY_JOB_SPEC.name`.
pub const JOB_NAME: &str = "approvals.integrity";
/// `schedule.every`: a day.
pub const EVERY_MS: f64 = 86_400_000.0;
/// `schedule.jitter`.
pub const JITTER: f64 = 0.1;

/// `APPROVALS_INTEGRITY_JOB_SPEC`: `{ name, needsLlm, singleton, schedule: { every, jitter }, exclusive }`.
pub fn spec() -> Value {
    serde_json::json!({ "name": JOB_NAME, "needsLlm": false, "singleton": true,
        "schedule": { "every": EVERY_MS as i64, "jitter": JITTER }, "exclusive": true })
}

/// What one run ended with (`SystemJobOutcome`).
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    /// `abandoned`, reason `aborted`.
    Abandoned,
    /// `skipped`, reason `store-absent`: the store has never been opened, so there is nothing to check.
    Skipped,
    /// `failed` with the verifier's reason; the detail is the whole result.
    Failed(VerifyResult),
    /// `completed`; the detail is the result.
    Completed(VerifyResult),
}

impl Outcome {
    /// `{ outcome, reason?, detail }` as TypeScript returns it.
    pub fn json(&self) -> Value {
        use serde_json::json;
        match self {
            Outcome::Abandoned => {
                json!({ "outcome": "abandoned", "reason": "aborted", "detail": null })
            }
            Outcome::Skipped => {
                json!({ "outcome": "skipped", "reason": "store-absent", "detail": null })
            }
            Outcome::Failed(v) => {
                let reason = match v {
                    VerifyResult::Broken { reason, .. } => reason.as_str(),
                    VerifyResult::Ok { .. } => "",
                };
                json!({ "outcome": "failed", "reason": reason, "detail": v.json() })
            }
            Outcome::Completed(v) => json!({ "outcome": "completed", "detail": v.json() }),
        }
    }
}

/// `ApprovalsIntegrityJobDeps` and the handler state (`lastRunAt`).
pub struct IntegrityJob<'a> {
    verify: Box<dyn FnMut() -> Result<VerifyResult, ApprovalError> + 'a>,
    present: Option<Box<dyn FnMut() -> bool + 'a>>,
    clock: Arc<dyn Clock>,
    rng: Box<dyn FnMut() -> f64 + 'a>,
    on_ok: Option<Box<dyn FnMut() + 'a>>,
    last_run_at: Option<i64>,
}

impl<'a> IntegrityJob<'a> {
    /// `createApprovalsIntegrityJob(deps)`. `rng` is `[0, 1)` (`Math.random` when the host has nothing better); with
    /// `defer_first_run` the first run is a day away instead of due now (no store yet, no ledger row at start).
    pub fn new(
        verify: Box<dyn FnMut() -> Result<VerifyResult, ApprovalError> + 'a>,
        clock: Arc<dyn Clock>,
        rng: Box<dyn FnMut() -> f64 + 'a>,
        defer_first_run: bool,
    ) -> Self {
        let last_run_at = defer_first_run.then(|| clock.now());
        IntegrityJob {
            verify,
            present: None,
            clock,
            rng,
            on_ok: None,
            last_run_at,
        }
    }

    /// `present`: whether the store exists (the job is skipped while it does not).
    pub fn with_present(mut self, present: Box<dyn FnMut() -> bool + 'a>) -> Self {
        self.present = Some(present);
        self
    }

    /// `onOk`: after a successful verify (announce due grants, sweep); it never fails the job.
    pub fn with_on_ok(mut self, on_ok: Box<dyn FnMut() + 'a>) -> Self {
        self.on_ok = Some(on_ok);
        self
    }

    /// `nextRunAt()`.
    pub fn next_run_at(&mut self) -> f64 {
        match self.last_run_at {
            None => self.clock.now() as f64,
            Some(last) => last as f64 + EVERY_MS * (1.0 + ((self.rng)() * 2.0 - 1.0) * JITTER),
        }
    }

    /// `validateArgs(args)`: nothing, `null` or an empty object; anything else is `E_INVALID_PARAMS` with this message.
    pub fn validate_args(args: Option<&Value>) -> Result<(), &'static str> {
        match args {
            None | Some(Value::Null) => Ok(()),
            Some(Value::Object(m)) if m.is_empty() => Ok(()),
            Some(Value::Object(_)) => Err("approvals.integrity takes no args"),
            Some(_) => Err("args must be an object"),
        }
    }

    /// `run(args, ctx)`: one check. A verify that fails to run is an error, as the rejected promise is in TypeScript.
    pub fn run(&mut self, aborted: bool) -> Result<Outcome, ApprovalError> {
        self.last_run_at = Some(self.clock.now());
        if aborted {
            return Ok(Outcome::Abandoned);
        }
        if let Some(present) = self.present.as_mut() {
            if !present() {
                return Ok(Outcome::Skipped);
            }
        }
        let v = (self.verify)()?;
        if !v.ok() {
            return Ok(Outcome::Failed(v));
        }
        if let Some(on_ok) = self.on_ok.as_mut() {
            // A sweep never fails the integrity job; a panic in it is the host's bug and is not caught here.
            on_ok();
        }
        Ok(Outcome::Completed(v))
    }
}
