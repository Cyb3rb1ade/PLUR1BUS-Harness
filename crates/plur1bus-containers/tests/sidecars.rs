use plur1bus_containers::*;
use std::{cell::Cell, collections::BTreeMap};
struct FakeProbe {
    calls: Cell<usize>,
    fail: bool,
}
impl HealthProbe for FakeProbe {
    fn check(&self, _: &str, _: &SidecarConfig) -> Result<()> {
        self.calls.set(self.calls.get() + 1);
        if self.fail {
            Err("unreachable".into())
        } else {
            Ok(())
        }
    }
}
#[test]
fn remote_bundled_off_and_unreachable() {
    let mut configs = BTreeMap::new();
    let mut bundled = BTreeMap::new();
    let mut c = SidecarConfig::off();
    c.mode = SidecarMode::Remote;
    c.url = Some("http://100.64.0.10:8080".into());
    configs.insert("searxng".into(), c.clone());
    bundled.insert("searxng".into(), "http://plur1bus-searxng:8080".into());
    let mut m = SidecarManager {
        configs,
        bundled,
        probe: FakeProbe {
            calls: Cell::new(0),
            fail: true,
        },
    };
    assert_eq!(
        m.resolve_endpoint("searxng").unwrap().unwrap(),
        c.url.unwrap()
    );
    assert!(m
        .health("searxng")
        .unwrap_err()
        .contains("searxng: unreachable"));
    m.configs.get_mut("searxng").unwrap().mode = SidecarMode::Off;
    m.health("searxng").unwrap();
    assert_eq!(m.probe.calls.get(), 1);
    m.configs.get_mut("searxng").unwrap().mode = SidecarMode::Bundled;
    assert_eq!(
        m.resolve_endpoint("searxng").unwrap().unwrap(),
        "http://plur1bus-searxng:8080"
    );
}
#[test]
fn self_signed_leaf_pin_match_mismatch_and_malformed() {
    let cert = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    let der = cert.cert.der();
    let fingerprint = certificate_fingerprint(der);
    verify_fingerprint(&fingerprint, der).unwrap();
    assert!(verify_fingerprint(&fingerprint, b"other cert").is_err());
    assert!(verify_fingerprint("sha256:a", der).is_err());
    let mut c = SidecarConfig::off();
    c.mode = SidecarMode::Remote;
    c.url = Some("http://localhost:8080".into());
    c.fingerprint = Some(fingerprint);
    assert!(resolve_endpoint("searxng", &c, None).is_err());
    c.url = Some("https://localhost:8080".into());
    assert!(resolve_endpoint("searxng", &c, None).is_ok());
}
#[test]
fn endpoints_reject_credentials_redirect_fragments_and_timeouts() {
    for url in [
        "https://user:secret@host/",
        "https://host/#fragment",
        "ftp://host/",
    ] {
        let mut c = SidecarConfig::off();
        c.mode = SidecarMode::Remote;
        c.url = Some(url.into());
        assert!(resolve_endpoint("s", &c, None).is_err());
    }
    let mut c = SidecarConfig::off();
    c.mode = SidecarMode::Remote;
    c.url = Some("http://100.64.0.1".into());
    c.timeout_ms = 0;
    assert!(resolve_endpoint("s", &c, None).is_err());
}
#[test]
fn uid_and_sidecar_manifests() {
    assert!(diagnose_uid_gid(10001, 10001, true).is_ok());
    assert!(diagnose_uid_gid(501, 20, true)
        .unwrap_err()
        .contains("virtiofs"));
    assert!(diagnose_uid_gid(10001, 10001, false).is_err());
    let m: SidecarManifest = serde_json::from_str(include_str!(
        "../../../containers/sidecars/searxng/manifest.json"
    ))
    .unwrap();
    assert!(m.service().unwrap().publish.is_none());
}
#[test]
fn remote_valkey_is_a_native_endpoint_without_a_bundled_container() {
    let mut c = SidecarConfig::off();
    c.mode = SidecarMode::Remote;
    c.url = Some("valkey://100.64.0.2:6379/0".into());
    assert_eq!(resolve_endpoint("valkey", &c, None).unwrap(), c.url);
    assert!(resolve_endpoint("searxng", &c, None).is_err());
    let mut m = SidecarManager {
        configs: BTreeMap::from([("valkey".into(), c)]),
        bundled: BTreeMap::new(),
        probe: FakeProbe {
            calls: Cell::new(0),
            fail: true,
        },
    };
    assert!(m.health("valkey").unwrap_err().contains("unreachable"));
    m.configs.get_mut("valkey").unwrap().mode = SidecarMode::Off;
    m.health("valkey").unwrap();
    assert_eq!(m.probe.calls.get(), 1);
}
