//! `plur1bus-attest`: the native half of OS-backed attestation (issue #192).
//!
//! The core starts this binary as a child process for ONE approval, writes one JSON request line to its stdin and reads one JSON
//! reply line from its stdout (`protocol`). The helper asks the operating system for a fresh confirmation of the person at the
//! machine (`platform`): Touch ID or the account password on macOS, Windows Hello or the UAC consent prompt on Windows, polkit on
//! Linux. It reports what the OS said and nothing more; binding to the approval (nonce, action hash, lifetime, single use) is
//! checked by the core, which never takes a client's word for it.
pub mod mapping;
pub mod platform;
pub mod protocol;

use platform::Platform;
use protocol::{error_line, parse_request, probe_line, reply_line, Outcome};
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `--probe`: whether a confirmation could be asked for here. Shows no dialog.
pub fn run_probe(platform: &dyn Platform) -> String {
    probe_line(&platform.probe())
}

/// `--attest`: one request line in, one reply line out.
pub fn run_attest(platform: &dyn Platform, input: &str) -> String {
    let req = match parse_request(input) {
        Ok(r) => r,
        Err(_) => return error_line(),
    };
    // A platform that is not usable here must say so before it opens anything.
    let outcome = match platform.probe() {
        protocol::Probe::Unavailable { .. } => Outcome::Unavailable,
        protocol::Probe::Available { .. } => platform.confirm(&req.text, req.ttl),
    };
    reply_line(&req, &outcome, now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::Probe;
    use serde_json::Value;
    use std::sync::Mutex;
    use std::time::Duration;

    struct Fake {
        probe: Probe,
        outcome: Outcome,
        asked: Mutex<Vec<(String, Duration)>>,
    }
    impl Platform for Fake {
        fn probe(&self) -> Probe {
            self.probe.clone()
        }
        fn confirm(&self, text: &str, ttl: Duration) -> Outcome {
            self.asked.lock().unwrap().push((text.to_string(), ttl));
            self.outcome.clone()
        }
    }
    fn fake(probe: Probe, outcome: Outcome) -> Fake {
        Fake {
            probe,
            outcome,
            asked: Mutex::new(vec![]),
        }
    }
    const REQ: &str = r#"{"v":1,"nonce":"n1","actionHash":"abababababababababababababababababababababababababababababababab","text":"Allow agent bernd\nto use shell.exec","ttlMs":5000}"#;

    #[test]
    fn asks_the_platform_with_the_cleaned_text_and_the_lifetime_and_reports_the_method() {
        let f = fake(
            Probe::Available {
                method: "touch-id".into(),
            },
            Outcome::Confirmed {
                method: "touch-id".into(),
            },
        );
        let v: Value = serde_json::from_str(&run_attest(&f, REQ)).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["method"], "touch-id");
        assert_eq!(v["nonce"], "n1");
        assert!(v["at"].as_u64().unwrap() > 1_700_000_000_000);
        assert_eq!(
            *f.asked.lock().unwrap(),
            vec![(
                "Allow agent bernd to use shell.exec".to_string(),
                Duration::from_secs(5)
            )]
        );
    }

    #[test]
    fn an_unusable_platform_opens_nothing() {
        let f = fake(
            Probe::Unavailable {
                reason: "no-polkit-agent".into(),
            },
            Outcome::Confirmed { method: "x".into() },
        );
        let v: Value = serde_json::from_str(&run_attest(&f, REQ)).unwrap();
        assert_eq!(
            (v["ok"].clone(), v["reason"].clone()),
            (Value::Bool(false), Value::String("unavailable".into()))
        );
        assert!(f.asked.lock().unwrap().is_empty());
    }

    #[test]
    fn a_request_it_cannot_parse_is_a_failure_and_opens_nothing() {
        let f = fake(
            Probe::Available {
                method: "touch-id".into(),
            },
            Outcome::Confirmed {
                method: "touch-id".into(),
            },
        );
        let v: Value = serde_json::from_str(&run_attest(&f, "garbage")).unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["reason"], "failed");
        assert!(f.asked.lock().unwrap().is_empty());
    }

    #[test]
    fn cancel_and_timeout_pass_through() {
        for (o, r) in [
            (Outcome::Cancelled, "cancelled"),
            (Outcome::TimedOut, "timeout"),
        ] {
            let f = fake(
                Probe::Available {
                    method: "touch-id".into(),
                },
                o,
            );
            let v: Value = serde_json::from_str(&run_attest(&f, REQ)).unwrap();
            assert_eq!(v["reason"], r);
        }
    }
}
