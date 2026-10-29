//! The shipped Harness exposes only a hidden fixed stdin-pipe entry to the isolated read-only SSH/SFTP worker.
use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn the_shipped_binary_runs_the_framed_worker_without_a_public_help_command_or_key_argument() {
    let binary = assert_cmd::cargo::cargo_bin("plur1bus");
    let help = Command::new(&binary).arg("--help").output().unwrap();
    assert!(help.status.success());
    assert!(!String::from_utf8_lossy(&help.stdout).contains("__remote-fs-worker"));
    let mut child = Command::new(&binary)
        .arg("__remote-fs-worker")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&u32::MAX.to_be_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    assert!(output.stderr.is_empty());
    assert!(
        output.stdout.len() >= 4,
        "hidden route must dispatch the framed native worker"
    );
    let length = u32::from_be_bytes(output.stdout[..4].try_into().unwrap()) as usize;
    assert_eq!(output.stdout.len(), length + 4);
    let value: serde_json::Value = serde_json::from_slice(&output.stdout[4..]).unwrap();
    assert_eq!(
        value,
        serde_json::json!({"v":1,"ok":false,"code":"E_INVALID_PARAMS","reason":"invalid-request"})
    );
}
