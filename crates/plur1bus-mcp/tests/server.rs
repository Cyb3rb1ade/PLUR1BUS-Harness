#![allow(clippy::unwrap_used, reason = "controlled MCP server fixtures")]

use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use plur1bus_mcp::server::{Actor, Error, Host, Server};
use rmcp::model::Tool;
use serde_json::{json, Map, Value};
use ureq::http::{HeaderMap, HeaderValue};

#[derive(Default)]
struct Echo(AtomicUsize);

impl Host for Echo {
    fn admit(&self, actor: &Actor, name: &str) -> bool {
        actor.agent_id() == "fixture-agent" && name == "alpha.echo"
    }

    fn call(
        &self,
        _: &Actor,
        _: &str,
        args: Map<String, Value>,
        _: Instant,
        _: &dyn Fn() -> bool,
    ) -> Result<Value, Error> {
        self.0.fetch_add(1, Ordering::AcqRel);
        Ok(json!({"echoed":args["msg"]}))
    }
}

fn echo_tool() -> Tool {
    serde_json::from_value(json!({
        "name":"alpha.echo","description":"Echoes a fixture message",
        "inputSchema":{"type":"object","properties":{"msg":{"type":"string","x-mcp-header":"Text"}}}
    }))
    .unwrap()
}

fn request(method: &str, params: &Value) -> (HeaderMap, Vec<u8>) {
    let mut params = params.as_object().unwrap().clone();
    params.insert(
        "_meta".into(),
        json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28"}),
    );
    let mut headers = HeaderMap::new();
    headers.insert(
        "mcp-protocol-version",
        HeaderValue::from_static("2026-07-28"),
    );
    headers.insert("mcp-method", HeaderValue::from_str(method).unwrap());
    let body = serde_json::to_vec(&json!({"jsonrpc":"2.0","id":7,"method":method,"params":params}))
        .unwrap();
    (headers, body)
}

#[test]
fn modern_server_checks_actor_and_protocol_headers_before_calling_the_host() {
    let actor = Actor::new("fixture-agent", "fixture-person").unwrap();
    let effect = Arc::new(Echo::default());
    let server = Server::new(actor, vec![echo_tool()], effect.clone(), 30_000).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    let (headers, body) = request("server/discover", &json!({}));
    let discovery = server.respond(&headers, &body, deadline);
    assert_eq!(
        discovery.message["result"]["supportedVersions"],
        json!(["2026-07-28", "2025-11-25"])
    );
    let (headers, body) = request("tools/list", &json!({}));
    assert_eq!(
        server.respond(&headers, &body, deadline).message["result"]["tools"][0]["name"],
        "alpha.echo"
    );

    let (mut headers, body) = request(
        "tools/call",
        &json!({"name":"alpha.echo","arguments":{"msg":"café"}}),
    );
    headers.insert("mcp-name", HeaderValue::from_static("alpha.echo"));
    assert_eq!(
        server.respond(&headers, &body, deadline).message["error"]["code"],
        -32020
    );
    assert_eq!(effect.0.load(Ordering::Acquire), 0);
    headers.insert(
        "mcp-param-text",
        HeaderValue::from_static("=?base64?Y2Fmw6k=?="),
    );
    assert_eq!(
        server.respond(&headers, &body, deadline).message["result"]["content"][0]["text"],
        r#"{"echoed":"café"}"#
    );
    assert_eq!(effect.0.load(Ordering::Acquire), 1);
}

#[test]
fn recorded_server_wire_matches_both_typescript_protocol_eras() {
    let actor = Actor::new("fixture-agent", "fixture-person").unwrap();
    let effect = Arc::new(Echo::default());
    let server = Server::new(actor, vec![echo_tool()], effect.clone(), 30_000).unwrap();
    let fixture: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/mcp/server.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let mut headers = HeaderMap::new();
        for (name, value) in case["request"]["headers"].as_object().unwrap() {
            headers.insert(
                name.parse::<ureq::http::HeaderName>().unwrap(),
                value.as_str().unwrap().parse().unwrap(),
            );
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        let response = server.respond(
            &headers,
            &serde_json::to_vec(&case["request"]["message"]).unwrap(),
            deadline,
        );
        assert_eq!(response.status, case["response"]["status"]);
        let expected = &case["response"]["message"];
        if case["expected-divergence"] == "P4D-233" {
            assert_eq!(response.message["error"]["code"], expected["error"]["code"]);
            assert_eq!(response.message["id"], expected["id"]);
        } else {
            assert_eq!(&response.message, expected, "{}", case["name"]);
        }
    }
    assert_eq!(effect.0.load(Ordering::Acquire), 2);
}

struct LocalProcess(tokio::sync::watch::Sender<bool>);
impl plur1bus_mcp::session::Process for LocalProcess {
    fn stop(&mut self, _: Instant) -> Result<(), plur1bus_mcp::session::Error> {
        let _ = self.0.send(true);
        Ok(())
    }
}
impl Drop for LocalProcess {
    fn drop(&mut self) {
        let _ = self.0.send(true);
    }
}

struct LocalLauncher(Server);
impl plur1bus_mcp::session::Launcher for LocalLauncher {
    fn launch(
        &self,
        _: Instant,
    ) -> Result<plur1bus_mcp::session::ChildPipes, plur1bus_mcp::session::Error> {
        let (client, server) = tokio::io::duplex(32 * 1024);
        let (reader, writer) = tokio::io::split(client);
        let (inbound, outbound) = tokio::io::split(server);
        let (stop, receive_stop) = tokio::sync::watch::channel(false);
        let handler = self.0.clone();
        std::thread::spawn(move || {
            handler
                .serve_stdio(
                    Box::new(inbound),
                    Box::new(outbound),
                    receive_stop,
                    Duration::from_secs(2),
                )
                .unwrap();
        });
        Ok(plur1bus_mcp::session::ChildPipes {
            reader: Box::new(reader),
            writer: Box::new(writer),
            process: Box::new(LocalProcess(stop)),
        })
    }
}

#[test]
fn legacy_and_modern_sdk_sessions_share_the_native_stdio_protocol_layer() {
    use plur1bus_mcp::session::{Call, Protocol, Session, Timing};
    let actor = Actor::new("fixture-agent", "fixture-person").unwrap();
    let effect = Arc::new(Echo::default());
    let server = Server::new(actor, vec![echo_tool()], effect.clone(), 30_000).unwrap();
    for protocol in [Protocol::Legacy, Protocol::Modern] {
        let session = Session::open_stdio(
            Arc::new(LocalLauncher(server.clone())),
            protocol,
            Timing::default(),
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let tools = session.invoke(Call::ListTools, deadline).unwrap();
        assert_eq!(tools["tools"][0]["name"], "alpha.echo");
        let output = session
            .invoke(
                Call::CallTool {
                    name: "alpha.echo".into(),
                    arguments: [("msg".into(), json!("café"))].into_iter().collect(),
                },
                deadline,
            )
            .unwrap();
        assert_eq!(output["content"][0]["text"], r#"{"echoed":"café"}"#);
        session.close().unwrap();
    }
    assert_eq!(effect.0.load(Ordering::Acquire), 2);
}
