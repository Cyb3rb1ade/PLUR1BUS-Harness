//! Media job execution over durable store, adapter, budget and clock ports.

use std::{
    collections::{hash_map::Entry, HashMap},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::units::{self, Invalid, Units};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Error {
    BackendUnavailable,
    Cancelled,
    ContentPolicy,
    Interrupted,
    InvalidResponse,
    Timeout,
    TooLarge,
    UnsupportedParameter,
    Storage,
}

impl From<Invalid> for Error {
    fn from(invalid: Invalid) -> Self {
        match invalid {
            Invalid::TooLarge => Self::TooLarge,
            Invalid::UnsupportedParameter => Self::UnsupportedParameter,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

impl State {
    fn runnable(self) -> bool {
        matches!(self, Self::Queued | Self::Running)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Operation {
    Generate,
    Edit,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AdapterOperation {
    Generate,
    Edit,
    Resume,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    Queued,
    Running,
    Downloading,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Progress {
    pub fraction: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<Stage>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Checkpoint {
    pub id: String,
    pub model: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub adapter: String,
    pub operation: Operation,
    pub request: Value,
    pub state: State,
    pub progress: Progress,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<Checkpoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Error>,
}

pub enum Update {
    Checkpoint(Checkpoint),
    Progress(Progress),
}

pub struct AdapterCall<'a> {
    pub adapter: &'a str,
    pub operation: AdapterOperation,
    pub request: &'a Value,
    pub checkpoint: Option<&'a Checkpoint>,
    /// The adapter transport observes this during blocking operations and returns
    /// the corresponding typed end reason before the caller proceeds.
    pub abort: &'a dyn Fn() -> Option<Error>,
}

/// Durable operations key on the job id. Reserve and settle are idempotent.
/// A successful publication is atomic and discoverable through find_output.
/// The host owns exclusive claims and never assumes a stale writer has exited.
pub trait Host: Sync {
    type Output;

    fn now_ms(&self) -> i64;
    fn job_id(&self) -> String;
    fn supports(&self, adapter: &str) -> bool;
    fn supports_resume(&self, adapter: &str) -> bool;
    fn load(&self, id: &str) -> Result<Option<Job>>;
    fn save(&self, job: &Job) -> Result<()>;
    fn list(&self) -> Result<Vec<Job>>;
    fn claim(&self, id: &str) -> Result<()>;
    fn release(&self, id: &str) -> Result<()>;
    fn find_output(&self, id: &str) -> Result<Option<Value>>;
    fn publish(&self, id: &str, request: &Value, output: Self::Output) -> Result<Value>;
    fn reserve(&self, id: &str, requested: Units) -> Result<()>;
    fn settle(&self, id: &str, delivered: Option<Units>) -> Result<()>;
    fn produce(
        &self,
        call: AdapterCall<'_>,
        update: &mut dyn FnMut(Update) -> Result<()>,
    ) -> Result<Self::Output>;
}

pub struct Runner<'a, H> {
    host: &'a H,
    active: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl<'a, H: Host> Runner<'a, H> {
    pub fn new(host: &'a H) -> Self {
        Self {
            host,
            active: Mutex::default(),
        }
    }

    pub fn enqueue(&self, adapter: &str, request: Value, operation: Operation) -> Result<Job> {
        units::requested(&request)?;
        if !self.host.supports(adapter) {
            return Err(Error::BackendUnavailable);
        }
        let now = self.host.now_ms();
        let job = Job {
            id: self.host.job_id(),
            adapter: adapter.into(),
            operation,
            request,
            state: State::Queued,
            progress: Progress {
                fraction: 0.,
                stage: Some(Stage::Queued),
            },
            created_at: now,
            updated_at: now,
            checkpoint: None,
            output: None,
            error: None,
        };
        self.host.save(&job)?;
        Ok(job)
    }

    pub fn cancel(&self, id: &str) -> Result<()> {
        if let Some(abort) = self.active.lock().map_err(|_| Error::Storage)?.get(id) {
            abort.store(true, Ordering::Release);
            return Ok(());
        }
        self.claimed(id, || {
            if let Some(mut job) = self.host.load(id)?.filter(|job| job.state == State::Queued) {
                if job.id != id {
                    return Err(Error::Storage);
                }
                job.state = State::Cancelled;
                self.save(&mut job)?;
            }
            Ok(())
        })
    }

    pub fn run(&self, id: &str, abort: &dyn Fn() -> Option<Error>) -> Result<()> {
        let cancelled = Arc::new(AtomicBool::new(false));
        match self
            .active
            .lock()
            .map_err(|_| Error::Storage)?
            .entry(id.into())
        {
            Entry::Occupied(_) => return Err(Error::BackendUnavailable),
            Entry::Vacant(entry) => {
                entry.insert(cancelled.clone());
            }
        }
        let combined = || {
            if cancelled.load(Ordering::Acquire) {
                Some(Error::Cancelled)
            } else {
                abort()
            }
        };
        let result = self.claimed(id, || self.run_claimed(id, &combined));
        self.active.lock().map_err(|_| Error::Storage)?.remove(id);
        result
    }

    pub fn recover(&self, abort: &dyn Fn() -> Option<Error>) -> Result<()> {
        let mut failure = None;
        for job in self
            .host
            .list()?
            .into_iter()
            .filter(|job| job.state.runnable())
        {
            if let Err(error @ Error::Storage) = self.run(&job.id, abort) {
                failure.get_or_insert(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }

    fn claimed(&self, id: &str, work: impl FnOnce() -> Result<()>) -> Result<()> {
        self.host.claim(id)?;
        let result = work();
        let release = self.host.release(id);
        result.and(release)
    }

    fn save(&self, job: &mut Job) -> Result<()> {
        job.updated_at = self.host.now_ms();
        self.host.save(job)
    }

    fn run_claimed(&self, id: &str, abort: &dyn Fn() -> Option<Error>) -> Result<()> {
        let Some(mut job) = self.host.load(id)?.filter(|job| job.state.runnable()) else {
            return Err(Error::UnsupportedParameter);
        };
        if job.id != id || !self.host.supports(&job.adapter) {
            return Err(Error::BackendUnavailable);
        }
        if let Some(output) = self.host.find_output(id)? {
            return self.finish(&mut job, output);
        }
        let mut reserved = false;
        let produced = self.produce(&mut job, abort, &mut reserved);
        match produced {
            Ok(output) => self.finish(&mut job, output),
            Err(error) => {
                job.error = Some(error);
                job.state = if error == Error::Cancelled {
                    State::Cancelled
                } else {
                    State::Failed
                };
                if reserved {
                    // The budget port keeps durable reconciliation if settlement fails.
                    let _ = self.host.settle(id, None);
                }
                self.save(&mut job)
            }
        }
    }

    fn produce(
        &self,
        job: &mut Job,
        abort: &dyn Fn() -> Option<Error>,
        reserved: &mut bool,
    ) -> Result<Value> {
        no_abort(abort)?;
        let operation = match (job.state, job.operation) {
            (State::Running, _)
                if job.checkpoint.is_none() || !self.host.supports_resume(&job.adapter) =>
            {
                return Err(Error::Interrupted);
            }
            (State::Running, _) => AdapterOperation::Resume,
            (_, Operation::Edit) => AdapterOperation::Edit,
            (_, Operation::Generate) => AdapterOperation::Generate,
        };
        self.host
            .reserve(&job.id, units::requested(&job.request)?)?;
        *reserved = true;
        job.state = State::Running;
        self.save(job)?;
        let adapter = job.adapter.clone();
        let request = job.request.clone();
        let checkpoint = job.checkpoint.clone();
        let output = self.host.produce(
            AdapterCall {
                adapter: &adapter,
                operation,
                request: &request,
                checkpoint: checkpoint.as_ref(),
                abort,
            },
            &mut |update| {
                no_abort(abort)?;
                match update {
                    Update::Checkpoint(checkpoint) => job.checkpoint = Some(checkpoint),
                    Update::Progress(progress) => {
                        if !(0.0..=1.0).contains(&progress.fraction) {
                            return Err(Error::InvalidResponse);
                        }
                        job.progress = progress;
                    }
                }
                self.save(job)
            },
        )?;
        no_abort(abort)?;
        self.host.publish(&job.id, &job.request, output)
    }

    fn finish(&self, job: &mut Job, output: Value) -> Result<()> {
        let files = output["files"].as_array().ok_or(Error::InvalidResponse)?;
        let durations: Vec<_> = files
            .iter()
            .map(|f| f["durationSeconds"].as_f64())
            .collect();
        let delivered = units::delivered(units::requested(&job.request)?, &durations)?;
        // A failed settle or terminal save leaves the running row recoverable via
        // the already published output. Retrying never resubmits the provider job.
        self.host.settle(&job.id, Some(delivered))?;
        job.output = Some(output);
        job.state = State::Succeeded;
        job.progress = Progress {
            fraction: 1.,
            stage: None,
        };
        self.save(job)
    }
}

fn no_abort(abort: &dyn Fn() -> Option<Error>) -> Result<()> {
    abort().map_or(Ok(()), Err)
}
