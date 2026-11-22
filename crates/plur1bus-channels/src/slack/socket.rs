//! Slack Socket Mode hello, ACK, deduplication and disconnect handling.
use crate::http::{Error as ApiError, Kind};
use crate::websocket::Error;
use serde_json::Value;
use std::collections::{HashSet, VecDeque};

const ENVELOPE_MEMORY: usize = 2048;

#[derive(Default)]
pub struct SocketMode {
    seen: HashSet<String>,
    order: VecDeque<String>,
}

pub struct Connection {
    ready: bool,
}

pub enum Outcome {
    Ignored,
    Hello,
    Envelope { value: Value, acked: bool },
    Refresh,
    Fatal(&'static str),
    Closed,
}

pub enum OpenFailure {
    Fatal(String),
    Retry { hint_ms: u64 },
}

impl SocketMode {
    pub fn new_connection(&self) -> Connection {
        Connection { ready: false }
    }

    /// An overlapping refresh uses a new Connection and retains the same deduplication window.
    pub fn receive(
        &mut self,
        connection: &mut Connection,
        text: &str,
        ack: impl FnOnce(&str) -> Result<(), Error>,
    ) -> Outcome {
        let Ok(value) = serde_json::from_str::<Value>(text) else {
            return Outcome::Ignored;
        };
        match value["type"].as_str() {
            Some("hello") if !connection.ready => {
                connection.ready = true;
                return Outcome::Hello;
            }
            Some("hello") => return Outcome::Ignored,
            Some("disconnect") => {
                return match value["reason"].as_str() {
                    Some("refresh_requested" | "warning") => Outcome::Refresh,
                    Some("link_disabled") => Outcome::Fatal("link_disabled"),
                    _ => Outcome::Closed,
                }
            }
            _ if !connection.ready => return Outcome::Ignored,
            _ => {}
        }
        let Some(id) = value["envelope_id"].as_str().filter(|id| {
            (1..=128).contains(&id.len())
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
        }) else {
            return Outcome::Ignored;
        };
        // The ID grammar excludes JSON quoting and escape characters.
        let acked = ack(&format!("{{\"envelope_id\":\"{id}\"}}")).is_ok();
        if !self.seen.insert(id.to_owned()) {
            return Outcome::Ignored;
        }
        self.order.push_back(id.to_owned());
        if self.order.len() > ENVELOPE_MEMORY {
            if let Some(oldest) = self.order.pop_front() {
                self.seen.remove(&oldest);
            }
        }
        Outcome::Envelope { value, acked }
    }

    pub fn open_failure(error: &ApiError) -> OpenFailure {
        let code = error.code.as_ref().and_then(Value::as_str);
        if error.kind == Kind::Unauthorized
            || matches!(
                code,
                Some(
                    "invalid_auth"
                        | "account_inactive"
                        | "token_revoked"
                        | "not_authed"
                        | "token_expired"
                        | "invalid_token"
                        | "not_allowed_token_type"
                        | "missing_scope"
                        | "link_disabled"
                )
            )
        {
            OpenFailure::Fatal(code.unwrap_or("unauthorized").to_owned())
        } else {
            OpenFailure::Retry {
                hint_ms: error.retry_after_ms.unwrap_or(0),
            }
        }
    }

    pub fn backoff(attempt: u32, hint_ms: u64, random: f64) -> u64 {
        let base = (1000u64 << attempt.saturating_sub(1).min(16)).min(60_000);
        let delay = (base as f64 * (0.75 + random.clamp(0., 1.) * 0.5)).round() as u64;
        delay.max(hint_ms)
    }
}
