//! Loopback replay of exchanges recorded by the TypeScript wire exporters.
//!
//! Support for integration tests. Bindings and workers are scoped to the server's lifetime.
//! Repeated HTTP method/path pairs consume their responses in recording order. WebSocket
//! recordings belong to a single connection. Use a fresh server to replay a recording again.
#![forbid(unsafe_code)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// RFC 6455 §1.3.
const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_HEAD: usize = 64 * 1024;
const MAX_BODY: usize = 1024 * 1024;

/// A recorded wire fixture, checked for the format `export-wire.ts` writes.
pub fn fixture(name: &str) -> Value {
    load_fixture("wire", name)
}

/// Loads one W fixture from `fixtures/parity/<area>/`.
pub fn load_fixture(area: &str, name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/parity")
        .join(area)
        .join(format!("{name}.json"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["schema"], "plur1bus.parity-wire/1", "{name}");
    value
}

/// `Sec-WebSocket-Accept` for a `Sec-WebSocket-Key`.
pub fn ws_accept(key: &str) -> String {
    use sha1::{Digest, Sha1};
    let digest = Sha1::digest(format!("{key}{WS_GUID}").as_bytes());
    STANDARD.encode(digest.as_slice())
}

struct Script {
    http: Vec<(String, String, VecDeque<Value>)>,
    ws: Vec<(Vec<Value>, Vec<Value>)>,
    received: Vec<Value>,
}

/// A running fake server; dropping it stops it.
pub struct FakeServer {
    /// Where it listens (127.0.0.1).
    pub addr: SocketAddr,
    script: Arc<Mutex<Script>>,
    stop: mpsc::Sender<()>,
    listener: Option<JoinHandle<()>>,
}

impl FakeServer {
    /// Serves `fixture` (see [`fixture`]) on an ephemeral loopback port.
    pub fn start(fixture: &Value) -> Self {
        let exchanges = fixture["exchanges"].as_array().expect("exchanges");
        let mut script = Script {
            http: Vec::new(),
            ws: Vec::new(),
            received: Vec::new(),
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
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr = listener.local_addr().unwrap();
        let script = Arc::new(Mutex::new(script));
        let (stop, stopped) = mpsc::channel();
        let shared = Arc::clone(&script);
        let listener = thread::spawn(move || serve(&listener, &shared, &stopped));
        Self {
            addr,
            script,
            stop,
            listener: Some(listener),
        }
    }

    /// HTTP requests with lower-case headers, readable text and exact base64 body bytes,
    /// or the JSON messages received from a WebSocket client.
    pub fn received(&self) -> Vec<Value> {
        self.script.lock().unwrap().received.clone()
    }
}

impl Drop for FakeServer {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(listener) = self.listener.take() {
            listener.join().unwrap();
        }
    }
}

fn serve(listener: &TcpListener, script: &Arc<Mutex<Script>>, stopped: &mpsc::Receiver<()>) {
    let mut workers: Vec<(TcpStream, JoinHandle<()>)> = Vec::new();
    loop {
        if !matches!(stopped.try_recv(), Err(mpsc::TryRecvError::Empty)) {
            break;
        }
        workers.retain(|(_, worker)| !worker.is_finished());
        match listener.accept() {
            Ok((mut stream, _)) => {
                let wake = stream.try_clone().unwrap();
                let script = Arc::clone(script);
                let worker = thread::spawn(move || {
                    let _ = connection(&mut stream, &script);
                    // The listener holds a clone to unblock this socket on fixture shutdown.
                    let _ = stream.shutdown(Shutdown::Both);
                });
                workers.push((wake, worker));
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                if !matches!(
                    stopped.recv_timeout(Duration::from_millis(2)),
                    Err(mpsc::RecvTimeoutError::Timeout)
                ) {
                    break;
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => panic!("fixture listener: {error}"),
        }
    }
    for (stream, _) in &workers {
        let _ = stream.shutdown(Shutdown::Both);
    }
    for (_, worker) in workers {
        worker.join().unwrap();
    }
}

fn connection(stream: &mut TcpStream, script: &Mutex<Script>) -> io::Result<()> {
    stream.set_nonblocking(false)?;
    let mut buffer = Vec::new();
    let head_end = loop {
        if let Some(i) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        if buffer.len() >= MAX_HEAD || read_more(stream, &mut buffer)? == 0 {
            return Ok(());
        }
    };
    if head_end > MAX_HEAD {
        return Ok(());
    }
    let head = std::str::from_utf8(&buffer[..head_end]).map_err(io::Error::other)?;
    let mut lines = head.split_terminator("\r\n");
    let mut request_line = lines.next().unwrap_or_default().split_whitespace();
    let Some((method, path)) = request_line.next().zip(request_line.next()) else {
        return Ok(());
    };
    let headers: serde_json::Map<String, Value> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.to_ascii_lowercase(), json!(value.trim())))
        .collect();
    let header = |name: &str| headers.get(name).and_then(Value::as_str);
    if header("upgrade").is_some_and(|u| u.eq_ignore_ascii_case("websocket")) {
        let Some(key) = header("sec-websocket-key") else {
            return Ok(());
        };
        write!(
            stream,
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n",
            ws_accept(key)
        )?;
        return websocket(stream, buffer.split_off(head_end), script);
    }
    if headers.contains_key("transfer-encoding") {
        return Ok(());
    }
    let length = header("content-length")
        .unwrap_or("0")
        .parse::<usize>()
        .map_err(io::Error::other)?;
    if length > MAX_BODY {
        return Ok(());
    }
    let (method, path) = (method.to_owned(), path.to_owned());
    while buffer.len() < head_end + length {
        if read_more(stream, &mut buffer)? == 0 {
            return Ok(());
        }
    }
    let body = &buffer[head_end..head_end + length];
    let response = {
        let mut script = script.lock().unwrap();
        script.received.push(json!({
            "method": method, "path": path, "headers": headers,
            "body": String::from_utf8_lossy(body), "bodyBase64": STANDARD.encode(body),
        }));
        script.http.iter_mut()
            .find(|(m, p, _)| *m == method && *p == path)
            .and_then(|(_, _, queue)| queue.pop_front())
    }
    .unwrap_or_else(|| json!({ "status": 501, "body": { "fake": format!("no recorded exchange for {method} {path}") } }));
    send_http(stream, &response)
}

fn send_http(stream: &mut TcpStream, response: &Value) -> io::Result<()> {
    let status = response["status"].as_u64().unwrap();
    let headers = response["headers"].as_object();
    write!(
        stream,
        "HTTP/1.1 {status} {}\r\nconnection: close\r\n",
        reason(status)
    )?;
    for (name, value) in headers.into_iter().flatten() {
        assert!(
            !["connection", "content-length", "transfer-encoding"]
                .iter()
                .any(|reserved| name.eq_ignore_ascii_case(reserved)),
            "fixture framing header: {name}"
        );
        writeln_header(stream, name, value.as_str().unwrap())?;
    }
    if let Some(chunks) = response["chunksBase64"].as_array() {
        stream.write_all(b"transfer-encoding: chunked\r\n\r\n")?;
        for chunk in chunks {
            let bytes = decode_bytes(chunk);
            assert!(!bytes.is_empty(), "zero-length chunk ends a response");
            write!(stream, "{:x}\r\n", bytes.len())?;
            stream.write_all(&bytes)?;
            stream.write_all(b"\r\n")?;
        }
        return stream.write_all(b"0\r\n\r\n");
    }
    if !headers.is_some_and(|values| {
        values
            .keys()
            .any(|key| key.eq_ignore_ascii_case("content-type"))
    }) {
        stream.write_all(b"content-type: application/json\r\n")?;
    }
    let body = serde_json::to_vec(&response["body"]).unwrap();
    write!(stream, "content-length: {}\r\n\r\n", body.len())?;
    stream.write_all(&body)
}

fn writeln_header(stream: &mut TcpStream, name: &str, value: &str) -> io::Result<()> {
    assert!(!name.contains(['\r', '\n', ':']) && !value.contains(['\r', '\n']));
    write!(stream, "{name}: {value}\r\n")
}

fn decode_bytes(value: &Value) -> Vec<u8> {
    STANDARD.decode(value.as_str().unwrap()).unwrap()
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

fn read_more(stream: &mut TcpStream, buffer: &mut Vec<u8>) -> io::Result<usize> {
    let mut chunk = [0u8; 8192];
    let n = stream.read(&mut chunk)?;
    buffer.extend_from_slice(&chunk[..n]);
    Ok(n)
}

/// One frame from the client (masked, as RFC 6455 requires): `(opcode, payload)`, `None` at end of stream.
fn read_frame(stream: &mut TcpStream, buffer: &mut Vec<u8>) -> io::Result<Option<(u8, Vec<u8>)>> {
    loop {
        if let Some((opcode, payload, used)) = parse_frame(buffer) {
            if buffer[1] & 0x80 == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "unmasked client frame",
                ));
            }
            buffer.drain(..used);
            return Ok(Some((opcode, payload)));
        }
        if buffer.len() >= MAX_BODY + 14 || read_more(stream, buffer)? == 0 {
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
            usize::try_from(u64::from_be_bytes(bytes.get(2..10)?.try_into().ok()?)).ok()?,
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
    if length > MAX_BODY {
        return None;
    }
    let end = at.checked_add(length)?;
    let mut payload = bytes.get(at..end)?.to_vec();
    if let Some(mask) = mask {
        payload
            .iter_mut()
            .enumerate()
            .for_each(|(i, b)| *b ^= mask[i % 4]);
    }
    Some((opcode, payload, end))
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

fn websocket(
    stream: &mut TcpStream,
    mut buffer: Vec<u8>,
    script: &Mutex<Script>,
) -> io::Result<()> {
    let exchanges = std::mem::take(&mut script.lock().unwrap().ws);
    let mut exchanges = exchanges.into_iter();
    let mut current = exchanges.next();
    let mut sent = 0;
    loop {
        // Server-first exchanges model a welcome message before the first client event.
        while let Some((send, receive)) = &current {
            if sent < send.len() {
                break;
            }
            for reply in receive {
                let text = serde_json::to_vec(reply).unwrap();
                stream.write_all(&frame(0x1, &text, None))?;
            }
            current = exchanges.next();
            sent = 0;
        }
        let Some((opcode, payload)) = read_frame(stream, &mut buffer)? else {
            return Ok(());
        };
        match opcode {
            0x1 => {
                let value: Value = serde_json::from_slice(&payload).map_err(io::Error::other)?;
                let matches = current
                    .as_ref()
                    .is_some_and(|(send, _)| send.get(sent) == Some(&value));
                script.lock().unwrap().received.push(value);
                if !matches {
                    stream.write_all(&frame(0x8, &1008u16.to_be_bytes(), None))?;
                    return Ok(());
                }
                sent += 1;
            }
            0x8 => {
                stream.write_all(&frame(0x8, &payload, None))?;
                return Ok(());
            }
            0x9 => stream.write_all(&frame(0xA, &payload, None))?,
            _ => {}
        }
    }
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
