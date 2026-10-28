//! `plur1bus ext __worker inspect|stage`: the supervisor's spawn of the two package-parsing halves (X1-R2). The
//! supervisor never reads package bytes; it runs the harness binary as a child with a deadline, reads the one JSON
//! line the child prints (`{ok:true,result}` or `{ok:false,error:{code,reason,message,data}}`) and kills it on overrun.
//! A crashing parser fails the call, never the supervisor. Supervisor-safe: only `std::process` (the lint in
//! `scripts/lint-hygiene.mjs` keeps it so).
use super::ExtError;
use crate::paths::Layout;
use serde_json::Value;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

/// How long an inspection may take (X1-R2).
pub const INSPECT_DEADLINE: Duration = Duration::from_secs(60);
/// How long staging may take (X1-R2).
pub const STAGE_DEADLINE: Duration = Duration::from_secs(300);

/// The most of the worker's stdout that is read: an inspection record is far smaller.
const STDOUT_CAP: u64 = 16 << 20;
/// The tail of the worker's stderr quoted when it gave no answer.
const STDERR_CAP: u64 = 64 << 10;

/// A fresh inspection id (uuid v4): the worker's `--id`, and the file stem under `run/inspect/`.
pub fn new_inspection_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// The `ErrorCode` names (the closed RPC enum).
const CODES: &[&str] = &[
    "E_UNAUTHORIZED",
    "E_RPC_VERSION",
    "E_NOT_AVAILABLE",
    "E_CORE_UNAVAILABLE",
    "E_INVALID_PARAMS",
    "E_AGENT_UNKNOWN",
    "E_CONFIG_INVALID",
    "E_MODULE_UNKNOWN",
    "E_INTERNAL",
    "E_LOCKED",
    "E_NOT_FOUND",
    "E_DENIED",
    "E_APPROVAL_REQUIRED",
    "E_CONFLICT",
    "E_STORAGE",
];

/// Every reason the worker half can answer (X1-R4 and the frozen ⟂EXT 2 names it reuses, plus the storage and io
/// reasons of the ext layer). A reason outside this list becomes `worker-failed`.
const REASONS: &[&str] = &[
    "package-invalid",
    "signature-invalid",
    "scripts-mismatch",
    "incompatible",
    "name-taken",
    "kind-unsupported",
    "policy-unsigned-disallowed",
    "revoked",
    "inspection-expired",
    "worker-failed",
    "archive-unsafe-entry",
    "archive-unsupported",
    "download-too-large",
    "digest-mismatch",
    "reserved-name",
    "socket-path-too-long",
    "io",
    "state-invalid",
    "index-invalid",
    "index-newer",
    "skills-locked",
    "egress-denied",
    "config-invalid",
    "source-unreachable",
];

/// Start barrier closes the Windows spawn-to-job-assignment race before the worker can create descendants.
pub(crate) fn await_start_gate() -> Result<(), ExtError> {
    if std::env::var("PLUR1BUS_EXT_WORKER_GATE").as_deref() == Ok("1") {
        let mut byte = [0];
        std::io::stdin()
            .read_exact(&mut byte)
            .map_err(|_| failed("ext worker start gate is closed"))?;
        if byte != [1] {
            return Err(failed("ext worker start gate is invalid"));
        }
    }
    Ok(())
}

/// Owns only the group/job created for this child, including streaming fetch descendants.
struct ProcessTree {
    killed: std::cell::Cell<bool>,
    #[cfg(unix)]
    pid: u32,
    #[cfg(windows)]
    job: windows_sys::Win32::Foundation::HANDLE,
}

impl ProcessTree {
    fn attach(child: &std::process::Child) -> std::io::Result<Self> {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Foundation::CloseHandle;
            use windows_sys::Win32::System::JobObjects::*;
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return Err(std::io::Error::last_os_error());
                }
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const _,
                    std::mem::size_of_val(&limits) as u32,
                ) == 0
                    || AssignProcessToJobObject(job, child.as_raw_handle() as _) == 0
                {
                    let error = std::io::Error::last_os_error();
                    CloseHandle(job);
                    return Err(error);
                }
                Ok(Self {
                    killed: std::cell::Cell::new(false),
                    job,
                })
            }
        }
        #[cfg(not(windows))]
        {
            Ok(Self {
                killed: std::cell::Cell::new(false),
                #[cfg(unix)]
                pid: child.id(),
            })
        }
    }

    fn kill(&self) {
        if self.killed.replace(true) {
            return;
        }
        #[cfg(unix)]
        if let Ok(pid) = i32::try_from(self.pid) {
            if pid > 0 {
                unsafe {
                    libc::kill(-pid, libc::SIGKILL);
                }
            }
        }
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job, 1);
        }
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        self.kill();
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job);
        }
    }
}

/// The test seam `PLUR1BUS_TEST_EXT_WORKER_ARGS=<op>:<arg> [<arg>…][;<op>:…]` (test internals only): extra arguments
/// the supervisor passes to the worker for `op` (`inspect` or `stage`), such as `stage:--crash` or
/// `inspect:--sleep-ms 800;stage:--sleep-ms 800`. Empty otherwise.
pub fn seam_args(op: &str) -> Vec<String> {
    if std::env::var("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref() != Ok("1") {
        return Vec::new();
    }
    let Ok(v) = std::env::var("PLUR1BUS_TEST_EXT_WORKER_ARGS") else {
        return Vec::new();
    };
    v.split(';')
        .filter_map(|part| part.trim().split_once(':'))
        .filter(|(which, _)| *which == op)
        .flat_map(|(_, rest)| rest.split_whitespace().map(str::to_string))
        .collect()
}

/// `default`, or the test seam `PLUR1BUS_TEST_EXT_WORKER_DEADLINE_MS=<op>:<ms>` for `op` (test internals only).
pub fn deadline(op: &str, default: Duration) -> Duration {
    if std::env::var("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref() != Ok("1") {
        return default;
    }
    std::env::var("PLUR1BUS_TEST_EXT_WORKER_DEADLINE_MS")
        .ok()
        .and_then(|v| {
            let (which, ms) = v.split_once(':')?;
            (which == op)
                .then(|| ms.trim().parse::<u64>().ok())
                .flatten()
        })
        .map_or(default, Duration::from_millis)
}

/// Set by [`stop_all`]: a running worker is killed and no new one starts.
static STOPPING: AtomicBool = AtomicBool::new(false);
/// Workers started and not yet reaped.
static RUNNING: AtomicUsize = AtomicUsize::new(0);

/// Counts a running worker until it is reaped.
struct Running;
impl Running {
    fn start() -> Running {
        RUNNING.fetch_add(1, Ordering::SeqCst);
        Running
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        RUNNING.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The supervisor is stopping: every running worker is killed (its caller gets `worker-failed` and cleans up), none
/// starts from now on, and this waits up to `within` for them to be reaped. Returns whether none is left.
pub fn stop_all(within: Duration) -> bool {
    STOPPING.store(true, Ordering::SeqCst);
    let start = Instant::now();
    while RUNNING.load(Ordering::SeqCst) > 0 {
        if start.elapsed() >= within {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    true
}

/// Whether `e` is the worker itself failing (a crash, a kill after its deadline, an answer that could not be read),
/// as opposed to a refusal it answered.
pub fn is_worker_failure(e: &ExtError) -> bool {
    e.code == "E_INTERNAL" && e.reason == Some("worker-failed")
}

fn failed(message: impl Into<String>) -> ExtError {
    ExtError::new("E_INTERNAL", "worker-failed", message)
}

fn intern(list: &[&'static str], s: &str) -> Option<&'static str> {
    list.iter().copied().find(|x| *x == s)
}

/// [`spawn_worker_with`] on this process's own executable (`std::env::current_exe()`).
pub fn spawn_worker(layout: &Layout, args: &[&str], deadline: Duration) -> Result<Value, ExtError> {
    let exe = std::env::current_exe()
        .map_err(|e| failed(format!("cannot locate the harness binary: {e}")))?;
    spawn_worker_with(&exe, layout, args, deadline)
}

fn drain(r: Option<impl Read + Send + 'static>, cap: u64) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(r) = r {
            let mut r = r.take(cap);
            let _ = r.read_to_end(&mut buf);
            // Keep reading (and dropping) past the cap so the child never blocks on a full pipe.
            let _ = std::io::copy(&mut r.into_inner(), &mut std::io::sink());
        }
        buf
    })
}

/// Runs `<exe> ext __worker <args…> --home <home>` with stdin closed and waits at most `deadline`. Its answer line's
/// `result` is returned; its refusal becomes the same [`ExtError`]. A worker that overruns is killed; one that exits
/// without a readable answer (a crash, a panic) is `E_INTERNAL reason=worker-failed` with its exit status and the
/// tail of its stderr.
pub(crate) fn spawn_worker_with(
    exe: &Path,
    layout: &Layout,
    args: &[&str],
    deadline: Duration,
) -> Result<Value, ExtError> {
    // Counted before the stop flag is read: a `stop_all` that sees no worker running has set the flag first, so this
    // spawn then sees it and starts nothing.
    let _running = Running::start();
    if STOPPING.load(Ordering::SeqCst) {
        return Err(failed(
            "the supervisor is stopping; no ext worker is started",
        ));
    }
    let mut command = Command::new(exe);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .args(["ext", "__worker"])
        .args(args)
        .arg("--home")
        .arg(&layout.home)
        .env("PLUR1BUS_EXT_WORKER_GATE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            failed(format!(
                "cannot start the ext worker {}: {e}",
                exe.display()
            ))
        })?;
    let tree = ProcessTree::attach(&child).map_err(|_| {
        let _ = child.kill();
        let _ = child.wait();
        failed("cannot isolate the ext worker process tree")
    })?;
    // The worker does not parse or spawn anything until it belongs to our process tree.
    if let Some(mut input) = child.stdin.take() {
        let _ = input.write_all(&[1]);
    }
    let out = drain(child.stdout.take(), STDOUT_CAP);
    let err = drain(child.stderr.take(), STDERR_CAP);
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if STOPPING.load(Ordering::SeqCst) => {
                tree.kill();
                let _ = child.kill();
                let _ = child.wait();
                let _ = (out.join(), err.join());
                return Err(failed(
                    "the supervisor is stopping; the ext worker was stopped",
                ));
            }
            Ok(None) if start.elapsed() >= deadline => {
                tree.kill();
                let _ = child.kill();
                let _ = child.wait();
                let _ = (out.join(), err.join());
                return Err(failed(format!(
                    "the ext worker did not answer within {} s and was stopped",
                    deadline.as_secs_f64()
                )));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => {
                tree.kill();
                let _ = child.kill();
                let _ = child.wait();
                let _ = (out.join(), err.join());
                return Err(failed(format!("cannot wait for the ext worker: {e}")));
            }
        }
    };
    // Also close descendants' inherited stdout/stderr when a parser exits before its children.
    tree.kill();
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    answer(&stdout).unwrap_or_else(|| {
        let tail = String::from_utf8_lossy(&stderr);
        let tail = tail.trim();
        let tail: String = tail
            .chars()
            .rev()
            .take(2000)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        Err(failed(format!(
            "the ext worker exited ({status}) without an answer{}",
            if tail.is_empty() {
                String::new()
            } else {
                format!(": {tail}")
            }
        )))
    })
}

/// The worker's answer: its last non-empty stdout line. `None` when there is none or it is not an answer.
fn answer(stdout: &[u8]) -> Option<Result<Value, ExtError>> {
    let text = std::str::from_utf8(stdout).ok()?;
    let line = text.lines().rev().find(|l| !l.trim().is_empty())?;
    let v: Value = serde_json::from_str(line).ok()?;
    match v.get("ok").and_then(Value::as_bool)? {
        true => Some(Ok(v.get("result").cloned().unwrap_or(Value::Null))),
        false => {
            let e = v.get("error")?;
            let s = |k: &str| e.get(k).and_then(Value::as_str).unwrap_or("");
            let message = s("message").to_string();
            let data = e.get("data").cloned().unwrap_or(Value::Null);
            let no_reason = e.get("reason").is_none_or(Value::is_null);
            Some(Err(
                match (intern(CODES, s("code")), intern(REASONS, s("reason"))) {
                    (Some(code), Some(reason)) => {
                        ExtError::new(code, reason, message).with_data(data)
                    }
                    (Some(code), None) if no_reason => ExtError {
                        code,
                        reason: None,
                        message,
                        data,
                    },
                    _ => failed(format!(
                        "the ext worker answered {} {}: {message}",
                        s("code"),
                        s("reason")
                    )),
                },
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_are_read_from_the_last_line_and_unknown_names_are_worker_failed() {
        let ok = answer(b"noise\n{\"ok\":true,\"result\":{\"a\":1}}\n\n")
            .unwrap()
            .unwrap();
        assert_eq!(ok["a"], 1);
        let e = answer(
            br#"{"ok":false,"error":{"code":"E_CONFLICT","reason":"name-taken","message":"m","data":{"k":1}}}"#,
        )
        .unwrap()
        .unwrap_err();
        assert_eq!(
            (e.code, e.reason, e.data["k"].clone()),
            ("E_CONFLICT", Some("name-taken"), 1.into())
        );
        let e = answer(br#"{"ok":false,"error":{"code":"E_NOPE","reason":"x","message":"m"}}"#)
            .unwrap()
            .unwrap_err();
        assert_eq!((e.code, e.reason), ("E_INTERNAL", Some("worker-failed")));
        assert!(answer(b"").is_none() && answer(b"not json").is_none() && answer(b"{}").is_none());
    }

    #[test]
    fn every_package_refusal_reason_survives_the_worker_boundary() {
        use plur1bus_ext::refusal::reason as r;
        for x in [
            r::PACKAGE_INVALID,
            r::SIGNATURE_INVALID,
            r::SCRIPTS_MISMATCH,
            r::INCOMPATIBLE,
            r::UNSAFE_ENTRY,
            r::UNSUPPORTED,
            r::TOO_LARGE,
            r::DIGEST,
            r::RESERVED,
            r::KIND_UNSUPPORTED,
            r::REVOKED,
        ] {
            assert!(REASONS.contains(&x), "{x}");
        }
    }
}
