//! The real [`Host`]: every action is a child `plur1bus` process, the old binary for `daemon stop` and the *target*
//! binary for everything the new version must prove (`daemon start`, `--version`, `daemon status`, `1staid check`).
//! The service manager is only ever reached through those commands, i.e. through `service::Runner`.
use super::Host;
use crate::paths::Layout;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// One command's budget (a `daemon start` waits for the core itself).
const STEP_TIMEOUT: Duration = Duration::from_secs(180);
const POLL: Duration = Duration::from_millis(250);

pub struct SystemHost {
    /// The binary that runs `daemon stop`: the one that is running now.
    pub current: PathBuf,
    pub gate_timeout: Duration,
}

impl SystemHost {
    pub fn new(current: PathBuf) -> Self {
        let test = std::env::var("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref() == Ok("1");
        let ms = test
            .then(|| std::env::var("PLUR1BUS_UPDATE_GATE_TIMEOUT_MS").ok())
            .flatten()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(90_000);
        SystemHost {
            current,
            gate_timeout: Duration::from_millis(ms),
        }
    }
}

struct Ran {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

fn run(bin: &Path, layout: &Layout, args: &[&str], timeout: Duration) -> Result<Ran, String> {
    let mut child = Command::new(bin)
        .arg("--home")
        .arg(&layout.home)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot run {}: {e}", bin.display()))?;
    let deadline = Instant::now() + timeout;
    let (mut out, mut err) = (child.stdout.take(), child.stderr.take());
    // Drain on threads so a chatty child cannot fill a pipe while we poll.
    let read = |r: Option<Box<dyn std::io::Read + Send>>| {
        std::thread::spawn(move || {
            let mut s = String::new();
            if let Some(mut r) = r {
                let _ = r.read_to_string(&mut s);
            }
            s
        })
    };
    let (ho, he) = (
        read(
            out.take()
                .map(|r| Box::new(r) as Box<dyn std::io::Read + Send>),
        ),
        read(
            err.take()
                .map(|r| Box::new(r) as Box<dyn std::io::Read + Send>),
        ),
    );
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("`{} {}` timed out", bin.display(), args.join(" ")));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(e.to_string()),
        }
    };
    Ok(Ran {
        code: status.code(),
        stdout: ho.join().unwrap_or_default(),
        stderr: he.join().unwrap_or_default(),
    })
}

fn failed(what: &str, r: &Ran) -> String {
    let detail = if r.stderr.trim().is_empty() {
        r.stdout.trim()
    } else {
        r.stderr.trim()
    };
    format!("{what} exited with {:?}: {detail}", r.code)
}

impl Host for SystemHost {
    fn stop(&self, layout: &Layout) -> Result<bool, String> {
        let r = run(
            &self.current,
            layout,
            &["--json", "daemon", "stop"],
            STEP_TIMEOUT,
        )?;
        if r.code != Some(0) {
            return Err(failed("daemon stop", &r));
        }
        let doc: Value =
            serde_json::from_str(&r.stdout).map_err(|e| format!("daemon stop: {e}"))?;
        Ok(doc["wasRunning"].as_bool().unwrap_or(false))
    }

    fn start(&self, layout: &Layout, bin: &Path) -> Result<(), String> {
        let r = run(bin, layout, &["--json", "daemon", "start"], STEP_TIMEOUT)?;
        if r.code == Some(0) {
            Ok(())
        } else {
            Err(failed("daemon start", &r))
        }
    }

    fn gate(&self, layout: &Layout, bin: &Path, version: &str) -> Result<(), String> {
        let v = run(bin, layout, &["--version"], Duration::from_secs(20))?;
        if v.code != Some(0) || !v.stdout.split_whitespace().any(|w| w == version) {
            return Err(format!(
                "the new binary reports `{}`, expected {version}",
                v.stdout.trim()
            ));
        }
        let deadline = Instant::now() + self.gate_timeout;
        loop {
            let last = match gate_once(bin, layout) {
                Ok(()) => return Ok(()),
                Err(m) => m,
            };
            if Instant::now() >= deadline {
                return Err(format!(
                    "not healthy within {} s: {last}",
                    self.gate_timeout.as_secs()
                ));
            }
            std::thread::sleep(POLL);
        }
    }

    fn alive(&self, pid: u32) -> bool {
        crate::proc::pid_alive(pid)
    }
}

/// One pass: the core child is `ready`, and `1staid check` has no `fail`.
fn gate_once(bin: &Path, layout: &Layout) -> Result<(), String> {
    let s = run(
        bin,
        layout,
        &["--json", "daemon", "status"],
        Duration::from_secs(20),
    )?;
    let doc: Value = serde_json::from_str(&s.stdout).map_err(|_| failed("daemon status", &s))?;
    if crate::commands::daemon::core_child(&doc).and_then(|c| c["process"]["state"].as_str())
        != Some("ready")
    {
        return Err("the core is not ready".into());
    }
    let c = run(
        bin,
        layout,
        &["--json", "1staid", "check"],
        Duration::from_secs(60),
    )?;
    let doc: Value = serde_json::from_str(&c.stdout).map_err(|_| failed("1staid check", &c))?;
    if c.code == Some(0) && doc["ok"].as_bool() == Some(true) {
        Ok(())
    } else {
        let bad: Vec<String> = doc["checks"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|x| x["status"] == "fail")
            .filter_map(|x| x["id"].as_str().map(str::to_string))
            .collect();
        Err(format!("1staid check failed: {}", bad.join(", ")))
    }
}
