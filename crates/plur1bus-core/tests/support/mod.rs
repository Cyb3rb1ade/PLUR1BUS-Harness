//! Parity mode W (P4-03): a fake HTTP and WebSocket server that serves the exchanges `scripts/parity/export-wire.ts`
//! recorded from the TypeScript fake servers (`fixtures/parity/wire/<name>.json`), so Rust tests never need Node. It
//! listens on 127.0.0.1 only, with an ephemeral port; nothing leaves the loopback interface.
//!
//! - `transport: "http"`: a request is answered with the next recorded response for its method and path (exchanges with
//!   the same route are served in recorded order); an unrecorded route gets 501 and a JSON body naming it.
//! - `transport: "websocket"`: after the RFC 6455 handshake the client's text frames are matched, in order, against each
//!   exchange's `send` frames; after the last one the exchange's `receive` frames are sent as text frames.
//!
//! [`FakeServer::received`] returns what arrived (HTTP: `{method, path, body}`; WebSocket: the parsed frames), so a test
//! can compare its own requests with the recorded ones. A small blocking client for both transports is in [`client`].
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use serde_json::{json, Value};
use std::collections::VecDeque;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// RFC 6455 §1.3.
pub const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_HEAD: usize = 64 * 1024;
const MAX_BODY: usize = 1024 * 1024;

/// A recorded wire fixture, checked for the format `export-wire.ts` writes.
pub fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/parity/wire")
        .join(format!("{name}.json"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["schema"], "plur1bus.parity-wire/1", "{name}");
    value
}

/// `Sec-WebSocket-Accept` for a `Sec-WebSocket-Key`.
pub fn ws_accept(key: &str) -> String {
    use base64::Engine as _;
    use sha1::{Digest, Sha1};
    let digest = Sha1::digest(format!("{key}{WS_GUID}").as_bytes());
    base64::engine::general_purpose::STANDARD.encode(digest.as_slice())
}

struct Script {
    http: Vec<(String, String, VecDeque<Value>)>,
    ws: Vec<(Vec<Value>, Vec<Value>)>,
}

/// A running fake server; dropping it stops it.
pub struct FakeServer {
    /// Where it listens (127.0.0.1).
    pub addr: SocketAddr,
    received: Arc<Mutex<Vec<Value>>>,
    _runtime: tokio::runtime::Runtime,
}

impl FakeServer {
    /// Serves `fixture` (see [`fixture`]) on an ephemeral loopback port.
    pub fn start(fixture: &Value) -> Self {
        let exchanges = fixture["exchanges"].as_array().expect("exchanges");
        let mut script = Script {
            http: Vec::new(),
            ws: Vec::new(),
        };
        match fixture["transport"].as_str() {
            Some("http") => {
                for exchange in exchanges {
                    let method = exchange["request"]["method"].as_str().unwrap().to_owned();
                    let path = exchange["request"]["path"].as_str().unwrap().to_owned();
                    let response = exchange["response"].clone();
                    match script
                        .http
                        .iter_mut()
                        .find(|(m, p, _)| *m == method && *p == path)
                    {
                        Some((_, _, queue)) => queue.push_back(response),
                        None => script.http.push((method, path, VecDeque::from([response]))),
                    }
                }
            }
            Some("websocket") => {
                for exchange in exchanges {
                    let frames = |key: &str| exchange[key].as_array().unwrap().clone();
                    script.ws.push((frames("send"), frames("receive")));
                }
            }
            other => panic!("unknown transport {other:?}"),
        }
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_io()
            .build()
            .unwrap();
        let listener = runtime.block_on(TcpListener::bind("127.0.0.1:0")).unwrap();
        let addr = listener.local_addr().unwrap();
        let received = Arc::new(Mutex::new(Vec::new()));
        let script = Arc::new(Mutex::new(script));
        let log = Arc::clone(&received);
        runtime.spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let (script, log) = (Arc::clone(&script), Arc::clone(&log));
                tokio::spawn(async move {
                    let _ = connection(stream, script, log).await;
                });
            }
        });
        Self {
            addr,
            received,
            _runtime: runtime,
        }
    }

    /// What arrived so far, in order.
    pub fn received(&self) -> Vec<Value> {
        self.received.lock().unwrap().clone()
    }
}

async fn connection(
    mut stream: TcpStream,
    script: Arc<Mutex<Script>>,
    log: Arc<Mutex<Vec<Value>>>,
) -> std::io::Result<()> {
    let mut buffer = Vec::new();
    let head_end = loop {
        if let Some(i) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        if buffer.len() > MAX_HEAD || read_more(&mut stream, &mut buffer).await? == 0 {
            return Ok(());
        }
    };
    let head = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next().unwrap_or_default().split(' ');
    let method = request_line.next().unwrap_or_default().to_owned();
    let path = request_line.next().unwrap_or_default().to_owned();
    let header = |name: &str| {
        head.split("\r\n").skip(1).find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.trim()
                .eq_ignore_ascii_case(name)
                .then(|| value.trim().to_owned())
        })
    };
    if header("upgrade").is_some_and(|u| u.eq_ignore_ascii_case("websocket")) {
        let key = header("sec-websocket-key").unwrap_or_default();
        let reply = format!(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n",
            ws_accept(&key)
        );
        stream.write_all(reply.as_bytes()).await?;
        return websocket(stream, buffer.split_off(head_end), script, log).await;
    }
    let length: usize = header("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
        .min(MAX_BODY);
    while buffer.len() < head_end + length {
        if read_more(&mut stream, &mut buffer).await? == 0 {
            return Ok(());
        }
    }
    let body = String::from_utf8_lossy(&buffer[head_end..head_end + length]).into_owned();
    log.lock()
        .unwrap()
        .push(json!({"method": method, "path": path, "body": body}));
    let response = {
        let mut script = script.lock().unwrap();
        script
            .http
            .iter_mut()
            .find(|(m, p, queue)| *m == method && *p == path && !queue.is_empty())
            .and_then(|(_, _, queue)| queue.pop_front())
    }
    .unwrap_or_else(|| json!({"status": 501, "body": {"fake": format!("no recorded exchange for {method} {path}")}}));
    let body = serde_json::to_string(&response["body"]).unwrap();
    let status = response["status"].as_u64().unwrap_or(500);
    let reply = format!(
        "HTTP/1.1 {status} {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        reason(status),
        body.len()
    );
    stream.write_all(reply.as_bytes()).await?;
    stream.shutdown().await
}

fn reason(status: u64) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        429 => "Too Many Requests",
        501 => "Not Implemented",
        _ => "Status",
    }
}

async fn read_more(stream: &mut TcpStream, buffer: &mut Vec<u8>) -> std::io::Result<usize> {
    let mut chunk = [0u8; 8192];
    let n = stream.read(&mut chunk).await?;
    buffer.extend_from_slice(&chunk[..n]);
    Ok(n)
}

/// One frame from the client (masked, as RFC 6455 requires): `(opcode, payload)`, `None` at end of stream.
async fn read_frame(
    stream: &mut TcpStream,
    buffer: &mut Vec<u8>,
) -> std::io::Result<Option<(u8, Vec<u8>)>> {
    loop {
        if let Some((opcode, payload, used)) = parse_frame(buffer) {
            buffer.drain(..used);
            return Ok(Some((opcode, payload)));
        }
        if read_more(stream, buffer).await? == 0 {
            return Ok(None);
        }
    }
}

/// Parses one complete frame from `bytes`: `(opcode, unmasked payload, bytes used)`.
pub fn parse_frame(bytes: &[u8]) -> Option<(u8, Vec<u8>, usize)> {
    if bytes.len() < 2 {
        return None;
    }
    let opcode = bytes[0] & 0x0f;
    let masked = bytes[1] & 0x80 != 0;
    let (length, mut at) = match bytes[1] & 0x7f {
        126 => (
            u16::from_be_bytes(bytes.get(2..4)?.try_into().ok()?) as usize,
            4,
        ),
        127 => (
            u64::from_be_bytes(bytes.get(2..10)?.try_into().ok()?) as usize,
            10,
        ),
        n => (n as usize, 2),
    };
    let mask = if masked {
        let mask: [u8; 4] = bytes.get(at..at + 4)?.try_into().ok()?;
        at += 4;
        Some(mask)
    } else {
        None
    };
    let mut payload = bytes.get(at..at + length)?.to_vec();
    if let Some(mask) = mask {
        payload
            .iter_mut()
            .enumerate()
            .for_each(|(i, b)| *b ^= mask[i % 4]);
    }
    Some((opcode, payload, at + length))
}

/// One frame with FIN set; `mask` is the client's masking key (servers send unmasked frames).
pub fn frame(opcode: u8, payload: &[u8], mask: Option<[u8; 4]>) -> Vec<u8> {
    let mut out = vec![0x80 | opcode];
    let flag = if mask.is_some() { 0x80 } else { 0 };
    match payload.len() {
        n if n < 126 => out.push(flag | n as u8),
        n if n <= 0xffff => {
            out.push(flag | 126);
            out.extend_from_slice(&(n as u16).to_be_bytes());
        }
        n => {
            out.push(flag | 127);
            out.extend_from_slice(&(n as u64).to_be_bytes());
        }
    }
    match mask {
        Some(mask) => {
            out.extend_from_slice(&mask);
            out.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        }
        None => out.extend_from_slice(payload),
    }
    out
}

async fn websocket(
    mut stream: TcpStream,
    mut buffer: Vec<u8>,
    script: Arc<Mutex<Script>>,
    log: Arc<Mutex<Vec<Value>>>,
) -> std::io::Result<()> {
    let exchanges = std::mem::take(&mut script.lock().unwrap().ws);
    let mut exchanges = exchanges.into_iter();
    let mut current = exchanges.next();
    let mut sent = 0;
    while let Some((opcode, payload)) = read_frame(&mut stream, &mut buffer).await? {
        match opcode {
            0x1 => {
                let value: Value = serde_json::from_slice(&payload).unwrap_or(Value::Null);
                log.lock().unwrap().push(value.clone());
                let Some((send, receive)) = &current else {
                    continue;
                };
                if send.get(sent) != Some(&value) {
                    // Not the recorded conversation: end it, as a policy violation (1008).
                    stream
                        .write_all(&frame(0x8, &1008u16.to_be_bytes(), None))
                        .await?;
                    return Ok(());
                }
                sent += 1;
                if sent == send.len() {
                    for reply in receive {
                        let text = serde_json::to_vec(reply).unwrap();
                        stream.write_all(&frame(0x1, &text, None)).await?;
                    }
                    current = exchanges.next();
                    sent = 0;
                }
            }
            0x8 => {
                stream.write_all(&frame(0x8, &payload, None)).await?;
                return Ok(());
            }
            0x9 => stream.write_all(&frame(0xA, &payload, None)).await?,
            _ => {}
        }
    }
    Ok(())
}

/// Blocking clients for tests: one HTTP request per connection, and a minimal WebSocket client that masks its frames and
/// checks the server's accept key.
pub mod client {
    use super::{frame, parse_frame, ws_accept};
    use serde_json::Value;
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;

    /// Sends one request and returns `(status, JSON body)`.
    pub fn http(addr: SocketAddr, method: &str, path: &str, json: Option<&Value>) -> (u16, Value) {
        let mut stream = TcpStream::connect(addr).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let body = json
            .map(|j| serde_json::to_string(j).unwrap())
            .unwrap_or_default();
        let request = format!(
            "{method} {path} HTTP/1.1\r\nhost: {addr}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        let (head, body) = response.split_once("\r\n\r\n").unwrap();
        let status = head.split(' ').nth(1).unwrap().parse().unwrap();
        (status, serde_json::from_str(body).unwrap())
    }

    /// A connected WebSocket.
    pub struct Ws {
        stream: TcpStream,
        buffer: Vec<u8>,
    }

    impl Ws {
        /// Connects and completes the handshake; panics unless the server's accept key is RFC 6455's.
        pub fn connect(addr: SocketAddr, path: &str) -> Self {
            let mut stream = TcpStream::connect(addr).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            // RFC 6455: the base64 of 16 bytes; fixed, a test needs no randomness.
            let key = {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD.encode(*b"p4a-wire-fixture")
            };
            let key = key.as_str();
            let request = format!(
                "GET {path} HTTP/1.1\r\nhost: {addr}\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-key: {key}\r\nsec-websocket-version: 13\r\n\r\n"
            );
            stream.write_all(request.as_bytes()).unwrap();
            let mut buffer = Vec::new();
            let mut chunk = [0u8; 1024];
            let end = loop {
                if let Some(i) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                    break i + 4;
                }
                let n = stream.read(&mut chunk).unwrap();
                assert!(n > 0, "the server closed during the handshake");
                buffer.extend_from_slice(&chunk[..n]);
            };
            let head = String::from_utf8_lossy(&buffer[..end]).to_lowercase();
            assert!(head.starts_with("http/1.1 101"), "{head}");
            let accept = format!("sec-websocket-accept: {}", ws_accept(key).to_lowercase());
            assert!(head.contains(&accept), "{head}");
            Self {
                stream,
                buffer: buffer.split_off(end),
            }
        }

        /// Sends one masked text frame with `value` as JSON.
        pub fn send(&mut self, value: &Value) {
            let text = serde_json::to_vec(value).unwrap();
            self.stream
                .write_all(&frame(0x1, &text, Some([0x11, 0x22, 0x33, 0x44])))
                .unwrap();
        }

        /// Reads the next frame: `(opcode, payload)`.
        pub fn read(&mut self) -> (u8, Vec<u8>) {
            let mut chunk = [0u8; 8192];
            loop {
                if let Some((opcode, payload, used)) = parse_frame(&self.buffer) {
                    self.buffer.drain(..used);
                    return (opcode, payload);
                }
                let n = self.stream.read(&mut chunk).unwrap();
                assert!(n > 0, "the server closed the connection");
                self.buffer.extend_from_slice(&chunk[..n]);
            }
        }

        /// Sends a close frame and waits for the server's.
        pub fn close(mut self) -> u8 {
            self.stream
                .write_all(&frame(0x8, &1000u16.to_be_bytes(), Some([1, 2, 3, 4])))
                .unwrap();
            self.read().0
        }
    }
}
