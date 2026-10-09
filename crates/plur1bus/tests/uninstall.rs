//! `plur1bus uninstall` against the recording fake service manager (`PLUR1BUS_SERVICE_FAKE`) and, where a daemon is
//! needed, a real `supervise --no-core`. The binary to remove is a stand-in file named `plur1bus`
//! (`PLUR1BUS_UPDATE_TARGET_BIN`), never the test binary. Temp homes only; `HOME` points into the temp dir.
//!
//! Unix only: on Windows the binary is removed by a script after the process exits (unit-tested in
//! `src/commands/uninstall.rs`).
#![cfg(unix)]
mod common;

use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;

struct Env {
    _tmp: tempfile::TempDir,
    home: PathBuf,
    user: PathBuf,
    fake: PathBuf,
    bin: PathBuf,
}

fn env() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().to_path_buf();
    let home = root.join("p1b home").join(".plur1bus");
    let user = root.join("user");
    let fake = root.join("fake");
    let bin = root.join("bin dir").join("plur1bus");
    for d in [
        "runtime/core",
        "update/snapshot",
        "agents/bernd",
        "logs",
        "state",
    ] {
        std::fs::create_dir_all(home.join(d)).unwrap();
    }
    std::fs::write(home.join("runtime/core/core.js"), "core").unwrap();
    std::fs::write(home.join("manifest.json"), "{}").unwrap();
    std::fs::write(home.join("config.json"), "{\"kept\":true}").unwrap();
    std::fs::write(home.join("agents/bernd/persona.md"), "persona").unwrap();
    for d in [&user, &fake, bin.parent().unwrap()] {
        std::fs::create_dir_all(d).unwrap();
    }
    std::fs::write(&bin, "#!/bin/sh\n").unwrap();
    Env {
        _tmp: tmp,
        home,
        user,
        fake,
        bin,
    }
}

fn base(e: &Env) -> Command {
    let mut c = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"));
    c.env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env("PLUR1BUS_SERVICE_FAKE", &e.fake)
        .env("PLUR1BUS_UPDATE_TARGET_BIN", &e.bin)
        .env("HOME", &e.user)
        .env("USERPROFILE", &e.user)
        .env_remove("XDG_CONFIG_HOME")
        .env_remove("PLUR1BUS_CONTAINER")
        .env_remove("PLUR1BUS_HOME")
        .arg("--home")
        .arg(&e.home)
        .arg("--json");
    c
}

fn run(e: &Env, args: &[&str]) -> (i32, Value) {
    let out = base(e).args(args).output().unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    let v = serde_json::from_str(stdout.trim()).unwrap_or_else(|err| {
        panic!(
            "stdout is not JSON ({err}): {stdout:?}; stderr: {}",
            String::from_utf8_lossy(&out.stderr)
        )
    });
    (out.status.code().unwrap_or(-1), v)
}

fn uninstall(e: &Env, args: &[&str]) -> (i32, Value) {
    let mut a = vec!["uninstall"];
    a.extend_from_slice(args);
    run(e, &a)
}

/// Registers the service in the fake manager (and writes its unit file under the temp `HOME`).
fn install_service(e: &Env) {
    let (code, v) = run(e, &["service", "install", "--no-start"]);
    assert_eq!(code, 0, "{v}");
}

fn registered(e: &Env) -> bool {
    let (code, v) = run(e, &["service", "status"]);
    assert_eq!(code, 0, "{v}");
    v["registered"].as_bool().unwrap()
}

/// Every path under the temp root with its size, for "nothing changed" checks.
fn tree(e: &Env) -> BTreeSet<(String, u64)> {
    fn walk(p: &Path, out: &mut BTreeSet<(String, u64)>) {
        for ent in std::fs::read_dir(p).unwrap().flatten() {
            let path = ent.path();
            let meta = std::fs::symlink_metadata(&path).unwrap();
            out.insert((path.display().to_string(), meta.len()));
            if meta.is_dir() {
                walk(&path, out);
            }
        }
    }
    let mut out = BTreeSet::new();
    walk(e._tmp.path(), &mut out);
    // The fake service manager's own bookkeeping is not the installation.
    out.retain(|(p, _)| !p.starts_with(&e.fake.display().to_string()));
    out
}

#[test]
fn dry_run_prints_the_plan_of_the_real_run_and_changes_nothing() {
    let e = env();
    install_service(&e);
    let before = tree(&e);
    let (code, dry) = uninstall(&e, &["--dry-run"]);
    assert_eq!(code, 0, "{dry}");
    assert_eq!(dry["schema"], "uninstall/1");
    assert_eq!(dry["dryRun"], true);
    assert_eq!(dry["applied"], false);
    assert!(dry["result"].is_null());
    assert_eq!(tree(&e), before, "a dry run changes nothing");
    assert!(registered(&e));

    let (code, real) = uninstall(&e, &["--yes"]);
    assert_eq!(code, 0, "{real}");
    assert_eq!(real["applied"], true);
    assert_eq!(
        dry["plan"], real["plan"],
        "dry-run and real run show one plan"
    );
}

#[test]
fn removes_service_binary_and_software_and_keeps_the_data() {
    let e = env();
    install_service(&e);
    assert!(registered(&e));
    let (code, v) = uninstall(&e, &["--yes"]);
    assert_eq!(code, 0, "{v}");
    assert!(!registered(&e), "the service unit is gone");
    let unit = v["plan"]["service"]["path"].as_str().unwrap();
    assert!(!Path::new(unit).exists());
    assert!(!e.bin.exists(), "the binary is gone");
    for gone in ["runtime", "update", "manifest.json", "run"] {
        assert!(!e.home.join(gone).exists(), "{gone}");
    }
    assert_eq!(
        std::fs::read_to_string(e.home.join("config.json")).unwrap(),
        "{\"kept\":true}"
    );
    assert!(e.home.join("agents/bernd/persona.md").is_file());
    assert!(e.home.join("logs").is_dir() && e.home.join("state").is_dir());
    assert_eq!(v["plan"]["purge"], false);
    let keep: Vec<&str> = v["plan"]["keep"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap())
        .collect();
    assert!(keep.contains(&"config.json") && keep.contains(&"agents"));
    assert_eq!(v["result"]["serviceRemoved"], true);
    assert_eq!(v["result"]["failures"], json!([]));
}

#[test]
fn stops_a_running_daemon_before_removing_anything() {
    let e = env();
    install_service(&e);
    // The supervisor runs in the very home that gets uninstalled.
    let mut sup = common::start(&e.home);
    let (code, plan) = uninstall(&e, &["--dry-run"]);
    assert_eq!(code, 0, "{plan}");
    assert_eq!(plan["plan"]["stopDaemon"], true);
    assert!(
        sup.child.try_wait().unwrap().is_none(),
        "dry run leaves it running"
    );

    let (code, v) = uninstall(&e, &["--yes"]);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["result"]["daemonStopped"], true);
    common::wait_until("the supervisor to exit", common::WAIT, || {
        sup.child.try_wait().unwrap().is_some()
    });
    assert!(!e.home.join("run").exists());
    assert!(!registered(&e));
    assert!(e.home.join("config.json").is_file());
}

#[test]
fn a_second_run_has_nothing_to_remove_and_exits_0() {
    let e = env();
    install_service(&e);
    assert_eq!(uninstall(&e, &["--yes"]).0, 0);
    let after_first = tree(&e);
    let (code, v) = uninstall(&e, &[]); // no --yes: nothing to ask about
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["plan"]["nothingToRemove"], true);
    assert_eq!(v["applied"], false);
    assert_eq!(tree(&e), after_first);
    // Human text says so, too.
    let out = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"))
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env("PLUR1BUS_SERVICE_FAKE", &e.fake)
        .env("PLUR1BUS_UPDATE_TARGET_BIN", &e.bin)
        .env("HOME", &e.user)
        .arg("--home")
        .arg(&e.home)
        .arg("uninstall")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&out.stdout).contains("nothing to remove"));
}

#[test]
fn purge_without_no_backup_tries_the_backup_first_and_changes_nothing_when_it_cannot() {
    let e = env();
    install_service(&e);
    let before = tree(&e);
    // No core runs, so no backup can be written: the run stops before the first change.
    let (code, v) = uninstall(&e, &["--yes", "--purge"]);
    assert_eq!(code, 1, "{v}");
    assert_eq!(v["schema"], "error/1");
    assert_eq!(tree(&e), before);
    assert!(registered(&e) && e.bin.exists());
}

#[test]
fn purge_with_no_backup_removes_the_home_and_the_binary() {
    let e = env();
    install_service(&e);
    let (code, v) = uninstall(&e, &["--yes", "--purge", "--no-backup"]);
    assert_eq!(code, 0, "{v}");
    assert!(!e.home.exists(), "the data went with the home");
    assert!(!e.bin.exists());
    assert!(!registered(&e));
    assert!(v["plan"]["backup"].is_null() || v["plan"].get("backup").is_none());
    assert!(v["result"]["backup"].is_null());
    // Idempotent after a purge, too.
    let (code, v) = uninstall(&e, &["--yes", "--purge", "--no-backup"]);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["plan"]["nothingToRemove"], true);
}

#[test]
fn the_purge_plan_names_a_backup_outside_the_home_unless_declined() {
    let e = env();
    let (code, v) = uninstall(&e, &["--dry-run", "--purge"]);
    assert_eq!(code, 0, "{v}");
    let dir = PathBuf::from(v["plan"]["backup"]["dir"].as_str().unwrap());
    assert!(!dir.starts_with(&e.home));
    assert_eq!(dir, e.home.parent().unwrap());
    let (_, v) = uninstall(&e, &["--dry-run", "--purge", "--no-backup"]);
    assert!(v["plan"].get("backup").is_none());
    // A backup path inside the home is refused: the purge would delete it.
    let inside = e.home.join("backups").join("b.tar.gz");
    let (code, v) = uninstall(
        &e,
        &[
            "--dry-run",
            "--purge",
            "--backup-out",
            inside.to_str().unwrap(),
        ],
    );
    assert_eq!(
        (code, v["reason"].as_str()),
        (2, Some("backup-inside-home")),
        "{v}"
    );
}

#[test]
fn nothing_is_applied_without_yes_off_a_terminal() {
    let e = env();
    install_service(&e);
    let before = tree(&e);
    let (code, v) = uninstall(&e, &[]);
    assert_eq!(code, 2, "{v}");
    assert_eq!(v["error"], "E_INVALID_PARAMS");
    assert_eq!(v["applied"], false);
    assert_eq!(tree(&e), before);
}

#[test]
fn container_mode_refuses() {
    let e = env();
    install_service(&e);
    let before = tree(&e);
    for args in [
        &["--yes"][..],
        &["--dry-run"][..],
        &["--yes", "--purge"][..],
    ] {
        let out = base(&e)
            .env("PLUR1BUS_CONTAINER", "1")
            .arg("uninstall")
            .args(args)
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(1));
        let v: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(v["error"], "E_NOT_AVAILABLE");
        assert_eq!(v["reason"], "container-managed");
    }
    assert_eq!(tree(&e), before);
}

#[test]
fn purge_refuses_a_directory_that_is_not_a_home() {
    let e = env();
    let foreign = e._tmp.path().join("docs").join("stuff");
    std::fs::create_dir_all(&foreign).unwrap();
    std::fs::write(foreign.join("thesis.tex"), "x").unwrap();
    let out = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"))
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env("PLUR1BUS_SERVICE_FAKE", &e.fake)
        .env("PLUR1BUS_UPDATE_TARGET_BIN", &e.bin)
        .env("HOME", &e.user)
        .env_remove("PLUR1BUS_CONTAINER")
        .arg("--home")
        .arg(&foreign)
        .args(["--json", "uninstall", "--yes", "--purge", "--no-backup"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["reason"], "not-a-home");
    assert!(foreign.join("thesis.tex").is_file());
}

#[test]
fn no_backup_needs_purge() {
    let e = env();
    let out = base(&e)
        .args(["uninstall", "--no-backup"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
}

#[test]
fn the_json_result_has_the_documented_shape() {
    let e = env();
    install_service(&e);
    let (code, v) = uninstall(&e, &["--yes"]);
    assert_eq!(code, 0, "{v}");
    for k in ["schema", "dryRun", "applied", "plan", "result"] {
        assert!(v.get(k).is_some(), "{k}");
    }
    for k in [
        "home",
        "os",
        "purge",
        "stopDaemon",
        "service",
        "remove",
        "keep",
        "notes",
        "nothingToRemove",
    ] {
        assert!(v["plan"].get(k).is_some(), "plan.{k}");
    }
    for k in [
        "backup",
        "daemonStopped",
        "serviceRemoved",
        "removed",
        "deferred",
        "failures",
    ] {
        assert!(v["result"].get(k).is_some(), "result.{k}");
    }
    assert_eq!(v["plan"]["os"], "unix");
    assert_eq!(v["plan"]["service"]["registered"], true);
    assert_eq!(v["plan"]["remove"][0]["kind"], "binary");
}
