//! E2/E3: the real production Core SSH service connects through the fixed native worker using a private key lease.
use serde_json::json;
use std::path::Path;
use std::process::Command;

#[test]
fn core_ssh_service_vets_trusts_reads_and_revokes_without_exposing_private_keys() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let target = assert_cmd::cargo::cargo_bin("plur1bus");
    let example = target
        .parent()
        .unwrap()
        .join("examples")
        .join(if cfg!(windows) {
            "sftp_test_server.exe"
        } else {
            "sftp_test_server"
        });
    assert!(example.is_file(), "explicit prerequisite: cargo build --locked -p plur1bus-remote-fs --bin plur1bus-remote-fs --example sftp_test_server");
    let fixture = tempfile::tempdir().unwrap();
    std::fs::write(
        fixture.path().join("config.json"),
        b"{\"model\":\"fixture\"}\n",
    )
    .unwrap();
    let output = Command::new("node")
        .args([
            "--experimental-strip-types",
            "--conditions=source",
            "--no-warnings=ExperimentalWarning",
        ])
        .arg(root.join("packages/core/test/fixtures/import-ssh-native-stack.mjs"))
        .arg(target.canonicalize().unwrap())
        .arg(example)
        .arg(fixture.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "actual Core SSH service failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        json!({"publicKey":true,"probe":true,"trust":true,"read":true,
        "roleRevocation":true,"mismatchBeforeKey":true,"rotation":true})
    );
}
