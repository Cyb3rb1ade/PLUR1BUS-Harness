//! `plur1bus uninstall` at the CLI boundary, for what `uninstall.rs` does not pin: `--help` and flag conflicts, the
//! `-y` short form, the human-text dry run, unsafe and symlinked homes refused before any plan, an explicit
//! `--backup-out` path in the plan, and determinism of the plan. The service manager is the recording fake
//! (`PLUR1BUS_SERVICE_FAKE`), the binary to remove is a stand-in file, and HOME points into the temp dir. Unix only,
//! like its sibling (the Windows deferral is unit-tested in `src/commands/uninstall.rs`).
#![cfg(unix)]

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

struct Env {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    home: PathBuf,
    fake: PathBuf,
    bin: PathBuf,
}

fn env() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().to_path_buf();
    let home = root.join("p1b").join(".plur1bus");
    let fake = root.join("fake");
    let bin_dir = root.join("bin");
    for d in [
        home.join("runtime/core"),
        home.join("update/snapshot"),
        home.join("agents/bernd"),
        home.join("logs"),
        root.join("user"),
        fake.clone(),
        bin_dir.clone(),
    ] {
        std::fs::create_dir_all(d).unwrap();
    }
    std::fs::write(home.join("manifest.json"), "{}").unwrap();
    std::fs::write(home.join("config.json"), "{\"kept\":true}").unwrap();
    let bin = bin_dir.join("plur1bus");
    std::fs::write(&bin, "#!/bin/sh\n").unwrap();
    Env {
        _tmp: tmp,
        root,
        home,
        fake,
        bin,
    }
}

/// `plur1bus --home <home> uninstall <args>`, with the fake service manager and the stand-in binary.
fn cli(e: &Env, home: &Path, args: &[&str]) -> Command {
    let mut c = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"));
    c.env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env("PLUR1BUS_SERVICE_FAKE", &e.fake)
        .env("PLUR1BUS_UPDATE_TARGET_BIN", &e.bin)
        .env("HOME", e.root.join("user"))
        .env("USERPROFILE", e.root.join("user"))
        .env_remove("XDG_CONFIG_HOME")
        .env_remove("PLUR1BUS_CONTAINER")
        .env_remove("PLUR1BUS_HOME")
        .arg("--home")
        .arg(home)
        .arg("uninstall")
        .args(args);
    c
}

fn json_run(e: &Env, args: &[&str]) -> (i32, Value) {
    let mut c = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"));
    c.env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env("PLUR1BUS_SERVICE_FAKE", &e.fake)
        .env("PLUR1BUS_UPDATE_TARGET_BIN", &e.bin)
        .env("HOME", e.root.join("user"))
        .env_remove("PLUR1BUS_CONTAINER")
        .arg("--json")
        .arg("--home")
        .arg(&e.home)
        .arg("uninstall")
        .args(args);
    let o: Output = c.output().unwrap();
    let v = serde_json::from_slice(&o.stdout)
        .unwrap_or_else(|err| panic!("not JSON ({err}): {}", String::from_utf8_lossy(&o.stdout)));
    (o.status.code().unwrap_or(-1), v)
}

fn text(o: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    )
}

#[test]
fn help_documents_every_flag_and_the_default_that_keeps_the_data() {
    let e = env();
    let o = cli(&e, &e.home, &["--help"]).output().unwrap();
    assert_eq!(o.status.code(), Some(0));
    let help = text(&o);
    for flag in [
        "--yes",
        "--dry-run",
        "--purge",
        "--no-backup",
        "--backup-out",
    ] {
        assert!(help.contains(flag), "{flag} missing from help");
    }
    assert!(help.contains("[experimental]"), "{help}");
    assert!(help.contains("the data stays unless --purge"), "{help}");
}

#[test]
fn the_purge_companion_flags_need_purge_and_do_not_mix() {
    let e = env();
    let outside = e.root.join("out.tar.gz");
    for args in [
        vec!["--backup-out", outside.to_str().unwrap(), "--dry-run"],
        vec![
            "--purge",
            "--no-backup",
            "--backup-out",
            outside.to_str().unwrap(),
            "--dry-run",
        ],
        vec!["--dry-run", "--bogus-flag"],
    ] {
        let o = cli(&e, &e.home, &args).output().unwrap();
        assert_eq!(o.status.code(), Some(2), "{args:?}: {}", text(&o));
    }
    assert!(e.home.join("config.json").is_file(), "nothing was touched");
}

#[test]
fn the_short_yes_flag_applies_the_plan_like_the_long_one() {
    let e = env();
    let (code, v) = json_run(&e, &["-y"]);
    // No service registered in the fake: the binary and the software are still removed.
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["applied"], true);
    assert!(!e.bin.exists(), "the stand-in binary is removed");
    assert!(!e.home.join("manifest.json").exists());
    assert_eq!(
        std::fs::read_to_string(e.home.join("config.json")).unwrap(),
        "{\"kept\":true}"
    );
}

#[test]
fn the_human_dry_run_says_nothing_was_changed_and_leaves_every_file() {
    let e = env();
    let o = cli(&e, &e.home, &["--dry-run"]).output().unwrap();
    assert_eq!(o.status.code(), Some(0), "{}", text(&o));
    let out = String::from_utf8_lossy(&o.stdout).to_string();
    assert!(out.contains("dry run: nothing was changed"), "{out}");
    assert!(e.bin.exists());
    assert!(e.home.join("runtime/core").is_dir());
    assert!(e.home.join("manifest.json").is_file());
}

#[test]
fn the_plan_is_the_same_on_every_dry_run() {
    let e = env();
    let (c1, a) = json_run(&e, &["--dry-run", "--purge", "--no-backup"]);
    let (c2, b) = json_run(&e, &["--dry-run", "--purge", "--no-backup"]);
    assert_eq!((c1, c2), (0, 0));
    assert_eq!(a["plan"], b["plan"]);
    assert_eq!(a["plan"]["purge"], true);
    assert!(a["plan"]["remove"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["kind"] == "home"));
}

#[test]
fn an_explicit_backup_path_outside_the_home_is_the_planned_file() {
    let e = env();
    let out = e.root.join("backups").join("mine.tar.gz");
    let (code, v) = json_run(
        &e,
        &[
            "--dry-run",
            "--purge",
            "--backup-out",
            out.to_str().unwrap(),
        ],
    );
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["plan"]["backup"]["file"], out.to_str().unwrap());
    assert!(!out.exists(), "a dry run writes no backup");
}

#[test]
fn a_purge_of_a_home_that_contains_the_user_home_is_refused() {
    let e = env();
    // The temp root holds HOME (root/user): purging the root would take the user's home with it.
    let (code, v) = {
        let mut c = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"));
        c.env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
            .env("PLUR1BUS_SERVICE_FAKE", &e.fake)
            .env("HOME", e.root.join("user"))
            .env_remove("PLUR1BUS_CONTAINER")
            .args(["--json", "--home"])
            .arg(&e.root)
            .args(["uninstall", "--dry-run", "--purge", "--no-backup"]);
        let o = c.output().unwrap();
        (
            o.status.code().unwrap_or(-1),
            serde_json::from_slice::<Value>(&o.stdout).unwrap(),
        )
    };
    assert_eq!(code, 2, "{v}");
    assert_eq!(v["reason"], "unsafe-home");
    assert!(e.home.join("config.json").is_file());
}

#[test]
fn a_filesystem_root_is_never_a_purge_target() {
    let e = env();
    let mut c = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"));
    c.env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env("PLUR1BUS_SERVICE_FAKE", &e.fake)
        .env("HOME", e.root.join("user"))
        .env_remove("PLUR1BUS_CONTAINER")
        .args([
            "--json",
            "--home",
            "/",
            "uninstall",
            "--dry-run",
            "--purge",
            "--no-backup",
        ]);
    let o = c.output().unwrap();
    assert_eq!(o.status.code(), Some(2), "{}", text(&o));
    let v: Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(v["reason"], "unsafe-home");
}

#[test]
fn a_symlinked_home_is_refused_for_purge_and_the_target_is_untouched() {
    let e = env();
    let link = e.root.join("link-to-home");
    std::os::unix::fs::symlink(&e.home, &link).unwrap();
    let (code, v) = {
        let mut c = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"));
        c.env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
            .env("PLUR1BUS_SERVICE_FAKE", &e.fake)
            .env("HOME", e.root.join("user"))
            .env_remove("PLUR1BUS_CONTAINER")
            .args(["--json", "--home"])
            .arg(&link)
            .args(["uninstall", "--yes", "--purge", "--no-backup"]);
        let o = c.output().unwrap();
        (
            o.status.code().unwrap_or(-1),
            serde_json::from_slice::<Value>(&o.stdout).unwrap(),
        )
    };
    assert_eq!(code, 2, "{v}");
    assert_eq!(v["reason"], "home-is-symlink");
    assert!(
        e.home.join("config.json").is_file(),
        "the real home is untouched"
    );
    assert!(e.bin.exists());
}

#[test]
fn a_dry_run_on_a_missing_home_plans_the_binary_and_creates_nothing() {
    let e = env();
    let missing = e.root.join("p1b").join("never-here");
    let mut c = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"));
    c.env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env("PLUR1BUS_SERVICE_FAKE", &e.fake)
        .env("HOME", e.root.join("user"))
        .env_remove("PLUR1BUS_CONTAINER")
        .args(["--json", "--home"])
        .arg(&missing)
        .args(["uninstall", "--dry-run"]);
    let o = c.output().unwrap();
    assert_eq!(o.status.code(), Some(0), "{}", text(&o));
    let v: Value = serde_json::from_slice(&o.stdout).unwrap();
    // The stand-in binary is still planned for removal, so the home being absent is not "nothing to remove".
    assert_eq!(v["plan"]["nothingToRemove"], false, "{v}");
    assert_eq!(v["applied"], false);
    assert_eq!(v["plan"]["remove"][0]["kind"], "binary");
    assert!(!missing.exists(), "a dry run does not create the home");
}
