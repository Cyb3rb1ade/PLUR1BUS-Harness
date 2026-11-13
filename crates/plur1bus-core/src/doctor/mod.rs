//! `doctor-report.ts`: `doctor.report` (the cached authoritative `1staid` report with the core's own live checks laid
//! over it) as a plain function over a deps struct.
//!
//! Not wired into `CoreMethods`, the route table or the server yet; the flip PR adapts [`DoctorMethods::report`] to the
//! generated trait ([`DoctorParams::from_value`] for the params, [`Report::to_value`] for the result,
//! [`DoctorError::into_method_error`] for a refusal).
//!
//! What the TypeScript handler takes from parts of the core that are not ported comes in through [`DoctorDeps`] as
//! traits and closures, the way the options object of `buildDoctorMethods` injects them (P4-11 ruling 2): the probe
//! ([`DoctorDeps::check`], default [`firstaid::run_first_aid`]), RBAC ([`DoctorAccess`]: `authenticatedPrincipal` and
//! `authorize(.., "doctor.run", ..)`), the sandbox detection, the host tool-eval reports and gate ([`HostEval`]), the
//! external-agent refusal, the turn telemetry and the clock. No result of those is invented here.
//!
//! The report is built once at start (a scheduled snapshot, [`DoctorDeps::schedule_initial`]), cached, and refreshed
//! on request at most once per 30 seconds. A read overlays the live checks (the core's own, capability index, skill
//! mining, turn usage) on a copy of the cached report without rerunning the probe. Concurrent callers share one
//! in-flight run.
//!
//! Differences from the TypeScript handler, all deliberate:
//!  * the probe's `status` must be a JSON string; TypeScript also takes `String(status)`, so an array such as `["ok"]`
//!    passes there and is reported with the array as the status;
//!  * a text cut at 4096 UTF-16 units drops a character that straddles the limit (TypeScript keeps its first surrogate);
//!  * `homedir()` is [`DoctorDeps::user_home`] (default: `$HOME`, on Windows `%USERPROFILE%`), `process.platform ===
//!    "linux"` is [`DoctorDeps::linux`] (default: the build target);
//!  * the injected closures are synchronous; a caller that needs to wait blocks on its own thread.
pub mod firstaid;
mod generate;
mod report;
pub mod sanitize;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod vectors;

pub use report::{Check, Group, Repair, Report, Status};

use crate::frame::RpcErr;
use crate::logs::levels::{system_clock, Clock};
use crate::logs::methods::CallContext;
use crate::logs::redact::TextRedactor;
use crate::metrics::metrics::TurnTelemetrySummary;
use plur1bus_log_schema::redact::{RedactOptions, Redactor};
use plur1bus_rpc::server::MethodError;
use plur1bus_rpc::types::ErrorCode;
use sanitize::Sanitizer;
use serde_json::Value;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};

/// A refresh (or a retry of a failed snapshot) is allowed this long after the last run began.
pub const REFRESH_INTERVAL_MS: i64 = 30_000;
/// `DEFAULT_MAX_TASKS` of the sandbox: tasks per sandboxed run when `tools.sandbox.maxTasks` is not set.
pub const DEFAULT_MAX_TASKS: f64 = 512.0;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

// ---- errors and params ----

/// What a handler fails with.
#[derive(Debug)]
pub enum DoctorError {
    /// A refusal for the caller, with the code, message and reason of the TypeScript `RpcError`.
    Rpc(RpcErr),
}

impl From<RpcErr> for DoctorError {
    fn from(e: RpcErr) -> Self {
        DoctorError::Rpc(e)
    }
}

impl DoctorError {
    /// The refusal.
    pub fn rpc(&self) -> &RpcErr {
        match self {
            DoctorError::Rpc(e) => e,
        }
    }

    /// The error the generated dispatcher takes. `None` when the code is not one of the schema's.
    pub fn into_method_error(self) -> Option<MethodError> {
        let DoctorError::Rpc(e) = self;
        let code: ErrorCode = e.code.parse().ok()?;
        let mut out = MethodError::rpc(code, e.message);
        if let Some(reason) = e.reason {
            out = out.with_reason(reason);
        }
        Some(out)
    }
}

/// The params of `doctor.report`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DoctorParams {
    /// Ask for a fresh run (Owner, Admin and Operator; once per 30 seconds).
    pub refresh: Option<bool>,
}

impl DoctorParams {
    /// The params from the request's `params`: an object whose `refresh`, when present, is a boolean (the schema has
    /// refused anything else before the TypeScript handler runs).
    pub fn from_value(v: &Value) -> Result<DoctorParams, DoctorError> {
        let invalid = |message: &str| {
            DoctorError::Rpc(RpcErr::new("E_INVALID_PARAMS", message, Some("schema")))
        };
        match v {
            Value::Null => Ok(DoctorParams::default()),
            Value::Object(o) => match o.get("refresh") {
                None => Ok(DoctorParams::default()),
                Some(Value::Bool(b)) => Ok(DoctorParams { refresh: Some(*b) }),
                Some(_) => Err(invalid("refresh has the wrong type")),
            },
            _ => Err(invalid("params has the wrong type")),
        }
    }
}

// ---- the seams ----

/// What the probe fails with.
#[derive(Debug)]
pub enum CheckError {
    /// A refusal; shown to the caller as it is (`RpcError` passes through).
    Rpc(RpcErr),
    /// Anything else (a spawn error carries paths): not shown, the caller sees `firstaid-unavailable`.
    Other(String),
}

/// The probe: the parsed `1staid check` document.
pub type CheckFn = Arc<dyn Fn() -> Result<Value, CheckError> + Send + Sync>;
/// Runs one snapshot (or joins the one in flight) and gives its report.
pub type StartFn = Arc<dyn Fn() -> Result<Report, DoctorError> + Send + Sync>;
/// `scheduleInitial(start)`: takes the function that runs the initial snapshot, to call it when the core is ready.
pub type ScheduleInitial = Box<dyn FnOnce(StartFn) + Send>;
/// A list of checks read at call time.
pub type ChecksFn = Arc<dyn Fn() -> Vec<Check> + Send + Sync>;

/// RBAC (`authenticatedPrincipal` and `authorize`).
pub trait DoctorAccess: Send + Sync {
    /// `authenticatedPrincipal(ctx)`: the call's identity was established by this invocation's guard, else
    /// `E_UNAUTHORIZED`. Runs for every call.
    fn authenticate(&self, ctx: &CallContext) -> Result<(), RpcErr>;
    /// `authorize(principal, "doctor.run", { kind: "system" }, { now }).effect === "allow"`.
    fn may_refresh(&self, ctx: &CallContext, now_ms: i64) -> bool;
}

/// How the process cap is enforced (`SandboxTasks.mechanism`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskMechanism {
    /// A limit set inside the run's own user namespace (Linux).
    NamespaceLimit,
    /// Forks are denied (Seatbelt).
    ForkDenied,
    /// None can be enforced.
    None,
}

/// `SandboxTasks`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SandboxTasks {
    /// The mechanism.
    pub mechanism: TaskMechanism,
    /// Why, or why not.
    pub reason: String,
    /// What to do about it.
    pub hint: Option<String>,
}

/// `SandboxDetection`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SandboxDetection {
    /// `seatbelt`, `bubblewrap`, `windows-restricted` or `none`.
    pub backend: String,
    /// `strong`, `partial` or `none`.
    pub strength: String,
    /// A sandbox can be used.
    pub available: bool,
    /// The process-cap measurement.
    pub tasks: SandboxTasks,
    /// Why.
    pub reason: String,
    /// What to do about it.
    pub hint: Option<String>,
}

/// `detectSandbox(limitsHelper)`.
pub type DetectSandbox = Arc<dyn Fn(&Path) -> SandboxDetection + Send + Sync>;

/// `ModelRef`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelRef {
    /// The provider id.
    pub provider: String,
    /// The model id.
    pub model: String,
}

/// A default model with the host tool-eval label it earned (`supported`, `limited tool use` or `unknown`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GateModel {
    /// The provider id.
    pub provider: String,
    /// The model id.
    pub model: String,
    /// The label.
    pub label: String,
}

/// The result of `hostEvalGate`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostEvalGate {
    /// Every default model is `supported`.
    pub passed: bool,
    /// The default models with their labels.
    pub models: Vec<GateModel>,
}

/// `readHostEvalReports(home, now)` and `hostEvalGate(defaults, reports)` as one seam.
pub trait HostEval: Send + Sync {
    /// The gate for the default models over the reports under `home`, at `now_ms`.
    fn gate(&self, defaults: &[ModelRef], home: &Path, now_ms: i64) -> HostEvalGate;
}

/// `externalAgentRefusal()`: why external ACP agents are refused on this host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalAgentRefusal {
    /// `sandbox-unavailable`.
    pub reason: String,
    /// `macos-acceptance-pending` on macOS.
    pub cause: Option<String>,
}

/// `miningStatus()`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MiningStatus {
    /// The engine exposes a skill-artifact proposal API.
    pub available: bool,
}

/// `capabilityStatus()`.
#[derive(Clone, Debug, PartialEq)]
pub struct CapabilityStatus {
    /// `fts5-only` or the full mode.
    pub mode: String,
    /// The source could not be read.
    pub source_error: bool,
    /// Milliseconds since the epoch of the last recheck (JavaScript number); `None` is `pending`.
    pub last_recheck: Option<f64>,
}

/// The options object of `buildDoctorMethods`.
pub struct DoctorDeps {
    /// The core's home (`<home>/bin/plur1bus-sandbox-limits` is the limits helper).
    pub home: PathBuf,
    /// Milliseconds since the epoch.
    pub clock: Clock,
    /// RBAC.
    pub access: Arc<dyn DoctorAccess>,
    /// Sandbox detection.
    pub detect_sandbox: DetectSandbox,
    /// Host tool-eval reports and gate.
    pub host_eval: Arc<dyn HostEval>,
    /// The external-agent refusal for this host.
    pub external_agent_refusal: Arc<dyn Fn() -> Option<ExternalAgentRefusal> + Send + Sync>,
    /// `sandboxRequired`: false when the owner disabled `tools.sandbox.required`.
    pub sandbox_required: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    /// `sandboxMaxTasks`: `tools.sandbox.maxTasks`; default [`DEFAULT_MAX_TASKS`].
    pub sandbox_max_tasks: Option<Arc<dyn Fn() -> f64 + Send + Sync>>,
    /// `toolEvalDefaults`: the default model inventory.
    pub tool_eval_defaults: Option<Arc<dyn Fn() -> Vec<ModelRef> + Send + Sync>>,
    /// Default: a redactor with PII on.
    pub redactor: Option<Arc<dyn TextRedactor>>,
    /// Problems the core itself found while composing (a refused turn provider); added to the report as checks.
    pub composition_checks: Option<ChecksFn>,
    /// Checks the core answers itself from its live configuration (e.g. `privacy.local-only`); appended to the
    /// provisioning group and overlaid live on every read.
    pub core_checks: Option<ChecksFn>,
    /// The probe; default [`firstaid::run_first_aid`] over `home`.
    pub check: Option<CheckFn>,
    /// Skill mining status.
    pub mining_status: Option<Arc<dyn Fn() -> Option<MiningStatus> + Send + Sync>>,
    /// Capability index status.
    pub capability_status: Option<Arc<dyn Fn() -> Option<CapabilityStatus> + Send + Sync>>,
    /// Numeric process-local turn usage, overlaid live without rerunning installation probes.
    pub turn_telemetry: Option<Arc<dyn Fn() -> Option<TurnTelemetrySummary> + Send + Sync>>,
    /// Defers the internal snapshot until the core is ready; default: the snapshot starts now, on its own thread.
    pub schedule_initial: Option<ScheduleInitial>,
    /// `homedir()`; default `$HOME` (Windows: `%USERPROFILE%`), empty when unset.
    pub user_home: Option<String>,
    /// `process.platform === "linux"`; default the build target.
    pub linux: Option<bool>,
}

impl DoctorDeps {
    /// Deps for `home` with the seams that have no default and everything else unset.
    pub fn new(
        home: impl Into<PathBuf>,
        clock: Clock,
        access: Arc<dyn DoctorAccess>,
        detect_sandbox: DetectSandbox,
        host_eval: Arc<dyn HostEval>,
        external_agent_refusal: Arc<dyn Fn() -> Option<ExternalAgentRefusal> + Send + Sync>,
    ) -> DoctorDeps {
        DoctorDeps {
            home: home.into(),
            clock,
            access,
            detect_sandbox,
            host_eval,
            external_agent_refusal,
            sandbox_required: None,
            sandbox_max_tasks: None,
            tool_eval_defaults: None,
            redactor: None,
            composition_checks: None,
            core_checks: None,
            check: None,
            mining_status: None,
            capability_status: None,
            turn_telemetry: None,
            schedule_initial: None,
            user_home: None,
            linux: None,
        }
    }

    /// The same deps with the system clock (a convenience for the flip PR).
    pub fn with_system_clock(mut self) -> DoctorDeps {
        self.clock = system_clock();
        self
    }
}

fn default_user_home() -> String {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var(var).unwrap_or_default()
}

// ---- the cache ----

/// One run of the probe that callers share.
struct Flight {
    result: Mutex<Option<Result<Report, RpcErr>>>,
    done: Condvar,
}

impl Flight {
    fn new() -> Flight {
        Flight {
            result: Mutex::new(None),
            done: Condvar::new(),
        }
    }

    fn finish(&self, result: Result<Report, RpcErr>) {
        *lock(&self.result) = Some(result);
        self.done.notify_all();
    }

    fn wait(&self) -> Result<Report, RpcErr> {
        let mut guard = lock(&self.result);
        loop {
            if let Some(result) = guard.as_ref() {
                return result.clone();
            }
            guard = self
                .done
                .wait(guard)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }
}

#[derive(Default)]
struct State {
    cached: Option<Report>,
    /// `lastStarted`: when the latest run began; `None` is `-Infinity`.
    last_started: Option<i64>,
    in_flight: Option<Arc<Flight>>,
}

pub(crate) struct Inner {
    home: PathBuf,
    clock: Clock,
    access: Arc<dyn DoctorAccess>,
    detect_sandbox: DetectSandbox,
    host_eval: Arc<dyn HostEval>,
    external_agent_refusal: Arc<dyn Fn() -> Option<ExternalAgentRefusal> + Send + Sync>,
    sandbox_required: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    sandbox_max_tasks: Option<Arc<dyn Fn() -> f64 + Send + Sync>>,
    tool_eval_defaults: Option<Arc<dyn Fn() -> Vec<ModelRef> + Send + Sync>>,
    composition_checks: Option<ChecksFn>,
    core_checks: Option<ChecksFn>,
    check: CheckFn,
    mining_status: Option<Arc<dyn Fn() -> Option<MiningStatus> + Send + Sync>>,
    capability_status: Option<Arc<dyn Fn() -> Option<CapabilityStatus> + Send + Sync>>,
    turn_telemetry: Option<Arc<dyn Fn() -> Option<TurnTelemetrySummary> + Send + Sync>>,
    sanitizer: Sanitizer,
    linux: bool,
    state: Mutex<State>,
}

impl Inner {
    fn now(&self) -> i64 {
        (self.clock)()
    }

    /// Joins the run in flight, or begins one (`lastStarted` is set at once). The second value is true for the caller
    /// that has to run it.
    fn begin(&self) -> (Arc<Flight>, bool) {
        let mut state = lock(&self.state);
        if let Some(flight) = &state.in_flight {
            return (flight.clone(), false);
        }
        let flight = Arc::new(Flight::new());
        state.in_flight = Some(flight.clone());
        state.last_started = Some(self.now());
        (flight, true)
    }

    /// Runs the probe for `flight`: caches a report, clears the flight, wakes the waiters.
    fn run(&self, flight: &Flight) {
        let result = catch_unwind(AssertUnwindSafe(|| self.generate())).unwrap_or_else(|_| {
            Err(RpcErr::new(
                "E_INTERNAL",
                "diagnostics failed unexpectedly",
                None,
            ))
        });
        {
            let mut state = lock(&self.state);
            if let Ok(report) = &result {
                state.cached = Some(report.clone());
            }
            state.in_flight = None;
        }
        flight.finish(result);
    }

    /// `start()`: one run, shared by every caller that arrives while it is going.
    fn start(&self) -> Result<Report, RpcErr> {
        let (flight, leader) = self.begin();
        if leader {
            self.run(&flight);
        }
        flight.wait()
    }
}

/// The `doctor.report` handler.
pub struct DoctorMethods {
    inner: Arc<Inner>,
}

impl DoctorMethods {
    /// The handler over `deps`. Fails when the default redactor cannot be built. The initial snapshot is scheduled
    /// ([`DoctorDeps::schedule_initial`]) or begins at once on its own thread.
    pub fn new(deps: DoctorDeps) -> Result<DoctorMethods, DoctorError> {
        let redactor: Arc<dyn TextRedactor> = match deps.redactor {
            Some(r) => r,
            None => Arc::new(
                Redactor::new(RedactOptions {
                    pii: true,
                    ..RedactOptions::default()
                })
                .map_err(|e| DoctorError::Rpc(RpcErr::new("E_INTERNAL", e.to_string(), None)))?,
            ),
        };
        let home_text = deps.home.to_string_lossy().into_owned();
        let user_home = deps.user_home.unwrap_or_else(default_user_home);
        let check: CheckFn = match deps.check {
            Some(check) => check,
            None => {
                let home = deps.home.clone();
                Arc::new(move || firstaid::run_first_aid(&home).map_err(CheckError::Rpc))
            }
        };
        let inner = Arc::new(Inner {
            home: deps.home,
            clock: deps.clock,
            access: deps.access,
            detect_sandbox: deps.detect_sandbox,
            host_eval: deps.host_eval,
            external_agent_refusal: deps.external_agent_refusal,
            sandbox_required: deps.sandbox_required,
            sandbox_max_tasks: deps.sandbox_max_tasks,
            tool_eval_defaults: deps.tool_eval_defaults,
            composition_checks: deps.composition_checks,
            core_checks: deps.core_checks,
            check,
            mining_status: deps.mining_status,
            capability_status: deps.capability_status,
            turn_telemetry: deps.turn_telemetry,
            sanitizer: Sanitizer::new(redactor, &home_text, &user_home),
            linux: deps.linux.unwrap_or(cfg!(target_os = "linux")),
            state: Mutex::new(State::default()),
        });
        match deps.schedule_initial {
            Some(schedule) => {
                let i = inner.clone();
                schedule(Arc::new(move || i.start().map_err(DoctorError::Rpc)));
            }
            None => {
                // "Initial snapshot is an internal startup check; reading never requests a refresh."
                let (flight, leader) = inner.begin();
                if leader {
                    let i = inner.clone();
                    let spawned = std::thread::Builder::new()
                        .name("doctor-initial".into())
                        .spawn({
                            let flight = flight.clone();
                            move || i.run(&flight)
                        });
                    if spawned.is_err() {
                        inner.run(&flight);
                    }
                }
            }
        }
        Ok(DoctorMethods { inner })
    }

    /// `doctor.report`.
    pub fn report(&self, params: &DoctorParams, ctx: &CallContext) -> Result<Report, DoctorError> {
        let i = &self.inner;
        i.access.authenticate(ctx)?;
        if params.refresh == Some(true) {
            if !i.access.may_refresh(ctx, i.now()) {
                return Err(RpcErr::new(
                    "E_DENIED",
                    "diagnostic refresh requires an operator",
                    None,
                )
                .into());
            }
            let (busy, last) = {
                let state = lock(&i.state);
                (state.in_flight.is_some(), state.last_started)
            };
            if busy || last.is_some_and(|at| i.now().saturating_sub(at) < REFRESH_INTERVAL_MS) {
                return Err(RpcErr::new(
                    "E_CONFLICT",
                    "diagnostics were refreshed recently",
                    Some("refresh-rate-limit"),
                )
                .into());
            }
            return Ok(i.current_report(&i.start()?));
        }
        let (flight, cached, last) = {
            let state = lock(&i.state);
            (
                state.in_flight.clone(),
                state.cached.clone(),
                state.last_started,
            )
        };
        if let Some(flight) = flight {
            return Ok(i.current_report(&flight.wait()?));
        }
        // A failed startup snapshot must not leave readers without a report until an operator refreshes: retry lazily,
        // inside the same rate limit as a refresh.
        let retry = last.is_none_or(|at| i.now().saturating_sub(at) >= REFRESH_INTERVAL_MS);
        match cached {
            None if retry => Ok(i.current_report(&i.start()?)),
            None => Err(firstaid::unavailable("firstaid-unavailable").into()),
            Some(report) => Ok(i.current_report(&report)),
        }
    }
}
