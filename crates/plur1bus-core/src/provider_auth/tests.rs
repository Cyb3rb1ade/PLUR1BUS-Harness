//! Ports of `packages/core/test/auth/*.test.ts` that are not already a recorded vector, and the secret rule of this package:
//! no type that holds a secret prints it, and no error or log line carries one.
use super::http::{OAuthHttpError, TokenData, TokenResponse, WireRequest};
use super::login::{callback_code, AuthorizationPrompt, CallbackGate, CallbackRequest, Judged};
use super::record::OAuthRecord;
use super::secret::Secret;

/// A marker every invented secret here carries.
fn canary(tag: &str) -> String {
    ["CAN", "ARY-", tag].concat()
}

#[test]
fn a_secret_prints_redacted() {
    let s = Secret::new(canary("A"));
    assert_eq!(format!("{s:?}"), "[redacted]");
    assert!(s.matches(&canary("A")));
    assert!(!s.matches(&canary("B")));
    assert!(!s.matches(""));
}

#[test]
fn a_record_prints_and_serialises_without_its_tokens() {
    let mut r = OAuthRecord::new(Secret::new(canary("ACCESS")), 3.0);
    r.refresh_token = Some(Secret::new(canary("REFRESH")));
    r.expires_at = Some(5.0);
    let d = format!("{r:?}");
    assert!(!d.contains("CANARY"), "{d}");
    assert!(!r.redacted_json().to_string().contains("CANARY"));
    assert!(
        r.encode().expose().contains(&canary("ACCESS")),
        "only encode writes the value"
    );
    assert_eq!(format!("{:?}", r.encode()), "[redacted]");
}

#[test]
fn transport_and_token_types_print_redacted() {
    let mut m = serde_json::Map::new();
    m.insert("access_token".into(), serde_json::json!(canary("X")));
    let data = TokenData(m);
    assert!(!format!("{data:?}").contains("CANARY"));
    assert!(!data.redacted_json().to_string().contains("CANARY"));
    let t = TokenResponse {
        access_token: Secret::new(canary("T")),
        refresh_token: Some(Secret::new(canary("R"))),
        expires_in_seconds: None,
        refresh_expires_in_seconds: None,
    };
    assert!(!format!("{t:?}").contains("CANARY"));
    let e = OAuthHttpError::new("invalid_grant");
    assert!(!format!("{e:?}{}", e.message()).contains("CANARY"));
    let req = WireRequest {
        method: "POST".into(),
        url: "https://idp.example.test/token".into(),
        headers: vec![],
        body: Secret::new(format!("refresh_token={}", canary("R"))),
        limits: super::http::Limits {
            max_bytes: None,
            error_body_bytes: None,
            timeout_ms: None,
            no_redirects: true,
        },
        pin: super::http::Pin {
            host: "h".into(),
            address: "1.1.1.1".into(),
            family: 4,
            port: 443,
        },
    };
    assert!(!format!("{req:?}").contains("CANARY"));
}

fn gate() -> (CallbackGate, String) {
    let state = canary("STATE");
    (
        CallbackGate::new(
            "http://127.0.0.1:5000/auth/callback",
            Secret::new(state.clone()),
        )
        .unwrap(),
        state,
    )
}

fn get(target: &str) -> CallbackRequest {
    CallbackRequest {
        method: "GET".into(),
        target: target.into(),
        host: Some("127.0.0.1:5000".into()),
        ..CallbackRequest::default()
    }
}

#[test]
fn the_listener_refuses_without_echo_and_rate_limits_forgeries_only() {
    let (mut g, state) = gate();
    for i in 0..10 {
        match g.judge(&get(&format!("/auth/callback?code=x&state=forged{i}")), 0.0) {
            Judged::Refused(r) => {
                assert_eq!(r.status, 400);
                assert!(!r.body.contains("forged"));
            }
            Judged::Genuine(..) => panic!("forged accepted"),
        }
    }
    match g.judge(&get("/auth/callback?state=x"), 999.0) {
        Judged::Refused(r) => assert_eq!(r.status, 429),
        Judged::Genuine(..) => panic!(),
    }
    // A full second after the first forgery the window has room again, and the genuine one is never throttled.
    match g.judge(&get(&format!("/auth/callback?code=c&state={state}")), 999.0) {
        Judged::Genuine(r, Ok(_)) => assert_eq!(r.status, 200),
        _ => panic!("the genuine callback was throttled"),
    }
    match g.judge(
        &get(&format!("/auth/callback?code=c&state={state}")),
        1000.0,
    ) {
        Judged::Refused(r) => assert_eq!(r.status, 410),
        Judged::Genuine(..) => panic!("a second callback was accepted"),
    }
}

#[test]
fn the_listener_checks_host_path_and_method() {
    let (mut g, state) = gate();
    let good = format!("/auth/callback?code=c&state={state}");
    let mut foreign = get(&good);
    foreign.host = Some("evil.example".into());
    assert!(matches!(g.judge(&foreign, 0.0), Judged::Refused(r) if r.status == 400));
    let mut post = get(&good);
    post.method = "POST".into();
    assert!(matches!(g.judge(&post, 0.0), Judged::Refused(r) if r.status == 404));
    assert!(
        matches!(g.judge(&get(&format!("/other?code=c&state={state}")), 0.0), Judged::Refused(r) if r.status == 404)
    );
    let mut no_host = get(&good);
    no_host.host = None;
    assert!(matches!(g.judge(&no_host, 0.0), Judged::Refused(r) if r.status == 400));
    match g.judge(
        &get(&format!("/auth/callback?error=access_denied&state={state}")),
        0.0,
    ) {
        Judged::Genuine(r, Err(e)) => {
            assert_eq!(r.status, 400);
            assert_eq!(e.code.as_str(), "access_denied");
        }
        _ => panic!("an error callback with the right state ends the login"),
    }
}

#[test]
fn callback_code_checks_in_order_and_never_echoes() {
    let redirect = "http://127.0.0.1:5000/auth/callback";
    let st = Secret::new(canary("S"));
    let code = |raw: &str| {
        callback_code(raw, redirect, &st)
            .map(|c| c.expose().to_owned())
            .map_err(|e| e.code.as_str())
    };
    let ok = format!("{redirect}?code=abc&state={}", canary("S"));
    assert_eq!(code(&ok), Ok("abc".to_owned()));
    assert_eq!(
        code(&format!("{redirect}?code=abc&state=other")),
        Err("state_mismatch")
    );
    assert_eq!(
        code(&format!(
            "{redirect}?code=abc&state={0}&state={0}",
            canary("S")
        )),
        Err("state_mismatch")
    );
    assert_eq!(
        code(&format!(
            "{redirect}?code=abc&state={}&error=x",
            canary("S")
        )),
        Err("access_denied")
    );
    assert_eq!(
        code(&format!("{redirect}?state={}", canary("S"))),
        Err("login_failed")
    );
    assert_eq!(
        code(&format!("{redirect}#?code=abc&state={}", canary("S"))),
        Err("login_failed")
    );
    assert_eq!(code(&format!("{ok}#frag")), Err("login_failed"));
    assert_eq!(code(&format!("{ok}#")), Ok("abc".to_owned()));
    assert_eq!(
        code(&ok.replace("127.0.0.1", "localhost")),
        Err("login_failed")
    );
    let long = format!("{redirect}?code={}&state={}", "c".repeat(8193), canary("S"));
    assert_eq!(code(&long), Err("login_failed"));
}

#[test]
fn a_prompt_prints_without_its_url() {
    let p = super::login::DevicePrompt {
        user_code: Secret::new(canary("U")),
        verification_uri: Secret::new("https://x".to_owned()),
        verification_uri_complete: None,
    };
    assert!(!format!("{p:?}").contains("CANARY"));
    let _: Option<AuthorizationPrompt> = None;
}

mod adapters {
    //! The two real adapters of this package: the bridge to the core's secret store and the loopback listener over a real
    //! socket on 127.0.0.1 (no other address, no network beyond this machine).
    use super::super::env::EnvSnapshot;
    use super::super::http::{HttpTransport, OAuthHttp, TransportError, WireRequest, WireResponse};
    use super::super::login::{
        login, AuthorizationPrompt, DevicePrompt, LoginOptions, LoginUi, TcpLoopback,
    };
    use super::super::ports::{OsRandom, PortFailure};
    use super::super::profile::validate_profile;
    use super::super::record::{OAuthRecord, SecretStore as _, SecretsBridge};
    use super::super::secret::Secret;
    use super::super::testing::{FakeClock, MemStore, World};
    use super::canary;
    use crate::identity::codes::RandomSource;
    use crate::logs::redact::SecretSet;
    use crate::secrets::error::SecretError;
    use crate::secrets::memory_backend::MemoryBackend;
    use crate::secrets::store::{AuditEvent, AuditSink, StartupOptions};
    use crate::secrets::{SecretStore, SecretStoreOptions};
    use serde_json::json;
    use std::io::{Read, Write};
    use std::sync::Arc;

    struct NoAudit;
    impl AuditSink for NoAudit {
        fn record(&mut self, _event: &AuditEvent) -> Result<(), SecretError> {
            Ok(())
        }
    }
    struct Counter(u8);
    impl RandomSource for Counter {
        fn random_int(&mut self, _max: u32) -> u32 {
            0
        }
        fn fill_bytes(&mut self, out: &mut [u8]) {
            self.0 = self.0.wrapping_add(1);
            out.fill(self.0);
        }
    }

    #[test]
    fn the_bridge_reads_through_a_revoked_core_lease_and_writes_as_owner() {
        let service = SecretStore::new(SecretStoreOptions {
            keyring: Box::new(MemoryBackend::new(true)),
            file: Box::new(MemoryBackend::new(false)),
            file_fallback: Box::new(|| false),
            audit: Box::new(NoAudit),
            clock: Arc::new(|| 1_767_323_045_678),
            monotonic: Box::new(|| 0.0),
            random: Box::new(Counter(0)),
            logger: None,
            redaction: Arc::new(SecretSet::new()),
            startup: StartupOptions::default(),
        });
        let bridge = SecretsBridge::new(&service);
        assert!(
            bridge.get("auth.test").unwrap().is_none(),
            "nothing stored is None, not an error"
        );
        let mut rec = OAuthRecord::new(Secret::new(canary("ACCESS-bridge")), 0.0);
        rec.refresh_token = Some(Secret::new(canary("REFRESH-bridge")));
        bridge.set("auth.test", &rec.encode()).unwrap();
        let back = bridge.get("auth.test").unwrap().unwrap();
        assert_eq!(back.expose(), rec.encode().expose());
        let core = crate::secrets::SecretPrincipal::Core;
        assert!(
            service.active_leases(&core).unwrap().is_empty(),
            "the read lease is revoked at once"
        );
        bridge.delete("auth.test").unwrap();
        bridge.delete("auth.test").unwrap();
        assert!(bridge.get("auth.test").unwrap().is_none());
    }

    struct AnyToken;
    impl HttpTransport for AnyToken {
        fn send(&self, r: &WireRequest) -> Result<WireResponse, TransportError> {
            assert!(r.body.expose().contains("grant_type=authorization_code"));
            Ok(WireResponse {
                status: 200,
                headers: vec![],
                body: json!({ "access_token": canary("ACCESS-real"), "token_type": "Bearer", "expires_in": 60 })
                    .to_string()
                    .into_bytes(),
            })
        }
    }

    /// Plays the browser: one forged callback, then the genuine one, over real connections.
    type Seen = (u16, String, String);
    struct Browser(std::sync::Mutex<Option<std::thread::JoinHandle<Seen>>>);
    impl Browser {
        fn hit(port: u16, target: &str) -> String {
            let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            write!(
                s,
                "GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            let mut out = String::new();
            s.read_to_string(&mut out).unwrap();
            out
        }
    }
    impl LoginUi for Browser {
        fn open_browser(&self, url: &Secret) -> Option<Result<(), PortFailure>> {
            let u = url::Url::parse(url.expose()).unwrap();
            let q = |k: &str| {
                u.query_pairs()
                    .find(|(x, _)| x == k)
                    .unwrap()
                    .1
                    .into_owned()
            };
            let redirect = url::Url::parse(&q("redirect_uri")).unwrap();
            assert_eq!(redirect.host_str(), Some("127.0.0.1"));
            let port = redirect.port().unwrap();
            let state = q("state");
            *self.0.lock().unwrap() = Some(std::thread::spawn(move || {
                let forged = Browser::hit(port, "/auth/callback?code=x&state=forged");
                let genuine = Browser::hit(port, &format!("/auth/callback?code=c&state={state}"));
                (port, forged, genuine)
            }));
            Some(Ok(()))
        }
        fn on_authorization(&self, _p: &AuthorizationPrompt) -> Option<Result<(), PortFailure>> {
            None
        }
        fn has_read_callback(&self) -> bool {
            false
        }
        fn read_callback(&self, _p: &AuthorizationPrompt) -> Option<Result<Secret, PortFailure>> {
            None
        }
        fn on_device(&self, _p: &DevicePrompt) -> Option<Result<(), PortFailure>> {
            None
        }
        fn sleep(&self, _ms: f64) -> Result<(), PortFailure> {
            Ok(())
        }
    }

    #[test]
    fn a_real_loopback_login_refuses_a_forgery_and_completes_on_the_genuine_callback() {
        let world = World::new(
            &json!({ "allowHosts": ["idp.example.test"], "allowPorts": [443], "allowLoopback": false }),
            &json!({}),
            "93.184.216.34",
        );
        let egress = world.egress();
        let http = OAuthHttp::new(&egress, &AnyToken, None, None);
        let profile = validate_profile(&json!({
            "id": "test:oauth", "display_name": "Test", "kind": "oauth_pkce", "capabilities": ["chat"],
            "auth_header_scheme": "Authorization: Bearer {token}", "authorizeUrl": "https://idp.example.test/authorize",
            "tokenUrl": "https://idp.example.test/token", "client_id": "test-harness-client", "secret_ref": "auth/test",
            "policy_status": "allowed", "policy_source": "https://example.test/p", "policy_checked": "2026-10-07",
        }))
        .unwrap();
        let store = MemStore::default();
        let clock = FakeClock::at(1_000_000_000_000.0);
        let env = EnvSnapshot {
            platform: "darwin".into(),
            stdout_is_tty: true,
            ..EnvSnapshot::default()
        };
        let browser = Browser(std::sync::Mutex::new(None));
        let mut listener = TcpLoopback::new();
        let result = login(LoginOptions {
            profile: &profile,
            store: &store,
            clock: &clock,
            http: &http,
            env: &env,
            paste_callback: false,
            method: None,
            secret_ref: None,
            timeout_ms: Some(600_000.0),
            ui: &browser,
            listener: &mut listener,
            random: &OsRandom,
            log: None,
        })
        .unwrap();
        assert_eq!(result.expires_at, Some(1_000_000_060_000.0));
        let stored = store.read("auth/test").unwrap();
        assert!(stored.contains(&canary("ACCESS-real")));
        let (port, forged, genuine) = browser.0.lock().unwrap().take().unwrap().join().unwrap();
        assert!(forged.starts_with("HTTP/1.1 400"), "{forged}");
        assert!(
            !forged.contains("forged"),
            "nothing of the request is echoed"
        );
        assert!(genuine.starts_with("HTTP/1.1 200"), "{genuine}");
        assert!(
            genuine.contains("cache-control: no-store")
                && genuine.contains("content-security-policy: default-src 'none'")
        );
        // The listener is gone: the port refuses a late callback.
        assert!(
            std::net::TcpStream::connect(("127.0.0.1", port)).is_err(),
            "the one-shot listener closed"
        );
    }
}
