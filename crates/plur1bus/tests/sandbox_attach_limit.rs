//! Attach must enforce a measured excess before releasing the target gate.
#![cfg(target_os = "macos")]
use std::process::Command;

#[test]
fn attach_rss_excess_prevents_target_exec() {
    let temp = tempfile::tempdir().unwrap();
    let marker = temp.path().join("executed");
    let out = Command::new(assert_cmd::cargo::cargo_bin("plur1bus-sandbox-limits"))
        .args(["--watch-tree", "1", "1", "--", "/usr/bin/touch"])
        .arg(&marker)
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(122), "{out:?}");
    assert!(String::from_utf8_lossy(&out.stderr).contains("rss-limit-exceeded"));
    assert!(!marker.exists(), "target executed before attach completed");
}
