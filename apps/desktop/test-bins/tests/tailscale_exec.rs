//! The Tailscale CLI exec path (transport choice spec §5.2 step 2; package T3) through `fake-tailscale`: exactly
//! `status --json`, a cleared environment refilled from the allow-list, the 4 s timeout and the 8 MiB stdout cap. Each
//! test copies the fake into its own temporary directory with its own `fake-tailscale.scenario`, so the scenario never
//! travels through the environment the exec clears. `exec_status` is a debug-only test surface, so this file is too.
#![cfg(debug_assertions)]
use plur1bus_desktop::transport::{
    exec_status, CliTailscale, ExecOutcome, TailscaleSource, TailscaleStatus, UnavailableWhy,
};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Serialises the tests that change the process environment.
static ENV: Mutex<()> = Mutex::new(());

struct Fake {
    _dir: tempfile::TempDir,
    bin: PathBuf,
}

fn fake(scenario: &str) -> Fake {
    let dir = tempfile::tempdir().unwrap();
    let name = if cfg!(windows) {
        "fake-tailscale.exe"
    } else {
        "fake-tailscale"
    };
    let bin = dir.path().join(name);
    std::fs::copy(env!("CARGO_BIN_EXE_fake-tailscale"), &bin).unwrap();
    std::fs::write(dir.path().join("fake-tailscale.scenario"), scenario).unwrap();
    Fake { _dir: dir, bin }
}

fn exited(outcome: ExecOutcome) -> (bool, Vec<u8>) {
    match outcome {
        ExecOutcome::Exited { success, stdout } => (success, stdout),
        ExecOutcome::Failed(why) => panic!("failed: {why:?}"),
    }
}

/// Synchronous on purpose: the lock must cover the exec (which reads the environment), and a std lock is never held
/// across an `.await`.
#[test]
fn argv_is_exactly_status_json_and_only_allow_listed_variables_pass() {
    let f = fake("env");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let outcome = {
        let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("PLUR1BUS_SYNTHETIC_SENTINEL", "must-not-pass");
        std::env::set_var("FAKE_TAILSCALE_SCENARIO", "running");
        let outcome = runtime.block_on(exec_status(&f.bin));
        std::env::remove_var("PLUR1BUS_SYNTHETIC_SENTINEL");
        std::env::remove_var("FAKE_TAILSCALE_SCENARIO");
        outcome
    };
    let (success, stdout) = exited(outcome);
    assert!(success);
    let doc: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
    assert_eq!(doc["argv"], serde_json::json!(["status", "--json"]));
    // `argv[0]` is the path the exec was given (production passes the candidate path there).
    assert_eq!(doc["argv0"].as_str(), f.bin.to_str());
    let names: Vec<String> = doc["env"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    #[cfg(unix)]
    let allowed = ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG"];
    #[cfg(windows)]
    let allowed = [
        "SystemRoot",
        "USERPROFILE",
        "LOCALAPPDATA",
        "ProgramData",
        "TEMP",
    ];
    for name in &names {
        assert!(
            allowed.iter().any(|a| a.eq_ignore_ascii_case(name)),
            "{name} passed the allow-list: {names:?}"
        );
    }
    #[cfg(unix)]
    assert!(names.iter().any(|n| n == "LANG"), "{names:?}");
    assert!(!names.iter().any(|n| n.eq_ignore_ascii_case("PATH")));
}

#[tokio::test]
async fn sleeping_cli_is_killed_at_four_seconds() {
    let f = fake("sleep10");
    let start = Instant::now();
    let outcome = exec_status(&f.bin).await;
    let took = start.elapsed();
    assert!(
        matches!(outcome, ExecOutcome::Failed(UnavailableWhy::Timeout)),
        "{outcome:?}"
    );
    assert!(took >= Duration::from_millis(3_900), "{took:?}");
    assert!(took < Duration::from_millis(5_500), "{took:?}");
}

#[tokio::test]
async fn huge_output_is_capped() {
    let f = fake("huge");
    let start = Instant::now();
    let outcome = exec_status(&f.bin).await;
    assert!(
        matches!(outcome, ExecOutcome::Failed(UnavailableWhy::TooLarge)),
        "{outcome:?}"
    );
    assert!(start.elapsed() < Duration::from_secs(4));
}

#[tokio::test]
async fn exit_status_and_garbage_are_reported_as_they_are() {
    let (success, stdout) = exited(exec_status(&fake("exit1").bin).await);
    assert!(!success);
    assert!(stdout.is_empty());
    let (success, stdout) = exited(exec_status(&fake("garbage").bin).await);
    assert!(success);
    assert_eq!(stdout, b"this is not a status document");
}

#[tokio::test]
async fn relative_or_missing_binaries_are_spawn_failures() {
    for path in ["fake-tailscale", "./fake-tailscale"] {
        assert!(matches!(
            exec_status(std::path::Path::new(path)).await,
            ExecOutcome::Failed(UnavailableWhy::Spawn)
        ));
    }
    let dir = tempfile::tempdir().unwrap();
    assert!(matches!(
        exec_status(&dir.path().join("missing")).await,
        ExecOutcome::Failed(UnavailableWhy::Spawn)
    ));
}

/// The `PLUR1BUS_DESKTOP_TAILSCALE_BIN` seam end to end: a debug build runs the fake through the real exec path and
/// parser. (Release builds ignore the seam; `tailscale_status.rs` checks that without running anything.)
#[cfg(debug_assertions)]
#[tokio::test]
async fn binary_seam_runs_the_fake_through_the_exec_path() {
    let cases = [
        ("needs-login", Some(TailscaleStatus::NeedsLogin)),
        ("stopped", Some(TailscaleStatus::Stopped)),
        ("exit1", Some(TailscaleStatus::DaemonDown)),
        (
            "garbage",
            Some(TailscaleStatus::Unavailable(UnavailableWhy::Unparseable)),
        ),
        (
            "huge",
            Some(TailscaleStatus::Unavailable(UnavailableWhy::TooLarge)),
        ),
        ("running", None),
    ];
    for (scenario, expected) in cases {
        let f = fake(scenario);
        let source = {
            let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
            std::env::set_var("PLUR1BUS_DESKTOP_TAILSCALE_BIN", &f.bin);
            let source = CliTailscale::new();
            std::env::remove_var("PLUR1BUS_DESKTOP_TAILSCALE_BIN");
            source
        };
        assert!(source.uses_debug_seam());
        let status = source.status().await;
        match expected {
            Some(expected) => assert_eq!(status, expected, "{scenario}"),
            None => {
                let TailscaleStatus::Running(view) = status else {
                    panic!("{scenario}: {status:?}")
                };
                assert_eq!(view.peers.len(), 1);
                assert_eq!(view.magic_suffix.as_deref(), Some("example.ts.net"));
            }
        }
    }
}
