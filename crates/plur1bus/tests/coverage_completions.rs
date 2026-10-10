//! `plur1bus completions <shell>` and the hidden `plur1bus __manpages <dir>`, end to end: every supported shell
//! prints a non-empty script that names the commands and flags a user would complete, bad shell names are usage
//! errors, the output is deterministic and writes nothing under HOME, and the manpage writer reports I/O failures as
//! JSON. Pure stdout/exit-code checks; no network, no core, temp dirs only.
use assert_cmd::Command;
use serde_json::Value;
use std::path::Path;

const SHELLS: [&str; 5] = ["bash", "zsh", "fish", "powershell", "elvish"];

/// The binary with HOME and every state override pointed into `home`, so nothing reaches the real user dirs.
fn bin(home: &Path) -> Command {
    let mut c = Command::cargo_bin("plur1bus").unwrap();
    c.env("HOME", home)
        .env("USERPROFILE", home)
        .env_remove("XDG_CONFIG_HOME")
        .env_remove("XDG_DATA_HOME")
        .env_remove("PLUR1BUS_HOME")
        .env_remove("PLUR1BUS_CONTAINER");
    c
}

fn stdout(args: &[&str], home: &Path) -> (i32, String, String) {
    let o = bin(home).args(args).output().unwrap();
    (
        o.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&o.stdout).into_owned(),
        String::from_utf8_lossy(&o.stderr).into_owned(),
    )
}

#[test]
fn every_supported_shell_prints_a_script_that_names_the_commands() {
    let home = tempfile::tempdir().unwrap();
    for shell in SHELLS {
        let (code, out, err) = stdout(&["completions", shell], home.path());
        assert_eq!(code, 0, "{shell}: {err}");
        assert!(!out.trim().is_empty(), "{shell}: empty script");
        assert!(out.contains("plur1bus"), "{shell}: no binary name");
        for cmd in ["update", "uninstall", "login", "channel", "completions"] {
            assert!(out.contains(cmd), "{shell}: script lacks `{cmd}`");
        }
    }
}

#[test]
fn the_scripts_complete_the_flags_of_the_commands_that_have_them() {
    let home = tempfile::tempdir().unwrap();
    // Long flags are spelled the same in each shell's syntax, so the bare name is what must appear.
    let wanted = [
        "plan",
        "from",
        "allow-downgrade",
        "dry-run",
        "purge",
        "no-backup",
        "backup-out",
        "send-owner",
        "api-key",
        "no-browser",
    ];
    for shell in ["bash", "zsh", "fish"] {
        let (_, out, _) = stdout(&["completions", shell], home.path());
        for flag in wanted {
            assert!(out.contains(flag), "{shell}: no `{flag}` in the script");
        }
    }
}

#[test]
fn the_subcommands_of_the_commands_under_test_are_named() {
    let home = tempfile::tempdir().unwrap();
    let (_, out, _) = stdout(&["completions", "bash"], home.path());
    for leaf in [
        "status",
        "list",
        "logout",
        "show",
        "enable",
        "disable",
        "set",
        "test",
        "link-help",
    ] {
        assert!(out.contains(leaf), "bash script lacks `{leaf}`");
    }
}

#[test]
fn a_script_is_the_same_on_every_run() {
    let home = tempfile::tempdir().unwrap();
    for shell in SHELLS {
        let (_, first, _) = stdout(&["completions", shell], home.path());
        let (_, second, _) = stdout(&["completions", shell], home.path());
        assert_eq!(first, second, "{shell} changes between runs");
    }
}

#[test]
fn a_shell_name_is_a_usage_error_that_lists_the_choices() {
    let home = tempfile::tempdir().unwrap();
    for args in [
        vec!["completions", "tcsh"],
        vec!["completions", "BASH-SHELL"],
        vec!["completions"],
        vec!["completions", "bash", "zsh"],
    ] {
        let (code, out, err) = stdout(&args, home.path());
        assert_eq!(code, 2, "{args:?}");
        assert!(out.trim().is_empty(), "{args:?}: no script on stdout");
        if args.len() == 2 && args[1] == "tcsh" {
            assert!(err.contains("bash") && err.contains("elvish"), "{err}");
        }
    }
}

#[test]
fn the_help_names_every_supported_shell() {
    let home = tempfile::tempdir().unwrap();
    let (code, out, _) = stdout(&["completions", "--help"], home.path());
    assert_eq!(code, 0);
    assert!(out.contains("[experimental]"), "{out}");
    for shell in SHELLS {
        assert!(out.contains(shell), "{shell} missing from help");
    }
}

#[test]
fn the_script_is_text_even_with_json_requested_and_writes_nothing() {
    let home = tempfile::tempdir().unwrap();
    let (code, out, _) = stdout(&["--json", "completions", "zsh"], home.path());
    assert_eq!(code, 0);
    assert!(serde_json::from_str::<Value>(out.trim()).is_err());
    assert!(out.contains("plur1bus"));
    assert_eq!(
        std::fs::read_dir(home.path()).unwrap().count(),
        0,
        "completions must not create anything under HOME"
    );
}

#[test]
fn manpages_are_written_to_the_directory_and_reported_as_json() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("man");
    let o = bin(root.path())
        .args(["--json", "__manpages"])
        .arg(&dir)
        .output()
        .unwrap();
    assert_eq!(
        o.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
    let v: Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(v["schema"], "manpages/1");
    let files = v["files"].as_array().unwrap();
    let on_disk = std::fs::read_dir(&dir)
        .unwrap()
        .filter(|e| {
            e.as_ref()
                .unwrap()
                .path()
                .extension()
                .is_some_and(|x| x == "1")
        })
        .count();
    assert_eq!(
        files.len(),
        on_disk,
        "every reported file exists and nothing else is listed"
    );
    for want in [
        "plur1bus.1",
        "plur1bus-update.1",
        "plur1bus-uninstall.1",
        "plur1bus-login.1",
        "plur1bus-channel.1",
        "plur1bus-completions.1",
    ] {
        assert!(dir.join(want).is_file(), "{want} missing");
    }
    // The hidden command is not itself documented.
    assert!(!dir.join("plur1bus-__manpages.1").exists());
}

#[test]
fn manpages_into_a_path_that_is_a_file_fail_with_an_io_reason() {
    let root = tempfile::tempdir().unwrap();
    let blocker = root.path().join("not-a-dir");
    std::fs::write(&blocker, "x").unwrap();
    let o = bin(root.path())
        .args(["--json", "__manpages"])
        .arg(blocker.join("sub"))
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(1));
    let v: Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(v["schema"], "error/1");
    assert_eq!(v["error"], "E_INTERNAL");
    assert_eq!(v["reason"], "io");
    assert_eq!(std::fs::read_to_string(&blocker).unwrap(), "x");
}
