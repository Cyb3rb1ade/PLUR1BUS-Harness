#![allow(clippy::unwrap_used, reason = "wire fixture assertions")]

use plur1bus_voice_providers::{
    http::{Client, Error, Ports},
    polly::{Request, SignedRequests},
    registry::{Capability, Config, Credentials, ProviderConfig, Registry},
};
use plur1bus_wire_fixtures::FakeServer;
use serde_json::{json, Value};
use std::{
    cell::{Cell, RefCell},
    io::{Cursor, Read},
    net::SocketAddr,
    time::{Duration, Instant},
};
use url::Url;

const CREDENTIAL: &str = "synthetic-voice-credential";

struct Host {
    addr: SocketAddr,
    references: RefCell<Vec<String>>,
}

impl Ports for Host {
    fn wall_time(&self) -> std::time::SystemTime {
        std::time::UNIX_EPOCH
    }

    fn pin(&self, _: &Url, _: Instant) -> Option<SocketAddr> {
        Some(self.addr)
    }
}

impl Credentials for Host {
    fn resolve(&self, reference: &str, _: Instant) -> Result<Option<String>, Error> {
        self.references.borrow_mut().push(reference.into());
        if reference == "gemini-fixture" {
            Err(Error::Network)
        } else {
            Ok(Some(CREDENTIAL.into()))
        }
    }
}

impl SignedRequests for Host {
    fn synthesize(&self, _: &Request<'_>, _: Instant) -> Result<Box<dyn Read>, Error> {
        Err(Error::Unsupported)
    }

    fn describe_voices(&self, _: Option<&str>, _: Instant) -> Result<Box<dyn Read>, Error> {
        let body = json!({"Voices":[{"Id":"polly-fixture","SupportedEngines":["neural"]}]});
        Ok(Box::new(Cursor::new(body.to_string().into_bytes())))
    }
}

#[test]
fn discovery_matches_typescript_registration_order_and_preserves_partial_success() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/voice/registry.json")).unwrap();
    let server = FakeServer::start(&fixture);
    let host = Host {
        addr: server.addr,
        references: RefCell::default(),
    };
    let base = Url::parse(&format!("http://{}/v1", server.addr)).unwrap();
    let config = Config {
        elevenlabs: ProviderConfig {
            enabled: true,
            api_key_ref: Some("eleven-fixture"),
            base: Some(base.clone()),
        },
        elevenlabs_stt_model: Some("scribe_fixture"),
        xai: ProviderConfig {
            enabled: true,
            ..ProviderConfig::default()
        },
        gemini: ProviderConfig {
            enabled: true,
            api_key_ref: Some("gemini-fixture"),
            base: Some(base),
        },
        polly_enabled: true,
        ..Config::default()
    };
    let registry = Registry::new(
        config,
        Client::new(&host).with_loopback_http(),
        &host,
        Some(&host),
    );
    assert_eq!(json!(registry.status()), fixture["status"]);
    assert!(host.references.borrow().is_empty());
    let known = [
        (Capability::Asr, "elevenlabs"),
        (Capability::Tts, "polly"),
        (Capability::Realtime, "gemini"),
        (Capability::Realtime, "xai"),
        (Capability::Tts, "gemini"),
        (Capability::Asr, "constructor"),
    ]
    .map(|(kind, id)| registry.contains(kind, id));
    assert_eq!(json!(known), fixture["known"]);
    let result = registry.discover(Duration::from_secs(5));
    assert_eq!(json!(result), fixture["expected"]);
    assert_eq!(json!(*host.references.borrow()), fixture["references"]);
    let requests = server.received();
    let exchanges = fixture["exchanges"].as_array().unwrap();
    assert_eq!(requests.len(), exchanges.len());
    for (actual, exchange) in requests.iter().zip(exchanges) {
        assert_eq!(actual["method"], exchange["request"]["method"]);
        assert_eq!(actual["path"], exchange["request"]["path"]);
        assert_eq!(actual["headers"]["xi-api-key"], CREDENTIAL);
    }
}

#[test]
fn disabled_cloud_skips_credentials_and_transport() {
    let host = Host {
        addr: "127.0.0.1:1".parse().unwrap(),
        references: RefCell::default(),
    };
    let registry = Registry::new(Config::default(), Client::new(&host), &host, None);
    assert_eq!(
        json!(registry.discover(Duration::ZERO)),
        json!({
            "models": [], "voices": [], "errors": [],
        })
    );
    assert!(host.references.borrow().is_empty());
}

#[test]
fn credential_resolution_obeys_deadline_cancellation_and_header_validation() {
    struct CredentialProbe {
        response: Result<Option<String>, Error>,
        cancel_on_resolve: bool,
        cancelled: Cell<bool>,
        resolved: Cell<bool>,
        pinned: Cell<bool>,
    }

    impl Ports for CredentialProbe {
        fn wall_time(&self) -> std::time::SystemTime {
            std::time::UNIX_EPOCH
        }

        fn pin(&self, _: &Url, _: Instant) -> Option<SocketAddr> {
            self.pinned.set(true);
            None
        }

        fn cancelled(&self) -> bool {
            self.cancelled.get()
        }
    }

    impl Credentials for CredentialProbe {
        fn resolve(&self, _: &str, _: Instant) -> Result<Option<String>, Error> {
            self.resolved.set(true);
            self.cancelled.set(self.cancel_on_resolve);
            self.response.clone()
        }
    }

    let live = Duration::from_secs(5);
    for (response, cancel, budget, resolved, error) in [
        (
            Ok(Some(CREDENTIAL.into())),
            false,
            Duration::ZERO,
            false,
            "timeout",
        ),
        (Err(Error::Network), true, live, true, "aborted"),
        (Ok(None), false, live, true, "auth"),
        (
            Ok(Some(format!("{CREDENTIAL}\u{7f}"))),
            false,
            live,
            true,
            "auth",
        ),
    ] {
        let host = CredentialProbe {
            response,
            cancel_on_resolve: cancel,
            cancelled: Cell::new(false),
            resolved: Cell::new(false),
            pinned: Cell::new(false),
        };
        let config = Config {
            xai: ProviderConfig {
                enabled: true,
                api_key_ref: Some("fixture"),
                base: None,
            },
            ..Config::default()
        };
        let registry = Registry::new(config, Client::new(&host), &host, None);
        let result = registry.discover(budget);
        assert!(!host.pinned.get());
        assert_eq!(host.resolved.get(), resolved);
        assert_eq!(
            json!(result.errors),
            json!([{"provider":"xai","kind":"realtime","code":error}])
        );
    }
}
