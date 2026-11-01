use crate::error::RpcError;
use crate::transport::{connect as transport_connect, Stream};
use crate::types::{CoreAuthResult, ErrorCode, ModuleAuthResult, SupervisorAuthResult};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::time::Duration;

/// The server a client talks to; it picks the handshake method (ruling S2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Endpoint {
    /// The core: `core.auth`.
    #[default]
    Core,
    /// The supervisor: `supervisor.auth`.
    Supervisor,
    /// A module process: `module.auth` (B9). Its address and run files are per module
    /// (`Layout::endpoints` in the CLI crate), so this variant carries no name.
    Module,
}
impl Endpoint {
    /// The first call on a connection to this endpoint.
    pub fn auth_method(self) -> &'static str {
        match self {
            Endpoint::Core => "core.auth",
            Endpoint::Supervisor => "supervisor.auth",
            Endpoint::Module => "module.auth",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ConnectOptions {
    /// Bounds the socket connect and the whole handshake.
    pub connect_timeout: Duration,
    /// Read deadline for every call after the handshake.
    pub call_timeout: Duration,
    /// Which server `address` belongs to (default: the core).
    pub endpoint: Endpoint,
    /// The pid the caller expects to serve `address` (the one in `run/core.pid` or `run/supervisor.pid`). On Windows,
    /// where any account can create a pipe of a free name, a pipe whose `GetNamedPipeServerProcessId` differs is
    /// refused before the token is sent (`E_UNAUTHORIZED`, reason `pipe-server-mismatch`, ruling S11). `None` skips
    /// the check. On unix the equivalent is [`crate::trust`]: the socket's directory and file are checked before the
    /// connect, and the kernel's peer uid after it.
    pub expected_server_pid: Option<u32>,
}
impl Default for ConnectOptions {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_millis(300),
            call_timeout: Duration::from_secs(30),
            endpoint: Endpoint::Core,
            expected_server_pid: None,
        }
    }
}

// Keep optional streaming state off the legacy client's stack footprint; its frames and byte budget share a lifetime.
struct NotificationBuffer {
    frames: VecDeque<Vec<u8>>,
    bytes: usize,
}

/// Blocking, strictly request→response: one stream behind a BufReader is enough because the CLI never has two calls in flight.
/// Writes go through `reader.get_mut()`, the one real stream.
///
/// **Poisoning:** after a blocking call's read timeout, an I/O error, an over-long line or the core closing the connection, the stream may be
/// positioned mid-line (or hold a late answer to the abandoned call). The client then marks itself poisoned and every later
/// [`Client::call`] returns `RpcError::Unavailable { reason: "poisoned" }` without touching the stream; reconnect to continue.
/// A `Call` error, a `Protocol` error on a complete line, or a skipped notification leave the client usable.
pub struct Client {
    reader: BufReader<Box<dyn Stream>>,
    line_buffer: Vec<u8>,
    notifications: Option<Box<NotificationBuffer>>,
    pending_call: Option<(u64, String)>,
    next_id: u64,
    hello: Value,
    endpoint: Endpoint,
    poisoned: bool,
}

/// Maximum bytes in one NDJSON line, newline not counted (same cap as packages/module-api/src/framing.ts).
pub const MAX_LINE: usize = 4 * 1024 * 1024;
const MAX_NOTIFICATION_BYTES: usize = 2 * MAX_LINE;
const MAX_NOTIFICATIONS: usize = 256;

impl Client {
    pub fn connect(address: &str, token: &str, opts: ConnectOptions) -> Result<Client, RpcError> {
        // Audit M2: a unix socket must sit in a real `run/` directory of ours (not a symlink, no group/other write) and
        // belong to us, or nothing is connected and no token is sent.
        crate::trust::verify_address(address)?;
        let stream = transport_connect(address, opts.connect_timeout)?;
        Self::handshake(stream, token, opts)
    }

    /// Authenticates on a stream that is already connected ([`crate::transport::connect`]): the handshake of
    /// [`Client::connect`]. Lets a caller read the stream's [`Stream::peer_pid`] first and then talk to exactly that
    /// server.
    pub fn handshake(
        stream: Box<dyn Stream>,
        token: &str,
        opts: ConnectOptions,
    ) -> Result<Client, RpcError> {
        let mut client = Client {
            reader: BufReader::new(stream),
            line_buffer: Vec::new(),
            notifications: None,
            pending_call: None,
            next_id: 1,
            hello: Value::Null,
            endpoint: opts.endpoint,
            poisoned: false,
        };
        if cfg!(windows) {
            check_server_pid(opts.expected_server_pid, client.peer_pid())?;
        }
        // Audit M2: the kernel names the uid that listens; another user's server gets no token.
        #[cfg(unix)]
        {
            // SAFETY: geteuid has no preconditions and cannot fail.
            let euid = unsafe { libc::geteuid() };
            crate::trust::check_peer_uid(client.reader.get_ref().peer_uid(), euid)?;
        }
        let method = opts.endpoint.auth_method();
        // The handshake runs under the connect timeout: a server that owns the socket but never answers must fail fast.
        client
            .reader
            .get_ref()
            .set_read_timeout(Some(opts.connect_timeout))?;
        let raw = match client.call(method, json!({ "token": token })) {
            Err(RpcError::Unavailable { reason, detail }) if reason == "call-timeout" => {
                return Err(RpcError::Unavailable {
                    reason: "handshake-timeout".into(),
                    detail,
                })
            }
            other => other?,
        };
        // Check the major before parsing the rest: a MAJOR-2 hello may have a shape this client cannot read.
        let rpc = raw["rpc"]
            .as_str()
            .ok_or_else(|| RpcError::Protocol(format!("{method} result: missing rpc")))?;
        let major: Option<u64> = rpc.split('.').next().and_then(|s| s.parse().ok());
        if major != Some(crate::SUPPORTED_RPC_MAJOR) {
            return Err(RpcError::Version {
                server: rpc.to_string(),
            });
        }
        // The shape is checked against the generated (open) result type, but the raw value is what the client keeps:
        // unknown keys from a newer 1.x server survive for callers that print or forward the hello (R13).
        let shape = match opts.endpoint {
            Endpoint::Core => serde_json::from_value::<CoreAuthResult>(raw.clone()).map(drop),
            Endpoint::Supervisor => {
                serde_json::from_value::<SupervisorAuthResult>(raw.clone()).map(drop)
            }
            Endpoint::Module => serde_json::from_value::<ModuleAuthResult>(raw.clone()).map(drop),
        };
        shape.map_err(|e| RpcError::Protocol(format!("{method} result: {e}")))?;
        client
            .reader
            .get_ref()
            .set_read_timeout(Some(opts.call_timeout))?;
        client.hello = raw;
        Ok(client)
    }

    /// The handshake result exactly as the server sent it (`core.auth`, `supervisor.auth` or `module.auth`).
    pub fn hello(&self) -> &Value {
        &self.hello
    }

    /// The pid the OS names as the server of this connection (see [`Stream::peer_pid`]).
    pub fn peer_pid(&self) -> Option<u32> {
        self.reader.get_ref().peer_pid()
    }

    /// The server this client is connected to.
    pub fn endpoint(&self) -> Endpoint {
        self.endpoint
    }

    /// True when the hello has no `capabilities` (an older server answers for itself), else whether
    /// `capabilities.methods` names `method`.
    pub fn supports(&self, method: &str) -> bool {
        match self.hello.get("capabilities") {
            None | Some(Value::Null) => true,
            Some(capabilities) => capabilities["methods"].get(method).is_some(),
        }
    }

    /// Whether an earlier failure left the stream unusable (see the type docs).
    pub fn is_poisoned(&self) -> bool {
        self.poisoned
    }

    /// Retain notifications, including ones preceding a subscription reply. The default client keeps skipping them.
    /// A backlog over 256 frames or 8 MiB fails the connection; callers can replay durable events after reconnecting.
    pub fn enable_notifications(&mut self) {
        self.notifications.get_or_insert_with(|| {
            Box::new(NotificationBuffer {
                frames: VecDeque::new(),
                bytes: 0,
            })
        });
    }

    /// Drain an already buffered notification without reading. This also works while a polled call is in flight.
    pub fn take_notification(&mut self) -> Result<Option<Value>, RpcError> {
        if self.poisoned {
            return Err(RpcError::Unavailable {
                reason: "poisoned".into(),
                detail: "reconnect the event connection".into(),
            });
        }
        let queue = self
            .notifications
            .as_mut()
            .ok_or_else(|| RpcError::Protocol("enable notifications before reading them".into()))?;
        if let Some(bytes) = queue.frames.pop_front() {
            queue.bytes -= bytes.len();
            return notification(&bytes).map(Some);
        }
        Ok(None)
    }

    /// Read the event connection without sending a request. `None` is an idle read deadline, including a partial frame.
    /// Partial bytes stay buffered; EOF and over-long frames poison the connection just as they do for calls.
    pub fn next_notification(&mut self) -> Result<Option<Value>, RpcError> {
        if self.pending_call.is_some() {
            return Err(RpcError::Protocol(
                "poll the pending call and drain buffered notifications".into(),
            ));
        }
        if let Some(value) = self.take_notification()? {
            return Ok(Some(value));
        }
        loop {
            match self.read_line() {
                Ok(Line::Data(bytes)) if bytes.is_empty() => continue,
                Ok(Line::Data(bytes)) => return notification(&bytes).map(Some),
                Ok(Line::TooLong) => {
                    self.poisoned = true;
                    return Err(RpcError::Protocol("line too long".into()));
                }
                Ok(Line::Closed) => {
                    self.poisoned = true;
                    return Err(RpcError::Unavailable {
                        reason: "closed".into(),
                        detail: "event connection closed".into(),
                    });
                }
                Err(RpcError::Unavailable { reason, .. }) if reason == "call-timeout" => {
                    return Ok(None)
                }
                Err(error) => {
                    self.poisoned |= poisons(&error);
                    return Err(error);
                }
            }
        }
    }

    fn queue_notification(&mut self, bytes: Vec<u8>) -> Result<(), RpcError> {
        let Some(queue) = self.notifications.as_mut() else {
            return Ok(());
        };
        notification(&bytes)?;
        if queue.frames.len() >= MAX_NOTIFICATIONS
            || queue.bytes + bytes.len() > MAX_NOTIFICATION_BYTES
        {
            self.poisoned = true; // The outstanding response remains unread; never reuse that stream position.
            return Err(RpcError::Protocol(
                "notification backlog exceeded; reconnect and replay".into(),
            ));
        }
        queue.bytes += bytes.len();
        queue.frames.push_back(bytes);
        Ok(())
    }

    pub fn call(&mut self, method: &str, params: Value) -> Result<Value, RpcError> {
        self.start_call(method, params)?;
        match self.poll_call()? {
            Some(value) => Ok(value),
            None => {
                self.poisoned = true; // A blocking call abandons its pending reply at the first idle deadline.
                self.pending_call = None;
                Err(RpcError::Unavailable {
                    reason: "call-timeout".into(),
                    detail: format!("{method} timed out"),
                })
            }
        }
    }

    /// Start exactly one request. `poll_call` can then yield at read deadlines so input and events remain responsive.
    pub fn start_call(&mut self, method: &str, params: Value) -> Result<(), RpcError> {
        if self.poisoned {
            return Err(RpcError::Unavailable {
                reason: "poisoned".into(),
                detail: "an earlier call left the connection mid-line; reconnect".into(),
            });
        }
        if self.pending_call.is_some() {
            return Err(RpcError::Protocol(
                "a call is already in flight on this connection".into(),
            ));
        }
        let id = self.next_id;
        self.next_id += 1;
        // `Value`'s Display is infallible (a `Value` always serialises).
        let line =
            json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string();
        let written: Result<(), RpcError> = (|| {
            let w = self.reader.get_mut();
            w.write_all(line.as_bytes())?;
            w.write_all(b"\n")?;
            w.flush()?;
            Ok(())
        })();
        if let Err(error) = written {
            self.poisoned = true;
            return Err(error);
        }
        self.pending_call = Some((id, method.into()));
        Ok(())
    }

    /// `None` preserves the pending request and partial frame at an idle deadline; terminal results end the request.
    pub fn poll_call(&mut self) -> Result<Option<Value>, RpcError> {
        if self.poisoned {
            return Err(RpcError::Unavailable {
                reason: "poisoned".into(),
                detail: "reconnect the call connection".into(),
            });
        }
        let (id, method) = self
            .pending_call
            .clone()
            .ok_or_else(|| RpcError::Protocol("no call is in flight".into()))?;
        let result = self.poll_response(id, &method);
        if !matches!(&result, Ok(None)) {
            self.pending_call = None;
        }
        if let Err(error) = &result {
            self.poisoned |= poisons(error);
        }
        result
    }

    fn poll_response(&mut self, id: u64, method: &str) -> Result<Option<Value>, RpcError> {
        loop {
            let line = match self.read_line() {
                Err(RpcError::Unavailable { reason, .. }) if reason == "call-timeout" => {
                    return Ok(None)
                }
                result => result?,
            };
            let buf = match line {
                Line::Closed => {
                    return Err(RpcError::Unavailable {
                        reason: "closed".into(),
                        detail: "connection closed by core".into(),
                    })
                }
                Line::TooLong => {
                    self.poisoned = true; // the rest of the over-long line is still in the stream
                    return Err(RpcError::Protocol("line too long".into()));
                }
                Line::Data(b) => b,
            };
            if let Some(value) = self.response_line(buf, id, method)? {
                return Ok(Some(value));
            }
        }
    }

    fn response_line(
        &mut self,
        buf: Vec<u8>,
        id: u64,
        method: &str,
    ) -> Result<Option<Value>, RpcError> {
        if buf.is_empty() {
            return Ok(None);
        }
        let msg: Value =
            serde_json::from_slice(&buf).map_err(|error| RpcError::Protocol(error.to_string()))?;
        let Some(msg_id) = msg.get("id") else {
            self.queue_notification(buf)?;
            return Ok(None);
        };
        // id:null belongs to the single outstanding call (parse/length errors from the server).
        if *msg_id != json!(id) && !msg_id.is_null() {
            return Ok(None);
        }
        if let Some(error) = msg.get("error") {
            return Err(call_error(error));
        }
        if msg_id.is_null() {
            return Err(RpcError::Protocol(
                "response with id null and no error".into(),
            ));
        }
        msg.get("result").cloned().map(Some).ok_or_else(|| {
            RpcError::Protocol(format!("{method}: response has neither result nor error"))
        })
    }

    /// Reads one line with at most `MAX_LINE + 1` bytes buffered, so an endless line cannot exhaust memory.
    fn read_line(&mut self) -> Result<Line, RpcError> {
        let remaining = MAX_LINE + 1 - self.line_buffer.len();
        let n = (&mut self.reader)
            .take(remaining as u64)
            .read_until(b'\n', &mut self.line_buffer)?;
        if n == 0 {
            return Ok(Line::Closed);
        }
        if self.line_buffer.last() == Some(&b'\n') {
            let mut buf = std::mem::take(&mut self.line_buffer);
            buf.pop();
            return Ok(Line::Data(buf));
        }
        if self.line_buffer.len() > MAX_LINE {
            return Ok(Line::TooLong);
        }
        Ok(Line::Closed) // EOF in the middle of a line
    }

    pub fn call_typed<P: Serialize, R: DeserializeOwned>(
        &mut self,
        method: &str,
        params: &P,
    ) -> Result<R, RpcError> {
        let v = self.call(
            method,
            serde_json::to_value(params).map_err(|e| RpcError::Protocol(e.to_string()))?,
        )?;
        serde_json::from_value(v).map_err(|e| RpcError::Protocol(format!("{method} result: {e}")))
    }
}

fn notification(bytes: &[u8]) -> Result<Value, RpcError> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|error| RpcError::Protocol(error.to_string()))?;
    if value.get("id").is_some() || value["jsonrpc"] != "2.0" || !value["method"].is_string() {
        return Err(RpcError::Protocol(
            "expected a JSON-RPC notification".into(),
        ));
    }
    Ok(value)
}

enum Line {
    Data(Vec<u8>),
    TooLong,
    Closed,
}

/// Ruling S11: with an expectation, the OS must name exactly that pid as the server, or the token stays unsent.
fn check_server_pid(expected: Option<u32>, actual: Option<u32>) -> Result<(), RpcError> {
    let Some(expected) = expected else {
        return Ok(());
    };
    if actual == Some(expected) {
        return Ok(());
    }
    Err(RpcError::Call {
        error: ErrorCode::EUnauthorized,
        jsonrpc: -32000,
        message: "the pipe is not served by the expected process".into(),
        reason: Some("pipe-server-mismatch".into()),
        detail: Some(match actual {
            Some(pid) => format!("served by pid {pid}, expected pid {expected}"),
            None => format!("the OS does not name the server, expected pid {expected}"),
        }),
        ids: None,
        ext: None,
    })
}

/// Errors after which the stream position is unknown (timeouts, I/O errors, close). The over-long line case poisons
/// itself in `call_inner`, since a `Protocol` error on a complete line leaves the stream at a clean boundary.
fn poisons(e: &RpcError) -> bool {
    matches!(e, RpcError::Unavailable { .. })
}

fn call_error(err: &Value) -> RpcError {
    let error: ErrorCode =
        serde_json::from_value(err["data"]["error"].clone()).unwrap_or(ErrorCode::EInternal);
    RpcError::Call {
        error,
        jsonrpc: err["code"].as_i64().unwrap_or(-32000),
        message: err["message"].as_str().unwrap_or("").to_string(),
        reason: err["data"]["reason"].as_str().map(String::from),
        detail: err["data"]["detail"].as_str().map(String::from),
        ids: err["data"]["ids"].as_object().and_then(|m| {
            let ids: std::collections::BTreeMap<String, String> = m
                .iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect();
            (!ids.is_empty()).then(|| Box::new(ids))
        }),
        ext: err["data"]
            .get("ext")
            .filter(|v| v.is_object())
            .map(|v| Box::new(v.clone())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reason(r: Result<(), RpcError>) -> Option<String> {
        match r {
            Err(RpcError::Call {
                error: ErrorCode::EUnauthorized,
                reason,
                ..
            }) => reason,
            other => panic!("expected E_UNAUTHORIZED, got {other:?}"),
        }
    }

    /// X1-C19: `error.data.ext` reaches the caller as `RpcError::ext()`; an error without one (or with a non-object)
    /// has none.
    #[test]
    fn error_data_ext_survives_on_a_call_error() {
        let e = call_error(&json!({
            "code": -32000, "message": "needs an acknowledgment",
            "data": { "error": "E_APPROVAL_REQUIRED", "reason": "acknowledge-capabilities",
                      "ext": { "capabilities": { "network": { "mode": "none" } }, "authority": "full" } }
        }));
        assert_eq!(e.code_name(), "E_APPROVAL_REQUIRED");
        let ext = e.ext().expect("ext survives");
        assert_eq!(ext["authority"], "full");
        assert_eq!(ext["capabilities"]["network"]["mode"], "none");
        for data in [json!({ "error": "E_INTERNAL" }), json!({ "ext": "x" })] {
            let e = call_error(&json!({ "code": -32000, "message": "m", "data": data }));
            assert!(e.ext().is_none(), "{e:?}");
        }
    }

    #[test]
    fn a_server_pid_check_passes_on_a_match_or_without_an_expectation() {
        assert!(check_server_pid(Some(42), Some(42)).is_ok());
        assert!(check_server_pid(None, Some(42)).is_ok());
        assert!(check_server_pid(None, None).is_ok());
    }

    #[test]
    fn a_mismatched_or_unnamed_server_is_refused_as_pipe_server_mismatch() {
        assert_eq!(
            reason(check_server_pid(Some(1), Some(42))).as_deref(),
            Some("pipe-server-mismatch")
        );
        assert_eq!(
            reason(check_server_pid(Some(1), None)).as_deref(),
            Some("pipe-server-mismatch")
        );
    }
}
