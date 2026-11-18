//! `exec.run` behind the typestate gate (`packages/core/src/tools/exec/`, plan P4-30): run one program with an argument
//! array (no shell) in a granted working directory, with an allowlisted environment, a timeout and an output limit.
//!
//! The order of [`ExecTool::execute`] is the order of `execRun` on the path the dispatcher uses: validate the input,
//! the tier (`deny` is the default), the working directory through the path layer, the environment, the allowlist; then
//! the approved action is redeemed against the working directory and the environment as they are now (the TypeScript
//! check of the call against its classification); then the audit line `exec.run`, and only after it the spawn; the
//! bounded collection; the audit line `exec.result`.
//!
//! **Not ported.** `execRun` can also decide for itself (`policy.decide`, the approval port, `consumeOnce`) when no
//! dispatcher gated the call. Here the gate is the one place that decides ([`crate::gate`]), so that second path does
//! not exist: an executor cannot be called without an approved action. With it went the `shellAllowlisted` flag, which
//! only that path set. The wrapping of the child's output into log records (`deps.output`) belongs to the flip. An abort
//! while a person is asked is the gate's caller's business.
use crate::gate::{
    ApprovedAction, BindingError, Caller, Classification, Classifier, Executor, Live,
};
use plur1bus_core::audit::recorded_then;
use plur1bus_core::js;
use plur1bus_core::policy::decide::Clock;
use plur1bus_core::policy::fs_paths::{
    canonicalise_path, Access, CanonicaliseOptions, FileKind, PathFs, PathRoot,
};
use plur1bus_core::policy::paths::Nfc;
use plur1bus_core::rbac::audit::{AuditEvent, AuditSink};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

pub mod args;
pub mod capture;
pub mod env;
pub mod pattern;
pub mod process;
#[cfg(test)]
mod tests;
#[cfg(test)]
pub(crate) mod vectors;

pub use args::AllowedProgram;
use capture::{BoundedCapture, KnownSecrets};
use process::{Event, ProcessPort, SpawnSpec};

/// The default timeout.
pub const EXEC_TIMEOUT_MS: f64 = 30_000.0;
/// The longest timeout a call may ask for.
pub const EXEC_MAX_TIMEOUT_MS: f64 = 600_000.0;
/// The default output limit per stream.
pub const EXEC_MAX_OUTPUT_BYTES: f64 = 64.0 * 1024.0;
/// The largest output limit a call may ask for.
pub const EXEC_MAX_MAX_OUTPUT_BYTES: f64 = 4.0 * 1024.0 * 1024.0;

// RULING (TypeScript): these decide which executable a bare name or a script resolves to. An allowlist entry names a
// program, not a search path, so in the unattended `allowlist` tier a request may not set them.
const LOOKUP_VARS: [&str; 4] = ["PATH", "PATHEXT", "COMSPEC", "SYSTEMROOT"];
const KEYS: [&str; 6] = [
    "program",
    "args",
    "cwd",
    "env",
    "timeoutMs",
    "maxOutputBytes",
];

/// `ExecFailureCode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExecFailureCode {
    /// The tier is `deny`.
    Disabled,
    /// A malformed call.
    InvalidInput,
    /// The working directory.
    CwdRefused,
    /// A shell, a privilege escalator, a batch script.
    ProgramRefused,
    /// Not on the allowlist, or an argument outside its pattern.
    NotAllowlisted,
    /// The environment.
    EnvRefused,
    /// The policy, or an approved action that is not this action.
    PolicyDenied,
    /// Kept for the TypeScript code's list; the gate reports a missing approval.
    ApprovalDenied,
    /// The audit line could not be written.
    AuditFailed,
    /// The program could not be started or waited for.
    SpawnFailed,
}

impl ExecFailureCode {
    /// The TypeScript spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            ExecFailureCode::Disabled => "disabled",
            ExecFailureCode::InvalidInput => "invalid-input",
            ExecFailureCode::CwdRefused => "cwd-refused",
            ExecFailureCode::ProgramRefused => "program-refused",
            ExecFailureCode::NotAllowlisted => "not-allowlisted",
            ExecFailureCode::EnvRefused => "env-refused",
            ExecFailureCode::PolicyDenied => "policy-denied",
            ExecFailureCode::ApprovalDenied => "approval-denied",
            ExecFailureCode::AuditFailed => "audit-failed",
            ExecFailureCode::SpawnFailed => "spawn-failed",
        }
    }
}

/// `ExecFailure`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecFailure {
    /// The code.
    pub code: ExecFailureCode,
    /// A sentence for the model; never a secret.
    pub message: String,
}

impl ExecFailure {
    /// A failure.
    pub fn new(code: ExecFailureCode, message: &str) -> Self {
        ExecFailure {
            code,
            message: message.to_owned(),
        }
    }
    /// `toResult()`.
    pub fn to_result(&self) -> Value {
        json!({ "isError": true, "code": self.code.as_str(), "message": self.message })
    }
}

impl std::fmt::Display for ExecFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for ExecFailure {}

/// `ExecResult`.
#[derive(Clone, Debug, PartialEq)]
pub struct ExecResult {
    /// The exit code.
    pub exit_code: Option<i32>,
    /// The signal that ended the program.
    pub signal: Option<String>,
    /// Standard output, bounded.
    pub stdout: String,
    /// Standard error, bounded.
    pub stderr: String,
    /// Standard output was cut.
    pub stdout_truncated: bool,
    /// Standard error was cut.
    pub stderr_truncated: bool,
    /// The timeout ended it.
    pub timed_out: bool,
    /// The caller ended it.
    pub aborted: bool,
    /// How long it ran.
    pub duration_ms: f64,
}

impl ExecResult {
    /// `{ isError: false, value }`.
    pub fn to_result(&self) -> Value {
        json!({ "isError": false, "value": { "exitCode": self.exit_code, "signal": self.signal, "stdout": self.stdout,
            "stderr": self.stderr, "stdoutTruncated": self.stdout_truncated, "stderrTruncated": self.stderr_truncated,
            "timedOut": self.timed_out, "aborted": self.aborted, "durationMs": js_number(self.duration_ms) } })
    }
}

/// `ExecConfig`.
#[derive(Clone, Debug, Default)]
pub struct ExecConfig {
    /// `deny`, `ask` or `allowlist`. RULING: anything else, and nothing at all, is `deny`.
    pub mode: Option<String>,
    /// The granted roots.
    pub roots: Vec<PathRoot>,
    /// The deny list, as the configuration holds it.
    pub deny: Option<Value>,
    /// The allowlist.
    pub allowlist: Vec<AllowedProgram>,
    /// Names that may reach the child, inherited or requested (default [`env::DEFAULT_ENV_ALLOW`]).
    pub env_allow: Option<Vec<String>>,
    /// `defaultTimeoutMs`.
    pub default_timeout_ms: Option<f64>,
    /// `maxTimeoutMs`.
    pub max_timeout_ms: Option<f64>,
    /// `defaultMaxOutputBytes`.
    pub default_max_output_bytes: Option<f64>,
    /// `maxMaxOutputBytes`.
    pub max_max_output_bytes: Option<f64>,
}

impl ExecConfig {
    fn env_allow(&self) -> Vec<String> {
        match &self.env_allow {
            Some(a) => a.clone(),
            None => env::DEFAULT_ENV_ALLOW
                .iter()
                .map(|s| (*s).to_owned())
                .collect(),
        }
    }
}

/// The parts of the executor that come from its surroundings (R-K-2).
pub struct ExecPorts<'a, F: PathFs> {
    /// The file system of the path layer.
    pub fs: &'a F,
    /// NFC for the deny list.
    pub nfc: &'a dyn Nfc,
    /// Starts processes.
    pub process: &'a dyn ProcessPort,
    /// The clock (milliseconds), for the timeout, the duration and the audit lines.
    pub clock: &'a dyn Clock,
    /// The audit trail. No line, no run.
    pub audit: &'a mut dyn AuditSink,
    /// The environment the child's allowlisted names are read from.
    pub base_env: &'a [(String, Option<String>)],
    /// The caller cancelled.
    pub aborted: &'a dyn Fn() -> bool,
    /// The registered secret values, masked out of the captured output.
    pub known_secrets: Option<KnownSecrets<'a>>,
}

/// The `exec.run` executor.
pub struct ExecTool<'a, F: PathFs> {
    /// The configuration.
    pub config: ExecConfig,
    /// The ports.
    pub ports: ExecPorts<'a, F>,
    /// `process.platform` for the path rules and the name folding (default: the file system's).
    pub platform: Option<&'a str>,
    /// The host name in audit lines (default `local`).
    pub host: Option<&'a str>,
}

fn sha256_hex(text: &str) -> String {
    env::hex(&Sha256::digest(text.as_bytes()))
}

fn strings_json(list: &[String]) -> String {
    let items: Vec<String> = list.iter().map(|s| js::json_stringify(s)).collect();
    format!("[{}]", items.join(","))
}

/// `clampInt`.
fn clamp_int(v: Option<&Value>, def: f64, max: f64, what: &str) -> Result<f64, ExecFailure> {
    let Some(v) = v else { return Ok(def) };
    match v.as_f64() {
        Some(n) if v.is_number() && n.is_finite() && n.fract() == 0.0 && n >= 1.0 => Ok(n.min(max)),
        _ => Err(ExecFailure::new(
            ExecFailureCode::InvalidInput,
            &format!("{what} must be a positive integer"),
        )),
    }
}

/// The `env` member of a call as `(name, value)` (in the order `serde_json` holds an object: sorted by name).
fn requested_env(args: &Value) -> Vec<(String, Value)> {
    args.get("env")
        .and_then(Value::as_object)
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default()
}

/// The checks of the tool spec before `execRun` (`createExecTool(...).execute`): no audit line for these.
fn check_shape(args: &Value) -> Result<&Map<String, Value>, ExecFailure> {
    let invalid = |m: String| ExecFailure::new(ExecFailureCode::InvalidInput, &m);
    let Some(a) = args.as_object() else {
        return Err(invalid("arguments must be an object".to_owned()));
    };
    if let Some(extra) = a.keys().find(|k| !KEYS.contains(&k.as_str())) {
        return Err(invalid(format!("unknown argument: {extra}")));
    }
    if a.get("env").is_some_and(|e| !e.is_object()) {
        return Err(invalid("env must be an object".to_owned()));
    }
    Ok(a)
}

impl<F: PathFs> ExecTool<'_, F> {
    fn platform(&self) -> &str {
        self.platform.unwrap_or_else(|| self.ports.fs.platform())
    }

    fn audit(
        &mut self,
        who: &Caller,
        action: &str,
        target: &str,
        detail: Vec<(String, Value)>,
    ) -> Result<(), ExecFailure> {
        let event = self.event(who, action, target, detail);
        self.ports.audit.append(&event).map_err(|_| audit_failed())
    }

    fn event(
        &self,
        who: &Caller,
        action: &str,
        target: &str,
        detail: Vec<(String, Value)>,
    ) -> AuditEvent {
        AuditEvent {
            // The clock counts whole milliseconds; a clock that does not is cut, not rounded up.
            at: js_i64(self.ports.clock.now()),
            user: who.principal.clone(),
            host: self.host.unwrap_or("local").to_owned(),
            action: action.to_owned(),
            target: target.to_owned(),
            detail,
        }
    }

    /// `execRun`, on the path of a call the gate approved.
    fn run(&mut self, approved: ApprovedAction, who: &Caller) -> Result<ExecResult, ExecFailure> {
        // The arguments that run are the arguments that were verified.
        let raw = approved.args().clone();
        let a = check_shape(&raw)?;
        let windows = self.platform() == "win32";
        let config = self.config.clone();

        // Input shape first: a malformed call is refused (and recorded) whatever the tier.
        let shape = (|| -> Result<_, ExecFailure> {
            let program = args::validate_program(a.get("program"), windows)?;
            let args = args::validate_args(a.get("args"))?;
            let timeout_ms = clamp_int(
                a.get("timeoutMs"),
                config.default_timeout_ms.unwrap_or(EXEC_TIMEOUT_MS),
                config.max_timeout_ms.unwrap_or(EXEC_MAX_TIMEOUT_MS),
                "timeoutMs",
            )?;
            let max_out = clamp_int(
                a.get("maxOutputBytes"),
                config
                    .default_max_output_bytes
                    .unwrap_or(EXEC_MAX_OUTPUT_BYTES),
                config
                    .max_max_output_bytes
                    .unwrap_or(EXEC_MAX_MAX_OUTPUT_BYTES),
                "maxOutputBytes",
            )?;
            let cwd = a.get("cwd").and_then(Value::as_str).ok_or_else(|| {
                ExecFailure::new(ExecFailureCode::InvalidInput, "cwd must be a string")
            })?;
            Ok((program, args, timeout_ms, max_out, cwd.to_owned()))
        })();
        let (program, args, timeout_ms, max_out, cwd_input) = match shape {
            Ok(x) => x,
            Err(e) => {
                let target = a.get("program").and_then(Value::as_str).unwrap_or("?");
                self.audit(
                    who,
                    "exec.refused",
                    target,
                    vec![("code".into(), json!(e.code.as_str()))],
                )?;
                return Err(e);
            }
        };
        let argc = args.len();
        macro_rules! refuse {
            ($code:expr, $msg:expr, $extra:expr) => {{
                let mut detail = vec![
                    ("code".to_owned(), json!($code.as_str())),
                    ("argc".to_owned(), json!(argc)),
                ];
                detail.extend($extra);
                self.audit(who, "exec.refused", &program, detail)?;
                return Err(ExecFailure::new($code, $msg));
            }};
        }
        let none = Vec::<(String, Value)>::new;

        // Tier `deny` (the default): nothing is started and nothing is asked.
        let mode = config.mode.clone().unwrap_or_default();
        if mode != "ask" && mode != "allowlist" {
            refuse!(
                ExecFailureCode::Disabled,
                "exec.run is disabled (mode: deny)",
                none()
            );
        }

        // The working directory must be a directory inside a granted root.
        let platform = self.platform().to_owned();
        let mut o = CanonicaliseOptions::new(&config.roots);
        o.deny = config.deny.as_ref();
        o.access = Access::Read;
        o.platform = Some(&platform);
        let cwd = match canonicalise_path(self.ports.fs, &cwd_input, &o, self.ports.nfc) {
            Ok(c) => c,
            Err(r) => refuse!(
                ExecFailureCode::CwdRefused,
                &format!("cwd refused: {}", r.reason),
                vec![("reason".to_owned(), json!(r.reason))]
            ),
        };
        let is_dir = self
            .ports
            .fs
            .stat(&cwd.canonical)
            .is_ok_and(|s| s.kind == FileKind::Dir);
        if !is_dir {
            refuse!(
                ExecFailureCode::CwdRefused,
                "cwd is not an existing directory",
                vec![("reason".to_owned(), json!("not-directory"))]
            );
        }

        let requested = requested_env(&raw);
        let env = match env::build_env(
            &config.env_allow(),
            self.ports.base_env,
            &requested,
            windows,
        ) {
            Ok(e) => e,
            Err(e) => refuse!(ExecFailureCode::EnvRefused, &e.message, none()),
        };

        if mode == "allowlist" {
            let steering = requested
                .iter()
                .map(|(n, _)| n)
                .find(|n| LOOKUP_VARS.contains(&n.to_uppercase().as_str()));
            if let Some(name) = steering {
                refuse!(
                    ExecFailureCode::EnvRefused,
                    &format!("environment variable {name} decides which program runs and cannot be requested for an allowlisted program"),
                    none()
                );
            }
            let entry = args::find_allowed(&config.allowlist, &program, windows);
            let allowed =
                entry.is_some_and(|e| pattern::args_match_pattern(e.arg_pattern.as_deref(), &args));
            if !allowed {
                let message = if entry.is_some() {
                    "an argument does not match the program's allowlist pattern"
                } else {
                    "program is not on the allowlist"
                };
                refuse!(ExecFailureCode::NotAllowlisted, message, none());
            }
        }

        let mut env_names: Vec<String> = env.iter().map(|(n, _)| n.clone()).collect();
        js::sort_default(&mut env_names);
        // The hash covers the values (PATH=/usr/bin is another action than PATH=/tmp/x); the audit records names only.
        let action_hash = sha256_hex(&format!(
            "{{\"c\":\"shell.exec\",\"t\":\"exec.run\",\"program\":{},\"args\":{},\"cwd\":{},\"env\":{}}}",
            js::json_stringify(&program),
            strings_json(&args),
            js::json_stringify(&cwd.canonical),
            env::sorted_pairs_json(&env)
        ));
        let base = vec![
            ("argc".to_owned(), json!(argc)),
            (
                "argsSha256".to_owned(),
                json!(sha256_hex(&strings_json(&args))),
            ),
            ("cwd".to_owned(), json!(cwd.canonical)),
            ("envNames".to_owned(), json!(env_names)),
            ("mode".to_owned(), json!(mode)),
            ("actionHash".to_owned(), json!(action_hash)),
        ];

        // The approved action must be this action: the working directory and the environment as they are now, for the
        // caller it was approved for, in time. It is consumed here, whatever the answer.
        let fingerprint = env::env_fingerprint(&env);
        let targets = [cwd.canonical.clone()];
        let live = Live {
            tool: "exec.run",
            args: &raw,
            targets: &targets,
            hash_extra: Some(&fingerprint),
            caller: who,
        };
        match approved.redeem(&live, self.ports.clock) {
            Ok(_receipt) => {}
            Err(BindingError::Targets) => refuse!(
                ExecFailureCode::CwdRefused,
                "cwd no longer matches the classified call",
                none()
            ),
            Err(BindingError::HashExtra) => refuse!(
                ExecFailureCode::EnvRefused,
                "environment no longer matches the classified call",
                none()
            ),
            Err(e) => refuse!(
                ExecFailureCode::PolicyDenied,
                &e.to_string(),
                vec![("binding".to_owned(), json!(e.as_str()))]
            ),
        }

        // Nothing is started for a call that was cancelled while it waited.
        if (self.ports.aborted)() {
            self.audit(
                who,
                "exec.result",
                &program,
                vec![
                    ("actionHash".into(), json!(action_hash)),
                    ("outcome".into(), json!("aborted")),
                    ("started".into(), json!(false)),
                ],
            )?;
            return Ok(ExecResult {
                exit_code: None,
                signal: None,
                stdout: String::new(),
                stderr: String::new(),
                stdout_truncated: false,
                stderr_truncated: false,
                timed_out: false,
                aborted: true,
                duration_ms: 0.0,
            });
        }

        // The audit line before the effect: the program is started only after `exec.run` was recorded.
        let spec = SpawnSpec {
            program: program.clone(),
            args,
            cwd: cwd.canonical.clone(),
            env,
        };
        let event = self.event(who, "exec.run", &program, base);
        let process = self.ports.process;
        let spawned = recorded_then(self.ports.audit, &event, || process.spawn(&spec))
            .map_err(|_| audit_failed())?;
        let started = self.ports.clock.now();
        let hash_line = || ("actionHash".to_owned(), json!(action_hash));
        let spawn_failed = |m: String| ExecFailure::new(ExecFailureCode::SpawnFailed, &m);
        let mut handle = match spawned {
            Ok(h) => h,
            Err(message) => {
                self.audit(
                    who,
                    "exec.result",
                    &program,
                    vec![hash_line(), ("outcome".into(), json!("spawn-failed"))],
                )?;
                return Err(spawn_failed(message));
            }
        };

        // Limits are whole numbers of at most 4 MiB by `clamp_int`; a configured default is cut to a whole number.
        let limit = js_usize(max_out);
        let mut out = BoundedCapture::new(limit, self.ports.known_secrets);
        let mut err = BoundedCapture::new(limit, self.ports.known_secrets);
        let (mut timed_out, mut aborted) = (false, false);
        let exit = loop {
            let elapsed = self.ports.clock.now() - started;
            // Not `elapsed < timeout`: a clock that answers NaN ends the run.
            let in_time = elapsed < timeout_ms;
            if !timed_out && !in_time {
                timed_out = true;
                handle.kill_tree();
            }
            if !aborted && (self.ports.aborted)() {
                aborted = true;
                handle.kill_tree();
            }
            match handle.next((timeout_ms - elapsed).max(1.0)) {
                Ok(Event::Stdout(c)) => out.push(&c),
                Ok(Event::Stderr(c)) => err.push(&c),
                Ok(Event::Idle) => {}
                Ok(Event::Exit(x)) => break Ok(x),
                Err(m) => break Err(m),
            }
        };
        let failed = |tool: &mut Self, handle: &mut Box<dyn process::ProcessHandle>, m: String| {
            handle.kill_tree();
            // The failure below is the report, whether or not this line could be written.
            let _ = tool.audit(
                who,
                "exec.result",
                &program,
                vec![hash_line(), ("outcome".into(), json!("spawn-failed"))],
            );
            spawn_failed(m)
        };
        let exit = match exit {
            Ok(x) => x,
            Err(m) => return Err(failed(self, &mut handle, m)),
        };
        if timed_out || aborted {
            handle.kill_tree(); // the tree is gone before we report
        }
        let result = ExecResult {
            exit_code: exit.code,
            signal: exit.signal.clone(),
            stdout: out.text(true),
            stderr: err.text(true),
            stdout_truncated: out.truncated,
            stderr_truncated: err.truncated,
            timed_out,
            aborted,
            duration_ms: self.ports.clock.now() - started,
        };
        let outcome = if timed_out {
            "timeout"
        } else if aborted {
            "aborted"
        } else {
            "exited"
        };
        let line = vec![
            hash_line(),
            ("outcome".into(), json!(outcome)),
            ("exitCode".into(), json!(exit.code)),
            ("signal".into(), json!(exit.signal)),
            (
                "truncated".into(),
                json!(result.stdout_truncated || result.stderr_truncated),
            ),
            ("durationMs".into(), js_number(result.duration_ms)),
        ];
        if let Err(e) = self.audit(who, "exec.result", &program, line) {
            // As in TypeScript: a result that cannot be recorded is not handed out.
            return Err(failed(self, &mut handle, e.message));
        }
        Ok(result)
    }
}

fn audit_failed() -> ExecFailure {
    ExecFailure::new(
        ExecFailureCode::AuditFailed,
        "the audit line could not be written; nothing was run",
    )
}

/// A JavaScript number as a count: whole, not negative, at most what a `usize` holds.
fn js_usize(n: f64) -> usize {
    if n.is_finite() && n >= 1.0 {
        // The value is whole and in range by the checks before; the conversion saturates otherwise.
        format!("{:.0}", n.trunc()).parse().unwrap_or(usize::MAX)
    } else {
        0
    }
}

/// A JavaScript number as JSON writes it: a whole number without a fraction.
fn js_number(n: f64) -> Value {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        json!(js_i64(n))
    } else {
        json!(n)
    }
}

fn js_i64(n: f64) -> i64 {
    if n.is_finite() {
        format!("{:.0}", n.trunc()).parse().unwrap_or(0)
    } else {
        0
    }
}

impl<F: PathFs> Executor for ExecTool<'_, F> {
    type Output = Result<ExecResult, ExecFailure>;
    fn execute(&mut self, approved: ApprovedAction, who: &Caller) -> Self::Output {
        self.run(approved, who)
    }
}

/// The classifier of `exec.run` for the gate (`classifyExecRun` of the composition): the working directory through the
/// path layer, and the fingerprint of the environment the call would run with.
pub struct ExecClassifier<'a, F: PathFs> {
    /// The file system of the path layer.
    pub fs: &'a F,
    /// NFC for the deny list.
    pub nfc: &'a dyn Nfc,
    /// The granted roots.
    pub roots: &'a [PathRoot],
    /// The deny list.
    pub deny: Option<&'a Value>,
    /// The names that may reach the child.
    pub env_allow: &'a [String],
    /// The environment the allowlisted names are read from.
    pub base_env: &'a [(String, Option<String>)],
    /// The process port confines every launch (`tools.sandbox.required` is on).
    pub sandboxed: bool,
    /// `process.platform` (default: the file system's).
    pub platform: Option<&'a str>,
}

impl<F: PathFs> Classifier for ExecClassifier<'_, F> {
    fn classify(&self, args: &Value) -> Result<Classification, String> {
        let cwd = args
            .as_object()
            .and_then(|a| a.get("cwd"))
            .and_then(Value::as_str)
            .ok_or("cwd must be a string")?;
        let platform = self.platform.unwrap_or_else(|| self.fs.platform());
        let mut o = CanonicaliseOptions::new(self.roots);
        o.deny = self.deny;
        o.access = Access::Read;
        o.require_root = false;
        o.platform = Some(platform);
        let resolved = canonicalise_path(self.fs, cwd, &o, self.nfc)
            .map_err(|r| format!("cwd refused: {}", r.reason))?;
        if args.get("env").is_some_and(|e| !e.is_object()) {
            return Err("env must be an object".to_owned());
        }
        let env = env::build_env(
            self.env_allow,
            self.base_env,
            &requested_env(args),
            platform == "win32",
        )
        .map_err(|e| e.message)?;
        let mut flags = Map::new();
        flags.insert("outsideRoots".into(), json!(resolved.root_id.is_none()));
        flags.insert("denyListHit".into(), json!(false));
        flags.insert("sandboxed".into(), json!(self.sandboxed));
        if resolved.system_tree {
            flags.insert("systemTree".into(), json!(true));
        }
        Ok(Classification {
            flags,
            targets: Some(vec![resolved.canonical]),
            access: Some("write"),
            hash_extra: Some(env::env_fingerprint(&env)),
        })
    }
}
