//! The fullscreen selector is additive; help is a local parser operation and never opens a session.
use std::process::Command;

#[test]
fn tui_help_is_available_without_creating_a_home_or_contacting_a_core() {
    let temp = tempfile::tempdir().expect("temporary parent");
    let home = temp.path().join("not-created");
    let result = Command::new(env!("CARGO_BIN_EXE_plur1bus"))
        .arg("--home")
        .arg(&home)
        .args(["code", "--tui", "--help"])
        .output()
        .expect("CLI help");
    assert!(
        result.status.success(),
        "help failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    let help = String::from_utf8(result.stdout).expect("UTF-8 help");
    assert!(help.contains("--tui"), "the selector must be documented");
    assert!(!home.exists(), "help must not initialize a harness home");
}
