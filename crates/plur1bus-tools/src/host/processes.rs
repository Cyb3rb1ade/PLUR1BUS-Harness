use super::Failure;
use crate::gate::Caller;
use serde_json::Value;
use std::collections::VecDeque;
use uuid::Uuid;

const RUNNING: usize = 32;
const RETAINED: usize = 128;

#[derive(Clone, PartialEq, Eq)]
struct Owner {
    principal: String,
    agent: String,
    session: String,
}

impl Owner {
    fn of(who: &Caller) -> Result<Self, Failure> {
        let session = who
            .session_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                Failure::denied("A harness session is required for process ownership.")
            })?;
        Ok(Self {
            principal: who.principal.clone(),
            agent: who.agent_id.clone(),
            session: session.to_owned(),
        })
    }
}

pub(super) fn shell_args<'a>(shell: &str, command: &'a str) -> Vec<&'a str> {
    match shell {
        "bash" => vec!["--norc", "--noprofile", "-c", command],
        "zsh" => vec!["-f", "-c", command],
        "pwsh" => vec!["-NoProfile", "-NonInteractive", "-Command", command],
        _ => vec!["-c", command],
    }
}

struct Entry {
    id: Uuid,
    owner: Owner,
    running: bool,
}

/// Hostctl process registrations and their authenticated owners.
#[derive(Default)]
pub struct ProcessSessions {
    entries: VecDeque<Entry>,
}

impl ProcessSessions {
    pub(super) fn reserve(&mut self, who: &Caller, id: Uuid) -> Result<(), Failure> {
        let owner = Owner::of(who)?;
        if self.entries.iter().any(|entry| entry.id == id) {
            return Err(Failure::new("IO_ERROR", "Could not allocate a process ID."));
        }
        if self.entries.iter().filter(|entry| entry.running).count() >= RUNNING {
            return Err(Failure::too_large("The active process pool is full."));
        }
        if self.entries.len() >= RETAINED {
            let index = self
                .entries
                .iter()
                .position(|entry| !entry.running)
                .ok_or_else(|| Failure::too_large("The retained process pool is full."))?;
            self.entries.remove(index);
        }
        self.entries.push_back(Entry {
            id,
            owner,
            running: true,
        });
        Ok(())
    }

    pub(super) fn owned(&self, id: &str, who: &Caller) -> Result<Uuid, Failure> {
        let owner = Owner::of(who)?;
        let id = Uuid::parse_str(id).ok().filter(|candidate| {
            candidate.to_string() == id
                && self
                    .entries
                    .iter()
                    .any(|entry| entry.id == *candidate && entry.owner == owner)
        });
        id.ok_or_else(|| Failure::denied("Use a process ID owned by this harness session."))
    }

    pub(super) fn forget(&mut self, id: Uuid) {
        self.entries.retain(|entry| entry.id != id);
    }

    /// Mark the registered process exited. Called by the trusted process port on terminal notification.
    pub fn finished(&mut self, id: Uuid) {
        if let Some(entry) = self.entries.iter_mut().find(|entry| entry.id == id) {
            entry.running = false;
        }
    }

    /// End ownership of one harness session and return its running processes for teardown.
    pub fn revoke_session(&mut self, session: &str) -> Vec<Uuid> {
        let mut running = Vec::new();
        self.entries.retain(|entry| {
            if entry.owner.session != session {
                true
            } else {
                if entry.running {
                    running.push(entry.id);
                }
                false
            }
        });
        running
    }

    pub(super) fn visible(&self, who: &Caller) -> Result<Vec<Uuid>, Failure> {
        let owner = Owner::of(who)?;
        Ok(self
            .entries
            .iter()
            .filter(|entry| entry.owner == owner)
            .map(|entry| entry.id)
            .collect())
    }

    pub(super) fn filter_owned(&self, mut result: Value, who: &Caller) -> Result<Value, Failure> {
        let items = result
            .get_mut("processes")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| Failure::new("IO_ERROR", "The process list has an invalid shape."))?;
        items.retain(|item| {
            item.get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| self.owned(id, who).is_ok())
        });
        Ok(result)
    }
}

/// Run a redeemed `proc.exec` using K10a's process port and bounded capture.
/// The supplied environment is the trusted inherited environment. Requested values
/// have already been validated by the Hostctl executor.
pub fn exec<F: plur1bus_core::policy::fs_paths::PathFs>(
    call: &super::Invocation<'_>,
    fs: &F,
    port: &dyn crate::exec::process::ProcessPort,
    clock: &dyn plur1bus_core::policy::decide::Clock,
    inherited: &[(String, Option<String>)],
    known: Option<crate::exec::capture::KnownSecrets<'_>>,
) -> Option<Result<Value, Failure>> {
    matches!(call.name(), "hostctl.proc.exec" | "hostctl.proc.shell")
        .then(|| run_exec(call, fs, port, clock, inherited, known))
}

fn run_exec<F: plur1bus_core::policy::fs_paths::PathFs>(
    call: &super::Invocation<'_>,
    fs: &F,
    port: &dyn crate::exec::process::ProcessPort,
    clock: &dyn plur1bus_core::policy::decide::Clock,
    inherited: &[(String, Option<String>)],
    known: Option<crate::exec::capture::KnownSecrets<'_>>,
) -> Result<Value, Failure> {
    use crate::exec::capture::BoundedCapture;
    use crate::exec::process::Event;
    use serde_json::json;

    let aborted = || Failure::new("ABORTED", "Cancelled.");
    if call.aborted() {
        return Err(aborted());
    }
    let (spec, directory) = checked_spawn(call, fs, inherited)?;
    if call.aborted() {
        return Err(aborted());
    }
    let start = clock.now();
    let timeout = call.timeout_ms() as f64;
    let mut child = port
        .spawn(&spec)
        .map_err(|_| Failure::new("IO_ERROR", "The approved process could not be started."))?;
    // The verified directory stays open until the process port has started the child.
    drop(directory);
    let mut capture = BoundedCapture::new(call.max_output_bytes(), known);
    loop {
        if call.aborted() {
            child.kill_tree();
            return Err(aborted());
        }
        let elapsed = clock.now() - start;
        if !elapsed.is_finite() || elapsed >= timeout {
            child.kill_tree();
            return Err(Failure::new("TIMEOUT", "Process lifetime exceeded."));
        }
        match child.next((timeout - elapsed).clamp(1.0, 30.0)) {
            Ok(Event::Stdout(chunk) | Event::Stderr(chunk)) => capture.push(&chunk),
            Ok(Event::Idle) => {}
            Ok(Event::Exit(exit)) => {
                let mut output = capture.text(true);
                if capture.truncated {
                    output.push_str("\n[OUTPUT TRUNCATED]");
                }
                let mut result = json!({"output":output,"truncated":capture.truncated,
                    "timedOut":false,"running":false,"exitCode":exit.code});
                if let Some(pid) = child.pid() {
                    result["pid"] = json!(pid);
                }
                return Ok(result);
            }
            Err(_) => {
                child.kill_tree();
                return Err(Failure::new(
                    "IO_ERROR",
                    "The process could not be observed.",
                ));
            }
        }
    }
}

fn checked_spawn<F: plur1bus_core::policy::fs_paths::PathFs>(
    call: &super::Invocation<'_>,
    fs: &F,
    inherited: &[(String, Option<String>)],
) -> Result<(crate::exec::process::SpawnSpec, F::Handle), Failure> {
    use crate::exec::process::SpawnSpec;
    use plur1bus_core::policy::fs_paths::{open_verified, FileKind, OpenFlags};
    let cwd = call.paths().first().ok_or_else(Failure::outside)?;
    let directory = open_verified(fs, cwd, OpenFlags::READ)
        .map_err(|_| Failure::new("CHANGED", "The working directory changed."))?;
    if !fs
        .fstat(&directory)
        .is_ok_and(|meta| meta.kind == FileKind::Dir)
    {
        return Err(Failure::new("CHANGED", "The working directory changed."));
    }
    let args = call.args();
    let (program, argv) = if call.name() == "hostctl.proc.shell" {
        let command = args
            .get("command")
            .and_then(Value::as_str)
            .ok_or_else(|| Failure::invalid("Expected a command."))?;
        let words = shell_args(call.shell_program, command);
        (
            call.shell_program,
            words.into_iter().map(str::to_owned).collect(),
        )
    } else {
        let program = args
            .get("program")
            .and_then(Value::as_str)
            .ok_or_else(|| Failure::invalid("Expected a program."))?;
        let argv = args
            .get("args")
            .and_then(Value::as_array)
            .into_iter()
            .flat_map(|items| items.iter().filter_map(Value::as_str).map(str::to_owned))
            .collect();
        (program, argv)
    };
    let allow: Vec<String> = call
        .env_allow
        .iter()
        .filter(|key| !super::args::forbidden_env(key))
        .cloned()
        .collect();
    let requested: Vec<_> = args
        .get("env")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|m| m.iter().map(|(name, value)| (name.clone(), value.clone())))
        .collect();
    let env = crate::exec::env::build_env(&allow, inherited, &requested, fs.platform() == "win32")
        .map_err(|_| Failure::denied("Environment keys must be approved."))?;
    let spec = SpawnSpec {
        program: program.to_owned(),
        args: argv,
        cwd: cwd.canonical().to_owned(),
        env,
    };

    Ok((spec, directory))
}

/// A bounded snapshot from the platform's process supervisor.
pub struct ProcessObservation {
    /// An informational OS process ID.
    pub pid: Option<u32>,
    /// Retained merged stdout and stderr.
    pub output: Vec<u8>,
    /// The supervisor discarded output beyond the requested budget.
    pub truncated: bool,
    /// The configured deadline elapsed.
    pub timed_out: bool,
    /// The process is running or draining.
    pub running: bool,
    /// The numeric exit code, when known.
    pub exit_code: Option<i32>,
}

/// The native operations for an already authorized session process.
pub trait SessionPort {
    /// Start the exact program using the passed arguments, cwd and cleared environment.
    /// An error leaves no running child. The invocation gives the output budget and lifetime.
    fn start(
        &mut self,
        id: Uuid,
        spec: &crate::exec::process::SpawnSpec,
        call: &super::Invocation<'_>,
    ) -> Result<ProcessObservation, Failure>;
    /// Read the bounded snapshot of this process ID.
    fn observe(
        &mut self,
        id: Uuid,
        call: &super::Invocation<'_>,
    ) -> Result<ProcessObservation, Failure>;
    /// Check the pending byte limit and enqueue input in one operation, optionally closing stdin.
    fn write(
        &mut self,
        id: Uuid,
        bytes: &[u8],
        eof: bool,
        max_pending: usize,
        call: &super::Invocation<'_>,
    ) -> Result<usize, Failure>;
    /// End the process tree for this registered process ID.
    fn stop(
        &mut self,
        id: Uuid,
        call: &super::Invocation<'_>,
    ) -> Result<ProcessObservation, Failure>;
}

/// Apply a session operation using only the opaque IDs verified by Hostctl.
pub fn session<F: plur1bus_core::policy::fs_paths::PathFs>(
    call: &super::Invocation<'_>,
    fs: &F,
    port: &mut dyn SessionPort,
    inherited: &[(String, Option<String>)],
    known: Option<crate::exec::capture::KnownSecrets<'_>>,
) -> Option<Result<Value, Failure>> {
    match call.name() {
        "hostctl.proc.start"
        | "hostctl.proc.list"
        | "hostctl.proc.read_output"
        | "hostctl.proc.write_stdin"
        | "hostctl.proc.kill" => Some(run_session(call, fs, port, inherited, known)),
        _ => None,
    }
}

fn run_session<F: plur1bus_core::policy::fs_paths::PathFs>(
    call: &super::Invocation<'_>,
    fs: &F,
    port: &mut dyn SessionPort,
    inherited: &[(String, Option<String>)],
    known: Option<crate::exec::capture::KnownSecrets<'_>>,
) -> Result<Value, Failure> {
    use serde_json::json;

    let aborted = || Failure::new("ABORTED", "Cancelled.");
    if call.aborted() {
        return Err(aborted());
    }
    if call.name() == "hostctl.proc.list" {
        let mut visible = Vec::new();
        for &id in call.visible_processes() {
            if call.aborted() {
                return Err(aborted());
            }
            let snapshot = port.observe(id, call)?;
            visible.push(observation(id, &snapshot, call.max_output_bytes(), known));
        }
        return Ok(json!({"processes":visible}));
    }
    let id = call
        .process_id()
        .ok_or_else(|| Failure::denied("A verified process ID is required."))?;
    let snapshot = match call.name() {
        "hostctl.proc.start" => {
            let (spec, directory) = checked_spawn(call, fs, inherited)?;
            if call.aborted() {
                return Err(aborted());
            }
            let started = port.start(id, &spec, call);
            drop(directory);
            started?
        }
        "hostctl.proc.read_output" => port.observe(id, call)?,
        "hostctl.proc.kill" => port.stop(id, call)?,
        "hostctl.proc.write_stdin" => {
            let text = call
                .args()
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| Failure::invalid("Expected standard input text."))?;
            let eof = call
                .args()
                .get("eof")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let written = port.write(id, text.as_bytes(), eof, call.max_output_bytes(), call)?;
            return Ok(json!({"written":written}));
        }
        _ => return Err(Failure::invalid("Choose a process session operation.")),
    };
    Ok(observation(id, &snapshot, call.max_output_bytes(), known))
}

fn observation(
    id: Uuid,
    snapshot: &ProcessObservation,
    max_output_bytes: usize,
    known: Option<crate::exec::capture::KnownSecrets<'_>>,
) -> Value {
    use crate::exec::capture::BoundedCapture;
    use serde_json::json;

    let mut capture = BoundedCapture::new(max_output_bytes, known);
    capture.push(&snapshot.output);
    let mut output = capture.text(!snapshot.running && !snapshot.truncated);
    let truncated = snapshot.truncated || capture.truncated;
    if truncated {
        output.push_str("\n[OUTPUT TRUNCATED]");
    }
    json!({"id":id.to_string(), "pid":snapshot.pid, "output":output, "truncated":truncated,
        "timedOut":snapshot.timed_out, "running":snapshot.running, "exitCode":snapshot.exit_code})
}

/// An OS handle that can identify and signal a foreign process without reusing a numeric PID.
pub trait ForeignProcessPort {
    /// A native handle bound to a live process.
    type Target;
    /// Bind the verified PID and refuse the harness, its supervisor and any process in its group.
    /// If the platform cannot bind an identity, this step returns `UNAVAILABLE`.
    fn bind(&mut self, pid: u32, call: &super::Invocation<'_>) -> Result<Self::Target, Failure>;
    /// Signal the same bound process with SIGTERM.
    fn terminate(
        &mut self,
        target: Self::Target,
        call: &super::Invocation<'_>,
    ) -> Result<(), Failure>;
}

/// Apply the separately approved foreign signal through a native identity handle.
pub fn signal_foreign<P: ForeignProcessPort>(
    call: &super::Invocation<'_>,
    port: &mut P,
) -> Option<Result<Value, Failure>> {
    (call.name() == "hostctl.proc.kill_foreign").then(|| {
        if call.aborted() {
            return Err(Failure::new("ABORTED", "Cancelled."));
        }
        let pid = call
            .args()
            .get("pid")
            .and_then(Value::as_f64)
            .ok_or_else(|| Failure::invalid("Expected a process ID."))? as u32;
        let target = port.bind(pid, call)?;
        if call.aborted() {
            return Err(Failure::new("ABORTED", "Cancelled."));
        }
        port.terminate(target, call)?;
        Ok(serde_json::json!({"signalled":true}))
    })
}
