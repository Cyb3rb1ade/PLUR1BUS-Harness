use std::{fs, process::Command};
#[test]
fn dry_run_creates_nothing_in_a_fresh_home() {
    let parent = tempfile::tempdir().unwrap();
    let home = parent.path().join("not-created");
    // Exercise the Windows main-thread stack budget on Unix too. The fresh shell
    // limits only its child; no test-runner thread or host limit is changed.
    #[cfg(unix)]
    let mut command = {
        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                "ulimit -s 1024 && exec \"$@\"",
                "plur1bus-stack-budget",
            ])
            .arg(env!("CARGO_BIN_EXE_plur1bus"));
        command
    };
    #[cfg(not(unix))]
    let mut command = Command::new(env!("CARGO_BIN_EXE_plur1bus"));
    let output = command
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
