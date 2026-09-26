use crate::error::RpcError;
use crate::transport::{connect as transport_connect, Stream};
use crate::types::{CoreAuthResult, ErrorCode, SupervisorAuthResult};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
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
}
impl Endpoint {
    /// The first call on a connection to this endpoint.
    pub fn auth_method(self) -> &'static str {
        match self {
            Endpoint::Core => "core.auth",
            Endpoint::Supervisor => "supervisor.auth",
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
}
impl Default for ConnectOptions {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_millis(300),
            call_timeout: Duration::from_secs(30),
            endpoint: Endpoint::Core,
        }
    }
}

/// Blocking, strictly request→response: one stream behind a BufReader is enough because the CLI never has two calls in flight.
/// Writes go through `reader.get_mut()`, the one real stream.
///
/// **Poisoning:** after a read timeout, an I/O error, an over-long line or the core closing the connection, the stream may be
/// positioned mid-line (or hold a late answer to the abandoned call). The client then marks itself poisoned and every later
/// [`Client::call`] returns `RpcError::Unavailable { reason: "poisoned" }` without touching the stream; reconnect to continue.
/// A `Call` error, a `Protocol` error on a complete line, or a skipped notification leave the client usable.
pub struct Client {
    reader: BufReader<Box<dyn Stream>>,
    next_id: u64,
    hello: Value,
    endpoint: Endpoint,
    poisoned: bool,
}

/// Maximum bytes in one NDJSON line, newline not counted (same cap as packages/module-api/src/framing.ts).
pub const MAX_LINE: usize = 4 * 1024 * 1024;

impl Client {
    pub fn connect(address: &str, token: &str, opts: ConnectOptions) -> Result<Client, RpcError> {
        let stream = transport_connect(address, opts.connect_timeout)?;
        let mut client = Client {
            reader: BufReader::new(stream),
            next_id: 1,
            hello: Value::Null,
            endpoint: opts.endpoint,
            poisoned: false,
        };
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
        };
        shape.map_err(|e| RpcError::Protocol(format!("{method} result: {e}")))?;
        client
            .reader
            .get_ref()
            .set_read_timeout(Some(opts.call_timeout))?;
        client.hello = raw;
        Ok(client)
    }

    /// The handshake result exactly as the server sent it (`core.auth` or `supervisor.auth`).
    pub fn hello(&self) -> &Value {
        &self.hello
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

    pub fn call(&mut self, method: &str, params: Value) -> Result<Value, RpcError> {
        if self.poisoned {
            return Err(RpcError::Unavailable {
                reason: "poisoned".into(),
                detail: "an earlier call left the connection mid-line; reconnect".into(),
            });
        }
        let result = self.call_inner(method, params);
        if let Err(e) = &result {
            if poisons(e) {
                self.poisoned = true;
            }
        }
        result
    }

    fn call_inner(&mut self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = self.next_id;
        self.next_id += 1;
        let line = serde_json::to_string(
            &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
        )
        .unwrap();
        {
            let w = self.reader.get_mut();
            w.write_all(line.as_bytes())?;
            w.write_all(b"\n")?;
            w.flush()?;
        }
        loop {
            let buf = match self.read_line()? {
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
            if buf.is_empty() {
                continue; // blank line, as framing.ts skips it
            }
            let msg: Value =
                serde_json::from_slice(&buf).map_err(|e| RpcError::Protocol(e.to_string()))?;
            // A notification (no id): the H1 CLI does not subscribe, so skip it.
            let Some(msg_id) = msg.get("id") else {
                continue;
            };
            // `id: null` is the core's answer to a request it could not parse or that was too long — with one call in
            // flight that request is ours, so surface its error.
            if *msg_id != json!(id) && !msg_id.is_null() {
                continue;
            }
            if let Some(err) = msg.get("error") {
                return Err(call_error(err));
            }
            if msg_id.is_null() {
                return Err(RpcError::Protocol(
                    "response with id null and no error".into(),
                ));
            }
            return match msg.get("result") {
                Some(r) => Ok(r.clone()),
                None => Err(RpcError::Protocol(format!(
                    "{method}: response has neither result nor error"
                ))),
            };
        }
    }

    /// Reads one line with at most `MAX_LINE + 1` bytes buffered, so an endless line cannot exhaust memory.
    fn read_line(&mut self) -> Result<Line, RpcError> {
        let mut buf = Vec::new();
        let n = (&mut self.reader)
            .take(MAX_LINE as u64 + 1)
            .read_until(b'\n', &mut buf)?;
        if n == 0 {
            return Ok(Line::Closed);
        }
        if buf.last() == Some(&b'\n') {
            buf.pop();
            return Ok(Line::Data(buf));
        }
        if buf.len() > MAX_LINE {
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

enum Line {
    Data(Vec<u8>),
    TooLong,
    Closed,
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
            (!ids.is_empty()).then_some(ids)
        }),
    }
}
