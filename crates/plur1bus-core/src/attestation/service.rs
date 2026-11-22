//! The attestation service (TypeScript: `attestation/service.ts`): one attempt, one nonce, one answer. Whatever the helper
//! says, the nonce is spent; an echoed nonce of an earlier attempt is a replay, any other mismatch is a mismatch, and an
//! answer outside the issue window (with 2 s of skew) is a mismatch too.
use super::helper::{run_helper, HelperHost, HelperOutcome, HelperSpec};
use serde_json::{json, Map, Value};
use std::collections::{HashSet, VecDeque};

/// A confirmation is asked for at most this long (the helper's dialog and the core's deadline).
pub const MAX_ATTEST_TTL_MS: f64 = 60_000.0;
const DEFAULT_TTL_MS: f64 = 60_000.0;
const PROBE_DEADLINE_MS: f64 = 5_000.0;
/// The helper's clock and the core's are the same machine's; this much skew is tolerated, no more.
const SKEW_MS: f64 = 2_000.0;
const CONSUMED_KEPT: usize = 4096;

/// Why an attestation did not happen (`AttestFailure`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttestFailure {
    /// The person cancelled the dialog.
    Cancelled,
    /// No answer in time.
    Timeout,
    /// No helper, or one that failed its pin.
    Unavailable,
    /// The helper broke or answered something unreadable.
    Failed,
    /// The answer echoed the nonce of an earlier attempt.
    Replay,
    /// The answer belongs to another request, or to another time.
    Mismatch,
}

impl AttestFailure {
    /// The TypeScript spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            AttestFailure::Cancelled => "cancelled",
            AttestFailure::Timeout => "timeout",
            AttestFailure::Unavailable => "unavailable",
            AttestFailure::Failed => "failed",
            AttestFailure::Replay => "replay",
            AttestFailure::Mismatch => "mismatch",
        }
    }
}

/// `AttestResult`.
#[derive(Clone, Debug, PartialEq)]
pub enum AttestResult {
    /// The OS confirmed with `method` at `at`.
    Confirmed {
        /// `touch-id`, `windows-hello`, `polkit`, ...
        method: String,
        /// The helper's time of the confirmation.
        at: f64,
    },
    /// No confirmation.
    Failed(AttestFailure),
}

impl AttestResult {
    /// The TypeScript object.
    pub fn json(&self) -> Value {
        match self {
            AttestResult::Confirmed { method, at } => {
                // A whole number prints without a fraction in JavaScript; keep it an integer in JSON as well.
                let at = if at.fract() == 0.0 && at.abs() < 9e15 {
                    json!(*at as i64)
                } else {
                    json!(at)
                };
                json!({ "ok": true, "method": method, "at": at })
            }
            AttestResult::Failed(r) => json!({ "ok": false, "reason": r.as_str() }),
        }
    }
}

/// `AttestInput`: what the core asks the person to confirm.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AttestInput {
    /// Hash of the concrete approval: the one thing this confirmation covers.
    pub action_hash: String,
    /// The sentence shown in the OS dialog.
    pub text: String,
    /// For the audit line only.
    pub person: Option<String>,
    /// For the audit line only.
    pub request_id: Option<String>,
    /// For the audit line only.
    pub agent_id: Option<String>,
    /// For the audit line only.
    pub scope: Option<String>,
    /// Capped at [`MAX_ATTEST_TTL_MS`].
    pub ttl_ms: Option<f64>,
}

/// `AttestProbe`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AttestProbe {
    /// A confirmation could be asked for, with this method.
    Available(String),
    /// None could.
    Unavailable,
}

/// The audit writer the service records through (the policy audit writer in production). An error on the request line
/// means the attempt is not made: never ask unrecorded.
pub trait AttestAudit {
    /// One line.
    fn record(&mut self, action: &str, fields: &Value) -> Result<(), String>;
}

impl AttestAudit for crate::policy::audit::PolicyAudit<'_> {
    fn record(&mut self, action: &str, fields: &Value) -> Result<(), String> {
        crate::policy::audit::PolicyAudit::record(self, action, fields)
    }
}

/// `Math.min(Math.max(1, v), MAX)` with JavaScript's NaN.
fn clamp_ttl(v: f64) -> f64 {
    if v.is_nan() {
        return f64::NAN;
    }
    v.clamp(1.0, MAX_ATTEST_TTL_MS)
}

/// `^[a-z0-9][a-z0-9-]{0,31}$`.
fn method_ok(m: &str) -> bool {
    let b = m.as_bytes();
    let first = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    !b.is_empty() && b.len() <= 32 && first(&b[0]) && b.iter().all(|c| first(c) || *c == b'-')
}

/// `createAttestationService`.
pub struct AttestationService<'a> {
    helper: Option<HelperSpec>,
    host: &'a dyn HelperHost,
    audit: Option<&'a mut dyn AttestAudit>,
    now: &'a dyn Fn() -> f64,
    new_nonce: &'a mut dyn FnMut() -> String,
    base_ttl: f64,
    issued: HashSet<String>,
    consumed: VecDeque<String>,
}

impl<'a> AttestationService<'a> {
    /// `helper: None` is no helper (container mode, no graphical session): every attempt is `unavailable`.
    pub fn new(
        helper: Option<HelperSpec>,
        host: &'a dyn HelperHost,
        audit: Option<&'a mut dyn AttestAudit>,
        now: &'a dyn Fn() -> f64,
        new_nonce: &'a mut dyn FnMut() -> String,
        ttl_ms: Option<f64>,
    ) -> Self {
        AttestationService {
            helper,
            host,
            audit,
            now,
            new_nonce,
            base_ttl: clamp_ttl(ttl_ms.unwrap_or(DEFAULT_TTL_MS)),
            issued: HashSet::new(),
            consumed: VecDeque::new(),
        }
    }

    fn consume(&mut self, nonce: &str) {
        self.issued.remove(nonce);
        self.consumed.push_back(nonce.to_owned());
        if self.consumed.len() > CONSUMED_KEPT {
            self.consumed.pop_front();
        }
    }

    fn result(
        &mut self,
        fields: &Map<String, Value>,
        r: AttestResult,
        method: Option<&str>,
        why: Option<&str>,
    ) -> AttestResult {
        let outcome = match &r {
            AttestResult::Confirmed { .. } => "confirmed",
            AttestResult::Failed(f) => f.as_str(),
        };
        let mut f = fields.clone();
        f.insert("attestationOutcome".into(), json!(outcome));
        if let Some(m) = method {
            f.insert("method".into(), json!(m));
        }
        if let Some(w) = why {
            f.insert("reason".into(), json!(w));
        }
        if let Some(a) = self.audit.as_mut() {
            // The outcome stands whether or not the result line was written.
            let _ = a.record("attestation.result", &Value::Object(f));
        }
        r
    }

    /// `attest(input)`: asks the OS for a fresh confirmation. Never fails otherwise.
    pub fn attest(&mut self, input: &AttestInput) -> AttestResult {
        let mut fields = Map::new();
        let opt = [
            ("person", &input.person),
            ("requestId", &input.request_id),
            ("agentId", &input.agent_id),
            ("scope", &input.scope),
        ];
        for (k, v) in opt {
            if let Some(v) = v.as_ref().filter(|s| !s.is_empty()) {
                fields.insert(k.into(), json!(v));
            }
        }
        fields.insert("actionHash".into(), json!(input.action_hash));
        let fail = |s: &mut Self, reason: AttestFailure, why: Option<&str>| {
            s.result(&fields, AttestResult::Failed(reason), None, why)
        };

        let Some(helper) = self.helper.clone() else {
            return fail(self, AttestFailure::Unavailable, None);
        };
        let nonce = (self.new_nonce)();
        let ttl = clamp_ttl(input.ttl_ms.unwrap_or(self.base_ttl));
        let issued_at = (self.now)();
        if let Some(a) = self.audit.as_mut() {
            if a.record("attestation.requested", &Value::Object(fields.clone()))
                .is_err()
            {
                return AttestResult::Failed(AttestFailure::Failed); // never ask unrecorded
            }
        }
        self.issued.insert(nonce.clone());
        let ttl_json = if ttl.is_nan() {
            Value::Null
        } else {
            json!(ttl)
        };
        let request = json!({ "v": 1, "nonce": nonce, "actionHash": input.action_hash, "text": input.text, "ttlMs": ttl_json });
        let out = run_helper(self.host, &helper, "--attest", Some(&request), ttl);
        // Whatever the helper says, this nonce is spent: one attempt, one answer.
        self.consume(&nonce);
        let v = match out {
            HelperOutcome::Timeout => return fail(self, AttestFailure::Timeout, None),
            HelperOutcome::Missing => return fail(self, AttestFailure::Unavailable, None),
            // A helper that fails its pin is no helper; the reason is for the audit log.
            HelperOutcome::Refused(reason) => {
                return fail(self, AttestFailure::Unavailable, Some(reason))
            }
            HelperOutcome::Broken => return fail(self, AttestFailure::Failed, None),
            HelperOutcome::Reply(v) => v,
        };
        if v.get("v").and_then(Value::as_f64) != Some(1.0) {
            return fail(self, AttestFailure::Failed, None);
        }
        let echoed = v.get("nonce");
        if let Some(e) = echoed.and_then(Value::as_str) {
            if e != nonce {
                let replay = self.consumed.iter().any(|c| c == e);
                return fail(
                    self,
                    if replay {
                        AttestFailure::Replay
                    } else {
                        AttestFailure::Mismatch
                    },
                    None,
                );
            }
        }
        if v.get("ok") != Some(&Value::Bool(true)) {
            let r = match v.get("reason").and_then(Value::as_str) {
                Some("cancelled") => AttestFailure::Cancelled,
                Some("unavailable") => AttestFailure::Unavailable,
                Some("timeout") => AttestFailure::Timeout,
                _ => AttestFailure::Failed,
            };
            return fail(self, r, None);
        }
        if echoed.and_then(Value::as_str) != Some(nonce.as_str()) {
            return fail(self, AttestFailure::Mismatch, None);
        }
        if v.get("actionHash").and_then(Value::as_str) != Some(input.action_hash.as_str()) {
            return fail(self, AttestFailure::Mismatch, None);
        }
        let Some(method) = v
            .get("method")
            .and_then(Value::as_str)
            .filter(|m| method_ok(m))
            .map(str::to_owned)
        else {
            return fail(self, AttestFailure::Failed, None);
        };
        let at = v
            .get("at")
            .and_then(Value::as_f64)
            .filter(|a| a.is_finite());
        let Some(at) = at.filter(|a| *a >= issued_at - SKEW_MS && *a <= (self.now)() + SKEW_MS)
        else {
            return fail(self, AttestFailure::Mismatch, None);
        };
        self.result(
            &fields,
            AttestResult::Confirmed {
                method: method.clone(),
                at,
            },
            Some(&method),
            None,
        )
    }

    /// `probe()`: whether a confirmation could be asked for, without showing any dialog.
    pub fn probe(&self) -> AttestProbe {
        let Some(helper) = self.helper.as_ref() else {
            return AttestProbe::Unavailable;
        };
        match run_helper(self.host, helper, "--probe", None, PROBE_DEADLINE_MS) {
            HelperOutcome::Reply(v)
                if v.get("v").and_then(Value::as_f64) == Some(1.0)
                    && v.get("available") == Some(&Value::Bool(true)) =>
            {
                match v
                    .get("method")
                    .and_then(Value::as_str)
                    .filter(|m| method_ok(m))
                {
                    Some(m) => AttestProbe::Available(m.to_owned()),
                    None => AttestProbe::Unavailable,
                }
            }
            _ => AttestProbe::Unavailable,
        }
    }

    /// Nonces issued and not yet answered (zero between attempts).
    pub fn pending(&self) -> usize {
        self.issued.len()
    }
}
