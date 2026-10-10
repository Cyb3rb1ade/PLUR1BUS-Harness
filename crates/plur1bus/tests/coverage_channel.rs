//! `plur1bus channel ...` argument validation and offline error paths that `channel_cli.rs` does not pin: per-leaf
//! help, unknown and surplus arguments, leading-hyphen values, the `--send-owner` flag shape, and that every leaf's
//! JSON error names the core and the reason without touching HOME. No core is started; every writing leaf fails at
//! the connection, which is the offline behaviour under test.
use serde_json::Value;
use std::path::Path;
use std::process::{Command, Output};

fn bin(home: &Path) -> Command {
    let mut c = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"));
    c.arg("--home")
        .arg(home.join("p1b"))
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env_remove("PLUR1BUS_CONTAINER")
        .env_remove("PLUR1BUS_HOME");
    c
}

fn text(o: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    )
}

fn json(o: &Output) -> Value {
    serde_json::from_slice(&o.stdout)
        .unwrap_or_else(|e| panic!("stdout is not JSON ({e}): {}", text(o)))
}

#[test]
fn each_leaf_has_its_own_help_marked_experimental() {
    let home = tempfile::tempdir().unwrap();
    for leaf in [
        "list",
        "show",
        "enable",
        "disable",
        "set",
        "test",
        "status",
        "link-help",
    ] {
        let o = bin(home.path())
            .args(["channel", leaf, "--help"])
            .output()
            .unwrap();
        assert_eq!(o.status.code(), Some(0), "{leaf}: {}", text(&o));
        assert!(text(&o).contains("[experimental]"), "{leaf}");
    }
}

#[test]
fn the_test_leaf_help_names_the_send_owner_flag_and_its_limit() {
    let home = tempfile::tempdir().unwrap();
    let o = bin(home.path())
        .args(["channel", "test", "--help"])
        .output()
        .unwrap();
    let t = text(&o);
    assert_eq!(o.status.code(), Some(0));
    assert!(t.contains("--send-owner"), "{t}");
    assert!(t.contains("never to anyone else"), "{t}");
}

#[test]
fn the_group_help_exits_0_and_the_bare_group_is_a_usage_error() {
    let home = tempfile::tempdir().unwrap();
    let o = bin(home.path())
        .args(["channel", "--help"])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(0));
    assert!(
        text(&o).contains("secret"),
        "the group help mentions secrets"
    );
    let o = bin(home.path()).arg("channel").output().unwrap();
    assert_eq!(o.status.code(), Some(2));
}

#[test]
fn unknown_leaves_and_surplus_arguments_are_usage_errors() {
    let home = tempfile::tempdir().unwrap();
    for args in [
        vec!["channel", "bogus"],
        vec!["channel", "list", "extra"],
        vec!["channel", "status", "--all"],
        vec!["channel", "enable"],
        vec!["channel", "disable"],
        vec!["channel", "link-help"],
        vec!["channel", "test", "discord", "--send-owner=yes"],
        vec!["channel", "set", "discord"],
        vec!["channel", "set", "discord", "locale", "de", "extra"],
    ] {
        let o = bin(home.path()).args(&args).output().unwrap();
        assert_eq!(o.status.code(), Some(2), "{args:?}: {}", text(&o));
        assert!(!o.stderr.is_empty(), "{args:?}: clap explains the error");
    }
}

#[test]
fn a_value_that_starts_with_a_hyphen_is_a_value_not_a_flag() {
    let home = tempfile::tempdir().unwrap();
    // `set` allows hyphen values: the argument reaches the core (absent here) instead of failing to parse.
    let o = bin(home.path())
        .args([
            "--json",
            "channel",
            "set",
            "discord",
            "replyPolicy",
            "-mention",
        ])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(1), "{}", text(&o));
    assert_eq!(json(&o)["error"], "E_CORE_UNAVAILABLE");
}

#[test]
fn every_leaf_error_document_has_the_documented_shape() {
    let home = tempfile::tempdir().unwrap();
    for args in [
        vec!["channel", "list"],
        vec!["channel", "show", "discord"],
        vec!["channel", "enable", "slack"],
        vec!["channel", "disable", "imessage"],
        vec!["channel", "set", "slack", "locale", "de"],
        vec!["channel", "test", "discord", "--send-owner"],
        vec!["channel", "link-help", "discord"],
    ] {
        let o = bin(home.path()).arg("--json").args(&args).output().unwrap();
        assert_eq!(o.status.code(), Some(1), "{args:?}");
        let v = json(&o);
        assert_eq!(v["schema"], "error/1", "{args:?}");
        assert_eq!(v["error"], "E_CORE_UNAVAILABLE", "{args:?}");
        assert!(
            v["message"].as_str().is_some_and(|m| !m.is_empty()),
            "{args:?}"
        );
    }
}

#[test]
fn an_offline_channel_command_creates_no_channel_state_under_home() {
    let home = tempfile::tempdir().unwrap();
    for args in [
        vec!["channel", "set", "discord", "allowlist", "[\"123\"]"],
        vec!["channel", "enable", "discord"],
        vec!["channel", "disable", "discord"],
    ] {
        let o = bin(home.path()).arg("--json").args(&args).output().unwrap();
        assert_eq!(o.status.code(), Some(1), "{args:?}");
    }
    // Nothing that looks like a config write or a channel store exists after the failed writes.
    let mut stray = Vec::new();
    fn walk(p: &Path, out: &mut Vec<std::path::PathBuf>) {
        if let Ok(rd) = std::fs::read_dir(p) {
            for e in rd.flatten() {
                let path = e.path();
                if path.is_dir() {
                    walk(&path, out);
                } else {
                    out.push(path);
                }
            }
        }
    }
    walk(home.path(), &mut stray);
    for f in &stray {
        let name = f.file_name().unwrap().to_string_lossy().to_string();
        assert_ne!(
            name, "config.json",
            "a failed write must not create config.json"
        );
    }
}

#[test]
fn a_secret_typed_for_a_secret_key_is_not_echoed_in_the_json_error_either() {
    let home = tempfile::tempdir().unwrap();
    let typed = ["ghp", "COVERAGE", "MARKER", "0123456789abcdef"].join("_");
    let o = bin(home.path())
        .args(["--json", "channel", "set", "github", "tokenSecret", &typed])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(1));
    assert!(!text(&o).contains(&typed), "{}", text(&o));
}
