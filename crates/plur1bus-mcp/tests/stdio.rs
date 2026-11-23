#![allow(clippy::unwrap_used, reason = "controlled in-process pipes")]

use std::time::Duration;

use plur1bus_mcp::stdio::{Error, Framed};
use rmcp::{model::ClientJsonRpcMessage, transport::Transport, RoleClient};
use serde_json::json;
use tokio::io::{duplex, split, AsyncReadExt, AsyncWriteExt};

const LIMIT: usize = 64;
const WAIT: Duration = Duration::from_millis(400);

type ClientPipes = Framed<
    RoleClient,
    tokio::io::ReadHalf<tokio::io::DuplexStream>,
    tokio::io::WriteHalf<tokio::io::DuplexStream>,
>;

fn paired() -> (ClientPipes, tokio::io::DuplexStream) {
    let (local, peer) = duplex(256);
    let (read, write) = split(local);
    (Framed::new(read, write, LIMIT, WAIT).unwrap(), peer)
}

#[tokio::test]
async fn byte_limit_applies_to_each_complete_line_across_reads() {
    for extra in [0, 1] {
        let (mut stdio, mut peer) = paired();
        let mut bytes = br#"{"jsonrpc":"2.0","id":1,"result":{}}"#.to_vec();
        bytes.resize(LIMIT + extra, b' ');
        bytes.push(b'\n');
        peer.write_all(&bytes[..19]).await.unwrap();
        peer.write_all(&bytes[19..]).await.unwrap();
        let got = stdio.receive().await;
        if extra == 0 {
            assert_eq!(
                serde_json::to_value(got.unwrap()).unwrap(),
                json!({"jsonrpc":"2.0","id":1,"result":{}})
            );
            assert_eq!(stdio.failure(), None);
        } else {
            assert!(got.is_none());
            assert_eq!(stdio.failure(), Some(Error::FrameLimit));
        }
    }
}

#[tokio::test]
async fn an_unfinished_line_has_a_deadline_and_ends_the_connection() {
    let (mut stdio, mut peer) = paired();
    peer.write_all(br#"{"jsonrpc":"2.0","#).await.unwrap();
    let started = std::time::Instant::now();
    assert!(stdio.receive().await.is_none());
    assert_eq!(stdio.failure(), Some(Error::Timeout));
    assert!(started.elapsed() < Duration::from_millis(1_100));
}

#[tokio::test]
async fn output_is_a_single_frame_and_close_flushes_owned_stdin() {
    let (mut stdio, mut peer) = paired();
    let msg: ClientJsonRpcMessage =
        serde_json::from_value(json!({"jsonrpc":"2.0","id":1,"method":"ping"})).unwrap();
    stdio.send(msg).await.unwrap();
    stdio.close().await.unwrap();
    let mut actual = Vec::new();
    peer.read_to_end(&mut actual).await.unwrap();
    assert_eq!(
        actual,
        b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n"
    );
}

#[tokio::test]
async fn native_stdio_preserves_recorded_typescript_request_frames() {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use serde_json::Value;
    let data: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/mcp/stdio.json")).unwrap();
    for case in data["cases"].as_array().unwrap() {
        let (local, mut peer) = duplex(64 * 1024);
        let (read, write) = split(local);
        let mut framed = Framed::<RoleClient, _, _>::new(read, write, 1024 * 1024, WAIT).unwrap();
        if case["mode"] == "legacy" {
            framed = framed.with_legacy_envelope();
        }
        let request = STANDARD.decode(case["request"].as_str().unwrap()).unwrap();
        for line in request.split_inclusive(|byte| *byte == b'\n') {
            framed
                .send(serde_json::from_slice(line).unwrap())
                .await
                .unwrap();
        }
        let replies = STANDARD.decode(case["response"].as_str().unwrap()).unwrap();
        peer.write_all(&replies).await.unwrap();
        peer.shutdown().await.unwrap();
        for line in replies.split_inclusive(|byte| *byte == b'\n') {
            let expected: Value = serde_json::from_slice(line).unwrap();
            let actual = serde_json::to_value(framed.receive().await.unwrap()).unwrap();
            assert_eq!(actual["id"], expected["id"]);
            assert_eq!(actual["result"], expected["result"]);
        }
        assert!(framed.receive().await.is_none());
        assert_eq!(framed.failure(), None);
        framed.close().await.unwrap();
        let mut sent = Vec::new();
        peer.read_to_end(&mut sent).await.unwrap();
        assert_eq!(
            String::from_utf8(sent).unwrap(),
            String::from_utf8(request).unwrap()
        );
    }
}

#[tokio::test]
async fn sending_a_frame_applies_the_same_byte_limit_as_receiving() {
    let (mut stdio, _peer) = paired();
    let request = serde_json::from_value(json!({
        "jsonrpc":"2.0","id":"i".repeat(LIMIT),"method":"ping"
    }))
    .unwrap();
    assert_eq!(stdio.send(request).await, Err(Error::FrameLimit));
}
