//! Authenticated, bounded NDJSON engine server and the process lifecycle it owns.

use std::collections::HashMap;
use std::fmt;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use plur1bus_rpc::server_transport::{Accepted, Listener};
use serde_json::{json, Map, Value};

use super::diagnostics::{self, Lifecycle, Reason, Stage};
use super::layout::EngineLayout;
use super::lifeline::{Lifeline, Watch};
use super::methods::{self, WireError};
use crate::contract::{AgentId, AgentStoreHandle, Cancel, CaptureHandle, CaptureResult, Engine};

use crate::contract::{MaintenanceGrant, MaintenanceMethod, MaintenanceOps};
use crate::contract::{SnapshotGrant, SnapshotMethod, SnapshotOps};

/// Proof created only after this adapter has authenticated the actual Core link.
pub(crate) struct AuthenticatedCoreLink {
    instance: String,
    cancellation: Cancel,
}
impl AuthenticatedCoreLink {
    pub(crate) fn instance(&self) -> &str {
        &self.instance
    }
    pub(crate) fn cancellation(&self) -> &Cancel {
        &self.cancellation
    }
}

const TICK: Duration = Duration::from_millis(25);
const MAX_CONNECTIONS: usize = 64;
const MAX_IN_FLIGHT: usize = 8;
const MAX_PENDING_CAPTURES: usize = 128;
const MAX_CAPTURES: usize = 256;
const ACCEPT_BACKOFF: Duration = Duration::from_millis(50);
const CAPTURE_RETENTION: Duration = Duration::from_secs(1800);
const STOP_BUDGET: Duration = Duration::from_secs(30);
const MAX_OUTBOUND_FRAMES: usize = 8;
const MAX_OUTBOUND_BYTES: usize = 8 * 1024 * 1024;

/// A bounded server-start or transport failure. A live owner is never terminated here.
#[derive(Debug)]
pub enum ServeError {
    /// Another engine owns this home's nonce lock or endpoint.
    Locked,
    /// Local setup or transport failed.
    Io(io::Error),
    /// The checked-in wire schema could not be compiled.
    Schema,
}
impl From<io::Error> for ServeError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}
impl fmt::Display for ServeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Locked => "another engine owns this home",
            Self::Io(_) => "engine local transport failed",
            Self::Schema => "invalid embedded RPC schema",
        })
    }
}
impl std::error::Error for ServeError {}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}
fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

// Test injection stays above the unchanged shared transport interface.
#[derive(Default)]
pub(super) struct ServerOptions {
    pub(super) permission_denied_accept: bool,
    pub(super) maintenance: Option<Arc<dyn MaintenanceOps>>,
    pub(super) snapshots: Option<Arc<dyn SnapshotOps>>,
    pub(super) store_base: Option<PathBuf>,
    pub(super) job_host: Option<Arc<super::host_client::RpcHost>>,
    pub(super) process: Option<Arc<super::engine::ProcessEngine>>,
    #[cfg(test)]
    pub(super) accept_errors: usize,
    #[cfg(test)]
    pub(super) fail_spawn: Option<&'static str>,
    #[cfg(test)]
    pub(super) block_first_notification: Option<Arc<super::engine::testkit::FixtureGate>>,
}

struct WorkerStarter {
    #[cfg(test)]
    fail_name: Option<&'static str>,
    #[cfg(test)]
    failures: AtomicUsize,
}
impl WorkerStarter {
    fn new(_options: &ServerOptions) -> Self {
        Self {
            #[cfg(test)]
            fail_name: _options.fail_spawn,
            #[cfg(test)]
            failures: AtomicUsize::new(1),
        }
    }
    fn spawn<F>(&self, name: &'static str, work: F) -> io::Result<JoinHandle<()>>
    where
        F: FnOnce() + Send + 'static,
    {
        #[cfg(test)]
        if self.fail_name == Some(name)
            && self
                .failures
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |left| {
                    left.checked_sub(1)
                })
                .is_ok()
        {
            return Err(io::Error::other("engine worker unavailable"));
        }
        thread::Builder::new().name(name.into()).spawn(work)
    }
}

struct ServerListener {
    inner: Listener,
    permission_denied: AtomicBool,
    #[cfg(test)]
    errors: AtomicUsize,
    #[cfg(test)]
    notification_gate: Mutex<Option<Arc<super::engine::testkit::FixtureGate>>>,
}

#[cfg(test)]
struct BlockedNotificationWriter {
    inner: Box<dyn Write + Send>,
    gate: Arc<super::engine::testkit::FixtureGate>,
    blocked: bool,
}
#[cfg(test)]
impl Write for BlockedNotificationWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if !self.blocked
            && serde_json::from_slice::<Value>(bytes)
                .is_ok_and(|message| message["method"] == "engine.capture.done")
        {
            self.blocked = true;
            self.gate.block();
        }
        self.inner.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}
impl ServerListener {
    fn accept_timeout(&self, timeout: Duration) -> io::Result<Option<Accepted>> {
        if self.permission_denied.swap(false, Ordering::AcqRel) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "injected accept failure",
            ));
        }
        #[cfg(test)]
        if self
            .errors
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |left| {
                left.checked_sub(1)
            })
            .is_ok()
        {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "injected accept failure",
            ));
        }
        let accepted = self.inner.accept_timeout(timeout)?;
        #[cfg(test)]
        let accepted = accepted.map(|mut accepted| {
            if let Some(gate) = lock(&self.notification_gate).take() {
                accepted.writer = Box::new(BlockedNotificationWriter {
                    inner: accepted.writer,
                    gate,
                    blocked: false,
                });
            }
            accepted
        });
        Ok(accepted)
    }
}

struct Capture {
    done: Mutex<Option<std::sync::mpsc::Receiver<CaptureResult>>>,
    connection: Weak<Connection>,
    completed: Mutex<Option<(Result<CaptureResult, WireError>, Instant)>>,
    changed: Condvar,
    abort: Box<dyn Fn(Option<String>) + Send + Sync>,
}

struct CaptureReservation<'a> {
    pending: &'a AtomicUsize,
    committed: bool,
}
impl Drop for CaptureReservation<'_> {
    fn drop(&mut self) {
        if !self.committed {
            self.pending.fetch_sub(1, Ordering::AcqRel);
        }
    }
}

struct Connection {
    id: u64,
    accepted_at: Instant,
    writer: Mutex<Box<dyn Write + Send>>,
    outbound: std::sync::mpsc::SyncSender<OutboundFrame>,
    outbound_budget: Arc<OutboundBudget>,
    closer: Arc<dyn Fn() + Send + Sync>,
    cancel: Cancel,
    authenticated: AtomicBool,
    peer_pid: Option<u32>,
    agents: Mutex<HashMap<String, Vec<AgentStoreHandle>>>,
}

#[derive(Default)]
struct OutboundBudget {
    frames: AtomicUsize,
    bytes: AtomicUsize,
}

struct OutboundFrame {
    bytes: Vec<u8>,
    budget: Arc<OutboundBudget>,
}
impl Drop for OutboundFrame {
    fn drop(&mut self) {
        self.budget
            .bytes
            .fetch_sub(self.bytes.len() + 1, Ordering::AcqRel);
        self.budget.frames.fetch_sub(1, Ordering::AcqRel);
    }
}

impl OutboundBudget {
    fn reserve(self: &Arc<Self>, bytes: Vec<u8>) -> io::Result<OutboundFrame> {
        self.frames
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < MAX_OUTBOUND_FRAMES).then_some(count + 1)
            })
            .map_err(|_| {
                io::Error::new(io::ErrorKind::WouldBlock, "engine notification queue full")
            })?;
        if self
            .bytes
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                count
                    .checked_add(bytes.len() + 1)
                    .filter(|total| *total <= MAX_OUTBOUND_BYTES)
            })
            .is_err()
        {
            self.frames.fetch_sub(1, Ordering::AcqRel);
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "engine notification byte limit reached",
            ));
        }
        Ok(OutboundFrame {
            bytes,
            budget: self.clone(),
        })
    }
}

struct FrameBuffer {
    bytes: Vec<u8>,
    full: bool,
}
impl Write for FrameBuffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.bytes.len().saturating_add(bytes.len()) > plur1bus_rpc::client::MAX_LINE {
            self.full = true;
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "engine frame exceeds limit",
            ));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn frame_bytes(value: &Value) -> io::Result<Vec<u8>> {
    let mut frame = FrameBuffer {
        bytes: Vec::new(),
        full: false,
    };
    if let Err(error) = serde_json::to_writer(&mut frame, value) {
        return Err(if frame.full {
            io::Error::new(io::ErrorKind::InvalidData, "engine frame exceeds limit")
        } else {
            io::Error::other(error)
        });
    }
    Ok(frame.bytes)
}

impl Connection {
    // This path only serializes and enqueues; peer I/O belongs to its writer worker.
    fn notify(&self, value: &Value) -> io::Result<()> {
        if self.cancel.is_cancelled() {
            return Err(io::Error::new(
                io::ErrorKind::NotConnected,
                "engine peer closed",
            ));
        }
        let bytes = frame_bytes(value)?;
        let frame = match self.outbound_budget.reserve(bytes) {
            Ok(frame) => frame,
            Err(error) => {
                self.close();
                return Err(error);
            }
        };
        match self.outbound.try_send(frame) {
            Ok(()) => Ok(()),
            Err(error) => {
                // The frame's reservation refunds both counters on every drop
                // path, including disconnected receivers and failed writes.
                drop(error);
                self.close();
                Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "engine notification queue unavailable",
                ))
            }
        }
    }
    fn send_bytes(&self, bytes: &[u8]) -> io::Result<()> {
        let mut writer = lock(&self.writer);
        writer.write_all(bytes)?;
        writer.write_all(b"\n")?;
        writer.flush()
    }
    fn reply(&self, id: Value, result: Result<Value, WireError>) {
        let mut response = match result {
            Ok(result) => json!({"jsonrpc":"2.0","result":result}),
            Err(error) => {
                let mut data = json!({"error":error.error,"reason":error.reason});
                if let Some(ids) = error.ids {
                    data["ids"] = json!(ids);
                }
                json!({"jsonrpc":"2.0","error":{"code":error.code,"message":error.message,"data":data}})
            }
        };
        response["id"] = id;
        let bytes = frame_bytes(&response).or_else(|failure| {
            if failure.kind() != io::ErrorKind::InvalidData { return Err(failure); }
            let error = WireError::response_too_large();
            frame_bytes(&json!({"jsonrpc":"2.0","id":response["id"],"error":{"code":error.code,"message":error.message,"data":{"error":error.error,"reason":error.reason}}}))
        });
        if bytes.and_then(|bytes| self.send_bytes(&bytes)).is_err() {
            (self.closer)();
        }
    }
    fn close(&self) {
        self.cancel.cancel();
        (self.closer)();
    }
    fn close_agents(&self) {
        for handles in lock(&self.agents).drain().map(|(_, v)| v) {
            for handle in handles {
                let _ = (handle.close)();
            }
        }
    }
}

struct Shared {
    engine: Arc<dyn Engine>,
    process: Option<Arc<super::engine::ProcessEngine>>,
    job_host: Option<Arc<super::host_client::RpcHost>>,
    maintenance: Option<Arc<dyn MaintenanceOps>>,
    snapshots: Option<Arc<dyn SnapshotOps>>,
    home: PathBuf,
    token: String,
    instance: String,
    stopping: AtomicBool,
    stop_deadline: Mutex<Option<Instant>>,
    stop_reason: Mutex<Option<Reason>>,
    starter: WorkerStarter,
    watch: Mutex<Watch>,
    orphaned_since: AtomicU64,
    requests: AtomicU64,
    auth_failures: AtomicU64,
    accept_errors: AtomicU64,
    spawn_errors: AtomicU64,
    scheduler_lag_us: AtomicU64,
    connections: Mutex<HashMap<u64, Weak<Connection>>>,
    captures: Mutex<HashMap<String, Arc<Capture>>>,
    capture_pending: AtomicUsize,
    capture_changed: Condvar,
    validators: Validation,
}

impl Shared {
    fn spawn_failed(&self, error: &io::Error) {
        let count = self.spawn_errors.fetch_add(1, Ordering::Relaxed) + 1;
        if count.is_power_of_two() {
            diagnostics::failure(Stage::Spawn, error);
        }
    }
    fn stop(&self, budget: Duration, reason: Reason) {
        self.prepare_stop(budget, reason);
        self.stopping.store(true, Ordering::Release);
        self.capture_changed.notify_all();
    }

    fn prepare_stop(&self, budget: Duration, reason: Reason) {
        let mut deadline = lock(&self.stop_deadline);
        if deadline.is_none() {
            *deadline = Some(Instant::now() + budget);
            *lock(&self.stop_reason) = Some(reason);
            diagnostics::lifecycle(Lifecycle::Stopping, reason);
        }
    }

    fn status(&self) -> Value {
        let mut status = serde_json::to_value(self.engine.status()).unwrap_or(Value::Null);
        let since = self.orphaned_since.load(Ordering::Acquire);
        status["rpc"] = json!(plur1bus_rpc::RPC_VERSION);
        status["pid"] = json!(std::process::id());
        status["instanceId"] = json!(self.instance);
        status["process"] = json!({"state":if self.stopping.load(Ordering::Acquire) {"stopping"} else if since > 0 {"orphaned"} else {"ready"},"orphanedSince":if since == 0 {Value::Null} else {json!(since)}});
        let captures = lock(&self.captures);
        let completed = captures
            .values()
            .filter(|c| lock(&c.completed).is_some())
            .count();
        status["counters"] = json!({"requests":self.requests.load(Ordering::Relaxed),"authFailures":self.auth_failures.load(Ordering::Relaxed),"acceptErrors":self.accept_errors.load(Ordering::Relaxed),"activeConnections":lock(&self.connections).len(),"capturesPending":captures.len()-completed,"capturesCompleted":completed});
        status["schedulerLagMs"] =
            json!(self.scheduler_lag_us.load(Ordering::Relaxed) as f64 / 1000.0);
        status
    }

    fn capture(&self, connection: &Arc<Connection>, params: &Value) -> Result<Value, WireError> {
        self.capture_pending
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |pending| {
                (pending < MAX_PENDING_CAPTURES).then_some(pending + 1)
            })
            .map_err(|_| WireError::engine_busy())?;
        let mut reservation = CaptureReservation {
            pending: &self.capture_pending,
            committed: false,
        };
        // Native callbacks run without the receipt-map lock.
        let turn: crate::contract::TurnRecord = decode(&params["turn"])?;
        let options = decode(params.get("options").unwrap_or(&json!({})))?;
        let handle = if let Some(items) = params.get("messageMetadata") {
            self.live_core_instance(connection)?;
            let process = self.process.as_ref().ok_or_else(WireError::not_available)?;
            let metadata: Vec<crate::neo::turn_batch::MessageMetadata> = decode(items)?;
            if !crate::neo::turn_batch::valid_metadata(&turn.messages, &metadata) {
                return Err(WireError::invalid_params());
            }
            process.capture_host_turn(turn, options, Some(metadata))?
        } else {
            self.engine.capture(turn, options)?
        };
        let CaptureHandle {
            id,
            accepted_at,
            done,
            abort,
        } = handle;
        let mut captures = lock(&self.captures);
        captures.retain(|_, c| {
            lock(&c.completed)
                .as_ref()
                .is_none_or(|(_, at)| at.elapsed() < CAPTURE_RETENTION)
        });
        if captures.contains_key(&id) {
            drop(captures);
            abort(Some("duplicate-receipt".into()));
            return Err(WireError::internal());
        }
        while captures.len() >= MAX_CAPTURES {
            let oldest = captures
                .iter()
                .filter_map(|(id, entry)| {
                    lock(&entry.completed)
                        .as_ref()
                        .map(|(_, at)| (id.clone(), *at))
                })
                .min_by_key(|(_, at)| *at)
                .map(|(id, _)| id);
            let Some(oldest) = oldest else {
                return Err(WireError::engine_busy());
            };
            captures.remove(&oldest);
        }
        captures.insert(
            id.clone(),
            Arc::new(Capture {
                done: Mutex::new(Some(done)),
                connection: Arc::downgrade(connection),
                completed: Mutex::new(None),
                changed: Condvar::new(),
                abort,
            }),
        );
        reservation.committed = true;
        self.capture_changed.notify_one();
        Ok(json!({"id":id,"acceptedAt":accepted_at}))
    }

    fn capture_wait(&self, params: &Value, cancel: &Cancel) -> Result<Value, WireError> {
        let entry = lock(&self.captures)
            .get(
                params["id"]
                    .as_str()
                    .ok_or_else(WireError::invalid_params)?,
            )
            .cloned()
            .ok_or_else(WireError::not_available)?;
        let timeout = params["timeoutMs"]
            .as_f64()
            .unwrap_or(30_000.0)
            .clamp(0.0, 120_000.0);
        let deadline = Instant::now() + Duration::from_secs_f64(timeout / 1000.0);
        let mut result = lock(&entry.completed);
        loop {
            if let Some((value, _)) = &*result {
                return value.clone().and_then(encode);
            }
            cancel.check().map_err(crate::contract::EngineError::from)?;
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Ok(json!({"pending":true}));
            }
            result = entry
                .changed
                .wait_timeout(result, left.min(TICK))
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .0;
        }
    }

    /// Core can bootstrap its EngineClient before publishing its PID file. Check the
    /// authenticated socket's actual peer at every maintenance or snapshot call.
    fn core_instance(&self, connection: &Connection) -> Result<uuid::Uuid, WireError> {
        connection
            .peer_pid
            .and_then(|pid| super::host_client::core_instance_for_peer(&self.home, pid))
            .ok_or_else(|| unauthorized("core-link-required"))
    }

    /// Verify a direct Core or the live child Core behind the Rust front door.
    fn live_core_instance(&self, connection: &Connection) -> Result<uuid::Uuid, WireError> {
        connection
            .peer_pid
            .and_then(|pid| super::host_client::live_core_instance_for_peer(&self.home, pid))
            .ok_or_else(|| unauthorized("core-link-required"))
    }

    fn run_job(&self, connection: &Connection, params: &Value) -> Result<Value, WireError> {
        use crate::contract::{AgentContext, JobName, RunOptions, TurnOrigin};
        let (Some(process), Some(host)) = (&self.process, &self.job_host) else {
            return methods::dispatch(
                self.engine.as_ref(),
                "engine.jobs.run",
                params,
                &connection.cancel,
            );
        };
        let job: JobName = decode(&params["job"])?;
        if !process.job_needs_authority(job) {
            return methods::dispatch(
                self.engine.as_ref(),
                "engine.jobs.run",
                params,
                &connection.cancel,
            );
        }
        self.live_core_instance(connection)?;
        let agent: AgentId = decode(&params["agentId"])?;
        let opts = RunOptions {
            trigger: params.get("trigger").map(decode).transpose()?,
            dry_run: params.get("dryRun").map(decode).transpose()?,
        };
        let refuse = || crate::jobs::authority::unbound();
        let dry_run = opts.dry_run == Some(true);
        if let Some(principals) = host
            .job_principals(&agent, job, dry_run, &connection.cancel)
            .map_err(|_| refuse())?
        {
            use crate::jobs::registry::aggregate_runs;
            if principals.is_empty() || (!crate::jobs::each_person(job) && principals.len() > 1) {
                return Err(refuse().into());
            }
            let mut authorities = Vec::new();
            let mut seen = std::collections::HashSet::new();
            for principal in principals {
                let authority = crate::jobs::authority::JobAuthority::from_host(
                    host.as_ref(),
                    job,
                    &agent,
                    principal.clone(),
                    AgentContext {
                        background: true,
                        job_id: Some(job.to_string()),
                        origin: TurnOrigin::Cron,
                        parent_run_id: None,
                    },
                    crate::context::RouteVocabulary::shared(),
                )?;
                if !seen.insert(authority.request().owner_user_id.clone()) {
                    return Err(refuse().into());
                }
                let host = host.clone();
                let agent = agent.clone();
                let principal = encode(principal)?;
                authorities.push(authority.with_private_diary().with_recheck(move |cancel| {
                    let current = host
                        .job_principals(&agent, job, true, cancel)
                        .map_err(|_| refuse())?;
                    if current.is_some_and(|principals| {
                        principals.into_iter().any(|candidate| {
                            serde_json::to_value(candidate)
                                .is_ok_and(|candidate| candidate == principal)
                        })
                    }) {
                        Ok(())
                    } else {
                        Err(refuse())
                    }
                }));
            }
            let due = params["dueId"].as_str();
            let mut runs = Vec::new();
            let mut first_error = None;
            let mut owner_completed = false;
            let mut first_batch = true;
            let mut pending = authorities.into_iter();
            while let Some(first) = pending.next() {
                let second = pending.next();
                let execute = |authority: crate::jobs::authority::JobAuthority| {
                    let budget = connection
                        .cancel
                        .limited_to(Instant::now() + Duration::from_secs(300));
                    authority.check(&budget)?;
                    process.run_partitioned_job(authority, opts.clone(), &budget, due)
                };
                let first_slot = process.person_job_slot(&agent, &connection.cancel)?;
                let (first, second) = thread::scope(|scope| {
                    let second = second.map(|authority| {
                        scope.spawn(|| {
                            let _slot = process.person_job_slot(&agent, &connection.cancel)?;
                            execute(authority)
                        })
                    });
                    let first = execute(first);
                    drop(first_slot);
                    (first, second.map(|task| task.join()))
                });
                if first_batch {
                    owner_completed = first
                        .as_ref()
                        .is_ok_and(|run| run.outcome == crate::contract::JobOutcome::Completed);
                    first_batch = false;
                }
                for result in
                    std::iter::once(first.map_err(WireError::from)).chain(second.map(|result| {
                        result
                            .map_err(|_| WireError::not_available())
                            .and_then(|run| run.map_err(WireError::from))
                    }))
                {
                    match result {
                        Ok(run) => runs.push(run),
                        Err(error) => {
                            first_error.get_or_insert(error);
                        }
                    }
                }
            }
            if runs.is_empty() {
                return Err(first_error.unwrap_or_else(|| refuse().into()));
            }
            let mut run = aggregate_runs(runs)?;
            if first_error.is_some() && run.outcome != crate::contract::JobOutcome::Failed {
                run.outcome = crate::contract::JobOutcome::Incomplete;
                run.reason = Some("partition-incomplete".into());
            }
            if job == JobName::ConsolidateDaily && owner_completed {
                // Owner-only promotion is an independent scheduled job sharing the daily due.
                // Its own authorization and partition deduplicate it even on retries.
                let mut promotion = params.clone();
                promotion["job"] = json!(JobName::KnowledgeUpdate);
                match self.run_job(connection, &promotion) {
                    Ok(result) => {
                        for (source, target) in [
                            ("promoted", "knowledgePromoted"),
                            ("skipped", "knowledgeSkipped"),
                        ] {
                            if let Some(count) = result["counts"][source].as_u64() {
                                run.counts.insert(target.into(), count.into());
                            }
                        }
                        if result["outcome"] == "failed" || result["outcome"] == "incomplete" {
                            run.outcome = serde_json::from_value(result["outcome"].clone())
                                .map_err(|_| WireError::invalid_params())?;
                            run.reason = result["reason"].as_str().map(str::to_owned);
                        }
                    }
                    Err(error) if error.reason == crate::jobs::authority::AUTHORITY_UNBOUND => {}
                    Err(error) => return Err(error),
                }
            }
            return encode(run);
        }
        let principal = host
            .job_principal(&agent, job, opts.dry_run == Some(true), &connection.cancel)
            .map_err(|_| refuse())?
            .ok_or_else(refuse)?;
        connection
            .cancel
            .check()
            .map_err(crate::contract::EngineError::from)?;
        let context = AgentContext {
            background: true,
            job_id: Some(job.to_string()),
            origin: TurnOrigin::Cron,
            parent_run_id: None,
        };
        let authority = crate::jobs::authority::JobAuthority::from_host(
            host.as_ref(),
            job,
            &agent,
            principal,
            context,
            crate::context::RouteVocabulary::shared(),
        )?;
        encode(process.run_authorized_job(
            authority.with_private_diary(),
            opts,
            &connection.cancel,
        )?)
    }

    /// Invalid parameters for a snapshot method: the Core link is checked first (anyone else
    /// is refused without an audit line), then the refusal is audited and answered as invalid.
    fn refuse_snapshot(&self, connection: &Connection, method: SnapshotMethod) -> WireError {
        let instance = match self.core_instance(connection) {
            Ok(instance) => instance,
            Err(error) => return error,
        };
        let Some(port) = self.snapshots.as_deref() else {
            return WireError::not_available();
        };
        // A stopping server starts no audit step, like every other call after the stop.
        if self.stopping.load(Ordering::Acquire) {
            return WireError::not_available();
        }
        let link = AuthenticatedCoreLink {
            instance: format!("{instance}:{}", connection.id),
            cancellation: connection.cancel.clone(),
        };
        let grant = SnapshotGrant::from_authenticated_core_link(&link);
        methods::refuse_snapshot(port, method, &grant, &connection.cancel)
    }

    fn call(
        &self,
        connection: &Arc<Connection>,
        method: &str,
        params: &Value,
    ) -> Result<Value, WireError> {
        if let Some(method) = MaintenanceMethod::from_wire(method) {
            let instance = self.core_instance(connection)?;
            let port = self
                .maintenance
                .as_deref()
                .ok_or_else(WireError::not_available)?;
            let link = AuthenticatedCoreLink {
                instance: format!("{instance}:{}", connection.id),
                cancellation: connection.cancel.clone(),
            };
            let grant = MaintenanceGrant::from_authenticated_core_link(&link);
            return methods::dispatch_maintenance(port, method, params, &grant, &connection.cancel);
        }
        if let Some(method) = SnapshotMethod::from_wire(method) {
            // RE-D170: the same per-call peer binding, a separate grant and allowlist.
            let instance = self.core_instance(connection)?;
            let port = self
                .snapshots
                .as_deref()
                .ok_or_else(WireError::not_available)?;
            let link = AuthenticatedCoreLink {
                instance: format!("{instance}:{}", connection.id),
                cancellation: connection.cancel.clone(),
            };
            let grant = SnapshotGrant::from_authenticated_core_link(&link);
            return methods::dispatch_snapshot(port, method, params, &grant, &connection.cancel);
        }
        match method {
            "engine.status" => Ok(self.status()),
            "engine.shutdown" => Ok(json!({})),
            "engine.adopt" => {
                let path = self.home.join("run/supervisor.token");
                super::host_client::read_identity_file(&path)
                    .map_err(|_| unauthorized("adoption-refused"))
                    .and_then(|nonce| {
                        if token_equal(&params["nonce"], nonce.trim()) {
                            Ok(())
                        } else {
                            Err(unauthorized("adoption-refused"))
                        }
                    })?;
                lock(&self.watch).adopt(connection.id);
                self.orphaned_since.store(0, Ordering::Release);
                diagnostics::lifecycle(Lifecycle::Adopted, Reason::Adopted);
                Ok(json!({"status":self.status()}))
            }
            "engine.open" => {
                let agent: AgentId = decode(&params["agentId"])?;
                let handle = self.engine.open(&agent)?;
                lock(&connection.agents)
                    .entry(agent.to_string())
                    .or_default()
                    .push(handle);
                Ok(json!({"agentId":agent}))
            }
            "engine.agent.close" => {
                let key = params["agentId"]
                    .as_str()
                    .ok_or_else(WireError::invalid_params)?;
                if let Some(handle) = lock(&connection.agents).get_mut(key).and_then(Vec::pop) {
                    (handle.close)()?;
                }
                Ok(json!({}))
            }
            "engine.capture" => self.capture(connection, params),
            "engine.channels.register" => {
                self.live_core_instance(connection)?;
                let requested: Vec<String> = decode(&params["names"])?;
                let names = crate::context::RouteVocabulary::shared().register_all(&requested)?;
                Ok(json!({"names": names}))
            }
            "engine.jobs.run" => self.run_job(connection, params),
            "engine.capture.wait" => self.capture_wait(params, &connection.cancel),
            "engine.capture.abort" => {
                if let Some(capture) = lock(&self.captures).get(
                    params["id"]
                        .as_str()
                        .ok_or_else(WireError::invalid_params)?,
                ) {
                    (capture.abort)(params["reason"].as_str().map(str::to_owned));
                }
                Ok(json!({}))
            }
            _ => methods::dispatch(self.engine.as_ref(), method, params, &connection.cancel),
        }
    }
}

fn decode<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T, WireError> {
    serde_json::from_value(value.clone()).map_err(|_| WireError::invalid_params())
}
fn encode<T: serde::Serialize>(value: T) -> Result<Value, WireError> {
    serde_json::to_value(value).map_err(|_| WireError::internal())
}
fn unauthorized(reason: &'static str) -> WireError {
    WireError {
        code: -32000,
        error: "E_UNAUTHORIZED",
        reason,
        message: "engine authentication required",
        ids: None,
    }
}

/// Compare the fixed-length hex token without returning on its first differing byte.
fn token_equal(value: &Value, expected: &str) -> bool {
    let Some(received) = value.as_str() else {
        return false;
    };
    if received.len() != 64 || expected.len() != 64 {
        return false;
    }
    received
        .bytes()
        .zip(expected.bytes())
        .fold(0u8, |difference, (a, b)| {
            difference | (a.to_ascii_lowercase() ^ b.to_ascii_lowercase())
        })
        == 0
}

type Validation = HashMap<String, jsonschema::Validator>;

fn validators() -> Result<Validation, ServeError> {
    let root: Value = serde_json::from_str(plur1bus_rpc::capabilities::SCHEMA_JSON)
        .map_err(|_| ServeError::Schema)?;
    let definitions = root["$defs"].as_object().ok_or(ServeError::Schema)?;
    let methods = definitions
        .get("methods")
        .and_then(Value::as_object)
        .ok_or(ServeError::Schema)?;
    let mut validators = HashMap::new();
    for (name, method) in methods
        .iter()
        .filter(|(_, method)| method["x-server"] == "engine")
    {
        let schema = parameter_schema(name, &method["params"], definitions);
        validators.insert(
            name.clone(),
            jsonschema::validator_for(&schema).map_err(|_| ServeError::Schema)?,
        );
    }
    Ok(validators)
}

fn parameter_schema(name: &str, params: &Value, definitions: &Map<String, Value>) -> Value {
    let mut reachable = Map::new();
    let definitions = if collect_parameter_definitions(params, definitions, &mut reachable) {
        reachable.insert("methods".into(), json!({(name): {"params": params}}));
        reachable
    } else {
        // Keep the full document for references that leave the generated flat definitions.
        definitions.clone()
    };
    json!({"$defs": definitions, "$ref": format!("#/$defs/methods/{name}/params")})
}

fn collect_parameter_definitions(
    value: &Value,
    definitions: &Map<String, Value>,
    reachable: &mut Map<String, Value>,
) -> bool {
    match value {
        Value::Object(fields) => fields.iter().all(|(key, value)| match key.as_str() {
            "$ref" => {
                let Some(name) = value.as_str().and_then(|uri| uri.strip_prefix("#/$defs/")) else {
                    return false;
                };
                if name == "methods" || name.contains(['/', '~', '%']) {
                    return false;
                }
                let Some(definition) = definitions.get(name) else {
                    return false;
                };
                if reachable.contains_key(name) {
                    return true;
                }
                reachable.insert(name.to_owned(), definition.clone());
                collect_parameter_definitions(definition, definitions, reachable)
            }
            "$id" | "$anchor" | "$dynamicAnchor" | "$dynamicRef" | "$recursiveRef"
            | "$recursiveAnchor" => false,
            _ => collect_parameter_definitions(value, definitions, reachable),
        }),
        Value::Array(items) => items
            .iter()
            .all(|item| collect_parameter_definitions(item, definitions, reachable)),
        _ => true,
    }
}

#[cfg(test)]
#[test]
#[allow(clippy::unwrap_used, reason = "synthetic test schema must compile")]
fn parameter_schema_retains_transitive_rules_and_falls_back_for_other_pointers() {
    let document = json!({
        "Name": {"type":"string", "minLength":1},
        "Named": {"type":"object", "required":["name"], "additionalProperties":false,
                  "properties":{"name":{"$ref":"#/$defs/Name"}}},
        "Unused": {"properties":{"flag":{"type":"boolean"}}},
        "methods": {
            "engine.local": {"params":{"$ref":"#/$defs/Named"}},
            "engine.nested": {"params":{"$ref":"#/$defs/Unused/properties/flag"}}
        }
    });
    let definitions = document.as_object().unwrap();
    let local = parameter_schema(
        "engine.local",
        &document["methods"]["engine.local"]["params"],
        definitions,
    );
    assert!(local["$defs"].get("Unused").is_none());
    let local = jsonschema::validator_for(&local).unwrap();
    assert!(local.is_valid(&json!({"name":"test"})));
    assert!(!local.is_valid(&json!({"name":""})));
    assert!(!local.is_valid(&json!({"name":"test", "extra":true})));

    let nested = parameter_schema(
        "engine.nested",
        &document["methods"]["engine.nested"]["params"],
        definitions,
    );
    assert_eq!(nested["$defs"], document);
    let nested = jsonschema::validator_for(&nested).unwrap();
    assert!(nested.is_valid(&json!(true)));
    assert!(!nested.is_valid(&json!("true")));
}

fn reap(workers: &mut Vec<JoinHandle<()>>) {
    // Dropping a finished handle releases its resources without a blocking join.
    workers.retain(|worker| !worker.is_finished());
}

fn connection_loop(state: &Arc<Shared>, accepted: Accepted, id: u64) {
    let _ = accepted.set_read_timeout(Some(Duration::from_secs(30)));
    let peer_pid = accepted.peer_pid();
    let (outbound, notifications) = std::sync::mpsc::sync_channel(MAX_OUTBOUND_FRAMES);
    let connection = Arc::new(Connection {
        id,
        accepted_at: Instant::now(),
        writer: Mutex::new(accepted.writer),
        outbound,
        outbound_budget: Arc::new(OutboundBudget::default()),
        closer: accepted.closer,
        cancel: Cancel::never(),
        authenticated: AtomicBool::new(false),
        peer_pid,
        agents: Mutex::new(HashMap::new()),
    });
    let notification_connection = Arc::downgrade(&connection);
    let notification_worker = match state.starter.spawn("engine-peer-notifications", move || {
        notification_loop(&notification_connection, &notifications)
    }) {
        Ok(worker) => worker,
        Err(error) => {
            state.spawn_failed(&error);
            connection.close();
            return;
        }
    };
    let read_timeout = accepted.read_timeout;
    lock(&state.connections).insert(id, Arc::downgrade(&connection));
    let mut drain = accepted.drain;
    let mut reader = BufReader::new(accepted.reader);
    let mut authenticated = false;
    let mut workers = Vec::new();
    loop {
        let mut bytes = Vec::new();
        // take() bounds allocation even when the peer omits its newline.
        let limit = if authenticated {
            plur1bus_rpc::client::MAX_LINE
        } else {
            64 * 1024
        };
        let read = reader
            .by_ref()
            .take((limit + 2) as u64)
            .read_until(b'\n', &mut bytes);
        if !matches!(read, Ok(n) if n > 0)
            || bytes.len() > limit + 1
            || bytes.last() != Some(&b'\n')
        {
            break;
        }
        let request: Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(_) => {
                connection.reply(Value::Null, Err(WireError::invalid_params()));
                break;
            }
        };
        let request_id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request["method"].as_str().unwrap_or("");
        if request["jsonrpc"] != "2.0" || method.is_empty() {
            connection.reply(request_id, Err(WireError::invalid_params()));
            break;
        }
        // Authentication precedes method lookup, parameter validation, callbacks and all data-dependent work.
        if !authenticated
            && (method != "engine.auth" || !token_equal(&request["params"]["token"], &state.token))
        {
            state.auth_failures.fetch_add(1, Ordering::Relaxed);
            connection.reply(
                request_id,
                Err(unauthorized(if method == "engine.auth" {
                    "bad-token"
                } else {
                    "auth-required"
                })),
            );
            break;
        }
        let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
        let Some(validator) = state.validators.get(method) else {
            connection.reply(request_id, Err(WireError::method_not_found()));
            continue;
        };
        if !validator.is_valid(&params) {
            // RE-D170: a refused create/reapply of the Core link is audited as invalid.
            let refusal = match SnapshotMethod::from_wire(method) {
                Some(snapshot) if authenticated => state.refuse_snapshot(&connection, snapshot),
                _ => WireError::invalid_params(),
            };
            connection.reply(request_id, Err(refusal));
            if !authenticated {
                break;
            }
            continue;
        }
        if method == "engine.auth" {
            // Reauthentication can never turn a bad token into an already-authenticated call.
            if !token_equal(&params["token"], &state.token) {
                connection.reply(request_id, Err(unauthorized("bad-token")));
                break;
            }
            authenticated = true;
            if read_timeout(None).is_err() {
                break;
            }
            connection.reply(request_id,Ok(json!({"contract":state.engine.contract(),"rpc":plur1bus_rpc::RPC_VERSION,"instanceId":state.instance,"pid":std::process::id(),"capabilities":plur1bus_rpc::capabilities("engine",&[]),"engineCapabilities":state.engine.capabilities()})));
            connection.authenticated.store(true, Ordering::Release);
            continue;
        }
        if state.stopping.load(Ordering::Acquire) {
            connection.reply(request_id, Err(WireError::not_available()));
            break;
        }
        state.requests.fetch_add(1, Ordering::Relaxed);
        if method == "engine.shutdown" {
            let ms = params["budgetMs"]
                .as_f64()
                .unwrap_or(30_000.0)
                .clamp(0.0, 120_000.0);
            let budget = Duration::from_secs_f64(ms / 1000.0);
            // Start the common budget before taking the writer lock. A blocked
            // acknowledgement cannot postpone shutdown indefinitely.
            state.prepare_stop(budget, Reason::Shutdown);
            connection.reply(request_id, Ok(json!({})));
            state.stop(budget, Reason::Shutdown);
            break;
        }
        reap(&mut workers);
        if workers.len() >= MAX_IN_FLIGHT {
            connection.reply(request_id, Err(WireError::engine_busy()));
            continue;
        }
        let request_state = state.clone();
        let request_connection = connection.clone();
        let request_method = method.to_owned();
        let worker_id = request_id.clone();
        match state.starter.spawn("engine-request", move || {
            let result = request_state.call(&request_connection, &request_method, &params);
            request_connection.reply(worker_id, result);
        }) {
            Ok(worker) => workers.push(worker),
            Err(error) => {
                state.spawn_failed(&error);
                connection.reply(request_id, Err(WireError::engine_busy()));
            }
        }
    }
    drain();
    connection.close();
    lock(&state.connections).remove(&id);
    {
        let mut watch = lock(&state.watch);
        if watch.connection_closed(id) && !state.stopping.load(Ordering::Acquire) {
            state.orphaned_since.store(epoch_ms(), Ordering::Release);
            diagnostics::lifecycle(Lifecycle::Orphaned, Reason::ConnectionClosed);
        }
    }
    let local_deadline = Instant::now() + STOP_BUDGET;
    workers.push(notification_worker);
    join_until(&mut workers, || {
        lock(&state.stop_deadline).unwrap_or(local_deadline)
    });
    connection.close_agents();
}

fn notification_loop(
    connection: &Weak<Connection>,
    notifications: &std::sync::mpsc::Receiver<OutboundFrame>,
) {
    loop {
        if connection
            .upgrade()
            .is_none_or(|peer| peer.cancel.is_cancelled())
        {
            break;
        }
        match notifications.recv_timeout(TICK) {
            Ok(frame) => {
                let Some(peer) = connection.upgrade() else {
                    break;
                };
                if peer.cancel.is_cancelled() {
                    break;
                }
                let result = peer.send_bytes(&frame.bytes);
                drop(frame);
                if result.is_err() {
                    peer.close();
                    break;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    // Receiver ownership ends in the worker closure, dropping queued frames and
    // refunding every reservation even when the peer or write failed.
}

fn capture_loop(state: &Shared) {
    loop {
        let stopping = state.stopping.load(Ordering::Acquire);
        let entries: Vec<_> = lock(&state.captures)
            .iter()
            .map(|(id, entry)| (id.clone(), entry.clone()))
            .collect();
        for (id, entry) in entries {
            let mut receiver = lock(&entry.done);
            let Some(done) = receiver.as_ref() else {
                continue;
            };
            let result = match done.try_recv() {
                Ok(result) => Some(Ok(result)),
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    Some(Err(WireError::not_available()))
                }
                Err(std::sync::mpsc::TryRecvError::Empty) if stopping => {
                    (entry.abort)(Some("engine-stopping".into()));
                    Some(Err(WireError::not_available()))
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => None,
            };
            if let Some(result) = result {
                *receiver = None;
                drop(receiver);
                *lock(&entry.completed) = Some((result.clone(), Instant::now()));
                state.capture_pending.fetch_sub(1, Ordering::AcqRel);
                entry.changed.notify_all();
                if let (Ok(result), Some(connection)) = (result, entry.connection.upgrade()) {
                    let _ = connection.notify(&json!({"jsonrpc":"2.0","method":"engine.capture.done","params":{"id":id,"result":result}}));
                }
            }
        }
        if stopping {
            break;
        }
        let guard = lock(&state.captures);
        let _ = state
            .capture_changed
            .wait_timeout(guard, TICK)
            .unwrap_or_else(std::sync::PoisonError::into_inner);
    }
}

fn join_until(workers: &mut Vec<JoinHandle<()>>, deadline: impl Fn() -> Instant) -> bool {
    loop {
        reap(workers);
        if workers.is_empty() {
            return true;
        }
        let left = deadline().saturating_duration_since(Instant::now());
        if left.is_zero() {
            workers.clear();
            return false;
        }
        thread::sleep(left.min(TICK));
    }
}

fn fatal_accept(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::InvalidInput | io::ErrorKind::PermissionDenied | io::ErrorKind::Unsupported
    )
}

/// Serve until shutdown or orphan-grace expiry, using one common stop deadline.
/// Uncooperative engine callbacks are detached after that deadline. The process
/// entrypoint terminates them when it returns; library callers must account for
/// callbacks that outlive this scope and avoid starting a replacement engine.
pub fn serve(
    engine: Arc<dyn Engine>,
    layout: &EngineLayout,
    lifeline: Lifeline,
) -> Result<(), ServeError> {
    serve_configured(engine, layout, lifeline, ServerOptions::default())
}

/// Bind the existing wire methods to a separate native maintenance service.
pub fn serve_with_maintenance(
    engine: Arc<dyn Engine>,
    layout: &EngineLayout,
    lifeline: Lifeline,
    maintenance: Arc<dyn MaintenanceOps>,
) -> Result<(), ServeError> {
    serve_configured(
        engine,
        layout,
        lifeline,
        ServerOptions {
            maintenance: Some(maintenance),
            ..ServerOptions::default()
        },
    )
}

/// Bind the existing wire methods to the separate native maintenance (F7) and snapshot
/// (F9, RE-D170) services.
pub fn serve_with_ports(
    engine: Arc<dyn Engine>,
    layout: &EngineLayout,
    lifeline: Lifeline,
    maintenance: Arc<dyn MaintenanceOps>,
    snapshots: Arc<dyn SnapshotOps>,
) -> Result<(), ServeError> {
    serve_configured(
        engine,
        layout,
        lifeline,
        ServerOptions {
            maintenance: Some(maintenance),
            snapshots: Some(snapshots),
            ..ServerOptions::default()
        },
    )
}

/// Serve the concrete engine process, initializing its fresh store base while holding the
/// home's single-instance lock and before publishing readiness.
pub fn serve_process(
    engine: Arc<super::engine::ProcessEngine>,
    layout: &EngineLayout,
    lifeline: Lifeline,
    maintenance: Arc<dyn MaintenanceOps>,
    snapshots: Arc<dyn SnapshotOps>,
    job_host: Arc<super::host_client::RpcHost>,
) -> Result<(), ServeError> {
    let store_base = engine.configured_store_base().map(Path::to_owned);
    serve_configured(
        engine.clone(),
        layout,
        lifeline,
        ServerOptions {
            maintenance: Some(maintenance),
            snapshots: Some(snapshots),
            store_base,
            job_host: Some(job_host),
            process: Some(engine),
            ..ServerOptions::default()
        },
    )
}

fn serve_configured(
    engine: Arc<dyn Engine>,
    layout: &EngineLayout,
    lifeline: Lifeline,
    mut options: ServerOptions,
) -> Result<(), ServeError> {
    if super::seams::permission_denied_accept_from_env()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "engine test seam refused"))?
    {
        options.permission_denied_accept = true;
    }
    serve_with_options(engine, layout, lifeline, &options)
}

pub(super) fn serve_with_options(
    engine: Arc<dyn Engine>,
    layout: &EngineLayout,
    lifeline: Lifeline,
    options: &ServerOptions,
) -> Result<(), ServeError> {
    let _signals = super::signals::Guard::install()
        .inspect_err(|error| diagnostics::failure(Stage::Startup, error))?;
    let mut files = layout.acquire().inspect_err(|error| {
        if let ServeError::Io(error) = error {
            diagnostics::failure(Stage::Startup, error);
        }
    })?;
    // The pin initializes fresh bases on process startup so an empty home can still be backed up
    // (RE-D175). Keep library construction read-only. A base failure is reported by operations.
    if let Some(base) = &options.store_base {
        if let Err(error) = crate::store::schema_version::initialize_base(
            base,
            &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            crate::CRATE_VERSION,
        ) {
            let _ = writeln!(
                io::stderr().lock(),
                "plur1bus-engine: store base not initialized ({error})"
            );
        }
    }
    let validators = validators()?;
    let listener = ServerListener {
        inner: Listener::bind(&layout.address)
            .inspect_err(|error| diagnostics::failure(Stage::Listen, error))?,
        permission_denied: AtomicBool::new(options.permission_denied_accept),
        #[cfg(test)]
        errors: AtomicUsize::new(options.accept_errors),
        #[cfg(test)]
        notification_gate: Mutex::new(options.block_first_notification.clone()),
    };
    files
        .publish()
        .inspect_err(|error| diagnostics::failure(Stage::Startup, error))?;
    let state = Arc::new(Shared {
        engine,
        maintenance: options.maintenance.clone(),
        snapshots: options.snapshots.clone(),
        job_host: options.job_host.clone(),
        process: options.process.clone(),
        home: layout.home.clone(),
        token: layout.token().into(),
        instance: layout.instance_id.clone(),
        stopping: AtomicBool::new(false),
        stop_deadline: Mutex::new(None),
        stop_reason: Mutex::new(None),
        starter: WorkerStarter::new(options),
        watch: Mutex::new(Watch::new(lifeline, layout.grace)),
        orphaned_since: AtomicU64::new(0),
        requests: AtomicU64::new(0),
        auth_failures: AtomicU64::new(0),
        accept_errors: AtomicU64::new(0),
        spawn_errors: AtomicU64::new(0),
        scheduler_lag_us: AtomicU64::new(0),
        connections: Mutex::new(HashMap::new()),
        captures: Mutex::new(HashMap::new()),
        capture_pending: AtomicUsize::new(0),
        capture_changed: Condvar::new(),
        validators,
    });
    let mut workers = Vec::new();
    let result = run(&state, &listener, layout, lifeline, &mut workers);
    if !state.stopping.load(Ordering::Acquire) {
        state.stop(STOP_BUDGET, Reason::StartupFailed);
    }
    let deadline = lock(&state.stop_deadline).unwrap_or_else(Instant::now);
    // Cancel I/O first; user engine/agent close callbacks execute only in workers.
    for connection in lock(&state.connections).values().filter_map(Weak::upgrade) {
        connection.close();
    }
    let engine = state.engine.clone();
    let left = deadline.saturating_duration_since(Instant::now());
    let mut result = result;
    match state.starter.spawn("engine-close", move || {
        if engine.close(Some(left)).is_err() {
            diagnostics::failure(Stage::Close, &io::Error::other("engine close failed"));
        }
    }) {
        Ok(worker) => workers.push(worker),
        Err(error) => {
            diagnostics::failure(Stage::Close, &error);
            result = Err(error.into());
        }
    }
    let stop_reason = if !join_until(&mut workers, || deadline) {
        diagnostics::lifecycle(Lifecycle::Stopping, Reason::Deadline);
        Reason::Deadline
    } else {
        lock(&state.stop_reason).unwrap_or(Reason::Shutdown)
    };
    drop(listener);
    drop(files);
    diagnostics::lifecycle(Lifecycle::Stopped, stop_reason);
    diagnostics::flush(deadline.saturating_duration_since(Instant::now()).min(TICK));
    result
}

fn run(
    state: &Arc<Shared>,
    listener: &ServerListener,
    layout: &EngineLayout,
    lifeline: Lifeline,
    workers: &mut Vec<JoinHandle<()>>,
) -> Result<(), ServeError> {
    let events = state.engine.events();
    let event_state = state.clone();
    workers.push(state.starter.spawn("engine-events", move || {
        while !event_state.stopping.load(Ordering::Acquire) {
            match events.recv_timeout(TICK) {
                Ok(event) => {
                    let connections: Vec<_> = lock(&event_state.connections).values().filter_map(Weak::upgrade).collect();
                    for connection in connections {
                        if connection.authenticated.load(Ordering::Acquire) {
                            let _ = connection.notify(&json!({"jsonrpc":"2.0","method":"engine.event","params":event}));
                        }
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    }).inspect_err(|error| diagnostics::failure(Stage::Spawn, error))?);
    let capture_state = state.clone();
    workers.push(
        state
            .starter
            .spawn("engine-captures", move || capture_loop(&capture_state))
            .inspect_err(|error| diagnostics::failure(Stage::Spawn, error))?,
    );
    if lifeline == Lifeline::Stdin {
        let weak = Arc::downgrade(state);
        // stdin cannot be interrupted portably. This one process-owned reader
        // retains only Weak state and is deliberately detached on shutdown.
        let _ = state
            .starter
            .spawn("engine-lifeline", move || {
                let mut buffer = [0; 64];
                let mut stdin = io::stdin().lock();
                while matches!(stdin.read(&mut buffer), Ok(n) if n > 0) {}
                if let Some(state) = weak.upgrade() {
                    if lock(&state.watch).stdin_closed() {
                        state.orphaned_since.store(epoch_ms(), Ordering::Release);
                        diagnostics::lifecycle(Lifecycle::Orphaned, Reason::StdinClosed);
                    }
                }
            })
            .inspect_err(|error| diagnostics::failure(Stage::Spawn, error))?;
    }
    writeln!(
        io::stdout().lock(),
        "{}",
        json!({"ready":true,"address":layout.address,"pid":std::process::id()})
    )?;
    diagnostics::lifecycle(Lifecycle::Started, Reason::Ready);
    let mut next_id = 0;
    let mut connection_workers = Vec::new();
    let result = loop {
        if state.stopping.load(Ordering::Acquire) {
            break Ok(());
        }
        if lock(&state.stop_deadline).is_some_and(|deadline| Instant::now() >= deadline) {
            state.stopping.store(true, Ordering::Release);
            state.capture_changed.notify_all();
            break Ok(());
        }
        if super::signals::requested() {
            state.stop(
                super::signals::close_budget().unwrap_or(STOP_BUDGET),
                Reason::Signal,
            );
            break Ok(());
        }
        if lock(&state.watch).expired() {
            state.stop(STOP_BUDGET, Reason::GraceExpired);
            break Ok(());
        }
        reap(&mut connection_workers);
        for connection in lock(&state.connections).values().filter_map(Weak::upgrade) {
            if !connection.authenticated.load(Ordering::Acquire)
                && connection.accepted_at.elapsed() >= STOP_BUDGET
            {
                connection.close();
            }
        }
        let started = Instant::now();
        match listener.accept_timeout(TICK) {
            Ok(Some(accepted)) if connection_workers.len() < MAX_CONNECTIONS => {
                next_id += 1;
                let connection_state = state.clone();
                let closer = accepted.closer.clone();
                match state.starter.spawn("engine-connection", move || {
                    connection_loop(&connection_state, accepted, next_id)
                }) {
                    Ok(worker) => connection_workers.push(worker),
                    Err(error) => {
                        state.spawn_failed(&error);
                        closer();
                    }
                }
            }
            Ok(Some(accepted)) => (accepted.closer)(),
            Ok(None) => {}
            Err(error) => {
                let count = state.accept_errors.fetch_add(1, Ordering::Relaxed) + 1;
                if count.is_power_of_two() {
                    diagnostics::failure(Stage::Accept, &error);
                }
                if fatal_accept(&error) {
                    state.stop(STOP_BUDGET, Reason::TransportFatal);
                    break Err(error.into());
                }
                thread::sleep(ACCEPT_BACKOFF);
            }
        }
        state.scheduler_lag_us.store(
            started.elapsed().saturating_sub(TICK).as_micros() as u64,
            Ordering::Relaxed,
        );
    };
    workers.extend(connection_workers);
    result
}
