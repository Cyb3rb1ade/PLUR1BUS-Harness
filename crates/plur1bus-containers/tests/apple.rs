#![cfg(unix)]
use plur1bus_containers::*;
use std::{fs, os::unix::fs::PermissionsExt, time::Duration};
/// The fake CLI is written and made executable once per process, before any test thread can reach `fork`: Linux refuses
/// to `exec` a file that some process still holds open for writing (ETXTBSY, surfaced as "spawn: Text file busy" and
/// read by `detect` as `Missing`), and a `fork` on a sibling test thread inherits the writer's descriptor until its own
/// `exec`. Every test blocks on this `OnceLock` inside `fake()` before it spawns anything, so no fork can overlap the
/// write. Each test then gets its own inode-sharing hard link in its own directory, because the script keeps its state
/// beside `__file__`.
fn template() -> &'static std::path::Path {
    static T: std::sync::OnceLock<(tempfile::TempDir, std::path::PathBuf)> =
        std::sync::OnceLock::new();
    &T.get_or_init(|| {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("container");
        fs::write(&p, include_str!("fixtures/container.py")).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o700)).unwrap();
        (d, p)
    })
    .1
}
fn fake() -> (tempfile::TempDir, AppleContainerRuntime) {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("container");
    fs::hard_link(template(), &p).unwrap();
    let r = AppleContainerRuntime::new(p, Platform::MacArm, 26);
    (d, r)
}
#[test]
fn apple_detect_lifecycle_offline_load_and_private_flags() {
    let (d, r) = fake();
    assert_eq!(r.detect().state, RuntimeState::Ready);
    r.load(&d.path().join("offline.tar")).unwrap();
    let s = Service::harness("local:test");
    let mut stack = StackManager::new(&r, vec![s]);
    stack.health_timeout = Duration::ZERO;
    stack.up().unwrap();
    stack.up().unwrap();
    assert!(stack.status().unwrap()[0].1.as_ref().unwrap().healthy);
    let error = stack
        .upgrade_image("plur1bus-harness", "local:bad")
        .unwrap_err();
    assert!(error.contains("rollback: Ok"), "{error}");
    assert_eq!(
        stack.status().unwrap()[0].1.as_ref().unwrap().image,
        "local:test"
    );
    stack.down().unwrap();
    assert!(stack.status().unwrap()[0].1.is_none());
    let calls = fs::read_to_string(d.path().join("calls.jsonl")).unwrap();
    assert!(calls.contains("--read-only"));
    assert!(calls.contains("\"--workdir\", \"/\""));
    assert!(calls.contains("--cap-drop"));
    assert!(calls.contains("--internal"));
    assert!(calls.contains("--input"));
    assert!(!calls.contains("--publish"));
}
#[test]
fn detect_unsupported_missing_stopped_permissions_and_versions() {
    let (d, mut r) = fake();
    r.platform = Platform::Linux;
    assert_eq!(r.detect().state, RuntimeState::Unsupported);
    r.platform = Platform::MacArm;
    r.macos_major = 25;
    assert_eq!(r.detect().state, RuntimeState::Unsupported);
    r.macos_major = 26;
    let p = d.path().join("fake-state.json");
    fs::write(&p, r#"{"running":false,"version":"1.5.0"}"#).unwrap();
    assert_eq!(r.detect().state, RuntimeState::Stopped);
    r.ensure_running().unwrap();
    assert_eq!(r.detect().state, RuntimeState::Ready);
    fs::write(&p, r#"{"permission":true}"#).unwrap();
    assert_eq!(r.detect().state, RuntimeState::PermissionDenied);
    fs::write(&p, r#"{"running":true,"version":"0.8.0"}"#).unwrap();
    assert_eq!(r.detect().state, RuntimeState::Unsupported);
    r.cli = d.path().join("missing");
    assert_eq!(r.detect().state, RuntimeState::Missing);
}
#[test]
fn custom_network_connections_use_private_ips_not_bare_dns_names() {
    let (d, r) = fake();
    let mut dependency = Service::harness("local:test");
    dependency.name = "plur1bus-valkey".into();
    dependency.memory = 128 * 1024 * 1024;
    let mut search = Service::harness("local:test");
    search.name = "plur1bus-searxng".into();
    search.connections.push(Connection {
        env: "SEARXNG_VALKEY_URL".into(),
        service: dependency.name.clone(),
        scheme: "valkey".into(),
        port: 6379,
        path: "/0".into(),
    });
    let stack = StackManager::new(&r, vec![dependency, search]);
    stack.up().unwrap();
    let calls = fs::read_to_string(d.path().join("calls.jsonl")).unwrap();
    assert!(calls.contains("SEARXNG_VALKEY_URL=valkey://192.168.88.2:6379/0"));
    assert!(calls.contains("209715200"));
    stack.down().unwrap();
}
