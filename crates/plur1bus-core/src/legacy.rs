//! The legacy TypeScript core behind the front door (`core-legacy`, plan §2.4): spawned by the front door as
//! `node <core.js> --home <home> --behind-front-door supervised|standalone --lifeline stdin --instance <uuid>
//! [--test-internals <v>]`, with its stdin as the lifeline the front door holds. Its first stdout line is the TypeScript
//! core's ready line (`{"ready":true,"address","pid"}`); everything after it is copied to the front door's stderr.
//!
//! Ruling (P4-10, plan §3 "a core-legacy slot ... adopted under the front door"): the slot lives in the front door, not in
//! the supervisor. The legacy core is reachable only through the front door and is useless without it, so its lifetime is
//! the front door's: it is in the front door's process group (the supervisor's group kill covers it), it stops at once
//! when its lifeline closes, and an unexpected exit of it ends the front door too, so the supervisor restarts the pair
//! with its existing backoff, adoption and hang handling unchanged. `plur1bus core run` gets the same pair without a
//! supervisor. A legacy core that hangs notices no lifeline, so the OS ties it to the front door as well (security
//! review M4, [`Binding`]): Linux by a parent-death signal, Windows by a job object; on macOS the supervisor's and
//! 1staid's kill paths also kill the pid in `run/core-legacy.pid`.
use crate::lifecycle::relock;
use std::ffi::OsString;
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

/// How to start the legacy core.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LegacySpec {
    /// The Node runtime (`PLUR1BUS_NODE`, set by the CLI and the supervisor to the located runtime; `node` otherwise).
    pub node: PathBuf,
    /// `core.js` (`PLUR1BUS_CORE_JS`; `<home>/runtime/core/core.js` otherwise, as the CLI locates it).
    pub core_js: PathBuf,
    /// The harness home.
    pub home: PathBuf,
    /// The front door runs under the supervisor (`--lifeline stdin`): the legacy core reads its configuration from the
    /// supervisor's `config.watch` (`supervised`), else from `config.json` (`standalone`).
    pub supervised: bool,
    /// `PLUR1BUS_TEST_INTERNALS`, passed on as `--test-internals` exactly as `plur1bus core run` does.
    pub test_internals: Option<OsString>,
}

impl LegacySpec {
    /// The spec from the environment the CLI or the supervisor gave the front door.
    pub fn from_env(home: &Path, supervised: bool) -> LegacySpec {
        LegacySpec {
            node: std::env::var_os("PLUR1BUS_NODE")
                .map_or_else(|| PathBuf::from("node"), PathBuf::from),
            core_js: std::env::var_os("PLUR1BUS_CORE_JS").map_or_else(
                || home.join("runtime").join("core").join("core.js"),
                PathBuf::from,
            ),
            home: home.to_path_buf(),
            supervised,
            test_internals: std::env::var_os("PLUR1BUS_TEST_INTERNALS").filter(|v| !v.is_empty()),
        }
    }

    /// The command line, without the program.
    pub fn args(&self, instance: &str) -> Vec<OsString> {
        let mut args: Vec<OsString> = vec![
            self.core_js.clone().into(),
            "--home".into(),
            self.home.clone().into(),
            "--behind-front-door".into(),
            (if self.supervised {
                "supervised"
            } else {
                "standalone"
            })
            .into(),
            "--lifeline".into(),
            "stdin".into(),
            "--instance".into(),
            instance.into(),
        ];
        if let Some(v) = &self.test_internals {
            args.push("--test-internals".into());
            args.push(v.clone());
        }
        args
    }
}

/// A running legacy core.
pub struct Legacy {
    /// The process; the waiter takes it once the core is ready.
    pub child: Child,
    /// Its pid.
    pub pid: u32,
    /// Its instance id (`--instance`).
    pub instance: String,
    /// The write end of its stdin: its lifeline. Dropping it (or this process ending) orphans the legacy core, which
    /// then stops at once.
    pub lifeline: Option<ChildStdin>,
    /// What ties its life to this process; keep it until the legacy core is gone (dropping it on Windows kills it).
    pub binding: Binding,
}

/// What ties the legacy core's life to the front door's at the OS level (P4-10 security review M4), so a hung legacy
/// core does not outlive a killed front door, holding `run/core-legacy.lock` and the stores: Linux arms
/// `PR_SET_PDEATHSIG(SIGKILL)` in the child (`plur1bus_rpc::process::die_with_parent`), Windows assigns it to a job
/// object that kills on close (this value holds it). macOS has neither; there the supervisor's and 1staid's kill paths
/// also kill the pid in `run/core-legacy.pid`.
pub struct Binding {
    #[cfg(windows)]
    _job: Option<plur1bus_rpc::win::KillOnClose>,
}

impl Binding {
    /// Ends the binding once the legacy core is gone (Windows: closes the job, which ends anything still in it).
    pub fn release(self) {
        #[cfg(windows)]
        drop(self._job);
    }

    fn of(child: &Child) -> Binding {
        #[cfg(windows)]
        {
            let job = plur1bus_rpc::win::KillOnClose::assign(child)
                .map_err(|e| {
                    crate::server::log(
                        "warn",
                        "cannot bind the legacy core to the front door (job object); it may outlive a killed front door",
                        serde_json::json!({"err": e.to_string()}),
                    );
                })
                .ok();
            Binding { _job: job }
        }
        #[cfg(not(windows))]
        {
            let _ = child;
            Binding {}
        }
    }
}

/// Why the legacy core did not become ready.
#[derive(Debug)]
pub enum StartError {
    /// It could not be spawned.
    Spawn(io::Error),
    /// It exited before its ready line (its exit status; the TypeScript core's codes: 2 config invalid, 3 lock held, 4
    /// engine contract).
    Exited(ExitStatus),
    /// Its first line was not a ready line naming its own pid and the legacy address.
    BadReady(String),
    /// A stop was requested while it was starting.
    Stopped,
}

/// Spawns the legacy core as the front door's `instance` and waits for its ready line, while `stop` is not set. The
/// shared instance id is what binds `run/core-legacy.pid` to `run/core.pid` for the peers that check the core's pid
/// (the tools service). The legacy core's stderr is inherited (it goes where the front door's goes: the supervisor's
/// `logs/core.out.log`, or the terminal of `core run`).
pub fn start(
    spec: &LegacySpec,
    instance: &str,
    expected_address: &str,
    stop: &mut dyn FnMut() -> bool,
) -> Result<Legacy, StartError> {
    let instance = instance.to_owned();
    let mut cmd = Command::new(&spec.node);
    cmd.args(spec.args(&instance))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    // Called on the main thread (`serve`), which ends only with the process: the parent-death signal fires when the front
    // door ends, however it ends.
    #[cfg(unix)]
    plur1bus_rpc::process::die_with_parent(&mut cmd);
    let mut child = cmd.spawn().map_err(StartError::Spawn)?;
    let binding = Binding::of(&child);
    let pid = child.id();
    let lifeline = child.stdin.take();
    let stdout = child.stdout.take();
    let (tx, rx) = mpsc::channel::<String>();
    if let Some(stdout) = stdout {
        let spawned = std::thread::Builder::new()
            .name("core-legacy-stdout".into())
            .spawn(move || {
                let mut lines = BufReader::new(stdout);
                let mut first = String::new();
                if lines.read_line(&mut first).unwrap_or(0) > 0 {
                    let _ = tx.send(first);
                }
                // Anything later on stdout is not a protocol: copy it to stderr so the pipe never fills.
                let mut rest = Vec::new();
                while lines.read_until(b'\n', &mut rest).unwrap_or(0) > 0 {
                    let _ = io::stderr().lock().write_all(&rest);
                    rest.clear();
                }
            });
        if let Err(e) = spawned {
            let _ = child.kill();
            let _ = child.wait();
            return Err(StartError::Spawn(e));
        }
    }
    let mut legacy = Legacy {
        child,
        pid,
        instance,
        lifeline,
        binding,
    };
    loop {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(line) => {
                return match check_ready(&line, pid, expected_address) {
                    Ok(()) => Ok(legacy),
                    Err(e) => {
                        legacy.kill();
                        Err(StartError::BadReady(e))
                    }
                };
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // stdout closed without a ready line: the process is exiting.
                let status = legacy.child.wait().map_err(StartError::Spawn)?;
                return Err(StartError::Exited(status));
            }
        }
        if let Ok(Some(status)) = legacy.child.try_wait() {
            return Err(StartError::Exited(status));
        }
        if stop() {
            legacy.kill();
            return Err(StartError::Stopped);
        }
    }
}

/// The TypeScript core's ready line: `{"ready":true,"address":<legacy address>,"pid":<its pid>}`.
pub fn check_ready(line: &str, pid: u32, expected_address: &str) -> Result<(), String> {
    let v: serde_json::Value =
        serde_json::from_str(line.trim()).map_err(|_| "the first line is not JSON".to_owned())?;
    if v["ready"] != true {
        return Err("the first line is not a ready line".into());
    }
    if v["pid"].as_u64() != Some(u64::from(pid)) {
        return Err("the ready line names another pid".into());
    }
    if v["address"].as_str() != Some(expected_address) {
        return Err("the ready line names another address".into());
    }
    Ok(())
}

impl Legacy {
    /// Kills the process (SIGKILL / TerminateProcess) and reaps it.
    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Waits for `child` to exit until `deadline`; `None` when it is still running then. The lock is taken for each look
/// only, so the thread that watches the legacy core's exit keeps its turn.
pub fn wait_until(child: &Mutex<Child>, deadline: Instant) -> Option<ExitStatus> {
    loop {
        if let Ok(Some(status)) = relock(child).try_wait() {
            return Some(status);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn wait_until_returns_the_exit_or_nothing_at_the_deadline() {
        let quick = Mutex::new(Command::new("sh").args(["-c", "exit 3"]).spawn().unwrap());
        let status = wait_until(&quick, Instant::now() + Duration::from_secs(10)).unwrap();
        assert_eq!(status.code(), Some(3));
        let slow = Mutex::new(Command::new("sleep").arg("10").spawn().unwrap());
        let started = Instant::now();
        assert!(wait_until(&slow, Instant::now() + Duration::from_millis(100)).is_none());
        assert!(started.elapsed() < Duration::from_secs(5));
        let mut child = slow.lock().unwrap();
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn the_command_line_is_bin_ts_behind_the_front_door() {
        let spec = LegacySpec {
            node: "node".into(),
            core_js: "/r/core.js".into(),
            home: "/h".into(),
            supervised: true,
            test_internals: Some("flat-embedder".into()),
        };
        let args: Vec<String> = spec
            .args("u-1")
            .into_iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            [
                "/r/core.js",
                "--home",
                "/h",
                "--behind-front-door",
                "supervised",
                "--lifeline",
                "stdin",
                "--instance",
                "u-1",
                "--test-internals",
                "flat-embedder"
            ]
        );
        let standalone = LegacySpec {
            supervised: false,
            test_internals: None,
            ..spec
        };
        assert!(standalone
            .args("u")
            .iter()
            .any(|a| a.to_string_lossy() == "standalone"));
        assert!(!standalone
            .args("u")
            .iter()
            .any(|a| a.to_string_lossy() == "--test-internals"));
    }

    #[test]
    fn only_a_ready_line_with_its_own_pid_and_the_legacy_address_counts() {
        assert!(check_ready(
            r#"{"ready":true,"address":"/h/run/core-legacy.sock","pid":7}"#,
            7,
            "/h/run/core-legacy.sock"
        )
        .is_ok());
        assert!(check_ready(
            r#"{"ready":true,"address":"/h/run/core-legacy.sock","pid":8}"#,
            7,
            "/h/run/core-legacy.sock"
        )
        .is_err());
        assert!(check_ready(
            r#"{"ready":true,"address":"/h/run/core.sock","pid":7}"#,
            7,
            "/h/run/core-legacy.sock"
        )
        .is_err());
        assert!(check_ready("core: starting", 7, "/x").is_err());
        assert!(check_ready(r#"{"ready":false,"address":"/x","pid":7}"#, 7, "/x").is_err());
    }
}
