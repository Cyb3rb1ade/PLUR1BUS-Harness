#![allow(clippy::unwrap_used, reason = "synthetic OAuth fixture")]

use std::{
    net::SocketAddr,
    sync::Mutex,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use plur1bus_mcp::{
    auth::{Authorization, Callback, Client, Clock, Entropy, Error, Interaction, Prompt},
    http,
};
use plur1bus_wire_fixtures::FakeServer;
use serde_json::json;
use sha2::{Digest, Sha256};
use url::Url;

struct Pin(SocketAddr);
impl http::Admission for Pin {
    fn pin(&self, _: &Url, _: Instant) -> Result<SocketAddr, http::Error> {
        Ok(self.0)
    }
}

#[derive(Default)]
struct TestHost(Mutex<Vec<String>>);
impl Clock for TestHost {
    fn now_ms(&self) -> u64 {
        1_000
    }
}
impl Entropy for TestHost {
    fn verifier(&self) -> Result<[u8; 32], Error> {
        Ok([13; 32])
    }
    fn state(&self) -> Result<[u8; 32], Error> {
        Ok([37; 32])
    }
    fn protect(&self, value: &str) {
        self.0.lock().unwrap().push(value.to_owned());
    }
}

struct Human {
    wrong_state: bool,
    issuer: String,
}
impl Interaction for Human {
    fn approve(&self, prompt: &Prompt, _: Instant) -> Result<Callback, Error> {
        let params: std::collections::HashMap<_, _> =
            prompt.authorization_url().query_pairs().collect();
        let verifier = URL_SAFE_NO_PAD.encode([13; 32]);
        assert_eq!(params["code_challenge_method"], "S256");
        assert_eq!(
            params["code_challenge"],
            URL_SAFE_NO_PAD.encode(Sha256::digest(verifier))
        );
        assert!(!params.contains_key("code_verifier"));
        assert_eq!(params["scope"], "profile read");
        let state = if self.wrong_state {
            "incorrect-state".to_owned()
        } else {
            params["state"].to_string()
        };
        Ok(Callback::new(
            "<fixture-code>".into(),
            state,
            Some(self.issuer.clone()),
        ))
    }
}

#[test]
fn explicit_pkce_posts_the_bound_code_and_keeps_tokens_private() {
    for wrong_state in [false, true] {
        let exchanges = if wrong_state { 2 } else { 3 };
        let mut fixture = json!({"transport":"http","exchanges":[
            {"request":{"method":"GET","path":"/.well-known/oauth-protected-resource/mcp"},
             "response":{"status":200, "body":{"resource":"http://127.0.0.1:{port}/mcp",
                "authorization_servers":["http://127.0.0.1:{port}/issuer"]}}},
            {"request":{"method":"GET","path":"/.well-known/oauth-authorization-server/issuer"},
             "response":{"status":200,"body":{"issuer":"http://127.0.0.1:{port}/issuer",
                "authorization_endpoint":"http://127.0.0.1:{port}/authorize",
                "token_endpoint":"http://127.0.0.1:{port}/token",
                "code_challenge_methods_supported":["S256"],
                "authorization_response_iss_parameter_supported":true}}},
            {"request":{"method":"POST","path":"/token"},
             "response":{"status":200,"body":{"token_type":"Bearer",
                "access_token":"<fixture-access>","refresh_token":"<fixture-refresh>","expires_in":60}}}
        ]});
        fixture["exchanges"]
            .as_array_mut()
            .unwrap()
            .truncate(exchanges);
        let server = FakeServer::start_with(|addr| {
            serde_json::from_str(
                &fixture
                    .to_string()
                    .replace("{port}", &addr.port().to_string()),
            )
            .unwrap()
        });
        let base = format!("http://{}", server.addr);
        let resource = format!("{base}/mcp");
        let host = TestHost::default();
        let pin = Pin(server.addr);
        let client = Client::new(
            &resource,
            "fixture-public-client",
            "http://127.0.0.1:7081/callback",
            &pin,
        )
        .unwrap();
        let human = Human {
            wrong_state,
            issuer: format!("{base}/issuer"),
        };
        let result = client.authorize(
            Authorization::Pkce {
                metadata: None,
                scope: Some("read profile"),
            },
            &host,
            &host,
            &human,
            Instant::now() + Duration::from_secs(3),
        );
        if wrong_state {
            assert!(matches!(result, Err(Error::Callback)));
        } else {
            let tokens = result.unwrap();
            assert_eq!(
                tokens.access_for(&resource, 1_000),
                Some("<fixture-access>")
            );
            assert!(tokens.access_for(&format!("{base}/other"), 1_000).is_none());
            assert!(tokens.access_for(&resource, 56_001).is_none());
            assert!(!format!("{tokens:?}").contains("<fixture-access>"));
            let protected = host.0.lock().unwrap();
            for value in ["<fixture-code>", "<fixture-access>", "<fixture-refresh>"] {
                assert!(protected.iter().any(|item| item == value));
            }
        }
        let received = server.received();
        assert_eq!(received.len(), exchanges);
        for request in &received {
            assert!(request["headers"]["authorization"].is_null());
            assert!(request["headers"]["cookie"].is_null());
        }
    }
}

struct DeviceHost {
    now: std::sync::atomic::AtomicU64,
    waits: Mutex<Vec<u64>>,
    prompt: Mutex<Option<serde_json::Value>>,
}

impl Clock for DeviceHost {
    fn now_ms(&self) -> u64 {
        self.now.load(std::sync::atomic::Ordering::Relaxed)
    }
}

impl Interaction for DeviceHost {
    fn approve(&self, _: &Prompt, _: Instant) -> Result<Callback, Error> {
        Err(Error::Interaction)
    }

    fn show_device(
        &self,
        prompt: &plur1bus_mcp::auth::DevicePrompt,
        _: Instant,
    ) -> Result<(), Error> {
        let mut verification = prompt.verification_uri().clone();
        verification
            .set_port(None)
            .unwrap_or_else(|()| unreachable!());
        *self.prompt.lock().unwrap() = Some(json!({
            "verification": format!("{{origin}}{}", verification.path()),
            "userCode": prompt.user_code(),
        }));
        Ok(())
    }

    fn wait(&self, delay_ms: u64, _: Instant) -> Result<(), Error> {
        self.waits.lock().unwrap().push(delay_ms);
        self.now
            .fetch_add(delay_ms, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }
}

#[test]
fn rust_oauth_replays_typescript_forms_refresh_and_device_backoff() {
    use base64::engine::general_purpose::STANDARD;
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/mcp/auth.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let peer = FakeServer::start_with(|addr| {
            serde_json::from_str(
                &case
                    .to_string()
                    .replace("{origin}", &format!("http://{addr}")),
            )
            .unwrap()
        });
        let origin = format!("http://{}", peer.addr);
        let resource = format!("{origin}/mcp");
        let secrets = TestHost::default();
        let pin = Pin(peer.addr);
        let client = Client::new(
            &resource,
            "fixture-public-client",
            "http://127.0.0.1:7081/callback",
            &pin,
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        if case["mode"] == "pkce" {
            let human = Human {
                wrong_state: false,
                issuer: format!("{origin}/issuer"),
            };
            let tokens = client
                .authorize(
                    Authorization::Pkce {
                        metadata: None,
                        scope: Some("read profile"),
                    },
                    &secrets,
                    &secrets,
                    &human,
                    deadline,
                )
                .unwrap();
            assert!(tokens.access_for(&resource, secrets.now_ms()).is_none());
            let refreshed = client
                .refresh(&tokens, &secrets, &secrets, deadline)
                .unwrap();
            assert_eq!(
                refreshed.access_for(&resource, secrets.now_ms()),
                Some("<fixture-renewed-access>")
            );
            assert!(secrets
                .0
                .lock()
                .unwrap()
                .iter()
                .any(|value| value == "<fixture-renewed-access>"));
        } else {
            let host = DeviceHost {
                now: std::sync::atomic::AtomicU64::new(1_000),
                waits: Mutex::default(),
                prompt: Mutex::default(),
            };
            let tokens = client
                .authorize(
                    Authorization::Device {
                        metadata: None,
                        scope: Some("read profile"),
                    },
                    &host,
                    &secrets,
                    &host,
                    deadline,
                )
                .unwrap();
            assert_eq!(
                tokens.access_for(&resource, host.now_ms()),
                Some("<fixture-access>")
            );
            assert_eq!(
                json!(*host.waits.lock().unwrap()),
                case["observed"]["waits"]
            );
            assert_eq!(
                *host.prompt.lock().unwrap(),
                Some(case["observed"]["presented"].clone())
            );
        }
        let seen = peer.received();
        let expected = case["exchanges"].as_array().unwrap();
        assert_eq!(seen.len(), expected.len());
        for (actual, row) in seen.iter().zip(expected) {
            let request = &row["request"];
            assert_eq!(actual["method"], request["method"]);
            assert_eq!(actual["path"], request["path"]);
            let bytes = STANDARD
                .decode(actual["bodyBase64"].as_str().unwrap())
                .unwrap();
            let fields = url::form_urlencoded::parse(&bytes).map(|(key, value)| {
                let value = match key.as_ref() {
                    "resource" => value.replace(&origin, "{origin}"),
                    "code_verifier" => {
                        assert_eq!(value, URL_SAFE_NO_PAD.encode([13; 32]));
                        "<verifier>".to_owned()
                    }
                    _ => value.into_owned(),
                };
                (key.into_owned(), value)
            });
            let form = url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs(fields)
                .finish();
            assert_eq!(form, request["form"]);
            for name in ["authorization", "proxy-authorization", "cookie"] {
                assert!(actual["headers"][name].is_null());
            }
        }
    }
}
