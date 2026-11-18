//! The TypeScript tests of `packages/core/test/egress/` that are about the library (`policy`, `gate`, `a2a`,
//! `model-downloads`, the dry-run half of `service`), ported. `rpc.test.ts` belongs to the flip (T); `post-paths.test.ts`
//! and the request half of `service.test.ts` drive the guarded HTTP client, which is not ported here.
use super::gate::{Decision, DenyReason, Gate};
use super::guard::{ResolvedAddress, Resolver};
use super::model_downloads::{is_model_artifact_request, ModelRequest};
use super::policy::{compile_egress_policy, host_allowed, EgressPolicy, HostMatch};
use super::service::{ConfigSource, DryRun, Egress, Purpose};
use super::{parse_url, AsciiIdna, Idna, ParsedUrl};
use serde_json::{json, Value};
use std::sync::Mutex;

fn policy(cfg: &Value) -> EgressPolicy {
    compile_egress_policy(cfg, &AsciiIdna)
}

fn url(raw: &str) -> crate::config::endpoint::Url {
    match parse_url(raw, &AsciiIdna) {
        ParsedUrl::Ok(u) => u,
        other => panic!("{raw}: {other:?}"),
    }
}

fn pre(p: &EgressPolicy, raw: &str) -> Option<DenyReason> {
    Gate::new(p, |_| {})
        .before_resolve(&url(raw))
        .err()
        .map(|d| d.reason)
}

fn post(p: &EgressPolicy, raw: &str, address: &str) -> Option<DenyReason> {
    let pin = ResolvedAddress {
        address: address.to_owned(),
        family: if address.contains(':') { 6 } else { 4 },
    };
    Gate::new(p, |_| {})
        .after_resolve(&url(raw), &pin)
        .err()
        .map(|d| d.reason)
}

#[test]
fn defaults_deny_every_host() {
    let p = policy(&json!({ "allowHosts": [], "allowPorts": [443], "allowLoopback": false }));
    assert_eq!(p.allow_ports, vec![443]);
    assert!(!p.allow_loopback && p.errors.is_empty());
    assert!(!host_allowed(&p, "example.com", HostMatch::default()));
}

#[test]
fn any_error_makes_the_whole_list_deny_all() {
    for bad in [
        json!(""),
        json!("a*.example.com"),
        json!("0x7f.1"),
        json!(7),
        json!("[2001:db8::1"),
    ] {
        let p = policy(
            &json!({ "allowHosts": ["good.example", bad], "allowPorts": [443], "allowLoopback": true }),
        );
        assert_eq!(p.errors.len(), 1, "{bad}");
        assert!(!host_allowed(&p, "good.example", HostMatch::default()));
        assert!(p.allow_ports.is_empty() && !p.allow_loopback);
    }
    for ports in [
        json!([0]),
        json!([65536]),
        json!([1.5]),
        json!(["443"]),
        json!(443),
        Value::Null,
    ] {
        let p = policy(
            &json!({ "allowHosts": ["a.example"], "allowPorts": ports, "allowLoopback": true }),
        );
        assert!(!p.errors.is_empty(), "{ports}");
        assert!(p.allow_ports.is_empty());
    }
}

#[test]
fn star_names_never_ip_literals_and_suffixes_never_the_apex() {
    let p = policy(
        &json!({ "allowHosts": ["*", "*.api.test"], "allowPorts": [443], "allowLoopback": false }),
    );
    assert!(host_allowed(&p, "anything.example", HostMatch::default()));
    for ip in ["8.8.8.8", "[::1]", "127.0.0.1"] {
        assert!(!host_allowed(&p, ip, HostMatch::default()), "{ip}");
    }
    let only_suffix = policy(
        &json!({ "allowHosts": ["*.api.test"], "allowPorts": [443], "allowLoopback": false }),
    );
    assert!(host_allowed(
        &only_suffix,
        "a.b.api.test",
        HostMatch::default()
    ));
    assert!(!host_allowed(
        &only_suffix,
        "api.test",
        HostMatch::default()
    ));
    assert!(!host_allowed(
        &only_suffix,
        "evilapi.test",
        HostMatch::default()
    ));
}

#[test]
fn gate_scheme_port_host_and_loopback_rules() {
    let p = policy(
        &json!({ "allowHosts": ["example.com", "*.cdn.test"], "allowPorts": [443, 8443], "allowLoopback": false }),
    );
    assert_eq!(pre(&p, "https://example.com/x"), None);
    assert_eq!(
        pre(&p, "https://evil.test/"),
        Some(DenyReason::HostNotAllowed)
    );
    assert_eq!(pre(&p, "https://example.com:444/"), Some(DenyReason::Port));
    assert_eq!(pre(&p, "http://example.com/"), Some(DenyReason::Scheme));
    assert_eq!(
        pre(&p, "https://user:pw@example.com/"),
        Some(DenyReason::InvalidUrl)
    );
    assert_eq!(
        pre(&p, "https://example.com../"),
        Some(DenyReason::InvalidUrl)
    );
    let star =
        policy(&json!({ "allowHosts": ["*"], "allowPorts": [80, 443], "allowLoopback": true }));
    assert_eq!(
        pre(&star, "http://localhost/"),
        Some(DenyReason::HostNotAllowed),
        "a loopback host must be listed by name"
    );
    let lo =
        policy(&json!({ "allowHosts": ["127.0.0.1"], "allowPorts": [80], "allowLoopback": true }));
    for u in [
        "http://0x7f.1/",
        "http://2130706433/",
        "http://127.1/",
        "http://[::ffff:127.0.0.1]/",
    ] {
        assert_eq!(pre(&lo, u), None, "{u} is 127.0.0.1");
    }
    assert_eq!(
        pre(&lo, "http://0x7f.0.0.2/"),
        Some(DenyReason::HostNotAllowed)
    );
}

#[test]
fn rebinding_shaped_pins_are_refused_whatever_allow_loopback_says() {
    let lo = policy(
        &json!({ "allowHosts": ["localhost", "dev.example", "*"], "allowPorts": [443, 3000], "allowLoopback": true }),
    );
    assert_eq!(post(&lo, "https://dev.example/", "93.184.216.34"), None);
    assert_eq!(
        post(&lo, "https://dev.example/", "127.0.0.1"),
        Some(DenyReason::Loopback)
    );
    assert_eq!(
        post(&lo, "https://dev.example/", "::ffff:127.0.0.1"),
        Some(DenyReason::Loopback)
    );
    assert_eq!(post(&lo, "http://localhost:3000/", "127.0.0.1"), None);
    assert_eq!(
        post(&lo, "http://localhost:3000/", "93.184.216.34"),
        Some(DenyReason::Scheme)
    );
    let off = policy(
        &json!({ "allowHosts": ["localhost"], "allowPorts": [443], "allowLoopback": false }),
    );
    assert_eq!(
        post(&off, "https://localhost/", "127.0.0.1"),
        Some(DenyReason::Loopback)
    );
}

#[test]
fn the_gate_reports_allowed_and_denied_decisions() {
    let p = policy(
        &json!({ "allowHosts": ["a.example"], "allowPorts": [443], "allowLoopback": false }),
    );
    let mut seen = Vec::new();
    {
        let mut g = Gate::new(&p, |d| seen.push(d));
        g.before_resolve(&url("https://a.example/")).unwrap();
        g.after_resolve(
            &url("https://a.example/"),
            &ResolvedAddress {
                address: "93.184.216.34".into(),
                family: 4,
            },
        )
        .unwrap();
        assert!(g.before_resolve(&url("https://b.example/")).is_err());
    }
    assert_eq!(
        seen,
        vec![
            Decision::Allowed,
            Decision::Denied(DenyReason::HostNotAllowed)
        ]
    );
}

struct Fixed {
    cfg: Mutex<Value>,
    addresses: Mutex<Vec<&'static str>>,
    lookups: Mutex<usize>,
}

impl ConfigSource for Fixed {
    fn egress_config(&self) -> Value {
        self.cfg.lock().unwrap().clone()
    }
}

impl Resolver for Fixed {
    fn resolve(&self, _host: &str) -> Result<Vec<ResolvedAddress>, Option<String>> {
        *self.lookups.lock().unwrap() += 1;
        Ok(self
            .addresses
            .lock()
            .unwrap()
            .iter()
            .map(|a| ResolvedAddress {
                address: (*a).to_owned(),
                family: if a.contains(':') { 6 } else { 4 },
            })
            .collect())
    }
}

fn allowed(r: &DryRun) -> bool {
    matches!(r, DryRun::Allowed { .. })
}

#[test]
fn a2a_admits_listed_tailnet_pins_and_keeps_metadata_closed() {
    let f = Fixed {
        cfg: Mutex::new(
            json!({ "allowHosts": ["node.example"], "allowPorts": [443], "allowLoopback": false }),
        ),
        addresses: Mutex::new(vec!["100.64.0.9"]),
        lookups: Mutex::new(0),
    };
    let e = Egress::new(&f, &f, &AsciiIdna, 0);
    let u = "https://node.example/a2a";
    assert!(!allowed(&e.decide(u, Purpose::Ordinary)));
    assert!(allowed(&e.decide(u, Purpose::A2a)));
    *f.addresses.lock().unwrap() = vec!["fd7a:115c:a1e0::9"];
    assert!(allowed(&e.decide(u, Purpose::A2a)));
    for extra in [
        "10.0.0.1",
        "169.254.169.254",
        "100.100.100.200",
        "127.0.0.1",
    ] {
        *f.addresses.lock().unwrap() = vec!["100.64.0.9", extra];
        assert!(!allowed(&e.decide(u, Purpose::A2a)), "{extra}");
    }
    *f.addresses.lock().unwrap() = vec!["100.64.0.9"];
    *f.cfg.lock().unwrap() =
        json!({ "allowHosts": ["*"], "allowPorts": [443], "allowLoopback": false });
    let before = *f.lookups.lock().unwrap();
    assert!(!allowed(&e.decide(u, Purpose::A2a)));
    assert_eq!(
        *f.lookups.lock().unwrap(),
        before,
        "refused before any lookup"
    );
}

#[test]
fn model_downloads_admit_only_credential_free_repository_reads() {
    let artifact = "https://huggingface.co/intfloat/multilingual-e5-small/resolve/614241f622f53c4eeff9890bdc4f31cfecc418b3/config.json";
    let req = |url: &str, method: &str, headers: &[&str], body: bool| ModelRequest {
        method: method.into(),
        url: url.into(),
        header_names: headers.iter().map(|h| (*h).to_owned()).collect(),
        has_body: body,
    };
    assert!(is_model_artifact_request(&req(artifact, "GET", &[], false)));
    assert!(is_model_artifact_request(&req(
        artifact,
        "HEAD",
        &["range"],
        false
    )));
    assert!(!is_model_artifact_request(&req(
        &format!("{artifact}?text=private"),
        "GET",
        &[],
        false
    )));
    assert!(!is_model_artifact_request(&req(
        artifact,
        "GET",
        &["authorization"],
        false
    )));
    assert!(!is_model_artifact_request(&req(
        artifact,
        "POST",
        &[],
        true
    )));
    assert!(!is_model_artifact_request(&req(
        "https://huggingface.co/a/b/resolve/main/%2e%2e/model.onnx",
        "GET",
        &[],
        false
    )));
    assert!(!is_model_artifact_request(&req(
        "https://attacker.example/model.onnx",
        "GET",
        &[],
        false
    )));
}

#[test]
fn ascii_idna_answers_only_for_plain_ascii() {
    assert_eq!(
        AsciiIdna.domain_to_ascii("Example.COM").as_deref(),
        Some("example.com")
    );
    assert_eq!(AsciiIdna.domain_to_ascii("xn--bcher-kva.example"), None);
    assert_eq!(AsciiIdna.domain_to_ascii("XN--bcher-kva.example"), None);
    assert_eq!(AsciiIdna.domain_to_ascii("bücher.example"), None);
    assert_eq!(
        parse_url("https://bücher.example/", &AsciiIdna),
        ParsedUrl::NeedsIdna
    );
}

#[test]
fn host_idna_is_the_host_parser_not_utf46_alone() {
    use super::HostIdna;
    let ascii = |d: &str| HostIdna.domain_to_ascii(d).unwrap();
    assert_eq!(ascii("Example.COM"), "example.com");
    assert_eq!(ascii("b\u{fc}cher.example"), "xn--bcher-kva.example");
    // A name that ends in a number is an IPv4 address or nothing.
    assert_eq!(ascii("0x7f.0x1"), "127.0.0.1");
    assert_eq!(ascii("foo.0x"), "");
    assert_eq!(ascii("a b.example"), "");
    // The reader has decoded the host once; a `%` left over is a forbidden code point, never decoded a second time.
    assert_eq!(
        parse_url("https://%2541.example/", &HostIdna),
        ParsedUrl::Invalid
    );
}
