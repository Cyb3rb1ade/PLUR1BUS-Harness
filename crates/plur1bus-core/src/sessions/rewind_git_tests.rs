//! The real Git process port against stand-in `git` executables (shell scripts on a private `PATH`), for the behaviours a real
//! `git` cannot produce on demand: a child that resists `SIGTERM`, one that never ends, one that writes too much. Port of
//! `rewind-git-process.test.ts`. Unix only: the stand-ins are shell scripts and the checks use `kill -0`.
#![cfg(all(test, unix))]
use super::rewind_git::{AbortReason, Cancel, GitFailure, GitProcess, SystemGit, MAX_BYTES};
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

struct Rig {
    dir: tempfile::TempDir,
}

impl Rig {
    fn new(script: &str) -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        let git = bin.join("git");
        std::fs::write(&git, format!("#!/bin/sh\n{script}\n")).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&git, std::fs::Permissions::from_mode(0o755)).unwrap();
        Rig { dir }
    }

    fn env(&self) -> Vec<(String, String)> {
        vec![
            (
                "PATH".into(),
                format!("{}/bin:/usr/bin:/bin", self.dir.path().display()),
            ),
            ("RIG".into(), self.dir.path().to_string_lossy().into_owned()),
        ]
    }

    fn pid(&self) -> Option<i32> {
        std::fs::read_to_string(self.dir.path().join("pid"))
            .ok()
            .and_then(|s| s.trim().parse().ok())
    }

    fn wait_pid(&self) -> i32 {
        let t = Instant::now();
        loop {
            if let Some(p) = self.pid() {
                return p;
            }
            assert!(
                t.elapsed() < Duration::from_secs(10),
                "the stand-in never started"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

fn alive(pid: i32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn quick() -> SystemGit {
    SystemGit {
        timeout: Duration::from_millis(400),
        kill_grace: Duration::from_millis(150),
    }
}

fn run(r: &Rig, g: SystemGit, cancel: &Cancel) -> Result<String, GitFailure> {
    g.run(&["--version".to_owned()], &r.env(), cancel)
}

#[test]
fn stdout_is_returned_exactly_and_stderr_is_never_part_of_it() {
    let r = Rig::new("printf 'result\\n'; printf PRIVATE_STDERR >&2");
    assert_eq!(
        run(&r, SystemGit::default(), &Cancel::new()).unwrap(),
        "result\n"
    );
}

#[test]
fn a_non_zero_exit_names_its_status_and_never_carries_the_private_stderr() {
    let r = Rig::new("printf PRIVATE_STDERR >&2; exit 7");
    let e = run(&r, SystemGit::default(), &Cancel::new()).unwrap_err();
    assert_eq!(e, GitFailure::Exit { code: Some(7) });
    assert!(!format!("{e:?}").contains("PRIVATE_STDERR"));
}

#[test]
fn a_missing_git_is_a_spawn_error_with_the_node_code() {
    let e = SystemGit::default()
        .run(
            &[],
            &[("PATH".to_owned(), "/nonexistent-cx-git-path".to_owned())],
            &Cancel::new(),
        )
        .unwrap_err();
    assert_eq!(e, GitFailure::Spawn("ENOENT".into()));
}

#[test]
fn the_child_gets_exactly_the_given_environment_and_nothing_inherited() {
    let r = Rig::new("printf '%s|%s' \"$RIG_X\" \"${HOME:-unset}\"");
    let mut env = r.env();
    env.push(("RIG_X".into(), "given".into()));
    let out = SystemGit::default().run(&[], &env, &Cancel::new()).unwrap();
    assert_eq!(out, "given|unset");
}

#[test]
fn an_already_aborted_signal_never_starts_a_child() {
    let r = Rig::new("touch \"$RIG/started\"");
    let c = Cancel::new();
    c.abort(AbortReason::Caller);
    assert_eq!(
        run(&r, SystemGit::default(), &c).unwrap_err(),
        GitFailure::Aborted(AbortReason::Caller)
    );
    assert!(!r.dir.path().join("started").exists());
}

#[test]
fn an_abort_stops_the_child_and_waits_until_it_is_gone() {
    let r = Rig::new("echo $$ > \"$RIG/pid\"; exec sleep 30");
    let c = Cancel::new();
    let c2 = c.clone();
    let rig_dir = r.dir.path().to_path_buf();
    let aborter = std::thread::spawn(move || {
        while !Path::new(&rig_dir.join("pid")).exists() {
            std::thread::sleep(Duration::from_millis(5));
        }
        c2.abort(AbortReason::Caller);
    });
    let started = Instant::now();
    let e = run(&r, SystemGit::default(), &c).unwrap_err();
    aborter.join().unwrap();
    assert_eq!(e, GitFailure::Aborted(AbortReason::Caller));
    assert!(started.elapsed() < Duration::from_secs(10));
    assert!(
        !alive(r.wait_pid()),
        "no child remains when the operation returns"
    );
}

#[test]
fn a_child_that_resists_sigterm_is_killed_after_the_grace_period_and_reaped() {
    let r = Rig::new("trap '' TERM; echo $$ > \"$RIG/pid\"; while :; do sleep 0.05; done");
    let started = Instant::now();
    let e = run(&r, quick(), &Cancel::new()).unwrap_err();
    assert_eq!(e, GitFailure::Timeout);
    // The timeout (400 ms) plus the grace (150 ms) bound the run; the child is gone when it returns.
    assert!(
        started.elapsed() >= Duration::from_millis(500),
        "the polite stop gets its grace period"
    );
    assert!(!alive(r.wait_pid()));
}

#[test]
fn a_child_that_never_ends_times_out() {
    let r = Rig::new("echo $$ > \"$RIG/pid\"; exec sleep 30");
    let e = run(&r, quick(), &Cancel::new()).unwrap_err();
    assert_eq!(e, GitFailure::Timeout);
    assert!(!alive(r.wait_pid()));
}

#[test]
fn output_beyond_the_bound_on_either_stream_is_refused_without_partial_output() {
    for stream in ["1", "2"] {
        let r = Rig::new(&format!("head -c {} /dev/zero >&{stream}", MAX_BYTES + 1));
        let e = run(&r, SystemGit::default(), &Cancel::new()).unwrap_err();
        assert_eq!(e, GitFailure::OutputLimit, "stream {stream}");
    }
}

#[test]
fn output_at_the_bound_is_accepted() {
    let r = Rig::new(&format!("head -c {} /dev/zero | tr '\\0' x", 1024 * 1024));
    assert_eq!(
        run(&r, SystemGit::default(), &Cancel::new()).unwrap().len(),
        1024 * 1024
    );
}
