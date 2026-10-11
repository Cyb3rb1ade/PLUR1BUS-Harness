//! The Apple runtime's `--publish` argument carries the configured bind address for IPv4 and IPv6 hosts. The fake CLI is
//! the same script `apple.rs` uses; its template and per-test hard link are copied here so this file stands alone.
#![cfg(unix)]
use plur1bus_containers::*;
use std::{fs, os::unix::fs::PermissionsExt, time::Duration};

/// Written once per process before any test thread can fork (see `apple.rs` for why: ETXTBSY otherwise).
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
fn apple_publish_argument_carries_the_configured_bind_address_for_ipv4_and_ipv6() {
    for (bind, expected) in [
        ("192.168.1.10", "192.168.1.10:28700:18700"),
        ("::1", "[::1]:28700:18700"),
    ] {
        let (d, r) = fake();
        r.load(&d.path().join("offline.tar")).unwrap();
        let mut s = Service::harness("local:test");
        s.bind = bind.parse().unwrap();
        s.publish = Some(28700);
        let mut stack = StackManager::new(&r, vec![s]);
        stack.health_timeout = Duration::ZERO;
        stack.up().unwrap();
        let calls = fs::read_to_string(d.path().join("calls.jsonl")).unwrap();
        assert!(
            calls.contains(&format!("\"--publish\", \"{expected}\"")),
            "bind {bind}: {calls}"
        );
    }
}
