//! Slow host work and cancelled inbound requests over the real stdio session.
#![allow(clippy::unwrap_used, reason = "deterministic in-process MCP peers")]
use plur1bus_mcp::session::{
    Call, ChildPipes, ClientPorts, Feature, Launcher, Process, Protocol, Session, Timing,
};
use serde_json::{json, Value};
use std::{
    future::Future,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};
struct NoProcess;
impl Process for NoProcess {
    fn stop(&mut self, _: Instant) -> Result<(), plur1bus_mcp::session::Error> {
        Ok(())
    }
}

struct Once(Mutex<Option<ChildPipes>>);
impl Launcher for Once {
    fn launch(&self, _: Instant) -> Result<ChildPipes, plur1bus_mcp::session::Error> {
        self.0
            .lock()
            .unwrap()
            .take()
            .ok_or(plur1bus_mcp::session::Error::Start)
    }
}

type Peer = BufReader<DuplexStream>;

fn peer<F, Fut>(buffer: usize, run: F) -> Arc<Once>
where
    F: FnOnce(Peer) -> Fut + Send + 'static,
    Fut: Future<Output = ()>,
{
    let (client, server) = tokio::io::duplex(buffer);
    let (reader, writer) = tokio::io::split(client);
    thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        rt.block_on(run(BufReader::new(server)));
    });
    Arc::new(Once(Mutex::new(Some(ChildPipes {
        reader: Box::new(reader),
        writer: Box::new(writer),
        process: Box::new(NoProcess),
    }))))
}

async fn read(p: &mut Peer) -> Option<Value> {
    let mut line = String::new();
    match p.read_line(&mut line).await {
        Ok(0) | Err(_) => None,
        Ok(_) => serde_json::from_str(&line).ok(),
    }
}

async fn send(p: &mut Peer, bytes: &[u8]) -> bool {
    p.get_mut().write_all(bytes).await.is_ok()
}

async fn line(p: &mut Peer, value: &Value) -> bool {
    let mut bytes = serde_json::to_vec(value).unwrap();
    bytes.push(b'\n');
    send(p, &bytes).await
}

async fn init(p: &mut Peer) -> bool {
    let Some(init) = read(p).await else {
        return false;
    };
    line(
        p,
        &json!({"jsonrpc":"2.0","id":init["id"],"result":{"protocolVersion":"2025-11-25",
            "capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"probe","version":"1"}}}),
    )
    .await;
    read(p).await.is_some()
}

fn timing(request: u64, close: u64) -> Timing {
    Timing {
        connect: Duration::from_secs(2),
        request: Duration::from_secs(request),
        close: Duration::from_secs(close),
    }
}

struct SlowElicitation(Duration);
impl ClientPorts for SlowElicitation {
    fn supports(&self, feature: Feature) -> bool {
        matches!(
            feature,
            Feature::Elicitation | Feature::Sampling | Feature::Roots
        )
    }
    fn invoke(
        &self,
        _: Feature,
        _: Value,
        _: Instant,
        _: &dyn Fn() -> bool,
    ) -> Result<Value, plur1bus_mcp::session::Error> {
        thread::sleep(self.0);
        Ok(json!({"action":"decline"}))
    }
}

#[test]
fn a_five_second_host_elicitation_survives_a_two_second_close_deadline() {
    let launcher = peer(65536, |mut p| async move {
        assert!(init(&mut p).await);
        let call = read(&mut p).await.unwrap();
        assert!(line(&mut p, &json!({"jsonrpc":"2.0","id":"e1","method":"elicitation/create",
            "params":{"mode":"form","message":"confirm?","requestedSchema":{"type":"object","properties":{}}}})).await);
        assert!(line(&mut p, &json!({"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"waiting"}})).await);
        let reply = tokio::time::timeout(Duration::from_secs(15), read(&mut p))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reply["id"], "e1");
        assert_eq!(reply["result"]["action"], "decline");
        assert!(
            line(
                &mut p,
                &json!({"jsonrpc":"2.0","id":call["id"],"result":{"tools":[]}})
            )
            .await
        );
        // Keep this end open until the session has delivered the reply.
        let _ = read(&mut p).await;
    });
    let session = Session::open_stdio_with_ports(
        launcher,
        Protocol::Legacy,
        timing(20, 2),
        Some(Arc::new(SlowElicitation(Duration::from_secs(5)))),
    )
    .unwrap();
    let list = session
        .invoke(Call::ListTools, Instant::now() + Duration::from_secs(18))
        .unwrap();
    assert_eq!(list["tools"], json!([]));
    session.close().unwrap();
}
struct Hosted(Duration);
impl plur1bus_mcp::server::Host for Hosted {
    fn admit(&self, _: &plur1bus_mcp::server::Actor, _: &str) -> bool {
        true
    }
    fn call(
        &self,
        _: &plur1bus_mcp::server::Actor,
        name: &str,
        _: serde_json::Map<String, Value>,
        _: Instant,
        _: &dyn Fn() -> bool,
    ) -> Result<Value, plur1bus_mcp::server::Error> {
        thread::sleep(if name == "long" {
            Duration::from_secs(3)
        } else {
            self.0
        });
        Ok(json!("done"))
    }
}

fn own_server(
    host_delay: Duration,
    frame_deadline: Duration,
) -> (
    DuplexStream,
    tokio::sync::watch::Sender<bool>,
    thread::JoinHandle<Result<(), plur1bus_mcp::server::Error>>,
) {
    let tool: rmcp::model::Tool =
        serde_json::from_value(json!({"name":"slow","inputSchema":{"type":"object"}})).unwrap();
    let long: rmcp::model::Tool =
        serde_json::from_value(json!({"name":"long","inputSchema":{"type":"object"}})).unwrap();
    let server = plur1bus_mcp::server::Server::new(
        plur1bus_mcp::server::Actor::new("probe-agent", "probe-person").unwrap(),
        vec![tool, long],
        Arc::new(Hosted(host_delay)),
        30_000,
    )
    .unwrap();
    let (host_side, client_side) = tokio::io::duplex(65536);
    let (reader, writer) = tokio::io::split(host_side);
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let served = thread::spawn(move || {
        server.serve_stdio(Box::new(reader), Box::new(writer), stop_rx, frame_deadline)
    });
    (client_side, stop_tx, served)
}

async fn initialize_client(p: &mut Peer) {
    assert!(line(p, &json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{
        "protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"fixture","version":"1"}}})).await);
    assert!(read(p).await.unwrap()["result"].is_object());
    assert!(
        line(
            p,
            &json!({"jsonrpc":"2.0","method":"notifications/initialized"})
        )
        .await
    );
}

async fn tool_call(p: &mut Peer, id: usize, tool: &str) {
    assert!(line(p,&json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":tool,"arguments":{}}})).await);
}

async fn result_id(p: &mut Peer) -> u64 {
    let reply = tokio::time::timeout(Duration::from_secs(8), read(p))
        .await
        .unwrap()
        .unwrap();
    assert!(reply["result"].is_object(), "{reply}");
    assert_ne!(reply["result"]["isError"], true);
    reply["id"].as_u64().unwrap()
}

#[tokio::test]
async fn four_slow_calls_finish_after_the_write_deadline() {
    let (client, stop, served) = own_server(Duration::from_secs(3), Duration::from_secs(2));
    let mut p = BufReader::new(client);
    initialize_client(&mut p).await;
    for id in 100..104 {
        tool_call(&mut p, id, "slow").await;
    }
    let mut ids = Vec::new();
    for _ in 0..4 {
        ids.push(result_id(&mut p).await);
    }
    ids.sort_unstable();
    assert_eq!(ids, [100, 101, 102, 103]);
    stop.send(true).unwrap();
    assert_eq!(served.join().unwrap(), Ok(()));
}

#[tokio::test]
async fn a_long_call_completes_after_three_cancelled_calls() {
    let (client, stop, served) = own_server(Duration::from_millis(500), Duration::from_secs(2));
    let mut p = BufReader::new(client);
    initialize_client(&mut p).await;
    for id in 100..103 {
        tool_call(&mut p, id, "slow").await;
        assert!(line(&mut p,&json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":id,"reason":"user abort"}})).await);
        tokio::time::sleep(Duration::from_millis(900)).await;
    }
    tool_call(&mut p, 200, "long").await;
    assert_eq!(result_id(&mut p).await, 200);
    stop.send(true).unwrap();
    assert_eq!(served.join().unwrap(), Ok(()));
}
