//! `plur1bus service install|uninstall|status` against the recording fake service manager (the
//! `PLUR1BUS_SERVICE_FAKE=<dir>` seam, honoured only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`). The fake records every
//! manager command to `<dir>/calls.jsonl` and emulates just enough state for `status` and `uninstall`. `HOME` (and
//! `USERPROFILE` / `LOCALAPPDATA`) point into the test's temp dir, so unit files land there and never in the real
//! user's `~/.config/systemd/user` or `~/Library/LaunchAgents`. The renderers are unit-tested in `src/service/`.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Command;

struct Env {
    _tmp: tempfile::TempDir,
    /// The PLUR1BUS home under test (never the default one unless a test drops `--home`).
    home: PathBuf,
    /// Stands in for the OS user's home directory.
    user: PathBuf,
    fake: PathBuf,
}

fn env() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().to_path_buf();
    let home = root.join("p1b home");
    let user = root.join("user");
    let fake = root.join("fake");
    for d in [&home, &user, &fake] {
        std::fs::create_dir_all(d).unwrap();
    }
    Env {
        _tmp: tmp,
        home,
        user,
        fake,
    }
}

fn base(e: &Env) -> Command {
    let mut c = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"));
    c.env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env("PLUR1BUS_SERVICE_FAKE", &e.fake)
        .env("HOME", &e.user)
        .env("USERPROFILE", &e.user)
        .env("LOCALAPPDATA", e.user.join("AppData").join("Local"))
        .env_remove("XDG_CONFIG_HOME")
        .env_remove("PLUR1BUS_HOME");
    c
}

/// Runs `plur1bus --home <home> --json service <args>` → (exit code, stdout JSON).
fn service(e: &Env, args: &[&str]) -> (i32, Value) {
    let out = base(e)
        .arg("--home")
        .arg(&e.home)
        .args(["--json", "service"])
        .args(args)
        .output()
        .unwrap();
    parse(out)
}

fn parse(out: std::process::Output) -> (i32, Value) {
    let stdout = String::from_utf8_lossy(&out.stdout);
    let v = serde_json::from_str(stdout.trim()).unwrap_or_else(|err| {
        panic!(
            "stdout is not JSON ({err}): {stdout:?}; stderr: {}",
            String::from_utf8_lossy(&out.stderr)
        )
    });
    (out.status.code().unwrap_or(-1), v)
}

fn calls(e: &Env) -> Vec<Value> {
    match std::fs::read_to_string(e.fake.join("calls.jsonl")) {
        Ok(s) => s
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn clear_calls(e: &Env) {
    let _ = std::fs::remove_file(e.fake.join("calls.jsonl"));
}

fn suffix(home: &Path) -> String {
    let h = format!(
        "{:x}",
        Sha256::digest(home.to_string_lossy().to_lowercase().as_bytes())
    );
    h[..8].to_string()
}

fn host_manager() -> &'static str {
    if cfg!(target_os = "macos") {
        "launchd"
    } else if cfg!(windows) {
        "task-scheduler"
    } else {
        "systemd"
    }
}

fn base_name() -> &'static str {
    match host_manager() {
        "launchd" => "dev.plur1bus.supervisor",
        "task-scheduler" => "PLUR1BUS Supervisor",
        _ => "plur1bus",
    }
}

fn expected_path(e: &Env, name: &str) -> PathBuf {
    match host_manager() {
        "launchd" => e
            .user
            .join("Library")
            .join("LaunchAgents")
            .join(format!("{name}.plist")),
        "task-scheduler" => e.home.join("run").join(format!("{name}.xml")),
        _ => e
            .user
            .join(".config")
            .join("systemd")
            .join("user")
            .join(format!("{name}.service")),
    }
}

#[cfg(unix)]
fn uid() -> u32 {
    unsafe { libc::getuid() }
}

/// The host manager's command table for `install` (start or not), as (program, args).
fn install_table(name: &str, path: &Path, start: bool) -> Vec<Value> {
    let p = path.to_string_lossy().to_string();
    match host_manager() {
        "systemd" => {
            let unit = format!("{name}.service");
            let mut t = vec![
                json!({ "program": "systemctl", "args": ["--user", "daemon-reload"] }),
                json!({ "program": "systemctl", "args": ["--user", "enable", unit] }),
            ];
            if start {
                t.push(json!({ "program": "systemctl", "args": ["--user", "restart", unit] }));
            }
            t
        }
        #[cfg(unix)]
        "launchd" => {
            let target = format!("gui/{}/{name}", uid());
            if start {
                vec![
                    json!({ "program": "launchctl", "args": ["bootout", target] }),
                    json!({ "program": "launchctl", "args": ["print", target] }),
                    json!({ "program": "launchctl", "args": ["bootstrap", format!("gui/{}", uid()), p] }),
                ]
            } else {
                // A running agent is left alone; the new plist applies at the next login.
                vec![]
            }
        }
        _ => {
            let mut t = vec![
                json!({ "program": "schtasks", "args": ["/Create", "/XML", p, "/TN", name, "/F"] }),
            ];
            if start {
                t.push(json!({ "program": "schtasks", "args": ["/End", "/TN", name] }));
                t.push(json!({ "program": "schtasks", "args": ["/Run", "/TN", name] }));
            }
            t
        }
    }
}

#[test]
fn install_runs_the_manager_commands_in_order() {
    let e = env();
    let name = format!("{}-{}", base_name(), suffix(&e.home));
    let path = expected_path(&e, &name);

    let (code, v) = service(&e, &["install"]);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["schema"], "service.install/1");
    assert_eq!(v["installed"], true);
    assert_eq!(v["started"], true);
    assert_eq!(v["manager"], host_manager());
    assert_eq!(v["name"], name.as_str());
    assert_eq!(v["path"], path.to_string_lossy().as_ref());
    assert_eq!(calls(&e), install_table(&name, &path, true));
    let content = if cfg!(windows) {
        let bytes = std::fs::read(&path).unwrap();
        let units: Vec<u16> = bytes[2..]
            .chunks(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16(&units).unwrap()
    } else {
        std::fs::read_to_string(&path).unwrap()
    };
    assert!(content.contains("supervise"), "{content}");
    assert!(content.contains("p1b home"), "{content}");

    clear_calls(&e);
    let (code, v) = service(&e, &["install", "--no-start"]);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["started"], false);
    assert_eq!(calls(&e), install_table(&name, &path, false));
    // --no-start leaves the running instance alone.
    assert_eq!(service(&e, &["status"]).1["running"], true);

    // A re-install with start restarts the running instance on the new definition.
    clear_calls(&e);
    let (code, v) = service(&e, &["install"]);
    assert_eq!(code, 0, "{v}");
    assert_eq!(calls(&e), install_table(&name, &path, true));
    assert_eq!(service(&e, &["status"]).1["running"], true);
    // launchd opens StandardErrorPath under logs/ before supervise could create it.
    assert!(e.home.join("logs").is_dir());
}

#[test]
fn uninstall_is_idempotent() {
    let e = env();
    let name = format!("{}-{}", base_name(), suffix(&e.home));
    assert_eq!(service(&e, &["install"]).0, 0);
    let path = expected_path(&e, &name);
    assert!(path.exists());

    let (code, v) = service(&e, &["uninstall"]);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["schema"], "service.uninstall/1");
    assert_eq!(v["removed"], true);
    assert_eq!(v["name"], name.as_str());
    assert!(!path.exists(), "{} left behind", path.display());

    let (code, v) = service(&e, &["uninstall"]);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["removed"], false);

    let (code, v) = service(&e, &["status"]);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["registered"], false);
    assert_eq!(v["running"], false);
}

#[test]
fn status_follows_install_and_start() {
    let e = env();
    let (code, v) = service(&e, &["status"]);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["schema"], "service.status/1");
    assert_eq!(v["registered"], false);
    assert_eq!(v["manager"], host_manager());

    assert_eq!(service(&e, &["install", "--no-start"]).0, 0);
    let (_, v) = service(&e, &["status"]);
    assert_eq!(v["registered"], true, "{v}");
    assert_eq!(v["running"], false, "{v}");

    assert_eq!(service(&e, &["install"]).0, 0);
    let (_, v) = service(&e, &["status"]);
    assert_eq!(v["registered"], true, "{v}");
    assert_eq!(v["running"], true, "{v}");
    assert_eq!(
        v["path"],
        expected_path(&e, v["name"].as_str().unwrap())
            .to_string_lossy()
            .as_ref()
    );
    assert_eq!(service(&e, &["uninstall"]).0, 0);
}

#[test]
fn service_name_suffixes_non_default_homes() {
    let e = env();
    let (_, v) = service(&e, &["status"]);
    assert_eq!(
        v["name"],
        format!("{}-{}", base_name(), suffix(&e.home)).as_str()
    );

    // Without --home and without PLUR1BUS_HOME the home is the platform default under the (fake) user home: no
    // suffix. Only `status` runs here, so nothing is written anywhere.
    let out = base(&e)
        .args(["--json", "service", "status"])
        .output()
        .unwrap();
    let (code, v) = parse(out);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["name"], base_name());
}

#[cfg(unix)]
#[test]
fn hidden_env_reaches_the_unit() {
    let e = env();
    let (code, v) = service(
        &e,
        &[
            "install",
            "--no-start",
            "--env",
            "PLUR1BUS_NODE=/opt/node 24/bin/node",
        ],
    );
    assert_eq!(code, 0, "{v}");
    let content = std::fs::read_to_string(v["path"].as_str().unwrap()).unwrap();
    if host_manager() == "launchd" {
        assert!(
            content.contains("<key>EnvironmentVariables</key>"),
            "{content}"
        );
        assert!(content.contains("<key>PLUR1BUS_NODE</key>"), "{content}");
        assert!(
            content.contains("<string>/opt/node 24/bin/node</string>"),
            "{content}"
        );
    } else {
        assert!(
            content.contains("Environment=\"PLUR1BUS_NODE=/opt/node 24/bin/node\""),
            "{content}"
        );
    }
    for bad in ["NOEQUALS", "=v", "1A=v", "A-B=v", "A B=v", "Ä=v"] {
        let (code, v) = service(&e, &["install", "--no-start", "--env", bad]);
        assert_eq!(code, 2, "{bad}: {v}");
        assert_eq!(v["error"], "E_INVALID_PARAMS", "{bad}");
        assert_eq!(v["reason"], "env-malformed", "{bad}");
    }
    assert_eq!(
        service(&e, &["install", "--no-start", "--env", "_A1=x=y"]).0,
        0
    );
    assert_eq!(service(&e, &["uninstall"]).0, 0);
}

#[cfg(windows)]
#[test]
fn hidden_env_is_refused_on_windows() {
    let e = env();
    let (code, v) = service(&e, &["install", "--env", "A=B"]);
    assert_eq!(code, 1, "{v}");
    assert_eq!(v["error"], "E_INVALID_PARAMS");
    assert_eq!(v["reason"], "env-unsupported");
    assert!(calls(&e).is_empty());
}

#[test]
fn the_fake_manager_needs_allow_test_internals() {
    let e = env();
    let out = base(&e)
        .env_remove("PLUR1BUS_ALLOW_TEST_INTERNALS")
        .arg("--home")
        .arg(&e.home)
        .args(["--json", "service", "install"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(calls(&e).is_empty());
    assert!(!expected_path(&e, &format!("{}-{}", base_name(), suffix(&e.home))).exists());
}

/// A binary under a non-UTF-8 directory is refused instead of being rendered with U+FFFD (Linux: other file systems
/// refuse such names).
#[cfg(target_os = "linux")]
#[test]
fn a_non_utf8_binary_path_is_refused() {
    use std::os::unix::ffi::OsStrExt;
    let e = env();
    let dir = e.user.join(std::ffi::OsStr::from_bytes(b"bin-\xff"));
    std::fs::create_dir_all(&dir).unwrap();
    let bin = dir.join("plur1bus");
    std::fs::copy(assert_cmd::cargo::cargo_bin("plur1bus"), &bin).unwrap();
    let out = {
        let mut cmd = Command::new(&bin);
        for (k, v) in base(&e).get_envs() {
            match v {
                Some(v) => cmd.env(k, v),
                None => cmd.env_remove(k),
            };
        }
        cmd.arg("--home")
            .arg(&e.home)
            .args(["--json", "service", "install"])
            .output()
            .unwrap()
    };
    let (code, v) = parse(out);
    assert_eq!(code, 1, "{v}");
    assert_eq!(v["error"], "E_INVALID_PARAMS");
    assert_eq!(v["reason"], "path-not-utf8");
    assert!(calls(&e).is_empty());
}
