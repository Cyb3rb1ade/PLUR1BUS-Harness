//! The sandbox launcher `plur1bus-sandbox-limits` (`packages/core/src/tools/sandbox`): CPU time, address space and core
//! dumps are limited per process outside the sandbox; task limits are set only inside a different Linux user namespace.
#![cfg(unix)]
use std::process::Command;

fn launcher() -> Command {
    Command::new(assert_cmd::cargo::cargo_bin("plur1bus-sandbox-limits"))
}

#[cfg(target_os = "linux")]
fn max_processes(limits: &str) -> Option<String> {
    limits
        .lines()
        .find(|l| l.starts_with("Max processes"))
        .map(|l| {
            l.split_whitespace()
                .skip(2)
                .take(2)
                .collect::<Vec<_>>()
                .join(" ")
        })
}

#[cfg(target_os = "linux")]
fn own_userns() -> String {
    std::fs::read_link("/proc/self/ns/user")
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

#[cfg(target_os = "linux")]
#[test]
fn the_launcher_keeps_the_inherited_process_limit() {
    let own = max_processes(&std::fs::read_to_string("/proc/self/limits").unwrap()).unwrap();
    let out = launcher()
        .args(["30", "1073741824", "/bin/cat", "/proc/self/limits"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        max_processes(&String::from_utf8_lossy(&out.stdout)),
        Some(own)
    );
}

#[cfg(target_os = "linux")]
#[test]
fn the_task_mode_refuses_bad_arguments() {
    let cases: [&[&str]; 7] = [
        &["--tasks"],
        &["--tasks", "0", "user:[1]", "--", "/bin/true"],
        &["--tasks", "x", "user:[1]", "--", "/bin/true"],
        &["--tasks", "7", "user:[1]", "/bin/true"],
        &["--tasks", "7", "user:[1]", "--"],
        &["--probe-tasks"],
        &["--probe-tasks", "user:[1]", "extra"],
    ];
    for args in cases {
        let out = launcher().args(args).output().unwrap();
        assert_eq!(out.status.code(), Some(125), "{args:?}");
    }
}

#[cfg(target_os = "linux")]
#[test]
fn the_task_mode_sets_the_limit_outside_the_callers_namespace() {
    let out = launcher()
        .args([
            "--tasks",
            "7",
            "user:[1]",
            "--",
            "/bin/cat",
            "/proc/self/limits",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        max_processes(&String::from_utf8_lossy(&out.stdout)),
        Some("7 7".into())
    );
}

#[cfg(target_os = "linux")]
#[test]
fn the_task_mode_keeps_a_lower_inherited_hard_limit() {
    let out = Command::new("/usr/bin/prlimit")
        .args([
            "--nproc=50:50",
            assert_cmd::cargo::cargo_bin("plur1bus-sandbox-limits")
                .to_str()
                .unwrap(),
            "--tasks",
            "512",
            "user:[1]",
            "--",
            "/bin/cat",
            "/proc/self/limits",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        max_processes(&String::from_utf8_lossy(&out.stdout)),
        Some("50 50".into())
    );
}

#[cfg(target_os = "linux")]
#[test]
fn the_task_mode_skips_the_cap_in_the_callers_namespace() {
    let own = max_processes(&std::fs::read_to_string("/proc/self/limits").unwrap());
    let out = launcher()
        .args([
            "--tasks",
            "7",
            &own_userns(),
            "--",
            "/bin/cat",
            "/proc/self/limits",
        ])
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(max_processes(&String::from_utf8_lossy(&out.stdout)), own);
    assert!(String::from_utf8_lossy(&out.stderr).contains("process cap skipped"));
}

#[cfg(target_os = "linux")]
#[test]
fn the_task_mode_passes_later_double_dashes_to_the_program() {
    let out = launcher()
        .args(["--tasks", "7", "user:[1]", "--", "/bin/echo", "--", "x"])
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(out.stdout, b"-- x\n");
}

#[cfg(target_os = "linux")]
#[test]
fn the_probe_reports_what_the_kernel_enforces() {
    let out = launcher()
        .args(["--probe-tasks", &own_userns()])
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(out.stdout, b"shared-userns\n");
    // unshare(CLONE_NEWUSER) retains the caller's ucounts on Linux 6.18; bubblewrap's clone(CLONE_NEWUSER)
    // establishes the per-namespace accounting used in production. Exercise that launch chain.
    let out = Command::new("/usr/bin/bwrap")
        .args([
            "--unshare-all",
            "--die-with-parent",
            "--ro-bind",
            "/",
            "/",
            "--proc",
            "/proc",
            "--",
            assert_cmd::cargo::cargo_bin("plur1bus-sandbox-limits")
                .to_str()
                .unwrap(),
            "--probe-tasks",
            &own_userns(),
        ])
        .output();
    let out = match out {
        Ok(out)
            if !out.status.success()
                && String::from_utf8_lossy(&out.stderr).starts_with("bwrap:") =>
        {
            eprintln!(
                "skipped: no bubblewrap user namespace: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            return;
        }
        Ok(out) => out,
        Err(other) => {
            eprintln!("skipped: no user namespace: {other:?}");
            return;
        }
    };
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let release = std::fs::read_to_string("/proc/sys/kernel/osrelease").unwrap();
    let version: Vec<u32> = release
        .split('.')
        .take(2)
        .map(|s| s.parse().unwrap())
        .collect();
    let expected = if unsafe { libc::geteuid() } == 0 {
        "not-enforced\n"
    } else if version.as_slice() >= [5, 14].as_slice() {
        "enforced\n"
    } else {
        "per-user\n"
    };
    assert_eq!(String::from_utf8_lossy(&out.stdout), expected);
}

#[test]
fn the_launcher_refuses_missing_or_zero_limits() {
    let cases: [&[&str]; 3] = [
        &["30", "1073741824"],
        &["0", "1073741824", "/bin/true"],
        &["30", "0", "/bin/true"],
    ];
    for args in cases {
        let out = launcher().args(args).output().unwrap();
        assert_eq!(
            out.status.code(),
            Some(125),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}
