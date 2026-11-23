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
    assert!(stdio.receive().await.is_none());
    assert_eq!(stdio.failure(), Some(Error::Timeout));
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
