// Process fixtures fail immediately with bounded diagnostics and always kill/reap children.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[allow(
    dead_code,
    reason = "shared process support also covers unrelated RPC cases"
)]
mod rpc_process_support;

use rpc_process_support::{home, process_test, EngineProcess};
use std::process::Command;

fn fatal_accept(command: &mut Command) {
    command.env("PLUR1BUS_TEST_ACCEPT_ERROR", "permission-denied");
    command.env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1");
}

#[test]
fn a_fatal_accept_error_exits_2_and_removes_owned_run_files() {
    let _serial = process_test();
    let home = home();
    let mut engine =
        EngineProcess::spawn_configured(home.path(), None, true, None, Some(fatal_accept));
    assert_eq!(
        engine.wait_for_exit().code(),
        Some(2),
        "{}",
        engine.diagnostics()
    );
    let diagnostics = engine.diagnostics();
    // The fault must follow successful bind/publication, so removed files are
    // evidence of the fatal accept shutdown path rather than an early refusal.
    assert!(diagnostics.contains("\"ready\":true"), "{diagnostics}");
    assert!(
        diagnostics.contains("\"stage\":\"accept\""),
        "{diagnostics}"
    );
    assert!(
        diagnostics.contains("\"error_kind\":\"permission\""),
        "{diagnostics}"
    );
    assert!(
        diagnostics.contains("\"reason\":\"transport-fatal\""),
        "{diagnostics}"
    );
    engine.assert_run_files_removed();
    assert!(!home.path().join("run/engine.lock").exists());
}

#[test]
fn an_accept_error_seam_requires_explicit_test_authorization() {
    fn unauthorized(command: &mut Command) {
        command.env("PLUR1BUS_TEST_ACCEPT_ERROR", "permission-denied");
    }
    let _serial = process_test();
    let home = home();
    let mut engine =
        EngineProcess::spawn_configured(home.path(), None, true, None, Some(unauthorized));
    assert_eq!(
        engine.wait_for_exit().code(),
        Some(2),
        "{}",
        engine.diagnostics()
    );
    assert!(
        !engine.diagnostics().contains("\"ready\":true"),
        "{}",
        engine.diagnostics()
    );
    engine.assert_run_files_removed();
}
