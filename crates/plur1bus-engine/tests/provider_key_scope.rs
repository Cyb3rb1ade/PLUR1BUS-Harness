//! RX1/S1: provider selection and credential scope without external networking.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::contract::{
    Cancel, Decision, EgressGate, EngineConfig, EngineError, HostError, SecretPort, SecretValue,
    Target,
};
use plur1bus_engine::embedding::{
    build_embedding_owned, remote_openai::OpenAiEmbeddingProvider, VectorSpaceIdentity,
};
use plur1bus_engine::transport::{GuardedClient, Resolver, TransportError};
use serde_json::json;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use support::TestHost;

struct NoNetwork;
impl EgressGate for NoNetwork {
    fn decide(&self, _: &Target) -> Decision {
        Decision::Deny {
            reason: "fixture forbids networking".into(),
        }
    }
}
impl Resolver for NoNetwork {
    #[allow(
        clippy::panic,
        reason = "a DNS attempt must fail this offline credential-selection test"
    )]
    fn resolve(&self, _: &str, _: u16, _: Instant) -> Result<Vec<IpAddr>, TransportError> {
        panic!("credential selection must not resolve hosts")
    }
}
struct Names(Mutex<Vec<String>>);
impl SecretPort for Names {
    fn get(&self, name: &str) -> Result<Option<SecretValue>, HostError> {
        self.0.lock().unwrap().push(name.into());
        Ok(None)
    }
}
fn identity() -> VectorSpaceIdentity {
    serde_json::from_value(json!({"provider":"openai","model":"fixture","dimension":2,"revision":"unspecified","normalization":"none","prefixScheme":"none","instruction":"","dtype":"float32"})).unwrap()
}

#[test]
fn implicit_key_scope_tracks_endpoint_and_explicit_names_take_precedence() {
    for (endpoint, implicit) in [
        (None, "OPENAI_API_KEY"),
        (Some("https://api.openai.com/v1"), "OPENAI_API_KEY"),
        (Some("https://EU.api.openai.com/v1"), "OPENAI_API_KEY"),
        (
            Some("https://api.openai.com.example/v1"),
            "OPENAI_COMPATIBLE_API_KEY",
        ),
        (
            Some("https://notapi.openai.com/v1"),
            "OPENAI_COMPATIBLE_API_KEY",
        ),
        (
            Some("https://gateway.example/v1"),
            "OPENAI_COMPATIBLE_API_KEY",
        ),
        (
            Some("http://api.openai.com/v1"),
            "OPENAI_COMPATIBLE_API_KEY",
        ),
        (
            Some("http://localhost:8090/v1"),
            "OPENAI_COMPATIBLE_API_KEY",
        ),
        (Some("http://[::1]:8090/v1"), "OPENAI_COMPATIBLE_API_KEY"),
    ] {
        for explicit in [None, Some("apiKeyEnv"), Some("apiKeyRef")] {
            let mut config = json!({"model":"fixture","dimensions":2});
            if let Some(endpoint) = endpoint {
                config["baseUrl"] = json!(endpoint);
            }
            if let Some(field) = explicit {
                config[field] = json!("fixture/explicit");
            }
            let names = Names(Mutex::new(vec![]));
            let client = Arc::new(GuardedClient::new(&NoNetwork, Box::new(NoNetwork)));
            let provider =
                OpenAiEmbeddingProvider::new(&config, identity(), client, Some(&names)).unwrap();
            assert!(provider
                .embed_remote(&["fixture".into()], &Cancel::never())
                .is_err());
            let expected = if explicit.is_some() {
                "fixture/explicit"
            } else {
                implicit
            };
            assert_eq!(
                *names.0.lock().unwrap(),
                vec![expected],
                "{endpoint:?}, {explicit:?}"
            );
        }
    }
}

#[test]
fn unknown_embedding_provider_never_falls_through_to_remote_construction() {
    for provider in [json!("opneai"), json!("OPENAI"), json!(""), json!(7)] {
        assert!(
            serde_json::from_value::<EngineConfig>(json!({"embedding":{"provider":provider}}))
                .is_err(),
            "{provider}"
        );
    }
    let config: EngineConfig = serde_json::from_value(json!({"embedding":{"baseUrl":"https://gateway.example/v1","model":"fixture","dimensions":2}})).unwrap();
    let host = Arc::new(TestHost::new(std::env::temp_dir()));
    assert!(
        matches!(build_embedding_owned(&config, host), Err(EngineError::Invalid { field, .. }) if field == "embedding.provider")
    );
}

#[test]
fn implemented_remote_provider_names_remain_supported() {
    for provider in ["openai", "openai-compatible"] {
        let config: EngineConfig = serde_json::from_value(
            json!({"embedding":{"provider":provider,"model":"fixture","dimensions":2}}),
        )
        .unwrap();
        let host = Arc::new(TestHost::new(std::env::temp_dir()));
        assert!(build_embedding_owned(&config, host).is_ok(), "{provider}");
    }
}
