//! Synthetic stub data only: its snapshots must still detect corruption and copy bytes.
use std::process::Command;
fn run(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_fake-plur1bus"))
        .args(args)
        .output()
        .unwrap()
}
#[test]
fn stub_snapshot_verify_restore_preserves_data_and_refuses_corruption() {
    let d = tempfile::tempdir().unwrap();
    let src = d.path().join("src");
    let dst = d.path().join("dst");
    let out = d.path().join("restored");
    std::fs::create_dir(&src).unwrap();
    std::fs::write(src.join("fact.txt"), b"synthetic remembered fact").unwrap();
    let result = run(&[
        "state",
        "snapshot",
        "--src",
        src.to_str().unwrap(),
        "--dst",
        dst.to_str().unwrap(),
        "--json",
    ]);
    assert!(result.status.success());
    let value: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(value["manifestSha256"].as_str().unwrap().len(), 64);
    assert!(
        run(&["state", "verify", "--dir", dst.to_str().unwrap(), "--json"])
            .status
            .success()
    );
    assert!(run(&[
        "state",
        "restore",
        "--src",
        dst.to_str().unwrap(),
        "--dst",
        out.to_str().unwrap(),
        "--json"
    ])
    .status
    .success());
    assert_eq!(
        std::fs::read(out.join("fact.txt")).unwrap(),
        b"synthetic remembered fact"
    );
    std::fs::write(dst.join("fact.txt"), b"corrupted").unwrap();
    assert!(
        !run(&["state", "verify", "--dir", dst.to_str().unwrap(), "--json"])
            .status
            .success()
    );
}
