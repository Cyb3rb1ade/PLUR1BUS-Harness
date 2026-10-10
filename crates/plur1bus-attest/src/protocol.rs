//! The helper's wire protocol: one JSON line in on stdin, one JSON line out on stdout, then the process exits.
//!
//! Request  `{"v":1,"nonce":"…","actionHash":"<64 hex>","text":"…","ttlMs":60000}`
//! Reply    `{"v":1,"ok":true,"method":"touch-id","at":1790000000000,"nonce":"…","actionHash":"…"}`
//!          `{"v":1,"ok":false,"reason":"cancelled|timeout|unavailable|failed","nonce":"…"}`
//! Probe    `{"v":1,"available":true,"method":"touch-id"}` / `{"v":1,"available":false,"reason":"…"}`
//!
//! The helper echoes the nonce and the action hash; the core accepts an answer only when both are the ones it issued (and
//! only once). The helper never decides anything: it reports what the operating system said.
use serde::Deserialize;
use serde_json::json;
use std::time::Duration;

/// A confirmation is asked for at most this long. The core enforces the same bound.
pub const MAX_TTL_MS: u64 = 60_000;
const MAX_TEXT_CHARS: usize = 300;
const MAX_NONCE_BYTES: usize = 128;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRequest {
    v: u32,
    nonce: String,
    #[serde(rename = "actionHash")]
    action_hash: String,
    text: String,
    #[serde(rename = "ttlMs")]
    ttl_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub nonce: String,
    pub action_hash: String,
    /// What the OS dialog says: control characters removed, bounded.
    pub text: String,
    pub ttl: Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolError {
    Malformed,
    Version,
    BadNonce,
    BadHash,
    BadTtl,
}

/// What the operating system said.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Confirmed { method: String },
    Cancelled,
    TimedOut,
    Unavailable,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Probe {
    Available { method: String },
    Unavailable { reason: String },
}

pub fn parse_request(line: &str) -> Result<Request, ProtocolError> {
    let raw: RawRequest =
        serde_json::from_str(line.trim()).map_err(|_| ProtocolError::Malformed)?;
    if raw.v != 1 {
        return Err(ProtocolError::Version);
    }
    if raw.nonce.is_empty()
        || raw.nonce.len() > MAX_NONCE_BYTES
        || !raw.nonce.bytes().all(|b| b.is_ascii_graphic())
    {
        return Err(ProtocolError::BadNonce);
    }
    if raw.action_hash.len() != 64
        || !raw
            .action_hash
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(ProtocolError::BadHash);
    }
    if raw.ttl_ms == 0 || raw.ttl_ms > MAX_TTL_MS {
        return Err(ProtocolError::BadTtl);
    }
    Ok(Request {
        nonce: raw.nonce,
        action_hash: raw.action_hash,
        text: clean_text(&raw.text),
        ttl: Duration::from_millis(raw.ttl_ms),
    })
}

/// The dialog text is shown by the OS; it must not carry control characters (line breaks, escapes) or grow without bound.
pub fn clean_text(text: &str) -> String {
    let flat: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let squeezed = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    squeezed.chars().take(MAX_TEXT_CHARS).collect()
}

fn reason_of(outcome: &Outcome) -> &'static str {
    match outcome {
        Outcome::Cancelled => "cancelled",
        Outcome::TimedOut => "timeout",
        Outcome::Unavailable => "unavailable",
        Outcome::Confirmed { .. } | Outcome::Failed => "failed",
    }
}

/// The reply line (no trailing newline) for a well-formed request.
pub fn reply_line(req: &Request, outcome: &Outcome, at_ms: u64) -> String {
    match outcome {
        Outcome::Confirmed { method } => {
            json!({ "v": 1, "ok": true, "method": method, "at": at_ms, "nonce": req.nonce, "actionHash": req.action_hash }).to_string()
        }
        other => json!({ "v": 1, "ok": false, "reason": reason_of(other), "nonce": req.nonce }).to_string(),
    }
}

/// The reply to a request that could not be parsed: no nonce to echo, so the core can only call it failed.
pub fn error_line() -> String {
    json!({ "v": 1, "ok": false, "reason": "failed" }).to_string()
}

pub fn probe_line(probe: &Probe) -> String {
    match probe {
        Probe::Available { method } => {
            json!({ "v": 1, "available": true, "method": method }).to_string()
        }
        Probe::Unavailable { reason } => {
            json!({ "v": 1, "available": false, "reason": reason }).to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const HASH: &str = "abababababababababababababababababababababababababababababababab";
    fn line(extra: &str) -> String {
        format!(
            r#"{{"v":1,"nonce":"n-1","actionHash":"{HASH}","text":"Allow agent bernd","ttlMs":60000{extra}}}"#
        )
    }

    #[test]
    fn parses_a_well_formed_request() {
        let r = parse_request(&line("")).unwrap();
        assert_eq!(r.nonce, "n-1");
        assert_eq!(r.action_hash, HASH);
        assert_eq!(r.text, "Allow agent bernd");
        assert_eq!(r.ttl, Duration::from_secs(60));
    }

    #[test]
    fn refuses_what_it_does_not_understand() {
        assert_eq!(parse_request("not json"), Err(ProtocolError::Malformed));
        assert_eq!(
            parse_request(&line(r#","extra":1"#)),
            Err(ProtocolError::Malformed)
        );
        assert_eq!(
            parse_request(&line("").replace(r#""v":1"#, r#""v":2"#)),
            Err(ProtocolError::Version)
        );
        assert_eq!(
            parse_request(&line("").replace("n-1", "")),
            Err(ProtocolError::BadNonce)
        );
        assert_eq!(
            parse_request(&line("").replace("n-1", "a b")),
            Err(ProtocolError::BadNonce)
        );
        assert_eq!(
            parse_request(&line("").replace(HASH, "abc")),
            Err(ProtocolError::BadHash)
        );
        assert_eq!(
            parse_request(&line("").replace(HASH, &"A".repeat(64))),
            Err(ProtocolError::BadHash)
        );
        assert_eq!(
            parse_request(&line("").replace("60000", "0")),
            Err(ProtocolError::BadTtl)
        );
        assert_eq!(
            parse_request(&line("").replace("60000", "60001")),
            Err(ProtocolError::BadTtl)
        );
    }

    #[test]
    fn dialog_text_has_no_control_characters_and_is_bounded() {
        assert_eq!(clean_text("a\n\tb\u{1b}[31mc"), "a b [31mc");
        assert_eq!(clean_text(&"x".repeat(1000)).chars().count(), 300);
    }

    #[test]
    fn a_confirmation_echoes_nonce_and_action_hash() {
        let req = parse_request(&line("")).unwrap();
        let v: Value = serde_json::from_str(&reply_line(
            &req,
            &Outcome::Confirmed {
                method: "touch-id".into(),
            },
            42,
        ))
        .unwrap();
        assert_eq!(
            v,
            json!({ "v": 1, "ok": true, "method": "touch-id", "at": 42, "nonce": "n-1", "actionHash": HASH })
        );
    }

    #[test]
    fn every_other_outcome_is_a_refusal_with_the_nonce_and_never_a_method() {
        let req = parse_request(&line("")).unwrap();
        for (o, reason) in [
            (Outcome::Cancelled, "cancelled"),
            (Outcome::TimedOut, "timeout"),
            (Outcome::Unavailable, "unavailable"),
            (Outcome::Failed, "failed"),
        ] {
            let v: Value = serde_json::from_str(&reply_line(&req, &o, 1)).unwrap();
            assert_eq!(
                v,
                json!({ "v": 1, "ok": false, "reason": reason, "nonce": "n-1" })
            );
        }
    }

    #[test]
    fn probe_lines() {
        let a: Value = serde_json::from_str(&probe_line(&Probe::Available {
            method: "polkit".into(),
        }))
        .unwrap();
        assert_eq!(a, json!({ "v": 1, "available": true, "method": "polkit" }));
        let u: Value = serde_json::from_str(&probe_line(&Probe::Unavailable {
            reason: "no-polkit-agent".into(),
        }))
        .unwrap();
        assert_eq!(
            u,
            json!({ "v": 1, "available": false, "reason": "no-polkit-agent" })
        );
    }
}
