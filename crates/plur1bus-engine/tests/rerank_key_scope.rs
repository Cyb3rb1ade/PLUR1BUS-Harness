//! RX9/T9a: rerank credential scope (host x secret source x provider value) without external networking.
//!
//! Counterpart of `provider_key_scope.rs` for the reranker. Node pin 9f34008c (`lib/providers/reranker-remote.js`,
//! `lib/providers/config-normalize.js`): an explicit `apiKeyRef` (host secret) wins over `apiKeyEnv`, which wins over
//! the preset default name (`COHERE_API_KEY`, `JINA_API_KEY`, `VOYAGE_API_KEY`); `remote` has no default and runs
//! keyless. An unknown provider normalizes to `disabled` without an error. A credential goes only to the configured
//! endpoint; a cross-origin redirect drops it. Secret values are never read from the process environment here: the
//! `apiKeyEnv` value is a host secret NAME (documented in `Credential::new`).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use plur1bus_engine::contract::{
    AddressRules, AgentId, Cancel, Decision, EgressGate, EngineConfig, HostError, HostServices,
    JournalBacklog, LlmPort, PlatformCapabilities, SecretPort, SecretValue, Target,
};
use plur1bus_engine::embedding::rerank::remote::RemoteReranker;
use plur1bus_engine::embedding::{build_reranker_owned, Reranker};
use plur1bus_engine::transport::{GuardedClient, Resolver, TransportError};
use serde_json::{json, Value};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[path = "support/http_stub.rs"]
mod http_stub;
use http_stub::Stub;

/// Value handed out for a secret name; the name inside makes a misdirected credential attributable.
fn value_for(name: &str) -> String {
    format!("test-only-credential-for-{name}")
}

#[derive(Default)]
struct Names(Mutex<Vec<String>>);
impl SecretPort for Names {
    fn get(&self, name: &str) -> Result<Option<SecretValue>, HostError> {
        self.0.lock().unwrap().push(name.into());
        Ok(Some(SecretValue::new(value_for(name))))
    }
}
struct SharedNames(Arc<Names>);
impl SecretPort for SharedNames {
    fn get(&self, name: &str) -> Result<Option<SecretValue>, HostError> {
        self.0.get(name)
    }
}

/// Records every egress target and refuses it, so no DNS lookup or socket ever happens.
#[derive(Default)]
struct DenyAndRecord(Mutex<Vec<String>>);
impl EgressGate for DenyAndRecord {
    fn decide(&self, target: &Target) -> Decision {
        self.0.lock().unwrap().push(target.host.clone());
        Decision::Deny {
            reason: "fixture forbids networking".into(),
        }
    }
}

struct MatrixHost {
    state: PathBuf,
    secrets: Names,
    gate: DenyAndRecord,
    platform: PlatformCapabilities,
}
impl MatrixHost {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            state: std::env::temp_dir(),
            secrets: Names::default(),
            gate: DenyAndRecord::default(),
            platform: PlatformCapabilities::default(),
        })
    }
}
impl HostServices for MatrixHost {
    fn state_dir(&self) -> &Path {
        &self.state
    }
    fn config(&self) -> EngineConfig {
        serde_json::from_value(json!({})).unwrap()
    }
    fn workspace_dir(&self, _: &AgentId) -> Result<Option<PathBuf>, HostError> {
        Ok(None)
    }
    fn llm(&self) -> Option<&dyn LlmPort> {
        None
    }
    fn secrets(&self) -> Option<&dyn SecretPort> {
        Some(&self.secrets)
    }
    fn egress(&self) -> &dyn EgressGate {
        &self.gate
    }
    fn emit(&self, _: &str, _: Value) {}
    fn now_ms(&self) -> i64 {
        0
    }
    fn platform(&self) -> &PlatformCapabilities {
        &self.platform
    }
    fn journal_backlog(&self) -> Option<JournalBacklog> {
        None
    }
}

struct Gate;
impl EgressGate for Gate {
    fn decide(&self, _: &Target) -> Decision {
        Decision::Allow {
            address_rules: AddressRules {
                allow_loopback: true,
                ..AddressRules::default()
            },
        }
    }
}
struct Local;
impl Resolver for Local {
    fn resolve(&self, _: &str, _: u16, _: Instant) -> Result<Vec<IpAddr>, TransportError> {
        Ok(vec!["127.0.0.1".parse().unwrap()])
    }
}
fn loopback_client() -> Arc<GuardedClient<'static>> {
    Arc::new(GuardedClient::new_owned(Arc::new(Gate), Box::new(Local)))
}

/// (provider value, implicit secret name, default host of the preset)
const PROVIDERS: [(&str, Option<&str>, Option<&str>); 4] = [
    ("cohere", Some("COHERE_API_KEY"), Some("api.cohere.com")),
    ("jina", Some("JINA_API_KEY"), Some("api.jina.ai")),
    ("voyage", Some("VOYAGE_API_KEY"), Some("api.voyageai.com")),
    ("remote", None, None),
];
const REF: &str = "host/rerank-secret";
const ENV: &str = "RERANK_KEY_NAME";

#[derive(Clone, Copy, Debug)]
enum Source {
    Implicit,
    ApiKeyEnv,
    ApiKeyRef,
    RefAndEnv,
}
const SOURCES: [Source; 4] = [
    Source::Implicit,
    Source::ApiKeyEnv,
    Source::ApiKeyRef,
    Source::RefAndEnv,
];
impl Source {
    fn apply(self, config: &mut Value) {
        match self {
            Self::Implicit => {}
            Self::ApiKeyEnv => config["apiKeyEnv"] = json!(ENV),
            Self::ApiKeyRef => config["apiKeyRef"] = json!(REF),
            Self::RefAndEnv => {
                config["apiKeyRef"] = json!(REF);
                config["apiKeyEnv"] = json!(ENV);
            }
        }
    }
    /// Secret name the pin resolves first for this source (`None`: no secret lookup at all).
    fn expected(self, implicit: Option<&'static str>) -> Option<&'static str> {
        match self {
            Self::Implicit => implicit,
            Self::ApiKeyEnv => Some(ENV),
            Self::ApiKeyRef | Self::RefAndEnv => Some(REF),
        }
    }
}

fn engine_config(reranker: &Value) -> EngineConfig {
    serde_json::from_value(json!({ "reranker": reranker })).unwrap()
}

/// Build through the production factory, run one rerank against a refusing gate, and report what was touched.
fn probe(reranker: &Value) -> (bool, Vec<String>, Vec<String>) {
    let host = MatrixHost::new();
    let built = build_reranker_owned(&engine_config(reranker), host.clone()).unwrap();
    let present = built.is_some();
    if let Some(provider) = built {
        // The chain turns a refused hop into an empty, not-authoritative result (no fallback configured).
        assert!(provider
            .rerank("q", &["doc".into()], 1, &Cancel::never())
            .unwrap_or_default()
            .is_empty());
    }
    let names = host.secrets.0.lock().unwrap().clone();
    let targets = host.gate.0.lock().unwrap().clone();
    (present, names, targets)
}

#[test]
fn rerank_secret_name_follows_the_source_precedence_for_every_provider_and_host() {
    for (provider, implicit, default_host) in PROVIDERS {
        for endpoint in [
            None,
            Some(("https://gateway.example/v1", "gateway.example")),
            Some((
                "https://api.cohere.com.example/v2",
                "api.cohere.com.example",
            )),
            Some(("https://notapi.jina.ai/v1", "notapi.jina.ai")),
            Some(("http://localhost:8090/v1", "localhost")),
        ] {
            // `remote` has no preset endpoint; the Node pin refuses it without a baseUrl.
            let Some((expected_host, base_url)) = endpoint
                .map(|(url, host)| (host, Some(url)))
                .or(default_host.map(|host| (host, None)))
            else {
                continue;
            };
            for source in SOURCES {
                let mut reranker = json!({"provider": provider});
                if let Some(url) = base_url {
                    reranker["baseUrl"] = json!(url);
                }
                source.apply(&mut reranker);
                let expected = source.expected(implicit);
                let (present, names, targets) = probe(&reranker);
                let case = format!("{provider}, {endpoint:?}, {source:?}");
                // Presets without any credential are disabled (pin: `enabled: !requiresKey || hasCredential`).
                if matches!(source, Source::Implicit) && implicit.is_some() {
                    assert!(!present, "{case}");
                    assert!(names.is_empty() && targets.is_empty(), "{case}");
                    continue;
                }
                assert!(present, "{case}");
                assert_eq!(names.first().map(String::as_str), expected, "{case}");
                assert!(names.len() <= 1, "{case}: {names:?}");
                // The request goes to the configured origin and nowhere else.
                assert_eq!(targets, vec![expected_host.to_owned()], "{case}");
            }
        }
    }
}

#[test]
fn the_preset_default_secret_name_is_used_only_when_the_provider_is_a_preset() {
    // Library level: a preset without explicit names still resolves its default name, `remote` resolves nothing.
    for (provider, implicit, default_host) in PROVIDERS {
        let names = Arc::new(Names::default());
        let gate = Arc::new(DenyAndRecord::default());
        struct Forward(Arc<DenyAndRecord>);
        impl EgressGate for Forward {
            fn decide(&self, target: &Target) -> Decision {
                self.0.decide(target)
            }
        }
        let client = Arc::new(GuardedClient::new_owned(
            Arc::new(Forward(gate.clone())),
            Box::new(Local),
        ));
        let mut config = json!({"provider": provider});
        if default_host.is_none() {
            config["baseUrl"] = json!("https://gateway.example/v1");
        }
        let reranker =
            RemoteReranker::new_owned(&config, client, Some(Arc::new(SharedNames(names.clone()))))
                .unwrap();
        assert!(reranker
            .rerank("q", &["doc".into()], 1, &Cancel::never())
            .is_err());
        let got = names.0.lock().unwrap().clone();
        assert_eq!(
            got.iter().map(String::as_str).collect::<Vec<_>>(),
            implicit.into_iter().collect::<Vec<_>>(),
            "{provider}"
        );
        assert_eq!(gate.0.lock().unwrap().len(), 1, "{provider}");
    }
}

#[test]
fn an_unknown_reranker_provider_is_refused_by_the_typed_config_like_the_pin_schema() {
    // The pin's plugin manifest (reranker.provider enum: cohere, jina, voyage, remote, local-transformers,
    // disabled) refuses every other value, including the empty string and case variants, before any provider is
    // built. Below that schema, `normalizeRerankerConfig` would map an unknown name to `disabled`; Rust's
    // `reranker_configuration` does the same with `Ok(None)` (`src/embedding/mod.rs:334-337`), but that branch is not
    // reachable through a typed `EngineConfig`, exactly as it is not through the pin's schema.
    for provider in [
        "opneai", "Cohere", "COHERE", "openai", "tei", "local", "", " cohere", "cohere ",
    ] {
        let parsed = serde_json::from_value::<EngineConfig>(json!({"reranker":{
            "provider": provider,
            "baseUrl": "https://gateway.example/v1",
            "apiKeyRef": REF,
            "apiKeyEnv": ENV
        }}));
        assert!(parsed.is_err(), "{provider:?}");
    }
}

#[test]
fn the_disabled_provider_builds_nothing_and_touches_no_secret_or_host() {
    let reranker = json!({
        "provider": "disabled",
        "baseUrl": "https://gateway.example/v1",
        "apiKeyRef": REF,
        "apiKeyEnv": ENV
    });
    let (present, names, targets) = probe(&reranker);
    assert!(!present && names.is_empty() && targets.is_empty());
    let (present, names, targets) =
        probe(&json!({"enabled": false, "provider": "cohere", "apiKeyRef": REF}));
    assert!(!present && names.is_empty() && targets.is_empty());
}

#[test]
fn an_omitted_provider_infers_cohere_from_a_credential_and_remote_from_a_base_url() {
    // Pin: `raw.provider || (credential ? "cohere" : baseUrl ? "remote" : "disabled")`.
    for credential in [json!({"apiKeyRef": REF}), json!({"apiKeyEnv": ENV})] {
        let (present, names, targets) = probe(&credential);
        assert!(present);
        assert_eq!(names.len(), 1);
        assert_eq!(targets, vec!["api.cohere.com"]);
    }
    let (present, names, targets) = probe(&json!({"baseUrl": "https://gateway.example/v1"}));
    assert!(present);
    assert!(names.is_empty());
    assert_eq!(targets, vec!["gateway.example"]);
    let (present, names, targets) = probe(&json!({}));
    assert!(!present && names.is_empty() && targets.is_empty());
}

/// Header block of a recorded request, lower-cased for case-insensitive matching.
fn head(request: &str) -> String {
    request
        .split_once("\r\n\r\n")
        .map_or(request, |(head, _)| head)
        .to_ascii_lowercase()
}

#[test]
fn the_credential_reaches_only_the_configured_origin_with_the_expected_value() {
    let ok = r#"{"results":[{"index":0,"score":0.7}]}"#;
    for (provider, implicit, _) in PROVIDERS {
        for source in SOURCES {
            let configured = Stub::new(200, "", ok, Duration::ZERO);
            let bystander = Stub::new(200, "", ok, Duration::ZERO);
            let mut config =
                json!({"provider": provider, "baseUrl": configured.loopback_url("/v1")});
            source.apply(&mut config);
            let reranker = RemoteReranker::new_owned(
                &config,
                loopback_client(),
                Some(Arc::new(Names::default())),
            )
            .unwrap();
            reranker
                .rerank("q", &["doc".into()], 1, &Cancel::never())
                .unwrap();
            let case = format!("{provider}, {source:?}");
            let requests = configured.requests.lock().unwrap();
            assert_eq!(requests.len(), 1, "{case}");
            let sent = head(&requests[0]);
            match source.expected(implicit) {
                Some(name) => {
                    assert!(
                        sent.contains(&format!(
                            "authorization: bearer {}",
                            value_for(name).to_ascii_lowercase()
                        )),
                        "{case}"
                    );
                    // No other name's value is ever sent, in particular not the lower-precedence one.
                    for other in [REF, ENV, "COHERE_API_KEY", "JINA_API_KEY", "VOYAGE_API_KEY"] {
                        if other != name {
                            assert!(
                                !sent.contains(&value_for(other).to_ascii_lowercase()),
                                "{case}: {other}"
                            );
                        }
                    }
                }
                None => assert!(!sent.contains("authorization:"), "{case}"),
            }
            assert!(bystander.requests.lock().unwrap().is_empty(), "{case}");
        }
    }
}

#[test]
fn two_rerankers_never_share_a_credential_across_origins() {
    let ok = r#"{"results":[{"index":0,"score":0.7}]}"#;
    let first = Stub::new(200, "", ok, Duration::ZERO);
    let second = Stub::new(200, "", ok, Duration::ZERO);
    let secrets: Arc<dyn SecretPort> = Arc::new(Names::default());
    let make = |stub: &Stub, name: &str| {
        RemoteReranker::new_owned(
            &json!({"provider":"remote","baseUrl":stub.loopback_url("/"),"apiKeyRef":name}),
            loopback_client(),
            Some(secrets.clone()),
        )
        .unwrap()
    };
    let (one, two) = (make(&first, "host/first"), make(&second, "host/second"));
    for provider in [&two, &one, &two, &one] {
        provider
            .rerank("q", &["doc".into()], 1, &Cancel::never())
            .unwrap();
    }
    for (stub, mine, theirs) in [
        (&first, "host/first", "host/second"),
        (&second, "host/second", "host/first"),
    ] {
        for request in stub.requests.lock().unwrap().iter() {
            let sent = head(request);
            assert!(sent.contains(&value_for(mine).to_ascii_lowercase()));
            assert!(!sent.contains(&value_for(theirs).to_ascii_lowercase()));
        }
        assert_eq!(stub.requests.lock().unwrap().len(), 2);
    }
}

#[test]
fn a_redirect_to_another_origin_never_carries_the_credential() {
    for (provider, source) in [
        ("remote", Source::ApiKeyRef),
        ("remote", Source::ApiKeyEnv),
        ("cohere", Source::ApiKeyRef),
        ("jina", Source::Implicit),
        ("voyage", Source::RefAndEnv),
    ] {
        for status in [301, 302, 303, 307, 308] {
            let target = Stub::new(
                200,
                "",
                r#"{"results":[{"index":0,"score":0.7}]}"#,
                Duration::ZERO,
            );
            let redirecting = Stub::new(
                status,
                &format!("Location: {}\r\n", target.loopback_url("/rerank")),
                "",
                Duration::ZERO,
            );
            let mut config =
                json!({"provider": provider, "baseUrl": redirecting.loopback_url("/v1")});
            source.apply(&mut config);
            let reranker = RemoteReranker::new_owned(
                &config,
                loopback_client(),
                Some(Arc::new(Names::default())),
            )
            .unwrap();
            // Whether the redirected request succeeds is the transport's business; the key must not follow it.
            let _ = reranker.rerank("q", &["doc".into()], 1, &Cancel::never());
            let case = format!("{provider}, {source:?}, {status}");
            let first = redirecting.requests.lock().unwrap();
            assert_eq!(first.len(), 1, "{case}");
            assert!(head(&first[0]).contains("authorization: bearer "), "{case}");
            for request in target.requests.lock().unwrap().iter() {
                let sent = head(request);
                assert!(!sent.contains("authorization:"), "{case}");
                assert!(!sent.contains("test-only-credential"), "{case}");
            }
        }
    }
}

#[test]
fn a_credential_is_refused_on_a_plaintext_non_loopback_origin_for_every_source() {
    // The only hosts that may receive a credential over http are loopback hosts (plaintext guard in `GuardedClient`).
    let stub = Stub::new(200, "", "{}", Duration::ZERO);
    for (provider, _, _) in PROVIDERS {
        for source in SOURCES {
            if matches!(source, Source::Implicit) && provider == "remote" {
                continue; // keyless: nothing to protect, covered by the header test above
            }
            let mut config = json!({"provider": provider, "baseUrl": stub.url("/v1")});
            source.apply(&mut config);
            let reranker = RemoteReranker::new_owned(
                &config,
                loopback_client(),
                Some(Arc::new(Names::default())),
            )
            .unwrap();
            assert!(
                reranker
                    .rerank("q", &["doc".into()], 1, &Cancel::never())
                    .is_err(),
                "{provider}, {source:?}"
            );
        }
    }
    assert!(stub.requests.lock().unwrap().is_empty());
}

#[test]
fn a_literal_api_key_in_the_typed_config_only_enables_a_preset_and_selects_its_default_name() {
    // Pin: a literal `apiKey` is itself the bearer value (`resolveApiKey`, priority apiKeyEnv > apiKey > default).
    // Rust never carries a literal: the RPC loader refuses `apiKey` (`secret-in-config`), and below it the field only
    // counts as "a credential is configured" while the secret store is asked for the preset default name. Recorded
    // as it is (T9a report, concern 1): through this library door the default name follows an overridden baseUrl.
    for (provider, name) in [
        ("cohere", "COHERE_API_KEY"),
        ("jina", "JINA_API_KEY"),
        ("voyage", "VOYAGE_API_KEY"),
    ] {
        let (present, names, targets) = probe(&json!({
            "provider": provider,
            "apiKey": "unused-placeholder",
            "baseUrl": "https://gateway.example/v1"
        }));
        assert!(present, "{provider}");
        assert_eq!(names, vec![name], "{provider}");
        assert_eq!(targets, vec!["gateway.example"], "{provider}");
    }
}
