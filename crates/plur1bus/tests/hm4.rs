use std::{fs, process::Command};
#[test]
fn dry_run_creates_nothing_in_a_fresh_home() {
    let parent = tempfile::tempdir().unwrap();
    let home = parent.path().join("not-created");
    let output = Command::new(env!("CARGO_BIN_EXE_plur1bus"))
        .arg("--home")
        .arg(&home)
        .args(["--json", "setup", "--profile", "full", "--dry-run"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["dryRun"], true);
    assert_eq!(report["store"]["copied"], false);
    assert!(!home.exists());
    assert_eq!(fs::read_dir(parent.path()).unwrap().count(), 0);
}
