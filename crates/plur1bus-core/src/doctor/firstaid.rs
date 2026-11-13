//! `runFirstAid` of `doctor-report.ts`: the installation probe. It runs `plur1bus --home <home> --json 1staid check`
//! with an 8 second timeout and a 1 MiB bound on each output stream, and parses the JSON the CLI prints. A failing
//! check exits nonzero but still prints the authoritative report, so the exit status only decides which reason a
//! JSON that does not parse gets.
use crate::frame::RpcErr;
use serde_json::Value;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// How long the probe may run.
pub const TIMEOUT: Duration = Duration::from_secs(8);
/// How much of each output stream is kept; more kills the probe.
pub const MAX_BUFFER: usize = 1024 * 1024;
const POLL: Duration = Duration::from_millis(5);

/// The refusal for a probe that did not give a report. `reason` is `firstaid-unavailable` or `firstaid-invalid`.
pub fn unavailable(reason: &str) -> RpcErr {
    RpcErr::new(
        "E_NOT_AVAILABLE",
        "installation diagnostics are unavailable",
        Some(reason),
    )
}

/// What `runFirstAid(home)` runs: `$PLUR1BUS_BIN`, else `plur1bus`.
pub fn run_first_aid(home: &Path) -> Result<Value, RpcErr> {
    let binary = std::env::var("PLUR1BUS_BIN").unwrap_or_else(|_| "plur1bus".to_owned());
    run_first_aid_with(home, &binary, TIMEOUT, MAX_BUFFER)
}

/// `runFirstAid(home, binary)` with its limits as parameters.
pub fn run_first_aid_with(
    home: &Path,
    binary: &str,
    timeout: Duration,
    max_buffer: usize,
) -> Result<Value, RpcErr> {
    let mut command = Command::new(binary);
    command
        .arg("--home")
        .arg(home)
        .args(["--json", "1staid", "check"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: windowsHide
    }
    let Ok(mut child) = command.spawn() else {
        return Err(unavailable("firstaid-unavailable"));
    };
    let overflow = Arc::new(AtomicBool::new(false));
    let stdout = child
        .stdout
        .take()
        .map(|r| drain(r, max_buffer, overflow.clone()));
    let stderr = child
        .stderr
        .take()
        .map(|r| drain(r, max_buffer, overflow.clone()));
    let deadline = Instant::now() + timeout;
    let mut error = false;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                error |= !status.success();
                break;
            }
            Ok(None) => {}
            Err(_) => {
                error = true;
                break;
            }
        }
        if overflow.load(Ordering::SeqCst) || Instant::now() >= deadline {
            error = true;
            let _ = child.kill();
            let _ = child.wait();
            break;
        }
        thread::sleep(POLL);
    }
    let out = stdout.and_then(|h| h.join().ok()).unwrap_or_default();
    if let Some(h) = stderr {
        let _ = h.join();
    }
    error |= overflow.load(Ordering::SeqCst);
    match serde_json::from_str::<Value>(&String::from_utf8_lossy(&out)) {
        Ok(doc) => Ok(doc),
        Err(_) => Err(unavailable(if error {
            "firstaid-unavailable"
        } else {
            "firstaid-invalid"
        })),
    }
}

/// Reads a stream to its end, keeping at most `max` bytes; more sets `overflow`.
fn drain(
    mut stream: impl Read + Send + 'static,
    max: usize,
    overflow: Arc<AtomicBool>,
) -> JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut kept = Vec::new();
        let mut chunk = [0u8; 8192];
        while let Ok(n) = stream.read(&mut chunk) {
            if n == 0 {
                break;
            }
            let room = max.saturating_sub(kept.len());
            kept.extend_from_slice(&chunk[..n.min(room)]);
            if n > room {
                overflow.store(true, Ordering::SeqCst);
            }
        }
        kept
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    const SHORT: Duration = Duration::from_millis(400);

    fn script(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("fake-plur1bus");
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn run(body: &str, timeout: Duration, max: usize) -> Result<Value, RpcErr> {
        let dir = tempfile::tempdir().unwrap();
        let bin = script(dir.path(), body);
        run_first_aid_with(Path::new("/h"), bin.to_str().unwrap(), timeout, max)
    }

    fn reason(e: &RpcErr) -> &str {
        assert_eq!(e.code, "E_NOT_AVAILABLE");
        assert_eq!(e.message, "installation diagnostics are unavailable");
        e.reason.as_deref().unwrap()
    }

    #[test]
    fn passes_the_arguments_and_parses_the_report() {
        let dir = tempfile::tempdir().unwrap();
        let bin = script(
            dir.path(),
            r#"printf '{"schema":"1staid.check/1","args":"%s|%s|%s|%s|%s","checks":[]}' "$1" "$2" "$3" "$4" "$5""#,
        );
        let doc = run_first_aid_with(
            Path::new("/some/home"),
            bin.to_str().unwrap(),
            SHORT,
            MAX_BUFFER,
        )
        .unwrap();
        assert_eq!(doc["args"], "--home|/some/home|--json|1staid|check");
        assert_eq!(doc["schema"], "1staid.check/1");
    }

    #[test]
    fn a_failing_check_still_gives_its_report() {
        let doc = run(
            r#"echo '{"schema":"1staid.check/1","checks":[]}'; exit 3"#,
            SHORT,
            MAX_BUFFER,
        )
        .unwrap();
        assert_eq!(doc["checks"], serde_json::json!([]));
    }

    #[test]
    fn output_that_is_not_json_is_invalid_after_a_clean_exit_and_unavailable_after_a_failure() {
        let clean = run("echo not json", SHORT, MAX_BUFFER).unwrap_err();
        assert_eq!(reason(&clean), "firstaid-invalid");
        let empty = run("true", SHORT, MAX_BUFFER).unwrap_err();
        assert_eq!(reason(&empty), "firstaid-invalid");
        let failed = run("echo not json; exit 1", SHORT, MAX_BUFFER).unwrap_err();
        assert_eq!(reason(&failed), "firstaid-unavailable");
    }

    #[test]
    fn a_missing_binary_is_unavailable() {
        let e = run_first_aid_with(Path::new("/h"), "/nonexistent/plur1bus", SHORT, MAX_BUFFER)
            .unwrap_err();
        assert_eq!(reason(&e), "firstaid-unavailable");
    }

    #[test]
    fn a_probe_that_runs_too_long_is_killed() {
        let started = Instant::now();
        let e = run("exec sleep 5", Duration::from_millis(200), MAX_BUFFER).unwrap_err();
        assert_eq!(reason(&e), "firstaid-unavailable");
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn a_probe_that_prints_more_than_the_bound_is_killed() {
        let started = Instant::now();
        let e = run(
            r#"printf '{"schema":"x","pad":"'; yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | head -c 200000"#,
            Duration::from_secs(2),
            1000,
        )
        .unwrap_err();
        assert_eq!(reason(&e), "firstaid-unavailable");
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn stderr_does_not_reach_the_report() {
        let doc = run(
            r#"echo noise >&2; echo '{"schema":"1staid.check/1","checks":[]}'"#,
            SHORT,
            MAX_BUFFER,
        )
        .unwrap();
        assert_eq!(doc["schema"], "1staid.check/1");
    }
}
