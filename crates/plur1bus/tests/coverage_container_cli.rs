//! `plur1bus container ...` without an installed stack: the status document when nothing is installed, the refusal of the
//! leaves that need an install, a corrupt install record that must not read as "absent", the lock that keeps `up` and
//! `down` out of each other's way, and the injected Apple fake reaching the status document. Offline: no runtime is
//! started and the only executable is the fake CLI from `plur1bus-containers/tests/fixtures/container.py`.
#![cfg(unix)]

use serde_json::Value;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::OnceLock;

/// The fake CLI is written and made executable once per process, before any test can `fork`: Linux refuses to `exec` a
/// file another process still holds open for writing (ETXTBSY). Each test then gets its own hard link in its own
/// directory, because the script keeps its state beside `__file__`. The same pattern as `plur1bus-containers/tests/apple.rs`.
fn fake_template() -> &'static Path {
    static T: OnceLock<(tempfile::TempDir, PathBuf)> = OnceLock::new();
    &T.get_or_init(|| {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("container");
        fs::write(
            &p,
            include_str!("../../plur1bus-containers/tests/fixtures/container.py"),
        )
        .unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o700)).unwrap();
        (d, p)
    })
    .1
}

fn plur1bus(home: &Path, args: &[&str]) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_plur1bus"));
    c.arg("--home")
        .arg(home)
        .arg("--json")
        .args(args)
        .env_remove("PLUR1BUS_CONTAINER")
        .env_remove("PLUR1BUS_TEST_CONTAINER_CLI")
        .env_remove("PLUR1BUS_ALLOW_TEST_INTERNALS");
    c
}

fn doc(o: &Output) -> Value {
    serde_json::from_slice(&o.stdout).unwrap_or_else(|e| {
        panic!(
            "not JSON ({e}): {:?} stderr: {:?}",
            String::from_utf8_lossy(&o.stdout),
            String::from_utf8_lossy(&o.stderr)
        )
    })
}

#[test]
fn status_without_an_install_reports_not_installed_and_exits_0() {
    let dir = tempfile::tempdir().unwrap();
    let o = plur1bus(dir.path(), &["container", "status"])
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let v = doc(&o);
    assert_eq!(v["schema"], "container.status/1");
    assert_eq!(v["installed"], false);
    assert!(v["detections"].is_array(), "{v}");
}

#[test]
fn leaves_that_need_an_install_refuse_with_container_not_installed() {
    let dir = tempfile::tempdir().unwrap();
    for leaf in [
        vec!["container", "up"],
        vec!["container", "down"],
        vec!["container", "logs"],
    ] {
        let o = plur1bus(dir.path(), &leaf).output().unwrap();
        assert!(!o.status.success(), "{leaf:?}");
        let v = doc(&o);
        assert_eq!(v["schema"], "error/1", "{leaf:?}: {v}");
        assert_eq!(v["reason"], "container-not-installed", "{leaf:?}: {v}");
    }
}

#[test]
fn a_corrupt_install_record_is_an_error_and_not_reported_as_absent() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("container-install.json"), "{not json").unwrap();
    let o = plur1bus(dir.path(), &["container", "status"])
        .output()
        .unwrap();
    assert!(!o.status.success());
    let v = doc(&o);
    assert_eq!(v["schema"], "error/1", "{v}");
    assert_eq!(v["reason"], "container-not-installed", "{v}");
    assert!(v.get("installed").is_none(), "{v}");
}

#[test]
fn a_held_container_lock_refuses_up_and_down_but_status_still_answers() {
    let dir = tempfile::tempdir().unwrap();
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.path().join("container.lock"))
        .unwrap();
    lock.try_lock().unwrap();
    for leaf in [vec!["container", "up"], vec!["container", "down"]] {
        let o = plur1bus(dir.path(), &leaf).output().unwrap();
        assert!(!o.status.success(), "{leaf:?}");
        let v = doc(&o);
        assert_eq!(v["reason"], "container-busy", "{leaf:?}: {v}");
    }
    let o = plur1bus(dir.path(), &["container", "status"])
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    assert_eq!(doc(&o)["installed"], false);
    drop(lock);
}

#[test]
fn an_injected_apple_fake_reaches_the_status_detections() {
    let dir = tempfile::tempdir().unwrap();
    let fake_dir = tempfile::tempdir().unwrap();
    let fake = fake_dir.path().join("container");
    fs::hard_link(fake_template(), &fake).unwrap();
    let o = plur1bus(dir.path(), &["container", "status"])
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env("PLUR1BUS_TEST_CONTAINER_CLI", &fake)
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let v = doc(&o);
    assert_eq!(v["installed"], false);
    let text = v["detections"].to_string();
    assert!(
        text.contains("1.5.0"),
        "fake CLI version not reported: {text}"
    );
}

#[test]
fn container_help_names_the_default_service_and_the_leaves() {
    let out = Command::new(env!("CARGO_BIN_EXE_plur1bus"))
        .args(["container", "logs", "--help"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let text = String::from_utf8(out.stdout).unwrap();
    assert!(text.contains("plur1bus-harness"), "{text}");
    assert!(text.contains("Examples:"), "{text}");
}
