#![allow(
    clippy::expect_used,
    clippy::panic,
    clippy::unwrap_used,
    reason = "bounded loopback fixture"
)]

use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures::StreamExt;
use plur1bus_mcp::http::{Admission, Error, HttpClient};
use plur1bus_wire_fixtures::FakeServer;
use rmcp::{
    model::ClientJsonRpcMessage,
    transport::streamable_http_client::{
        StreamableHttpClient, StreamableHttpError, StreamableHttpPostResponse,
    },
};
use serde_json::{json, Value};
use url::Url;

struct Pin(SocketAddr);

impl Admission for Pin {
    fn pin(&self, _: &Url, _: Instant) -> Result<SocketAddr, Error> {
        Ok(self.0)
    }
}

fn message() -> ClientJsonRpcMessage {
    serde_json::from_value(json!({"jsonrpc":"2.0","id":1,"method":"ping"})).unwrap()
}

fn server(status: u16, content_type: &str, chunks: &[String]) -> FakeServer {
    FakeServer::start(&json!({"transport":"http","exchanges":[{
        "request":{"method":"POST","path":"/mcp"},
        "response":{"status":status,"headers":{"content-type":content_type},"chunksBase64":chunks}
    }]}))
}

fn client(server: &FakeServer) -> (HttpClient, Arc<str>) {
    let target: Arc<str> = format!("http://{}/mcp", server.addr).into();
    let port = Arc::new(Pin(server.addr));
    (
        HttpClient::new(&target, port, Duration::from_secs(5)).unwrap(),
        target,
    )
}

async fn post(
    server: &FakeServer,
) -> Result<StreamableHttpPostResponse, StreamableHttpError<Error>> {
    let (client, target) = client(server);
    client
        .post_message(target, message(), None, None, HashMap::new())
        .await
}

fn padded_json(prefix: &[u8], size: usize) -> Vec<String> {
    let mut remaining = size - prefix.len();
    let mut chunks = vec![STANDARD.encode(prefix)];
    let spaces = [b' '; 32 * 1024];
    while remaining != 0 {
        let len = remaining.min(spaces.len());
        chunks.push(STANDARD.encode(&spaces[..len]));
        remaining -= len;
    }
    chunks
}

const JSON_LIMIT: usize = 16 * 1024 * 1024;
const DIAGNOSTIC_LIMIT: usize = 64 * 1024;

#[tokio::test]
async fn counts_streamed_json_at_the_exact_limit_before_parsing() {
    let valid = br#"{"jsonrpc":"2.0","id":1,"result":{}}"#;
    let exact = server(200, "application/json", &padded_json(valid, JSON_LIMIT));
    let accepted: Value = match post(&exact).await.unwrap() {
        StreamableHttpPostResponse::Json(message, None) => serde_json::to_value(message).unwrap(),
        _ => panic!("expected JSON without a session"),
    };
    assert_eq!(accepted, json!({"jsonrpc":"2.0","id":1,"result":{}}));

    let extra = server(200, "application/json", &padded_json(valid, JSON_LIMIT + 1));
    assert!(matches!(
        post(&extra).await,
        Err(StreamableHttpError::ResponseBodyTooLarge {
            max_size: JSON_LIMIT
        })
    ));
}

#[tokio::test]
async fn diagnostic_limit_counts_bytes_and_keeps_reason_and_credentials_out_of_errors() {
    for extra in [0, 1] {
        let marker = "ordinary-private-fixture-note";
        let peer = server(
            503,
            "text/plain",
            &padded_json(marker.as_bytes(), DIAGNOSTIC_LIMIT + extra),
        );
        let result = post(&peer).await.unwrap_err();
        if extra == 0 {
            assert!(
                matches!(&result, StreamableHttpError::HttpStatus(status) if status.status == 503)
            );
        } else {
            assert!(matches!(
                &result,
                StreamableHttpError::ResponseBodyTooLarge {
                    max_size: DIAGNOSTIC_LIMIT
                }
            ));
        }
        assert!(!format!("{result:?} {result}").contains(marker));
    }
}

#[tokio::test]
async fn split_sse_delimiters_and_utf8_arrive_as_one_complete_event() {
    let first = "id: first\r\ndata: {\r";
    let second = "\ndata: \"label\":\"café\"}\r\n\r";
    let pos = second.find('é').unwrap() + 1;
    let peer = server(
        200,
        "text/event-stream",
        &[
            first.as_bytes(),
            &second.as_bytes()[..pos],
            &second.as_bytes()[pos..],
            b"\n",
        ]
        .into_iter()
        .map(|chunk| STANDARD.encode(chunk))
        .collect::<Vec<_>>(),
    );
    let (client, target) = client(&peer);
    let response = client
        .post_message_with_max_sse_event_size(target, message(), None, None, HashMap::new(), 96)
        .await
        .unwrap();
    let StreamableHttpPostResponse::Sse(mut events, None) = response else {
        panic!("expected stream without a session");
    };
    let event = events.next().await.unwrap().unwrap();
    assert_eq!(event.id.as_deref(), Some("first"));
    assert_eq!(event.data.as_deref(), Some("{\n\"label\":\"café\"}"));
    assert!(events.next().await.is_none());
}

#[tokio::test]
async fn sse_limit_applies_to_whole_raw_events_and_resets_between_events() {
    let event = b": note\r\ndata: line\r\n\r\n";
    for amount in [event.len(), event.len() - 1] {
        let peer = server(
            200,
            "text/event-stream",
            &[STANDARD.encode(event), STANDARD.encode(event)],
        );
        let (client, target) = client(&peer);
        let reply = client
            .post_message_with_max_sse_event_size(
                target,
                message(),
                None,
                None,
                HashMap::new(),
                amount,
            )
            .await
            .unwrap();
        let StreamableHttpPostResponse::Sse(mut events, None) = reply else {
            panic!("expected event stream");
        };
        if amount == event.len() {
            for _ in 0..2 {
                assert_eq!(
                    events.next().await.unwrap().unwrap().data.as_deref(),
                    Some("line")
                );
            }
        } else {
            let error = events.next().await.unwrap().unwrap_err();
            assert!(error.to_string().contains("MCP frame exceeds byte limit"));
        }
        assert!(events.next().await.is_none());
    }
}

#[tokio::test]
async fn an_inflight_body_keeps_the_request_deadline() {
    let peer = FakeServer::start(&json!({"transport":"http","exchanges":[{
        "request":{"method":"POST","path":"/mcp"},
        "response":{"status":200,"headers":{"content-type":"application/json"},
        "chunksBase64":[STANDARD.encode(br#"{"jsonrpc":"2.0","#),STANDARD.encode(br#""id":1,"result":{}}"#)],
        "chunkGapMs":1500}
    }]}));
    let target: Arc<str> = format!("http://{}/mcp", peer.addr).into();
    let client = HttpClient::new(
        &target,
        Arc::new(Pin(peer.addr)),
        Duration::from_millis(850),
    )
    .unwrap();
    let started = Instant::now();
    let reply = client
        .post_message(target, message(), None, None, HashMap::new())
        .await;
    assert!(matches!(
        reply,
        Err(StreamableHttpError::Client(Error::Timeout))
    ));
    assert!(started.elapsed() < Duration::from_millis(1200));
}

#[tokio::test]
async fn bearer_and_session_headers_stay_on_the_admitted_endpoint() {
    let session = "fixture-session";
    let marker = "fixture-mcp-bearer-marker";
    let peer = server(
        200,
        "application/json",
        &[STANDARD.encode(br#"{"jsonrpc":"2.0","id":1,"result":{}}"#)],
    );
    let other = server(
        200,
        "application/json",
        &[STANDARD.encode(br#"{"jsonrpc":"2.0","id":1,"result":{}}"#)],
    );
    let (client, target) = client(&peer);
    let wrong: Arc<str> = format!("http://{}/mcp", other.addr).into();
    assert!(matches!(
        client
            .post_message(
                wrong,
                message(),
                Some(session.into()),
                Some(marker.into()),
                HashMap::new()
            )
            .await,
        Err(StreamableHttpError::Client(Error::Denied))
    ));
    client
        .post_message(
            target,
            message(),
            Some(session.into()),
            Some(marker.into()),
            HashMap::new(),
        )
        .await
        .unwrap();
    let received = peer.received();
    assert_eq!(received.len(), 1);
    assert_eq!(
        received[0]["headers"]["authorization"],
        format!("Bearer {marker}")
    );
    assert_eq!(received[0]["headers"]["mcp-session-id"], session);
    assert!(other.received().is_empty());
    assert!(!format!("{client:?}").contains(marker));
}

#[tokio::test]
async fn typed_http_backend_replays_modern_and_session_bound_typescript_exchanges() {
    let data: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/mcp/http.json")).unwrap();
    for case in data["cases"].as_array().unwrap() {
        let peer = FakeServer::start(case);
        let (client, target) = client(&peer);
        let mut session = None;
        for row in case["exchanges"].as_array().unwrap() {
            let request = &row["request"];
            let status = row["response"]["status"].as_u64().unwrap();
            let headers = request["headers"].as_object().unwrap();
            let custom = headers
                .iter()
                .filter(|(name, _)| name.starts_with("mcp-") && name.as_str() != "mcp-session-id")
                .map(|(key, value)| {
                    (
                        key.parse().unwrap(),
                        value.as_str().unwrap().parse().unwrap(),
                    )
                })
                .collect();
            match request["method"].as_str().unwrap() {
                "POST" => {
                    let outgoing = STANDARD
                        .decode(request["bodyBase64"].as_str().unwrap())
                        .unwrap();
                    let message = serde_json::from_slice(&outgoing).unwrap();
                    let reply = client
                        .post_message(target.clone(), message, session.clone(), None, custom)
                        .await
                        .unwrap();
                    match reply {
                        StreamableHttpPostResponse::Accepted => assert_eq!(status, 202),
                        StreamableHttpPostResponse::Json(data, sid) => {
                            let bytes = STANDARD
                                .decode(row["response"]["chunksBase64"][0].as_str().unwrap())
                                .unwrap();
                            let expected: Value = serde_json::from_slice(&bytes).unwrap();
                            assert_eq!(serde_json::to_value(data).unwrap(), expected);
                            session = sid.map(Arc::from).or(session);
                        }
                        StreamableHttpPostResponse::Sse(mut events, _) => {
                            let first = events.next().await.unwrap().unwrap();
                            assert!(first.id.is_some() && first.data.is_some());
                        }
                        _ => panic!("unexpected SDK response class"),
                    }
                }
                "GET" => {
                    let last = headers["last-event-id"].as_str().map(ToOwned::to_owned);
                    let mut stream = client
                        .get_stream(target.clone(), session.clone(), last, None, custom)
                        .await
                        .unwrap();
                    let result = stream.next().await.unwrap().unwrap();
                    assert_eq!(result.id.as_deref(), Some("result"));
                    let value: Value = serde_json::from_str(&result.data.unwrap()).unwrap();
                    assert_eq!(value["result"]["tools"], json!([]));
                }
                "DELETE" => client
                    .delete_session(target.clone(), session.take().unwrap(), None, custom)
                    .await
                    .unwrap(),
                _ => panic!("unexpected recorded method"),
            }
        }
        let sent = peer.received();
        assert_eq!(sent.len(), case["exchanges"].as_array().unwrap().len());
        for (actual, row) in sent.iter().zip(case["exchanges"].as_array().unwrap()) {
            let expected = &row["request"];
            for key in ["method", "path", "bodyBase64"] {
                assert_eq!(actual[key], expected[key], "{} {key}", case["name"]);
            }
            for (key, value) in expected["headers"].as_object().unwrap() {
                assert_eq!(actual["headers"][key], *value, "{} {key}", case["name"]);
            }
        }
    }
}

#[test]
fn oauth_hint_reaches_the_private_observer_and_stays_out_of_sdk_diagnostics() {
    use plur1bus_mcp::auth::challenge::{Challenge, Observer};
    use plur1bus_mcp::session::{Error as SessionError, HttpOptions, Protocol, Session, Timing};
    struct Observe(std::sync::Mutex<Option<(String, Challenge)>>);
    impl Observer for Observe {
        fn required(&self, resource: &Url, challenge: Challenge) {
            *self.0.lock().unwrap() = Some((resource.to_string(), challenge));
        }
    }
    let marker = "ordinary-oauth-peer-marker";
    let peer = FakeServer::start_with(|addr| {
        json!({"transport":"http","exchanges":[{
            "request":{"method":"POST","path":"/mcp"},
            "response":{"status":403,"headers":{
                "www-authenticate":format!("Bearer resource_metadata=\"http://{addr}/oauth\", scope=\"read\", error=\"insufficient_scope\", error_description=\"{marker}\"")
            },"body":{"message":marker}}
        }]})
    });
    let observer = Arc::new(Observe(std::sync::Mutex::new(None)));
    let endpoint = format!("http://{}/mcp", peer.addr);
    let options = HttpOptions {
        endpoint: endpoint.clone(),
        admission: Arc::new(Pin(peer.addr)),
        bearer: None,
        headers: Default::default(),
        protocol: Protocol::Modern,
        timing: Timing::default(),
    };
    let result = Session::open_http_with_challenges(options, Some(observer.clone()));
    assert!(
        matches!(result, Err(SessionError::AuthRequired)),
        "{result:?}"
    );
    assert!(!format!("{result:?}").contains(marker));
    let (resource, challenge) = observer.0.lock().unwrap().take().unwrap();
    assert_eq!(resource, endpoint);
    assert!(challenge.insufficient_scope());
    assert_eq!(challenge.scope(), Some("read"));
    assert_eq!(challenge.metadata().unwrap().path(), "/oauth");
}

#[tokio::test]
async fn smaller_session_limit_is_applied_to_decoded_http_results() {
    const SESSION_LIMIT: usize = 1024 * 1024;
    for size in [SESSION_LIMIT, SESSION_LIMIT + 1] {
        let peer = server(
            200,
            "application/json",
            &padded_json(br#"{"jsonrpc":"2.0","id":1,"result":{}}"#, size),
        );
        let (client, target) = client(&peer);
        let reply = client
            .with_frame_limit(SESSION_LIMIT)
            .post_message(target, message(), None, None, HashMap::new())
            .await;
        if size == SESSION_LIMIT {
            assert!(matches!(
                reply,
                Ok(StreamableHttpPostResponse::Json(_, None))
            ));
        } else {
            assert!(matches!(
                reply,
                Err(StreamableHttpError::ResponseBodyTooLarge {
                    max_size: SESSION_LIMIT
                })
            ));
        }
    }
}
