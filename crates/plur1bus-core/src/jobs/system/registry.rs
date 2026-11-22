//! `createSystemJobs` (`system-jobs/index.ts`): the registry of the jobs the core runs itself (no model, singleton), their
//! runs and the ledger that remembers them. A run is written to the ledger when it starts, so a core that stops in the middle
//! of one leaves a row that reads back as `abandoned`; when it ends, the record is written, and a ledger that cannot take it is
//! logged and never turns the run's result into a failure.
//!
//! `exclusive` is the registry-side lock: while a run of such a job is in flight, a further run of the same job is not started;
//! it is recorded as `skipped` / `already_running` with the `runningRunId` of the holder. The lock is in memory and
//! process-wide (`state/core.lock` keeps a second core off the same home). A handler that wants to see this lock work calls
//! [`SystemJobs::run`] again through the handle it is given in its [`RunContext`], the way another caller reaches the registry
//! while TypeScript's handler awaits.
use super::ledger::{SecureHook, StartedEntry, SystemJobsLedger, SystemRunRecord, Warn};
use crate::approvals::js_json::J;
use crate::budget::{Clock, IdSource};
use crate::jobs::JobsError;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

/// `SystemJobSpec`: `needsLlm` is false and `singleton` true for every system job.
#[derive(Clone, Debug, PartialEq)]
pub struct SystemJobSpec {
    /// The job name.
    pub name: String,
    /// `schedule.every`.
    pub every: f64,
    /// `schedule.jitter`.
    pub jitter: f64,
    /// The registry-side lock.
    pub exclusive: bool,
}

/// `SystemJobOutcome.outcome`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SystemOutcome {
    /// `completed`
    Completed,
    /// `skipped`
    Skipped,
    /// `failed`
    Failed,
    /// `abandoned`
    Abandoned,
    /// `incomplete`
    Incomplete,
}

impl SystemOutcome {
    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Skipped => "skipped",
            Self::Failed => "failed",
            Self::Abandoned => "abandoned",
            Self::Incomplete => "incomplete",
        }
    }
}

/// `SystemJobOutcome`.
#[derive(Clone, Debug)]
pub struct SystemJobOutcome {
    /// How the run ended.
    pub outcome: SystemOutcome,
    /// Why.
    pub reason: Option<String>,
    /// The holder of the lock a skipped run found.
    pub running_run_id: Option<String>,
    /// What the caller of `run` gets back beside the record.
    pub detail: J,
}

/// What a handler is told about the run it is in.
pub struct RunContext<'a> {
    /// The run id.
    pub run_id: String,
    /// `cron`, `manual` or `harness`.
    pub trigger: String,
    /// `signal.aborted`, set by whoever started the run.
    pub signal: Arc<AtomicBool>,
    /// The registry, for a handler that reaches it again while it runs.
    pub jobs: &'a SystemJobs,
}

/// `SystemJobHandler`.
pub trait SystemJobHandler {
    /// The job's spec.
    fn spec(&self) -> SystemJobSpec;
    /// When it wants to run next (epoch ms; not necessarily whole), or `None`.
    fn next_run_at(&self) -> Option<f64>;
    /// The arguments a run may take, as an object; `E_INVALID_PARAMS` for anything else. `None` is `undefined`.
    fn validate_args(&self, args: Option<&J>) -> Result<J, JobsError>;
    /// The run.
    fn run(&self, args: &J, ctx: &RunContext<'_>) -> Result<SystemJobOutcome, JobsError>;
}

/// What a caller says about a run.
pub struct RunOptions {
    /// `cron`, `manual` or `harness`.
    pub trigger: String,
    /// `signal`; a run without one gets a signal that never fires.
    pub signal: Option<Arc<AtomicBool>>,
}

/// `SystemJobEntry` as `list()` gives it.
#[derive(Clone, Debug, PartialEq)]
pub struct SystemJobEntry {
    /// The job name.
    pub name: String,
    /// `schedule.every`.
    pub every: f64,
    /// `schedule.jitter`.
    pub jitter: f64,
    /// The next run the handler wants.
    pub next_run_at: Option<f64>,
}

impl SystemJobEntry {
    /// The entry as TypeScript lists it.
    pub fn to_j(&self) -> J {
        J::obj([
            ("name", J::s(&self.name)),
            ("kind", J::s("system")),
            ("needsLlm", J::Bool(false)),
            ("singleton", J::Bool(true)),
            (
                "schedule",
                J::obj([
                    ("every", J::Num(self.every)),
                    ("jitter", J::Num(self.jitter)),
                ]),
            ),
            ("nextRunAt", self.next_run_at.map_or(J::Null, J::Num)),
        ])
    }
}

/// `onRecorded` and `onFailed`: a throw is ignored.
pub type RecordedPort = Box<dyn Fn(&SystemRunRecord) -> Result<(), JobsError>>;

/// `CreateSystemJobsOptions`.
pub struct CreateSystemJobsOptions {
    /// `state/system-jobs/ledger.jsonl`.
    pub ledger_path: PathBuf,
    /// The clock (`clock.now()`).
    pub clock: Arc<dyn Clock>,
    /// `randomUUID()`: run ids.
    pub ids: Arc<dyn IdSource>,
    /// The platform's owner-only hook.
    pub secure_path: SecureHook,
    /// `logger.warn`.
    pub warn: Warn,
    /// `engineHasJob(name)`: a name the engine already uses cannot be registered.
    pub engine_has_job: Box<dyn Fn(&str) -> bool>,
    /// Called after a run was recorded.
    pub on_recorded: Option<RecordedPort>,
    /// Called after a run was recorded as failed (the inbox's job-failed notice).
    pub on_failed: Option<RecordedPort>,
}

/// `SystemJobs`.
pub struct SystemJobs {
    o: CreateSystemJobsOptions,
    handlers: RefCell<Vec<(String, Rc<dyn SystemJobHandler>)>>,
    in_flight: RefCell<HashSet<String>>,
    /// job name -> run id holding the registry lock of an `exclusive` job.
    holders: RefCell<HashMap<String, String>>,
    ledger: SystemJobsLedger,
}

/// The query of `history`.
#[derive(Clone, Copy, Debug, Default)]
pub struct HistoryQuery<'a> {
    /// Only this job (an empty name is no filter).
    pub job: Option<&'a str>,
    /// Only runs that finished at or after this instant.
    pub since: Option<f64>,
    /// At most this many (a negative or `NaN` limit is no limit).
    pub limit: Option<f64>,
}

impl SystemJobs {
    /// `createSystemJobs(options)`.
    pub fn new(mut o: CreateSystemJobsOptions) -> Self {
        let hook = std::mem::replace(&mut o.secure_path, Box::new(|_| true));
        let ledger = SystemJobsLedger::new(o.ledger_path.clone(), hook, Rc::clone(&o.warn));
        Self {
            o,
            handlers: RefCell::new(Vec::new()),
            in_flight: RefCell::new(HashSet::new()),
            holders: RefCell::new(HashMap::new()),
            ledger,
        }
    }

    /// `register(handler)`.
    pub fn register(&self, h: Rc<dyn SystemJobHandler>) -> Result<(), JobsError> {
        let name = h.spec().name;
        if (self.o.engine_has_job)(&name) {
            return Err(JobsError::Other(format!(
                "job name conflict: engine already has job {name}"
            )));
        }
        if self.has(&name) {
            return Err(JobsError::Other(format!(
                "system job already registered: {name}"
            )));
        }
        self.handlers.borrow_mut().push((name, h));
        Ok(())
    }

    /// `has(name)`.
    pub fn has(&self, name: &str) -> bool {
        self.handlers.borrow().iter().any(|(n, _)| n == name)
    }

    /// `list()`: in the order of registration.
    pub fn list(&self) -> Vec<SystemJobEntry> {
        let handlers: Vec<Rc<dyn SystemJobHandler>> = self
            .handlers
            .borrow()
            .iter()
            .map(|(_, h)| Rc::clone(h))
            .collect();
        handlers
            .iter()
            .map(|h| {
                let s = h.spec();
                SystemJobEntry {
                    name: s.name,
                    every: s.every,
                    jitter: s.jitter,
                    next_run_at: h.next_run_at(),
                }
            })
            .collect()
    }

    /// `safeFinish`: the run already happened, so a ledger fault when recording its end is logged and nothing more.
    fn safe_finish(&self, record: &SystemRunRecord) {
        if let Err(e) = self.ledger.finish(record) {
            (self.o.warn)(
                "failed to record the end of a system job run in the ledger",
                &J::obj([
                    ("runId", J::s(&record.run_id)),
                    ("job", J::s(&record.job)),
                    ("error", J::Str(format!("Error: {e}"))),
                ]),
            );
        }
    }

    /// `run(name, args, { trigger, signal })`.
    pub fn run(
        &self,
        name: &str,
        raw_args: Option<&J>,
        o: &RunOptions,
    ) -> Result<(SystemRunRecord, J), JobsError> {
        let handler = self
            .handlers
            .borrow()
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, h)| Rc::clone(h));
        let Some(handler) = handler else {
            return Err(JobsError::Rpc {
                code: "E_INVALID_PARAMS",
                message: format!("unknown system job {name}"),
                detail: Some(serde_json::json!({"detail": "job"})),
            });
        };
        let validated = handler.validate_args(raw_args)?;
        let run_id = self.o.ids.next_id();
        let started_at = self.o.clock.now();
        // A snapshot: the handler gets the live object and may mutate it; the record must say what was started.
        let args_to_store = match &validated {
            J::Obj(m) if !m.is_empty() => Some(validated.clone()),
            _ => None,
        };
        self.ledger.begin(&StartedEntry {
            run_id: run_id.clone(),
            job: name.to_owned(),
            trigger: o.trigger.clone(),
            started_at: started_at as f64,
            args: args_to_store.clone(),
        })?;
        self.in_flight.borrow_mut().insert(run_id.clone());
        let result = self.run_inner(
            &*handler,
            name,
            &validated,
            &run_id,
            started_at,
            args_to_store.as_ref(),
            o,
        );
        self.in_flight.borrow_mut().remove(&run_id);
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn run_inner(
        &self,
        handler: &dyn SystemJobHandler,
        name: &str,
        args: &J,
        run_id: &str,
        started_at: i64,
        args_to_store: Option<&J>,
        o: &RunOptions,
    ) -> Result<(SystemRunRecord, J), JobsError> {
        let exclusive = handler.spec().exclusive;
        // Check and take the lock in one step: nothing else runs between the two.
        let holder = if exclusive {
            self.holders.borrow().get(name).cloned()
        } else {
            None
        };
        let outcome = match holder {
            Some(h) => Ok(SystemJobOutcome {
                outcome: SystemOutcome::Skipped,
                reason: Some("already_running".into()),
                running_run_id: Some(h),
                detail: J::Null,
            }),
            None => {
                if exclusive {
                    self.holders
                        .borrow_mut()
                        .insert(name.to_owned(), run_id.to_owned());
                }
                let ctx = RunContext {
                    run_id: run_id.to_owned(),
                    trigger: o.trigger.clone(),
                    signal: o.signal.clone().unwrap_or_default(),
                    jobs: self,
                };
                let r = handler.run(args, &ctx);
                if self.holders.borrow().get(name).map(String::as_str) == Some(run_id) {
                    self.holders.borrow_mut().remove(name);
                }
                r
            }
        };
        // The system clock may step back during a run: a record never finishes before it started.
        let finished_at = started_at.max(self.o.clock.now());
        let duration_ms = finished_at - started_at;
        let record = |outcome: &str, reason: Option<J>, running: Option<J>| SystemRunRecord {
            run_id: run_id.to_owned(),
            job: name.to_owned(),
            trigger: Some(J::s(&o.trigger)),
            started_at: started_at as f64,
            finished_at: finished_at as f64,
            duration_ms: duration_ms as f64,
            outcome: outcome.to_owned(),
            reason,
            running_run_id: running,
            args: args_to_store.cloned(),
        };
        match outcome {
            Ok(out) => {
                let rec = record(
                    out.outcome.as_str(),
                    out.reason.as_deref().map(J::s),
                    out.running_run_id.as_deref().map(J::s),
                );
                self.safe_finish(&rec);
                if let Some(f) = &self.o.on_recorded {
                    let _ = f(&rec);
                }
                if rec.outcome == "failed" {
                    if let Some(f) = &self.o.on_failed {
                        let _ = f(&rec);
                    }
                }
                Ok((rec, out.detail))
            }
            Err(err) => {
                let failed = record("failed", Some(J::s("exception")), None);
                self.safe_finish(&failed);
                if let Some(f) = &self.o.on_failed {
                    let _ = f(&failed);
                }
                Err(err)
            }
        }
    }

    /// `history(query)`: newest first.
    pub fn history(&self, q: &HistoryQuery<'_>) -> Vec<SystemRunRecord> {
        let mut runs = self.ledger.read_all(&self.in_flight.borrow());
        runs.reverse();
        if let Some(job) = q.job.filter(|j| !j.is_empty()) {
            runs.retain(|r| r.job == job);
        }
        if let Some(since) = q.since {
            // `r.finishedAt >= since`: false for a `NaN` bound.
            runs.retain(|r| r.finished_at >= since);
        }
        if let Some(limit) = q.limit.filter(|l| *l >= 0.0) {
            runs.truncate(if limit.is_infinite() {
                usize::MAX
            } else {
                limit.trunc() as usize
            });
        }
        runs
    }
}
