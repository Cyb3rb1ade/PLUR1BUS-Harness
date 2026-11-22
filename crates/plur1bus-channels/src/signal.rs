//! Newline-delimited JSON-RPC for a host-owned signal-cli duplex stream.
use regex::Regex;
use serde::Serialize;
use serde_json::{value::RawValue, Value};
use std::collections::BTreeMap;
use std::fmt;
use std::sync::LazyLock;

const MAX_RPC_ID: u64 = (1 << 53) - 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    RateLimited,
    UntrustedIdentity,
    NotRegistered,
    Timeout,
    NotConnected,
    Disconnected,
    Rpc,
    Protocol,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Error {
    pub kind: Kind,
    pub message: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<i64>,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message)
    }
}

impl std::error::Error for Error {}

impl Error {
    fn new(kind: Kind, message: &'static str) -> Self {
        Self {
            kind,
            message,
            retry_after_ms: None,
            code: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CloseReason {
    Closed,
    Oversize,
}

pub struct Outbound {
    pub id: u64,
    pub bytes: Vec<u8>,
}

pub enum Event {
    Reply {
        id: u64,
        result: Result<Value, Error>,
    },
    Notification {
        method: String,
        params: Value,
    },
    Write(Vec<u8>),
    Closed(CloseReason),
}

pub struct JsonRpc {
    limit: usize,
    next: u64,
    pending: BTreeMap<u64, u64>,
    line: Vec<u8>,
    closed: bool,
}

impl JsonRpc {
    pub fn new(max_line_bytes: usize) -> Self {
        Self {
            limit: max_line_bytes,
            next: 1,
            pending: BTreeMap::new(),
            line: Vec::new(),
            closed: false,
        }
    }

    pub fn is_open(&self) -> bool {
        !self.closed
    }

    pub fn call(
        &mut self,
        method: &str,
        params: &RawValue,
        now_ms: u64,
        timeout_ms: u64,
    ) -> Result<Outbound, Error> {
        if self.closed {
            return Err(Error::new(
                Kind::NotConnected,
                "signal daemon is not connected",
            ));
        }
        if self.next > MAX_RPC_ID {
            return Err(Error::new(
                Kind::Protocol,
                "signal request id space exhausted",
            ));
        }
        #[derive(Serialize)]
        struct Call<'a> {
            jsonrpc: &'static str,
            id: u64,
            method: &'a str,
            params: &'a RawValue,
        }
        let id = self.next;
        let bytes = encode(Call {
            jsonrpc: "2.0",
            id,
            method,
            params,
        })
        .ok_or_else(|| Error::new(Kind::Protocol, "signal request serialization failed"))?;
        self.pending.insert(id, now_ms.saturating_add(timeout_ms));
        self.next += 1;
        Ok(Outbound { id, bytes })
    }

    pub fn expire(&mut self, now_ms: u64) -> Vec<Event> {
        let mut events = Vec::new();
        self.pending.retain(|id, deadline| {
            if now_ms >= *deadline {
                events.push(Event::Reply {
                    id: *id,
                    result: Err(Error::new(Kind::Timeout, "signal request timed out")),
                });
                false
            } else {
                true
            }
        });
        events
    }

    pub fn cancel(&mut self, id: u64) -> Option<Event> {
        self.fail(id, Error::new(Kind::NotConnected, "signal call aborted"))
    }

    pub fn write_failed(&mut self, id: u64) -> Option<Event> {
        self.fail(
            id,
            Error::new(Kind::Disconnected, "signal daemon write failed"),
        )
    }

    pub fn close(&mut self) -> Vec<Event> {
        self.finish(CloseReason::Closed)
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Event> {
        let mut events = Vec::new();
        if self.closed {
            return events;
        }
        for segment in bytes.split_inclusive(|b| *b == b'\n') {
            let full = segment.ends_with(b"\n");
            let tail = if full {
                &segment[..segment.len() - 1]
            } else {
                segment
            };
            if tail.len() > self.limit.saturating_sub(self.line.len()) {
                events.extend(self.finish(CloseReason::Oversize));
                break;
            }
            self.line.extend_from_slice(tail);
            if full {
                self.on_line(&mut events);
                self.line.clear();
            }
        }
        events
    }

    fn fail(&mut self, id: u64, error: Error) -> Option<Event> {
        self.pending.remove(&id).map(|_| Event::Reply {
            id,
            result: Err(error),
        })
    }

    fn finish(&mut self, reason: CloseReason) -> Vec<Event> {
        if self.closed {
            return Vec::new();
        }
        self.closed = true;
        self.line = Vec::new();
        let error = Error::new(Kind::Disconnected, "signal daemon connection closed");
        let mut events: Vec<_> = std::mem::take(&mut self.pending)
            .into_keys()
            .map(|id| Event::Reply {
                id,
                result: Err(error),
            })
            .collect();
        events.push(Event::Closed(reason));
        events
    }

    fn on_line(&mut self, events: &mut Vec<Event>) {
        let Ok(msg) = serde_json::from_str::<Value>(&String::from_utf8_lossy(&self.line)) else {
            return;
        };
        let id = &msg["id"];
        if let Some(method) = msg["method"].as_str() {
            if id.is_null() {
                events.push(Event::Notification {
                    method: method.to_owned(),
                    params: msg["params"].clone(),
                });
            } else if let Some(bytes) = unsupported(id) {
                events.push(Event::Write(bytes));
            }
        } else if let Some(id) = request_id(id) {
            if self.pending.remove(&id).is_some() {
                let error = &msg["error"];
                let result = if error.is_object() || error.is_array() {
                    Err(map_error(error))
                } else {
                    Ok(msg["result"].clone())
                };
                events.push(Event::Reply { id, result });
            }
        }
    }
}

fn request_id(value: &Value) -> Option<u64> {
    if let Some(value) = value.as_str() {
        let id = value.parse::<u64>().ok()?;
        return (id.to_string() == value).then_some(id);
    }
    let number = value.as_f64()?;
    ((0. ..=MAX_RPC_ID as f64).contains(&number) && number.fract() == 0.).then_some(number as u64)
}

fn encode(value: impl Serialize) -> Option<Vec<u8>> {
    let mut bytes = serde_json::to_vec(&value).ok()?;
    bytes.push(b'\n');
    Some(bytes)
}

fn unsupported(id: &Value) -> Option<Vec<u8>> {
    #[derive(Serialize)]
    struct Reply<'a> {
        jsonrpc: &'static str,
        id: &'a Value,
        error: Payload,
    }
    #[derive(Serialize)]
    struct Payload {
        code: i64,
        message: &'static str,
    }
    encode(Reply {
        jsonrpc: "2.0",
        id,
        error: Payload {
            code: -32601,
            message: "method not found",
        },
    })
}

pub fn map_error(e: &Value) -> Error {
    static RATE: LazyLock<Option<Regex>> =
        LazyLock::new(|| Regex::new(r"(?i)rate_limit|rate.?limit|too many requests|\b429\b").ok());
    static SECONDS: LazyLock<Option<Regex>> =
        LazyLock::new(|| Regex::new(r#""retryAfterSeconds"\s*:\s*([0-9]+(?:\.[0-9]+)?)"#).ok());
    static AFTER: LazyLock<Option<Regex>> =
        LazyLock::new(|| Regex::new(r"(?i)retry.?after\D{0,12}([0-9]+(?:\.[0-9]+)?)").ok());
    let code = e["code"].as_i64();
    let text = format!(
        "{} {}",
        e["message"].as_str().unwrap_or_default(),
        e["data"]
    );
    let lower = text.to_ascii_lowercase();
    let mut error = if lower.contains("notregistered") || lower.contains("not registered") {
        Error::new(Kind::NotRegistered, "signal account is not registered")
    } else if lower.contains("untrustedidentity") || lower.contains("untrusted identity") {
        Error::new(
            Kind::UntrustedIdentity,
            "signal identity key is not trusted for the recipient",
        )
    } else if RATE.as_ref().is_some_and(|re| re.is_match(&text)) {
        let caps = SECONDS
            .as_ref()
            .and_then(|re| re.captures(&text))
            .or_else(|| AFTER.as_ref().and_then(|re| re.captures(&text)));
        let seconds: f64 = caps
            .and_then(|caps| caps.get(1))
            .and_then(|mat| mat.as_str().parse().ok())
            .unwrap_or(1.);
        let mut error = Error::new(Kind::RateLimited, "signal rate limit");
        error.retry_after_ms = Some((seconds * 1000.).round().clamp(1000., 300_000.) as u64);
        error
    } else {
        Error::new(
            Kind::Rpc,
            if code == Some(-32601) {
                "signal method not found"
            } else {
                "signal request failed"
            },
        )
    };
    error.code = code;
    error
}
