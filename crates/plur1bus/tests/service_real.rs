//! The real OS service manager (systemd user instance, launchd GUI domain, Task Scheduler). Runs only with
//! `PLUR1BUS_SERVICE_TEST=1` (the CI `service` job, or the owner's VM): it registers a service under the test home's
//! suffixed name (S10), never the plain one, and removes it again even when an assertion fails. Run it with
//! `--test-threads=1`.
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

fn enabled() -> bool {
    let on = std::env::var("PLUR1BUS_SERVICE_TEST").as_deref() == Ok("1");
    if !on {
        eprintln!("skipped: set PLUR1BUS_SERVICE_TEST=1 to register a real OS service");
    }
    on
}

fn bin() -> PathBuf {
    assert_cmd::cargo::cargo_bin("plur1bus")
}

/// `plur1bus --home <home> --json service <args>` → stdout JSON; panics on a non-zero exit.
fn service(home: &Path, args: &[&str]) -> Value {
    let out = Command::new(bin())
        .arg("--home")
        .arg(home)
        .args(["--json", "service"])
        .args(args)
        .env_remove("PLUR1BUS_SERVICE_FAKE")
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success(),
        "service {args:?} failed: {stdout} {}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_str(stdout.trim()).unwrap()
}

/// Uninstalls on drop, so a failed assertion never leaves a registration behind.
struct Installed {
    home: PathBuf,
    _tmp: tempfile::TempDir,
}
impl Drop for Installed {
    fn drop(&mut self) {
        let _ = Command::new(bin())
            .arg("--home")
            .arg(&self.home)
            .args(["--json", "service", "uninstall"])
            .output();
    }
}

/// An absolute path to `node` from PATH (the service does not inherit the test's PATH).
#[cfg(unix)]
fn node() -> PathBuf {
    std::env::var_os("PATH")
        .and_then(|p| {
            std::env::split_paths(&p)
                .map(|d| d.join("node"))
                .find(|c| c.is_file())
        })
        .expect("node on PATH")
}

/// Installs and starts the service for a fresh home with a space and an umlaut in its path.
fn install() -> Installed {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("p1b svc ü");
    std::fs::create_dir_all(&home).unwrap();
    let installed = Installed {
        home: home.clone(),
        _tmp: tmp,
    };
    #[cfg(unix)]
    let v = {
        let core = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-core.mjs");
        service(
            &home,
            &[
                "install",
                "--env",
                &format!("PLUR1BUS_CORE_JS={}", core.display()),
                "--env",
                &format!("PLUR1BUS_NODE={}", node().display()),
            ],
        )
    };
    // No --env on Windows: without a core.js the supervisor stays up with the child crashed (H3-R11).
    #[cfg(windows)]
    let v = service(&home, &["install"]);
    assert_eq!(v["installed"], true, "{v}");
    assert_eq!(v["started"], true, "{v}");
    assert!(
        v["name"].as_str().unwrap().contains('-'),
        "not suffixed: {v}"
    );
    installed
}

fn wait_until(within: Duration, what: &str, mut f: impl FnMut() -> bool) {
    let deadline = Instant::now() + within;
    while !f() {
        assert!(Instant::now() < deadline, "{what} within {within:?}");
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn supervisor_pid(home: &Path) -> Option<u32> {
    std::fs::read_to_string(home.join("run").join("supervisor.pid"))
        .ok()?
        .split_whitespace()
        .next()?
        .parse()
        .ok()
}

fn alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // Signal 0 only checks that the pid exists (the service is not our child, so it never lingers as our zombie).
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
    #[cfg(windows)]
    {
        let out = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
    }
}

#[cfg(unix)]
fn supervisor_address(home: &Path) -> String {
    format!("{}/run/supervisor.sock", home.display())
}

#[test]
fn install_status_uninstall_in_user_context() {
    if !enabled() {
        return;
    }
    let svc = install();
    wait_until(Duration::from_secs(10), "registered and running", || {
        let st = service(&svc.home, &["status"]);
        st["registered"] == true && st["running"] == true
    });
    wait_until(Duration::from_secs(10), "run/supervisor.pid", || {
        supervisor_pid(&svc.home).is_some()
    });
    let pid = supervisor_pid(&svc.home).unwrap();

    let v = service(&svc.home, &["uninstall"]);
    assert_eq!(v["removed"], true, "{v}");
    let st = service(&svc.home, &["status"]);
    assert_eq!(st["registered"], false, "{st}");
    wait_until(Duration::from_secs(15), "supervise gone", || !alive(pid));
}

/// SIGKILL is a failure for every manager, so the OS starts a new supervisor, which answers `supervisor.auth`.
#[cfg(unix)]
#[test]
fn the_os_restarts_a_killed_supervisor() {
    use plur1bus_rpc::{Client, ConnectOptions, Endpoint};
    if !enabled() {
        return;
    }
    let svc = install();
    wait_until(Duration::from_secs(10), "run/supervisor.pid", || {
        supervisor_pid(&svc.home).is_some()
    });
    let first = supervisor_pid(&svc.home).unwrap();
    assert_eq!(unsafe { libc::kill(first as i32, libc::SIGKILL) }, 0);

    let opts = ConnectOptions {
        connect_timeout: Duration::from_secs(2),
        call_timeout: Duration::from_secs(5),
        endpoint: Endpoint::Supervisor,
    };
    wait_until(
        Duration::from_secs(15),
        "a new supervisor answers supervisor.auth",
        || {
            let Some(pid) = supervisor_pid(&svc.home) else {
                return false;
            };
            if pid == first {
                return false;
            }
            let Ok(token) = std::fs::read_to_string(svc.home.join("run").join("supervisor.token"))
            else {
                return false;
            };
            match Client::connect(&supervisor_address(&svc.home), token.trim(), opts.clone()) {
                Ok(c) => c.hello()["pid"].as_u64() == Some(pid as u64),
                Err(_) => false,
            }
        },
    );
    let v = service(&svc.home, &["uninstall"]);
    assert_eq!(v["removed"], true, "{v}");
}
