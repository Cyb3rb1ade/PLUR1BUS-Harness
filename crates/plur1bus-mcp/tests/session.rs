#![allow(clippy::unwrap_used, reason = "recorded MCP session")]

use std::{
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use plur1bus_mcp::{
    http::{Admission, Error as HttpError},
    session::{Call, HttpOptions, Protocol, Session, Timing},
};
use plur1bus_wire_fixtures::FakeServer;
use serde_json::{json, Value};
use url::Url;

struct Pin(SocketAddr);
impl Admission for Pin {
    fn pin(&self, _: &Url, _: Instant) -> Result<SocketAddr, HttpError> {
        Ok(self.0)
    }
}

fn modern_fixture() -> Value {
    let data: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/mcp/http.json")).unwrap();
    data["cases"][0].clone()
}

// rmcp starts its opaque numeric IDs at zero; the TypeScript ModernProtocol starts at one.
fn reindex_response(message: &str) -> String {
    let mut reply: Value = serde_json::from_str(message).unwrap();
    let id = reply["id"].as_u64().unwrap();
    reply["id"] = json!(id - 1);
    serde_json::to_string(&reply).unwrap()
}

fn fixture_for_sdk() -> (Value, Value) {
    let recorded = modern_fixture();
    let mut replay = recorded.clone();
    for exchange in replay["exchanges"].as_array_mut().unwrap() {
        let response = &mut exchange["response"];
        let sse = response["headers"]["content-type"] == "text/event-stream";
        for bytes in response["chunksBase64"].as_array_mut().unwrap() {
            let original =
                String::from_utf8(STANDARD.decode(bytes.as_str().unwrap()).unwrap()).unwrap();
            let updated = if sse {
                original
                    .split_inclusive("\r\n")
                    .map(|line| {
                        if let Some(json) = line
                            .strip_prefix("data: ")
                            .and_then(|line| line.strip_suffix("\r\n"))
                        {
                            format!("data: {}\r\n", reindex_response(json))
                        } else {
                            line.to_owned()
                        }
                    })
                    .collect()
            } else {
                reindex_response(&original)
            };
            *bytes = json!(STANDARD.encode(updated));
        }
    }
    (recorded, replay)
}

#[test]
fn rmcp_session_negotiates_and_invokes_the_recorded_peer() {
    let (recorded, replay) = fixture_for_sdk();
    let fixture = FakeServer::start(&replay);
    let session = Session::open_http(HttpOptions {
        endpoint: format!("http://{}/mcp", fixture.addr),
        admission: Arc::new(Pin(fixture.addr)),
        bearer: None,
        headers: Default::default(),
        protocol: Protocol::Modern,
        timing: Timing {
            connect: Duration::from_secs(3),
            request: Duration::from_secs(3),
            close: Duration::from_secs(2),
        },
    })
    .unwrap();
    let observed = &recorded["observed"];
    assert_eq!(session.info().protocol_version, observed["version"]);
    assert_eq!(
        serde_json::to_value(&session.info().server).unwrap(),
        observed["server"]
    );

    let until = || Instant::now() + Duration::from_secs(3);
    let tools = session.invoke(Call::ListTools, until()).unwrap();
    let names = tools["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].clone())
        .collect::<Vec<_>>();
    assert_eq!(json!(names), observed["tools"]);
    let result = session
        .invoke(
            Call::CallTool {
                name: "echo".into(),
                arguments: [("text".into(), json!("café"))].into_iter().collect(),
            },
            until(),
        )
        .unwrap();
    assert_eq!(
        result["structuredContent"],
        observed["result"]["structuredContent"]
    );
    let resource = session
        .invoke(
            Call::ReadResource {
                uri: "test://one".into(),
            },
            until(),
        )
        .unwrap();
    assert_eq!(resource["contents"], observed["resource"]["contents"]);
    let prompt = session
        .invoke(
            Call::GetPrompt {
                name: "greet".into(),
                arguments: Default::default(),
            },
            until(),
        )
        .unwrap();
    assert_eq!(prompt["messages"], observed["prompt"]["messages"]);
    session.close().unwrap();
    assert!(session.is_closed());

    let seen = fixture.received();
    let exchanges = recorded["exchanges"].as_array().unwrap();
    assert_eq!(seen.len(), exchanges.len());
    for (actual, expected) in seen.iter().zip(exchanges) {
        let expected = &expected["request"];
        assert_eq!(actual["method"], expected["method"]);
        assert_eq!(actual["path"], expected["path"]);
        for (key, value) in expected["headers"].as_object().unwrap() {
            assert_eq!(actual["headers"][key], *value, "{key}");
        }
        let original = STANDARD
            .decode(expected["bodyBase64"].as_str().unwrap())
            .unwrap();
        let actual = STANDARD
            .decode(actual["bodyBase64"].as_str().unwrap())
            .unwrap();
        let want = String::from_utf8(original).unwrap();
        let got = String::from_utf8(actual).unwrap();
        let want_id = serde_json::from_str::<Value>(&want).unwrap()["id"]
            .as_u64()
            .unwrap();
        let got_id = serde_json::from_str::<Value>(&got).unwrap()["id"]
            .as_u64()
            .unwrap();
        assert_eq!(got_id + 1, want_id);
        assert_eq!(
            got.replacen(
                &format!(r#""id":{got_id},"#),
                &format!(r#""id":{want_id},"#),
                1
            ),
            want
        );
    }
}

#[test]
fn a_legacy_version_hint_restarts_the_handshake_without_retrying_a_tool_call() {
    let fixture = FakeServer::start(&json!({"transport":"http","exchanges":[
        {"request":{"method":"POST","path":"/mcp"},"response":{"status":200,"body":{
            "jsonrpc":"2.0","id":0,"error":{"code":-32022,"message":"fixture legacy negotiation",
                "data":{"supported":["2025-11-25"],"private":"fixture marker"}}
        }}},
        {"request":{"method":"POST","path":"/mcp"},"response":{"status":200,"body":{
            "jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},
                "serverInfo":{"name":"legacy-fixture","version":"1"}}
        }}},
        {"request":{"method":"POST","path":"/mcp"},"response":{"status":202,"chunksBase64":[]}},
        {"request":{"method":"POST","path":"/mcp"},"response":{"status":200,"body":{
            "jsonrpc":"2.0","id":2,"result":{"tools":[]}
        }}}
    ]}));
    let session = Session::open_http(HttpOptions {
        endpoint: format!("http://{}/mcp", fixture.addr),
        admission: Arc::new(Pin(fixture.addr)),
        bearer: None,
        headers: Default::default(),
        protocol: Protocol::Auto,
        timing: Timing::default(),
    })
    .unwrap();
    assert_eq!(session.info().protocol_version, "2025-11-25");
    assert_eq!(
        session
            .invoke(Call::ListTools, Instant::now() + Duration::from_secs(2))
            .unwrap()["tools"],
        json!([])
    );
    session.close().unwrap();
    let methods = fixture
        .received()
        .iter()
        .map(|incoming| {
            let bytes = STANDARD
                .decode(incoming["bodyBase64"].as_str().unwrap())
                .unwrap();
            serde_json::from_slice::<Value>(&bytes).unwrap()["method"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        methods,
        [
            "server/discover",
            "initialize",
            "notifications/initialized",
            "tools/list"
        ]
    );
}

struct RootsPort;
impl plur1bus_mcp::session::ClientPorts for RootsPort {
    fn supports(&self, feature: plur1bus_mcp::session::Feature) -> bool {
        matches!(feature, plur1bus_mcp::session::Feature::Roots)
    }
    fn invoke(
        &self,
        feature: plur1bus_mcp::session::Feature,
        _: Value,
        _: Instant,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Value, plur1bus_mcp::session::Error> {
        assert!(matches!(feature, plur1bus_mcp::session::Feature::Roots));
        assert!(!cancelled());
        Ok(json!({"roots":[{"uri":"file:///fixture/workspace"}]}))
    }
}

struct LocalProcess;
impl plur1bus_mcp::session::Process for LocalProcess {
    fn stop(&mut self, _: Instant) -> Result<(), plur1bus_mcp::session::Error> {
        Ok(())
    }
}
struct RootsPeer(bool);
impl plur1bus_mcp::session::Launcher for RootsPeer {
    fn launch(
        &self,
        _: Instant,
    ) -> Result<plur1bus_mcp::session::ChildPipes, plur1bus_mcp::session::Error> {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        async fn read(peer: &mut BufReader<tokio::io::DuplexStream>) -> Value {
            let mut line = String::new();
            peer.read_line(&mut line).await.unwrap();
            serde_json::from_str(&line).unwrap()
        }
        async fn send(peer: &mut BufReader<tokio::io::DuplexStream>, value: Value) {
            let mut line = serde_json::to_vec(&value).unwrap();
            line.push(b'\n');
            peer.get_mut().write_all(&line).await.unwrap();
        }
        let (client, server) = tokio::io::duplex(4096);
        let (reader, writer) = tokio::io::split(client);
        let allowed = self.0;
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
                .unwrap();
            runtime.block_on(async move {
                let mut server = BufReader::new(server);
                let init = read(&mut server).await;
                assert_eq!(init["params"]["capabilities"]["roots"].is_object(), allowed);
                send(
                    &mut server,
                    json!({"jsonrpc":"2.0","id":init["id"],"result":{
                        "protocolVersion":"2025-11-25","capabilities":{"tools":{}},
                        "serverInfo":{"name":"fixture-roots","version":"1"}
                    }}),
                )
                .await;
                assert_eq!(
                    read(&mut server).await["method"],
                    "notifications/initialized"
                );
                let list = read(&mut server).await;
                assert_eq!(list["method"], "tools/list");
                send(
                    &mut server,
                    json!({"jsonrpc":"2.0","id":"fixture-call","method":"roots/list"}),
                )
                .await;
                let result = read(&mut server).await;
                assert_eq!(result["id"], "fixture-call");
                if allowed {
                    assert_eq!(
                        result["result"]["roots"][0]["uri"],
                        "file:///fixture/workspace"
                    );
                } else {
                    assert_eq!(result["error"]["code"], -32601);
                }
                send(
                    &mut server,
                    json!({"jsonrpc":"2.0","id":list["id"],"result":{"tools":[]}}),
                )
                .await;
            });
        });
        Ok(plur1bus_mcp::session::ChildPipes {
            reader: Box::new(reader),
            writer: Box::new(writer),
            process: Box::new(LocalProcess),
        })
    }
}

#[test]
fn host_callbacks_are_advertised_and_dispatched_only_when_present() {
    for allowed in [false, true] {
        let ports =
            allowed.then(|| Arc::new(RootsPort) as Arc<dyn plur1bus_mcp::session::ClientPorts>);
        let session = Session::open_stdio_with_ports(
            Arc::new(RootsPeer(allowed)),
            Protocol::Legacy,
            Timing::default(),
            ports,
        )
        .unwrap();
        let list = session
            .invoke(Call::ListTools, Instant::now() + Duration::from_secs(3))
            .unwrap();
        assert_eq!(list["tools"], json!([]));
        session.close().unwrap();
    }
}

#[test]
fn a_legacy_event_stream_waits_before_reopening() {
    let fixture = FakeServer::start(&json!({"transport":"http","exchanges":[
        {"request":{"method":"POST","path":"/mcp"},"response":{"status":200,
            "headers":{"mcp-session-id":"fixture-session"},
            "body":{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25","capabilities":{},
            "serverInfo":{"name":"fixture","version":"1"}}}}},
        {"request":{"method":"POST","path":"/mcp"},"response":{"status":202,"chunksBase64":[]}},
        {"request":{"method":"GET","path":"/mcp"},"response":{"status":200,
            "headers":{"content-type":"text/event-stream"},
            "chunksBase64":[STANDARD.encode(b"retry: 0\n\n")]}},
        {"request":{"method":"GET","path":"/mcp"},"response":{"status":405,"chunksBase64":[]}},
        {"request":{"method":"DELETE","path":"/mcp"},"response":{"status":204,"chunksBase64":[]}}
    ]}));
    let session = Session::open_http(HttpOptions {
        endpoint: format!("http://{}/mcp", fixture.addr),
        admission: Arc::new(Pin(fixture.addr)),
        bearer: None,
        headers: Default::default(),
        protocol: Protocol::Legacy,
        timing: Timing::default(),
    })
    .unwrap();
    let until = Instant::now() + Duration::from_secs(2);
    let gets = || {
        fixture
            .received()
            .iter()
            .filter(|request| request["method"] == "GET")
            .count()
    };
    while gets() == 0 && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(10));
    }
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(gets(), 1);
    while gets() == 1 && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(gets(), 2);
    session.close().unwrap();
}

#[test]
fn listed_tools_expose_only_the_bounded_display_descriptor() {
    let description = format!("Résumé\u{200b}\u{e0041}\u{fe0f}{}", "x".repeat(8200));
    let fixture = FakeServer::start(&json!({"transport":"http","exchanges":[
        {"request":{"method":"POST","path":"/mcp"},"response":{"status":200,"body":{
            "jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},
                "serverInfo":{"name":"fixture","version":"1"}}
        }}},
        {"request":{"method":"POST","path":"/mcp"},"response":{"status":202,"chunksBase64":[]}},
        {"request":{"method":"POST","path":"/mcp"},"response":{"status":200,"body":{
            "jsonrpc":"2.0","id":1,"result":{"tools":[{
                "name":"report\u{200b}.summary","title":"t".repeat(130),"description":description,
                "inputSchema":{"type":"object"},
                "_meta":{"ui":{"resourceUri":"ui://preview/summary"},"unused":"fixture"}
            }]}
        }}},
        {"request":{"method":"POST","path":"/mcp"},"response":{"status":200,"body":{
            "jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"summary"}]}
        }}},
        {"request":{"method":"POST","path":"/mcp"},"response":{"status":200,"body":{
            "jsonrpc":"2.0","id":3,"result":{"tools":[
                {"name":"forecast","inputSchema":{"type":"object"}},
                {"name":"forecast\u{200b}","inputSchema":{"type":"object"}}
            ]}
        }}}
    ]}));
    let session = Session::open_http(HttpOptions {
        endpoint: format!("http://{}/mcp", fixture.addr),
        admission: Arc::new(Pin(fixture.addr)),
        bearer: None,
        headers: Default::default(),
        protocol: Protocol::Legacy,
        timing: Timing::default(),
    })
    .unwrap();
    let deadline = || Instant::now() + Duration::from_secs(2);
    let list = session.invoke(Call::ListTools, deadline()).unwrap();
    let tool = &list["tools"][0];
    assert_eq!(tool["name"], "report.summary");
    assert_eq!(tool["title"], "t".repeat(128));
    assert_eq!(
        tool["description"],
        format!("Résumé{}", "x".repeat(8192 - 6))
    );
    assert_eq!(tool["uiResourceUri"], "ui://preview/summary");
    assert!(tool.get("_meta").is_none());
    session
        .invoke(
            Call::CallTool {
                name: "report.summary".into(),
                arguments: Default::default(),
            },
            deadline(),
        )
        .unwrap();
    assert_eq!(
        session.invoke(Call::ListTools, Instant::now() + Duration::from_secs(2)),
        Err(plur1bus_mcp::session::Error::Protocol)
    );
    session.close().unwrap();
    let requests = fixture.received();
    let call = STANDARD
        .decode(requests[3]["bodyBase64"].as_str().unwrap())
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&call).unwrap()["params"]["name"],
        "report\u{200b}.summary"
    );
}

#[test]
fn tool_descriptors_replay_typescript_acceptance_and_display_bounds() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/mcp/descriptors.json"
    ))
    .unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let input = &case["input"];
        let repeat = |key: &str, unit: &str| {
            unit.repeat(usize::try_from(input[key].as_u64().unwrap()).unwrap())
        };
        let wire_tool = json!({
            "name":input["label"],"title":repeat("titleUnits", "t"),"description":repeat("descriptionUnits", "d"),
            "inputSchema":{"type":"object"},
            "_meta":{"ui":{"resourceUri":"ui://preview/summary"},"unused":"fixture"}
        });
        let fixture = FakeServer::start(&json!({"transport":"http","exchanges":[
            {"request":{"method":"POST","path":"/mcp"},"response":{"status":200,"body":{
                "jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},
                    "serverInfo":{"name":"fixture","version":"1"}}
            }}},
            {"request":{"method":"POST","path":"/mcp"},"response":{"status":202,"chunksBase64":[]}},
            {"request":{"method":"POST","path":"/mcp"},"response":{"status":200,"body":{
                "jsonrpc":"2.0","id":1,"result":{"tools":[wire_tool]}
            }}}
        ]}));
        let session = Session::open_http(HttpOptions {
            endpoint: format!("http://{}/mcp", fixture.addr),
            admission: Arc::new(Pin(fixture.addr)),
            bearer: None,
            headers: Default::default(),
            protocol: Protocol::Legacy,
            timing: Timing::default(),
        })
        .unwrap();
        let result = session.invoke(Call::ListTools, Instant::now() + Duration::from_secs(2));
        let mut expected = case["observed"].clone();
        if expected["error"] == "protocol" {
            assert_eq!(result, Err(plur1bus_mcp::session::Error::Protocol));
        } else {
            if input["deviation"] == "P4D-244" {
                expected["name"] = json!("report.summary");
            }
            let mut descriptor = result.unwrap()["tools"][0].clone();
            let fields = descriptor.as_object_mut().unwrap();
            let title = fields
                .remove("title")
                .unwrap()
                .as_str()
                .unwrap()
                .encode_utf16()
                .count();
            let description = fields
                .remove("description")
                .unwrap()
                .as_str()
                .unwrap()
                .encode_utf16()
                .count();
            fields.insert("titleUnits".into(), json!(title));
            fields.insert("descriptionUnits".into(), json!(description));
            assert_eq!(descriptor, expected);
        }
        session.close().unwrap();
    }
}

#[test]
fn auto_http_fallback_delivers_peer_cancellation_to_the_legacy_callback() {
    use plur1bus_mcp::session::{ClientPorts, Error, Feature};
    use std::sync::mpsc;
    struct Callback(mpsc::Sender<bool>);
    impl ClientPorts for Callback {
        fn supports(&self, feature: Feature) -> bool {
            matches!(feature, Feature::Roots)
        }
        fn invoke(
            &self,
            _: Feature,
            _: Value,
            deadline: Instant,
            cancelled: &dyn Fn() -> bool,
        ) -> Result<Value, Error> {
            while !cancelled() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(5));
            }
            self.0
                .send(cancelled() && Instant::now() < deadline)
                .unwrap();
            Ok(json!({"roots":[]}))
        }
    }
    let event = |v: Value| STANDARD.encode(format!("event: message\ndata: {v}\n\n"));
    let fixture = FakeServer::start(&json!({"transport":"http","exchanges":[
        {"request":{"method":"POST","path":"/mcp"},"response":{"status":200,"body":{
            "jsonrpc":"2.0","id":0,"error":{"code":-32022,"message":"legacy version","data":{"supported":["2025-11-25"]}}}}},
        {"request":{"method":"POST","path":"/mcp"},"response":{"status":200,"headers":{"mcp-session-id":"legacy-callback"},"body":{
            "jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-11-25","capabilities":{},"serverInfo":{"name":"fixture","version":"1"}}}}},
        {"request":{"method":"POST","path":"/mcp"},"response":{"status":202,"chunksBase64":[]}},
        {"request":{"method":"GET","path":"/mcp"},"response":{"status":200,"headers":{"content-type":"text/event-stream"},"chunkGapMs":250,
            "chunksBase64":[event(json!({"jsonrpc":"2.0","id":71,"method":"roots/list"})), event(json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":71,"reason":"user cancelled"}})),STANDARD.encode(b": end\n\n")]}},
        {"request":{"method":"DELETE","path":"/mcp"},"response":{"status":204,"chunksBase64":[]}}
    ]}));
    let (signal, received) = mpsc::channel();
    let session = Session::open_http_with_ports(
        HttpOptions {
            endpoint: format!("http://{}/mcp", fixture.addr),
            admission: Arc::new(Pin(fixture.addr)),
            bearer: None,
            headers: Default::default(),
            protocol: Protocol::Auto,
            timing: Timing {
                request: Duration::from_secs(3),
                ..Timing::default()
            },
        },
        None,
        Some(Arc::new(Callback(signal))),
    )
    .unwrap();
    assert_eq!(session.info().protocol_version, "2025-11-25");
    let observed = received.recv_timeout(Duration::from_secs(4));
    session.close().unwrap();
    assert_eq!(observed, Ok(true));
}
