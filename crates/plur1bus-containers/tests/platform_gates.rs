//! Runtime detection gated by injected platform facts. Every case here either returns before any
//! process is spawned (platform/version gates, endpoint shape) or points the runtime at a path that
//! does not exist, so no fake binary is written and no fork can race a write.
use plur1bus_containers::*;

const MISSING_CLI: &str = "/nonexistent/plur1bus-test/container";

#[test]
fn apple_refuses_every_platform_that_is_not_apple_silicon_on_macos_26() {
    for platform in [Platform::Linux, Platform::Windows, Platform::MacIntel] {
        let r = AppleContainerRuntime::new(MISSING_CLI, platform, 26);
        let d = r.detect();
        assert_eq!(d.state, RuntimeState::Unsupported, "{platform:?}");
        assert!(
            d.detail.contains("macOS >=26"),
            "{platform:?}: {}",
            d.detail
        );
        assert!(r.ensure_running().is_err(), "{platform:?}");
    }
}

#[test]
fn apple_version_gate_is_checked_before_the_cli_is_touched() {
    // Old macOS on Apple Silicon: Unsupported, not Missing, even though the CLI path does not exist.
    for major in [0, 14, 25] {
        let r = AppleContainerRuntime::new(MISSING_CLI, Platform::MacArm, major);
        assert_eq!(r.detect().state, RuntimeState::Unsupported, "macOS {major}");
    }
    // Supported platform with no CLI installed: Missing.
    let r = AppleContainerRuntime::new(MISSING_CLI, Platform::MacArm, 26);
    assert_eq!(r.detect().state, RuntimeState::Missing);
    assert!(r.ensure_running().is_err());
}

#[test]
fn apple_unsupported_platform_never_attempts_to_start_the_system() {
    // `ensure_running` only calls `system start` on Stopped. An unsupported host must return the gate
    // error and leave the CLI alone, so the missing-binary path can't be mistaken for a start attempt.
    let r = AppleContainerRuntime::new(MISSING_CLI, Platform::Linux, 26);
    let err = r.ensure_running().unwrap_err();
    assert!(err.contains("macOS >=26"), "{err}");
}

#[cfg(unix)]
#[test]
fn docker_named_pipe_endpoint_is_unsupported_off_windows() {
    let r = DockerRuntime::new("npipe:////./pipe/docker_engine");
    let d = r.detect();
    assert_eq!(d.state, RuntimeState::Unsupported);
    assert!(d.detail.contains("named-pipe"), "{}", d.detail);
}

#[test]
fn docker_unknown_endpoint_scheme_is_unsupported() {
    for endpoint in ["ftp://engine.invalid/", "ssh://engine.invalid/"] {
        let r = DockerRuntime::new(endpoint);
        assert_eq!(r.detect().state, RuntimeState::Unsupported, "{endpoint}");
    }
}

#[test]
fn docker_plain_tcp_to_a_remote_host_is_refused_before_any_request() {
    // Remote engines require TLS: the refusal happens in `command`, so no socket is opened and the
    // state is Stopped (the generic "not reachable" bucket), with the TLS reason in the detail.
    let r = DockerRuntime::new("tcp://10.20.30.40:2375");
    let d = r.detect();
    assert_eq!(d.state, RuntimeState::Stopped);
    assert!(d.detail.contains("TLS"), "{}", d.detail);
}

#[test]
fn docker_missing_socket_is_missing_not_stopped() {
    let r = DockerRuntime::new("unix:///nonexistent/plur1bus-test/docker.sock");
    assert_eq!(r.detect().state, RuntimeState::Missing);
}
