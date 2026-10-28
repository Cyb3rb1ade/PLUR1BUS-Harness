#![allow(clippy::unwrap_used, clippy::expect_used)]

use plur1bus_engine::contract::{
    AddressRules, Cancel, Decision, EgressGate, HostError, SecretPort, SecretValue, Target,
};
use plur1bus_engine::embedding::remote_openai::OpenAiEmbeddingProvider;
use plur1bus_engine::embedding::rerank::cohere::CohereReranker;
use plur1bus_engine::embedding::rerank::{
    chained::ChainedReranker, remote::RemoteReranker, ProviderErrorKind,
};
use plur1bus_engine::embedding::{
    EmbedKind, EmbeddingProvider, RerankError, Reranker, VectorSpaceIdentity,
};
use plur1bus_engine::transport::{GuardedClient, Resolver, TransportError};
use serde_json::{json, Value};
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[path = "support/http_stub.rs"]
mod http_stub;
use http_stub::Stub;

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
struct Secrets(Mutex<Vec<String>>);
impl SecretPort for Secrets {
    fn get(&self, name: &str) -> Result<Option<SecretValue>, HostError> {
        self.0.lock().unwrap().push(name.into());
        Ok(Some(SecretValue::new("test-only-private-credential")))
    }
}
fn client() -> Arc<GuardedClient<'static>> {
    Arc::new(GuardedClient::new_owned(Arc::new(Gate), Box::new(Local)))
}
fn body(stub: &Stub) -> Value {
    let all = stub.requests.lock().unwrap();
    serde_json::from_str(all[0].split_once("\r\n\r\n").unwrap().1).unwrap()
}
fn identity() -> VectorSpaceIdentity {
    serde_json::from_value(json!({"provider":"openai","model":"text-embedding-3-small","dimension":2,"revision":"unspecified","normalization":"none","prefixScheme":"[\"\",\"\",\"\",null]","instruction":"","dtype":"float32"})).unwrap()
}

#[test]
fn openai_batches_float_requests_and_validates_dimensions() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/http/openai-embeddings/batch.json")).unwrap();
    let stub = Stub::new(
        200,
        "Content-Type: application/json\r\n",
        &fixture["response"].to_string(),
        Duration::ZERO,
    );
    let secrets = Secrets(Mutex::new(vec![]));
    let config = json!({"model":"text-embedding-3-small","dimensions":2,"apiKeyRef":"embedding/key","baseUrl":stub.url("/v1")});
    let provider =
        OpenAiEmbeddingProvider::new(&config, identity(), client(), Some(&secrets)).unwrap();
    assert_eq!(
        provider
            .embed(
                &["first".into(), "second".into()],
                EmbedKind::Passage,
                &Cancel::never()
            )
            .unwrap(),
        vec![vec![0.1_f32, 0.2], vec![0.3, 0.4]]
    );
    assert_eq!(body(&stub), fixture["request"]);
    assert!(stub.requests.lock().unwrap()[0].starts_with("POST /v1/embeddings "));
    assert_eq!(*secrets.0.lock().unwrap(), vec!["embedding/key"]);
}

#[test]
fn openai_preserves_status_taxonomy_without_provider_bodies() {
    let stub = Stub::new(
        401,
        "",
        "{\"error\":{\"message\":\"test-only-private-credential prompt body\"}}",
        Duration::ZERO,
    );
    let secrets = Secrets(Mutex::new(vec![]));
    let config = json!({"model":"text-embedding-3-small","dimensions":2,"apiKeyRef":"embedding/key","baseUrl":stub.url("/v1"),"requestTimeoutMs":1000});
    let provider =
        OpenAiEmbeddingProvider::new(&config, identity(), client(), Some(&secrets)).unwrap();
    let error = provider
        .embed_remote(&["first".into()], &Cancel::never())
        .unwrap_err();
    assert_eq!(error.kind, ProviderErrorKind::Auth);
    assert_eq!(error.status, Some(401));
    assert!(!format!("{error:?} {error}").contains("private-credential"));
}

#[test]
fn rerank_protocol_requests_match_recorded_node_shapes() {
    for (protocol, fixture) in [
        (
            "cohere",
            include_str!("fixtures/http/cohere-rerank/request-response.json"),
        ),
        (
            "jina",
            include_str!("fixtures/http/remote-rerank/jina.json"),
        ),
        (
            "voyage",
            include_str!("fixtures/http/remote-rerank/voyage.json"),
        ),
        ("tei", include_str!("fixtures/http/remote-rerank/tei.json")),
    ] {
        let fixture: Value = serde_json::from_str(fixture).unwrap();
        let stub = Stub::new(200, "", &fixture["response"].to_string(), Duration::ZERO);
        let config = json!({"provider":"remote","model":"fixture-model","protocol":protocol,"baseUrl":stub.url("/v1")});
        let provider = RemoteReranker::new(&config, client(), None).unwrap();
        let hits = provider
            .rerank(
                "query",
                &["first".into(), "second".into()],
                2,
                &Cancel::never(),
            )
            .unwrap();
        assert_eq!(body(&stub), fixture["request"], "{protocol}");
        assert!(stub.requests.lock().unwrap()[0].starts_with("POST /v1/rerank "));
        assert_eq!(hits[0].index.as_f64(), Some(1.0));
        assert_eq!(hits[0].score.as_f64(), Some(0.9));
    }
}

#[test]
fn every_remote_preset_maps_auth_rate_limit_timeout_and_invalid_response() {
    for provider_name in ["cohere", "jina", "voyage", "remote"] {
        for (status, expected) in [
            (401, RerankError::Auth),
            (402, RerankError::Auth),
            (403, RerankError::Auth),
            (429, RerankError::RateLimit),
            (408, RerankError::Timeout),
            (200, RerankError::InvalidResponse),
        ] {
            let stub = Stub::new(
                status,
                "",
                "{\"message\":\"test-only-private-credential\"}",
                Duration::ZERO,
            );
            let secrets = Secrets(Mutex::new(vec![]));
            let config = json!({"provider":provider_name,"apiKeyRef":"reranker/key","baseUrl":stub.url("/v2")});
            let provider = RemoteReranker::new(&config, client(), Some(&secrets)).unwrap();
            let error = provider
                .rerank("query", &["doc".into()], 1, &Cancel::never())
                .unwrap_err();
            assert_eq!(error, expected, "{provider_name}, {status}");
            assert!(!format!("{error:?} {error}").contains("private-credential"));
        }
    }
}

#[test]
fn malformed_rerank_indices_and_duplicate_results_are_rejected() {
    for response in [
        r#"{"results":[{"index":1,"relevance_score":0.4}]}"#,
        r#"{"results":[{"index":0,"relevance_score":0.4},{"index":0,"score":0.5}]}"#,
        r#"{"results":[{"index":0.5,"score":0.4}]}"#,
    ] {
        let stub = Stub::new(200, "", response, Duration::ZERO);
        let provider = RemoteReranker::new(
            &json!({"baseUrl":stub.url("/"),"provider":"remote"}),
            client(),
            None,
        )
        .unwrap();
        assert_eq!(
            provider
                .rerank("q", &["doc".into()], 1, &Cancel::never())
                .unwrap_err(),
            RerankError::InvalidResponse
        );
    }
}

#[test]
fn a_chained_reranker_uses_fallback_after_a_primary_timeout() {
    let slow = Stub::new(200, "", r#"{"results":[]}"#, Duration::from_millis(50));
    let fast = Stub::new(
        200,
        "",
        r#"{"results":[{"index":0,"score":0.7}]}"#,
        Duration::ZERO,
    );
    let primary = RemoteReranker::new(
        &json!({"provider":"remote","baseUrl":slow.url("/"),"timeoutMs":10}),
        client(),
        None,
    )
    .unwrap();
    let fallback = RemoteReranker::new(
        &json!({"provider":"remote","baseUrl":fast.url("/")}),
        client(),
        None,
    )
    .unwrap();
    let chain = ChainedReranker::new(Box::new(primary), Some(Box::new(fallback)));
    let hits = chain
        .rerank("q", &["doc".into()], 1, &Cancel::never())
        .unwrap();
    assert_eq!(hits[0].score.as_f64(), Some(0.7));
}

#[test]
fn a_chained_reranker_does_not_restart_an_expired_caller_deadline() {
    let slow = Stub::new(200, "", r#"{"results":[]}"#, Duration::from_millis(50));
    let fast = Stub::new(
        200,
        "",
        r#"{"results":[{"index":0,"score":0.7}]}"#,
        Duration::ZERO,
    );
    let primary = RemoteReranker::new(
        &json!({"provider":"remote","baseUrl":slow.url("/")}),
        client(),
        None,
    )
    .unwrap();
    let fallback = RemoteReranker::new(
        &json!({"provider":"remote","baseUrl":fast.url("/")}),
        client(),
        None,
    )
    .unwrap();
    let chain = ChainedReranker::new(Box::new(primary), Some(Box::new(fallback)));
    assert!(chain
        .rerank(
            "q",
            &["doc".into()],
            1,
            &Cancel::with_deadline(Instant::now() + Duration::from_millis(10))
        )
        .is_err());
    assert!(fast.requests.lock().unwrap().is_empty());
}

#[test]
fn cohere_constructor_applies_the_cohere_preset() {
    let stub = Stub::new(
        200,
        "",
        r#"{"results":[{"index":0,"score":0.7}]}"#,
        Duration::ZERO,
    );
    let secrets = Secrets(Mutex::new(vec![]));
    let provider = CohereReranker::new(
        &json!({"baseUrl":stub.url("/v2"),"apiKeyRef":"rerank/key"}),
        client(),
        Some(&secrets),
    )
    .unwrap();
    provider
        .rerank("q", &["doc".into()], 1, &Cancel::never())
        .unwrap();
    assert_eq!(body(&stub)["model"], "rerank-v3.5");
}

#[test]
fn a_rejected_secret_is_resolved_again_then_cached_after_success() {
    let count = std::sync::atomic::AtomicUsize::new(0);
    let stub = Stub::dynamic(move |_| {
        if count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
            (401, String::new(), "{}".into(), Duration::ZERO)
        } else {
            (
                200,
                String::new(),
                r#"{"results":[{"index":0,"score":0.7}]}"#.into(),
                Duration::ZERO,
            )
        }
    });
    let secrets = Secrets(Mutex::new(vec![]));
    let provider = RemoteReranker::new(
        &json!({"provider":"remote","baseUrl":stub.url("/"),"apiKeyRef":"rerank/key"}),
        client(),
        Some(&secrets),
    )
    .unwrap();
    assert_eq!(
        provider
            .rerank("q", &["doc".into()], 1, &Cancel::never())
            .unwrap_err(),
        RerankError::Auth
    );
    provider
        .rerank("q", &["doc".into()], 1, &Cancel::never())
        .unwrap();
    provider
        .rerank("q", &["doc".into()], 1, &Cancel::never())
        .unwrap();
    assert_eq!(*secrets.0.lock().unwrap(), vec!["rerank/key", "rerank/key"]);
}

#[test]
fn openai_retries_batches_then_falls_back_to_individual_inputs() {
    let stub = Stub::dynamic(|request| {
        let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        if body["input"].is_array() {
            (400, String::new(), "{}".into(), Duration::ZERO)
        } else {
            (
                200,
                String::new(),
                json!({"data":[{"embedding":[0.1,0.2]}]}).to_string(),
                Duration::ZERO,
            )
        }
    });
    let secrets = Secrets(Mutex::new(vec![]));
    let provider = OpenAiEmbeddingProvider::new(
        &json!({"baseUrl":stub.url("/v1"),"apiKeyRef":"embedding/key"}),
        identity(),
        client(),
        Some(&secrets),
    )
    .unwrap();
    assert_eq!(
        provider
            .embed(
                &["first".into(), "second".into()],
                EmbedKind::Query,
                &Cancel::never()
            )
            .unwrap()
            .len(),
        2
    );
    let requests = stub.requests.lock().unwrap();
    assert_eq!(requests.len(), 6);
    assert!(requests[..4]
        .iter()
        .all(|request| request.contains("[\"first\",\"second\"]")));
    assert!(requests[4].contains("\"input\":\"first\""));
    assert!(requests[5].contains("\"input\":\"second\""));
}

#[test]
fn openai_checks_dimensions_after_all_batch_and_single_attempts() {
    let stub = Stub::new(200, "", r#"{"data":[{"embedding":[0.1]}]}"#, Duration::ZERO);
    let secrets = Secrets(Mutex::new(vec![]));
    let provider = OpenAiEmbeddingProvider::new(
        &json!({"baseUrl":stub.url("/v1"),"apiKeyRef":"embedding/key"}),
        identity(),
        client(),
        Some(&secrets),
    )
    .unwrap();
    assert_eq!(
        provider
            .embed(&["first".into()], EmbedKind::Query, &Cancel::never())
            .unwrap_err(),
        plur1bus_engine::contract::EmbedError::DimensionMismatch {
            expected: 2,
            actual: 1
        }
    );
}

#[test]
fn openai_maps_rate_limit_timeout_and_protocol_errors() {
    for (status, kind) in [
        (429, ProviderErrorKind::RateLimit),
        (408, ProviderErrorKind::Timeout),
        (200, ProviderErrorKind::Unknown),
    ] {
        let stub = Stub::new(status, "", "{}", Duration::ZERO);
        let secrets = Secrets(Mutex::new(vec![]));
        let provider = OpenAiEmbeddingProvider::new(
            &json!({"baseUrl":stub.url("/v1"),"apiKeyRef":"embedding/key"}),
            identity(),
            client(),
            Some(&secrets),
        )
        .unwrap();
        let error = provider
            .embed_remote(&["first".into()], &Cancel::never())
            .unwrap_err();
        assert_eq!(error.kind, kind);
        if status == 200 {
            assert_eq!(error.code, Some("protocol"));
        }
    }
}

#[test]
fn openai_retries_a_server_timeout_while_the_shared_deadline_is_open() {
    let count = std::sync::atomic::AtomicUsize::new(0);
    let stub = Stub::dynamic(move |_| {
        if count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
            (408, String::new(), "{}".into(), Duration::ZERO)
        } else {
            (
                200,
                String::new(),
                json!({"data":[{"embedding":[0.1,0.2]}]}).to_string(),
                Duration::ZERO,
            )
        }
    });
    let secrets = Secrets(Mutex::new(vec![]));
    let provider = OpenAiEmbeddingProvider::new(
        &json!({"baseUrl":stub.url("/v1"),"apiKeyRef":"embedding/key"}),
        identity(),
        client(),
        Some(&secrets),
    )
    .unwrap();
    assert_eq!(
        provider
            .embed(&["first".into()], EmbedKind::Query, &Cancel::never())
            .unwrap(),
        vec![vec![0.1_f32, 0.2]]
    );
    assert_eq!(stub.requests.lock().unwrap().len(), 2);
    assert_eq!(*secrets.0.lock().unwrap(), vec!["embedding/key"]);
}

#[test]
fn an_oversized_auth_error_still_invalidates_the_rejected_secret() {
    let count = std::sync::atomic::AtomicUsize::new(0);
    let stub = Stub::dynamic(move |_| {
        if count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
            (401, String::new(), "x".repeat(70 * 1024), Duration::ZERO)
        } else {
            (
                200,
                String::new(),
                r#"{"results":[{"index":0,"score":0.7}]}"#.into(),
                Duration::ZERO,
            )
        }
    });
    let secrets = Secrets(Mutex::new(vec![]));
    let provider = RemoteReranker::new(
        &json!({"provider":"remote","baseUrl":stub.url("/"),"apiKeyRef":"rerank/key","maxResponseBytes":256}),
        client(),
        Some(&secrets),
    )
    .unwrap();
    assert_eq!(
        provider
            .rerank("q", &["doc".into()], 1, &Cancel::never())
            .unwrap_err(),
        RerankError::Auth
    );
    let hits = provider
        .rerank("q", &["doc".into()], 1, &Cancel::never())
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].score.as_f64(), Some(0.7));
    assert_eq!(*secrets.0.lock().unwrap(), vec!["rerank/key", "rerank/key"]);
}

#[test]
fn a_disabled_chain_fallback_does_not_mean_no_relevant_documents() {
    let stub = Stub::new(401, "", "{}", Duration::ZERO);
    let provider = RemoteReranker::new(
        &json!({"provider":"remote","baseUrl":stub.url("/")}),
        client(),
        None,
    )
    .unwrap();
    let chain = ChainedReranker::new(Box::new(provider), None);
    assert!(chain
        .rerank("q", &["doc".into()], 1, &Cancel::never())
        .unwrap()
        .is_empty());
    assert!(!chain.empty_result_is_valid());
}

#[test]
fn remote_error_kinds_follow_the_shared_provider_classification_order() {
    for (status, payload, kind) in [
        (
            503,
            json!({"error":{"code":"rate_limit_exceeded"}}),
            ProviderErrorKind::RateLimit,
        ),
        (
            400,
            json!({"error":{"code":"CONTEXT_LENGTH_EXCEEDED"}}),
            ProviderErrorKind::ContextLength,
        ),
        (
            413,
            json!({"message":"prompt is too long"}),
            ProviderErrorKind::ContextLength,
        ),
    ] {
        let stub = Stub::new(status, "", &payload.to_string(), Duration::ZERO);
        let provider = RemoteReranker::new(
            &json!({"provider":"remote","baseUrl":stub.url("/")}),
            client(),
            None,
        )
        .unwrap();
        assert_eq!(
            provider
                .rerank_remote("q", &["doc".into()], 1, &Cancel::never())
                .unwrap_err()
                .kind,
            kind
        );
    }
}

#[test]
fn reranker_limits_accept_integer_valued_json_floats() {
    let stub = Stub::new(
        200,
        "",
        r#"{"results":[{"index":0,"score":0.7}]}"#,
        Duration::ZERO,
    );
    let provider=RemoteReranker::new(&json!({"provider":"remote","baseUrl":stub.url("/"),"maxDocuments":1000.0,"maxRequestBytes":4096.0,"maxResponseBytes":1024.0}),client(),None).unwrap();
    assert_eq!(
        provider
            .rerank("q", &["doc".into()], 1, &Cancel::never())
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn an_owned_secret_port_cannot_hold_the_caller_or_cache_a_late_secret() {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc,
    };
    struct BlockingSecrets {
        started: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
        calls: Arc<AtomicUsize>,
    }
    impl SecretPort for BlockingSecrets {
        fn get(&self, _: &str) -> Result<Option<SecretValue>, HostError> {
            if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
                self.started.send(()).unwrap();
                self.release.lock().unwrap().recv().unwrap();
            }
            Ok(Some(SecretValue::new("test-only-secret")))
        }
    }
    let stub = Stub::new(
        200,
        "",
        r#"{"data":[{"embedding":[0.1,0.2]}]}"#,
        Duration::ZERO,
    );
    let (started, observe) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let calls = Arc::new(AtomicUsize::new(0));
    let secrets = Arc::new(BlockingSecrets {
        started,
        release: Mutex::new(wait),
        calls: calls.clone(),
    });
    let provider = Arc::new(
        OpenAiEmbeddingProvider::new_owned(
            &json!({"baseUrl":stub.url("/v1"),"apiKeyRef":"embedding/key"}),
            identity(),
            client(),
            Some(secrets),
        )
        .unwrap(),
    );
    let request = provider.clone();
    let (returned, receive) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        returned
            .send(request.embed_remote(
                &["first".into()],
                &Cancel::with_deadline(Instant::now() + Duration::from_millis(30)),
            ))
            .unwrap()
    });
    observe.recv_timeout(Duration::from_secs(1)).unwrap();
    let result = receive.recv_timeout(Duration::from_millis(200));
    release.send(()).unwrap();
    worker.join().unwrap();
    assert_eq!(
        result.unwrap().unwrap_err().kind,
        ProviderErrorKind::Timeout
    );
    provider
        .embed_remote(&["first".into()], &Cancel::never())
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[test]
fn a_coalesced_secret_wait_uses_its_own_deadline() {
    use std::sync::mpsc;
    struct BlockingSecrets {
        started: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
    }
    impl SecretPort for BlockingSecrets {
        fn get(&self, _: &str) -> Result<Option<SecretValue>, HostError> {
            self.started.send(()).unwrap();
            self.release.lock().unwrap().recv().unwrap();
            Ok(Some(SecretValue::new("test-only-secret")))
        }
    }
    let stub = Stub::new(
        200,
        "",
        r#"{"data":[{"embedding":[0.1,0.2]}]}"#,
        Duration::ZERO,
    );
    let (started, observe) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let provider = Arc::new(
        OpenAiEmbeddingProvider::new_owned(
            &json!({"baseUrl":stub.url("/v1"),"apiKeyRef":"embedding/key"}),
            identity(),
            client(),
            Some(Arc::new(BlockingSecrets {
                started,
                release: Mutex::new(wait),
            })),
        )
        .unwrap(),
    );
    let first = provider.clone();
    let owner = std::thread::spawn(move || {
        first.embed_remote(
            &["first".into()],
            &Cancel::with_deadline(Instant::now() + Duration::from_secs(5)),
        )
    });
    observe.recv_timeout(Duration::from_secs(1)).unwrap();
    let request = provider.clone();
    let (returned, receive) = mpsc::channel();
    let waiter = std::thread::spawn(move || {
        returned
            .send(request.embed_remote(
                &["second".into()],
                &Cancel::with_deadline(Instant::now() + Duration::from_millis(30)),
            ))
            .unwrap()
    });
    let result = receive.recv_timeout(Duration::from_millis(200));
    release.send(()).unwrap();
    waiter.join().unwrap();
    owner.join().unwrap().unwrap();
    assert_eq!(
        result.unwrap().unwrap_err().kind,
        ProviderErrorKind::Timeout
    );
}

#[test]
fn oversized_error_diagnostics_do_not_override_the_status_kind() {
    let body =
        json!({"error":{"code":"rate_limit_exceeded","message":"x".repeat(70*1024)}}).to_string();
    let stub = Stub::new(503, "", &body, Duration::ZERO);
    let provider = RemoteReranker::new(
        &json!({"provider":"remote","baseUrl":stub.url("/")}),
        client(),
        None,
    )
    .unwrap();
    let error = provider
        .rerank_remote("q", &["doc".into()], 1, &Cancel::never())
        .unwrap_err();
    assert_eq!(error.kind, ProviderErrorKind::Overloaded);
}

#[test]
fn openai_constructors_refuse_a_config_for_a_different_vector_space() {
    for config in [
        json!({"model":"text-embedding-3-large"}),
        json!({"provider":"openai-compatible"}),
        json!({"dimensions":3}),
    ] {
        assert!(OpenAiEmbeddingProvider::new(&config, identity(), client(), None).is_err());
        assert!(OpenAiEmbeddingProvider::new_owned(&config, identity(), client(), None).is_err());
    }
}

#[test]
fn an_auth_header_with_a_truncated_body_still_rotates_reranker_credentials() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    for status in [401, 403] {
        let calls = AtomicUsize::new(0);
        let stub = Stub::dynamic(move |_| {
            if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                (
                    status,
                    "Content-Length: 1024\r\n".into(),
                    "{".into(),
                    Duration::ZERO,
                )
            } else {
                (
                    200,
                    String::new(),
                    r#"{"results":[{"index":0,"score":0.7}]}"#.into(),
                    Duration::ZERO,
                )
            }
        });
        let secrets = Secrets(Mutex::new(vec![]));
        let provider = RemoteReranker::new(
            &json!({"provider":"remote","baseUrl":stub.url("/"),"apiKeyRef":"rerank/key"}),
            client(),
            Some(&secrets),
        )
        .unwrap();
        assert_eq!(
            provider
                .rerank("q", &["doc".into()], 1, &Cancel::never())
                .unwrap_err(),
            RerankError::Auth
        );
        assert_eq!(
            provider
                .rerank("q", &["doc".into()], 1, &Cancel::never())
                .unwrap()
                .len(),
            1
        );
        assert_eq!(secrets.0.lock().unwrap().len(), 2);
    }
}

#[test]
fn an_auth_header_with_a_truncated_body_still_rotates_embedding_credentials() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let calls = AtomicUsize::new(0);
    let stub = Stub::dynamic(move |_| {
        if calls.fetch_add(1, Ordering::SeqCst) == 0 {
            (
                401,
                "Content-Length: 1024\r\n".into(),
                "{".into(),
                Duration::ZERO,
            )
        } else {
            (
                200,
                String::new(),
                r#"{"data":[{"embedding":[0.1,0.2]}]}"#.into(),
                Duration::ZERO,
            )
        }
    });
    let secrets = Secrets(Mutex::new(vec![]));
    let provider = OpenAiEmbeddingProvider::new(
        &json!({"baseUrl":stub.url("/v1"),"apiKeyRef":"embedding/key"}),
        identity(),
        client(),
        Some(&secrets),
    )
    .unwrap();
    assert_eq!(
        provider
            .embed_remote(&["doc".into()], &Cancel::never())
            .unwrap_err()
            .kind,
        ProviderErrorKind::Auth
    );
    assert_eq!(
        provider
            .embed_remote(&["doc".into()], &Cancel::never())
            .unwrap()
            .len(),
        1
    );
    assert_eq!(secrets.0.lock().unwrap().len(), 2);
}

struct MutableGate(std::sync::atomic::AtomicBool);
impl EgressGate for MutableGate {
    fn decide(&self, _: &Target) -> Decision {
        if self.0.load(std::sync::atomic::Ordering::SeqCst) {
            Decision::Allow {
                address_rules: AddressRules {
                    allow_loopback: true,
                    ..AddressRules::default()
                },
            }
        } else {
            Decision::Deny {
                reason: "changed".into(),
            }
        }
    }
}

#[test]
fn an_embedding_provider_forwards_egress_invalidation() {
    let stub = Stub::new(
        200,
        "",
        r#"{"data":[{"embedding":[0.1,0.2]}]}"#,
        Duration::ZERO,
    );
    let gate = Arc::new(MutableGate(std::sync::atomic::AtomicBool::new(true)));
    let client = Arc::new(GuardedClient::new_owned(gate.clone(), Box::new(Local)));
    let secrets = Secrets(Mutex::new(vec![]));
    let provider = OpenAiEmbeddingProvider::new(
        &json!({"baseUrl":stub.url("/v1"),"apiKeyRef":"embedding/key"}),
        identity(),
        client,
        Some(&secrets),
    )
    .unwrap();
    provider
        .embed_remote(&["doc".into()], &Cancel::never())
        .unwrap();
    gate.0.store(false, std::sync::atomic::Ordering::SeqCst);
    provider.invalidate_egress();
    assert!(provider
        .embed_remote(&["doc".into()], &Cancel::never())
        .is_err());
    assert_eq!(stub.requests.lock().unwrap().len(), 1);
}

#[test]
fn a_chain_invalidates_the_egress_cache_of_every_member() {
    let primary = Stub::new(
        200,
        "",
        r#"{"results":[{"index":0,"score":0.7}]}"#,
        Duration::ZERO,
    );
    let fallback = Stub::new(
        200,
        "",
        r#"{"results":[{"index":0,"score":0.5}]}"#,
        Duration::ZERO,
    );
    let gate = Arc::new(MutableGate(std::sync::atomic::AtomicBool::new(true)));
    let make = |stub: &Stub| {
        RemoteReranker::new(
            &json!({"provider":"remote","baseUrl":stub.url("/")}),
            Arc::new(GuardedClient::new_owned(gate.clone(), Box::new(Local))),
            None,
        )
        .unwrap()
    };
    let primary_provider = make(&primary);
    let fallback_provider = make(&fallback);
    for provider in [&primary_provider, &fallback_provider] {
        provider
            .rerank("q", &["doc".into()], 1, &Cancel::never())
            .unwrap();
    }
    let chain = ChainedReranker::new(
        Box::new(primary_provider),
        Some(Box::new(fallback_provider)),
    );
    gate.0.store(false, std::sync::atomic::Ordering::SeqCst);
    chain.invalidate_egress();
    assert!(chain
        .rerank("q", &["doc".into()], 1, &Cancel::never())
        .is_err());
    assert_eq!(primary.requests.lock().unwrap().len(), 1);
    assert_eq!(fallback.requests.lock().unwrap().len(), 1);
}

#[test]
fn an_auth_header_rotates_the_secret_even_when_its_body_exceeds_the_deadline() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let calls = AtomicUsize::new(0);
    let stub = Stub::dynamic_body(move |_| {
        if calls.fetch_add(1, Ordering::SeqCst) == 0 {
            (401, String::new(), "{}".into(), Duration::from_millis(100))
        } else {
            (
                200,
                String::new(),
                r#"{"data":[{"embedding":[0.1,0.2]}]}"#.into(),
                Duration::ZERO,
            )
        }
    });
    let secrets = Secrets(Mutex::new(vec![]));
    let provider = OpenAiEmbeddingProvider::new(
        &json!({"baseUrl":stub.url("/v1"),"apiKeyRef":"embedding/key"}),
        identity(),
        client(),
        Some(&secrets),
    )
    .unwrap();
    assert_eq!(
        provider
            .embed_remote(
                &["doc".into()],
                &Cancel::with_deadline(Instant::now() + Duration::from_millis(60))
            )
            .unwrap_err()
            .kind,
        ProviderErrorKind::Timeout
    );
    assert_eq!(
        provider
            .embed_remote(&["doc".into()], &Cancel::never())
            .unwrap()
            .len(),
        1
    );
    assert_eq!(secrets.0.lock().unwrap().len(), 2);
}

fn wait_for_post(stub: &Stub) {
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        if !stub.requests.lock().unwrap().is_empty() {
            assert!(stub.requests.lock().unwrap()[0].starts_with("POST "));
            return;
        }
        assert!(Instant::now() < deadline, "provider did not send the POST");
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn an_owned_embedding_call_observes_caller_cancel_during_headers_and_body() {
    use std::sync::mpsc;
    for delay_body in [false, true] {
        let handler = |_: &str| {
            (
                200,
                String::new(),
                r#"{"data":[{"embedding":[0.1,0.2]}]}"#.to_owned(),
                Duration::from_secs(1),
            )
        };
        let stub = if delay_body {
            Stub::dynamic_body(handler)
        } else {
            Stub::dynamic(handler)
        };
        let provider = OpenAiEmbeddingProvider::new_owned(
            &json!({"baseUrl":stub.url("/v1"),"apiKeyRef":"embedding/key"}),
            identity(),
            client(),
            Some(Arc::new(Secrets(Mutex::new(vec![])))),
        )
        .unwrap();
        let cancel = Cancel::never();
        let caller = cancel.clone();
        let (returned, receive) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            returned
                .send(provider.embed_remote(&["doc".into()], &cancel))
                .unwrap();
        });
        wait_for_post(&stub);
        // In body mode the stub writes the headers immediately after recording the POST.
        std::thread::sleep(Duration::from_millis(20));
        caller.cancel();
        let result = receive.recv_timeout(Duration::from_millis(250));
        worker.join().unwrap();
        assert_eq!(
            result.unwrap().unwrap_err().kind,
            ProviderErrorKind::Aborted,
            "delayed body: {delay_body}"
        );
    }
}

#[test]
fn an_owned_rerank_call_observes_caller_cancel_during_headers_and_body() {
    use std::sync::mpsc;
    for delay_body in [false, true] {
        let handler = |_: &str| {
            (
                200,
                String::new(),
                r#"{"results":[{"index":0,"score":0.7}]}"#.to_owned(),
                Duration::from_secs(1),
            )
        };
        let stub = if delay_body {
            Stub::dynamic_body(handler)
        } else {
            Stub::dynamic(handler)
        };
        let provider = RemoteReranker::new_owned(
            &json!({"provider":"remote","baseUrl":stub.url("/")}),
            client(),
            None,
        )
        .unwrap();
        let cancel = Cancel::never();
        let caller = cancel.clone();
        let (returned, receive) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            returned
                .send(provider.rerank("q", &["doc".into()], 1, &cancel))
                .unwrap();
        });
        wait_for_post(&stub);
        std::thread::sleep(Duration::from_millis(20));
        caller.cancel();
        let result = receive.recv_timeout(Duration::from_millis(250));
        worker.join().unwrap();
        assert_eq!(
            result.unwrap().unwrap_err(),
            RerankError::Cancelled(plur1bus_engine::contract::Cancelled {
                reason: plur1bus_engine::contract::CancelReason::Caller,
            }),
            "delayed body: {delay_body}"
        );
    }
}

#[test]
fn a_cancelled_owned_secret_lookup_discards_its_late_credential() {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc,
    };
    struct BlockingSecrets {
        started: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
        completed: mpsc::Sender<()>,
        calls: Arc<AtomicUsize>,
    }
    impl SecretPort for BlockingSecrets {
        fn get(&self, _: &str) -> Result<Option<SecretValue>, HostError> {
            if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
                self.started.send(()).unwrap();
                self.release.lock().unwrap().recv().unwrap();
                self.completed.send(()).unwrap();
                Ok(Some(SecretValue::new("test-only-late-secret")))
            } else {
                Ok(Some(SecretValue::new("test-only-current-secret")))
            }
        }
    }
    let stub = Stub::new(
        200,
        "",
        r#"{"data":[{"embedding":[0.1,0.2]}]}"#,
        Duration::ZERO,
    );
    let (started, observe) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let (completed, finished) = mpsc::channel();
    let calls = Arc::new(AtomicUsize::new(0));
    let provider = Arc::new(
        OpenAiEmbeddingProvider::new_owned(
            &json!({"baseUrl":stub.url("/v1"),"apiKeyRef":"embedding/key"}),
            identity(),
            client(),
            Some(Arc::new(BlockingSecrets {
                started,
                release: Mutex::new(wait),
                completed,
                calls: calls.clone(),
            })),
        )
        .unwrap(),
    );
    let cancel = Cancel::never();
    let caller = cancel.clone();
    let request = provider.clone();
    let (returned, receive) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        returned
            .send(request.embed_remote(&["first".into()], &cancel))
            .unwrap();
    });
    observe.recv_timeout(Duration::from_secs(1)).unwrap();
    caller.cancel();
    let result = receive.recv_timeout(Duration::from_millis(250));
    // Release the host worker even on a regression so a failing test cannot leak it.
    release.send(()).unwrap();
    worker.join().unwrap();
    finished.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(
        result.unwrap().unwrap_err().kind,
        ProviderErrorKind::Aborted
    );
    assert!(stub.requests.lock().unwrap().is_empty());
    provider
        .embed_remote(&["second".into()], &Cancel::never())
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    let requests = stub.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].contains("Bearer test-only-current-secret"));
    assert!(!requests[0].contains("test-only-late-secret"));
}

#[test]
fn a_coalesced_secret_wait_observes_its_own_caller_cancel() {
    use std::sync::mpsc;
    struct BlockingSecrets {
        started: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
    }
    impl SecretPort for BlockingSecrets {
        fn get(&self, _: &str) -> Result<Option<SecretValue>, HostError> {
            self.started.send(()).unwrap();
            self.release.lock().unwrap().recv().unwrap();
            Ok(Some(SecretValue::new("test-only-secret")))
        }
    }
    let stub = Stub::new(
        200,
        "",
        r#"{"data":[{"embedding":[0.1,0.2]}]}"#,
        Duration::ZERO,
    );
    let (started, observe) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let provider = Arc::new(
        OpenAiEmbeddingProvider::new_owned(
            &json!({"baseUrl":stub.url("/v1"),"apiKeyRef":"embedding/key"}),
            identity(),
            client(),
            Some(Arc::new(BlockingSecrets {
                started,
                release: Mutex::new(wait),
            })),
        )
        .unwrap(),
    );
    let first = provider.clone();
    let owner = std::thread::spawn(move || first.embed_remote(&["first".into()], &Cancel::never()));
    observe.recv_timeout(Duration::from_secs(1)).unwrap();
    let cancel = Cancel::never();
    let caller = cancel.clone();
    let request = provider.clone();
    let (returned, receive) = mpsc::channel();
    let waiter = std::thread::spawn(move || {
        returned
            .send(request.embed_remote(&["second".into()], &cancel))
            .unwrap();
    });
    std::thread::sleep(Duration::from_millis(20));
    caller.cancel();
    let result = receive.recv_timeout(Duration::from_millis(250));
    release.send(()).unwrap();
    waiter.join().unwrap();
    owner.join().unwrap().unwrap();
    assert_eq!(
        result.unwrap().unwrap_err().kind,
        ProviderErrorKind::Aborted
    );
    assert_eq!(stub.requests.lock().unwrap().len(), 1);
}
