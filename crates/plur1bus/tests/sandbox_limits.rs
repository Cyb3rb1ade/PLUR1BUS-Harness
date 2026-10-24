//! The sandbox launcher `plur1bus-sandbox-limits` (`packages/core/src/tools/sandbox`): CPU time, address space and core
//! dumps are limited per process, the number of processes is not. On Linux that limit counts every thread of the user on
//! the whole system, so no fixed value can bound one sandbox (docs/superpowers/specs/2026-10-24-cpu-core-limit-design.md).
#![cfg(unix)]
use std::process::Command;

fn launcher() -> Command {
    Command::new(assert_cmd::cargo::cargo_bin("plur1bus-sandbox-limits"))
}

#[cfg(target_os = "linux")]
#[test]
fn the_launcher_keeps_the_inherited_process_limit() {
    let line = |limits: &str| {
        limits
            .lines()
            .find(|l| l.starts_with("Max processes"))
            .map(|l| l.trim_end().to_string())
    };
    let own = line(&std::fs::read_to_string("/proc/self/limits").unwrap()).unwrap();
    let out = launcher()
        .args(["30", "1073741824", "/bin/cat", "/proc/self/limits"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(line(&String::from_utf8_lossy(&out.stdout)), Some(own));
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
