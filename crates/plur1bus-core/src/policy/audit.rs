//! D109 §9 / D9: the policy audit trail (TypeScript: `policy/audit.ts`). One line per request, decision, grant change,
//! denial and integrity failure, written through the existing [`AuditSink`] (the hash-chained audit file is one; this
//! module adds no second log).
//!
//! What a line may carry is an allowlist, not a filter: a member that is not listed here is dropped, so file contents, tool
//! results, arguments, environment values and diffs cannot get in by accident. Every string goes through the D111 redactor
//! and is bounded; a payload is recorded as hash and size only ([`hash_and_size`]). [`PolicyAudit::record`] fails when the
//! sink cannot record, and a caller that must not act unrecorded lets that propagate.
use crate::js::{is_js_space, is_word_unit};
use crate::logs::redact::TextRedactor;
use crate::metrics::registry::js_number_to_string;
use crate::rbac::audit::{AuditEvent, AuditSink};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

/// At most this many targets are listed; `targetsTotal` counts the rest.
pub const MAX_AUDIT_TARGETS: usize = 20;
const MAX_STRING: usize = 256;
const MAX_PRE_REDACT: usize = 4096;
const MAX_REJECTED: usize = 20;
const MAX_ID: usize = 128;

const STRING_KEYS: [&str; 29] = [
    "person",
    "agentId",
    "subjectKind",
    "sessionId",
    "taskId",
    "jobId",
    "tool",
    "capability",
    "effect",
    "risk",
    "outcome",
    "via",
    "rule",
    "reason",
    "grantId",
    "grantScope",
    "matchKind",
    "requestId",
    "actionHash",
    "decision",
    "scope",
    "by",
    "resultCode",
    "payloadHash",
    "failure",
    "method",
    "attestationOutcome",
    "attestedVia",
    "origin",
];
const NUMBER_KEYS: [&str; 8] = [
    "surface",
    "decisionSurface",
    "argsBytes",
    "durationMs",
    "resultBytes",
    "payloadBytes",
    "brokenAt",
    "expiresAt",
];
const FLAG_KEYS: [&str; 10] = [
    "outsideRoots",
    "denyListHit",
    "privileged",
    "irreversible",
    "batch",
    "shellAllowlisted",
    "sandboxed",
    "secretSlotDeclared",
    "publishPublic",
    "systemTree",
];
const REJECTIONS: [&str; 5] = [
    "unknown",
    "revoked",
    "not-delegable",
    "task-mismatch",
    "foreign-person",
];

/// `hashAndSize`: the SHA-256 (hex) and the UTF-8 size of a payload, the only form a diff or payload is recorded in.
pub fn hash_and_size(text: &str) -> (String, usize) {
    let digest = Sha256::digest(text.as_bytes());
    (
        digest.iter().map(|b| format!("{b:02x}")).collect(),
        text.len(),
    )
}

/// `text.slice(0, n)` over UTF-16 units. A cut through a surrogate pair keeps neither half (JavaScript would keep a lone
/// high surrogate, which a Rust string cannot hold).
fn slice_units(text: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in text.char_indices() {
        units += c.len_utf16();
        if units > n {
            return &text[..i];
        }
    }
    text
}

fn is_class(u: u16) -> bool {
    is_word_unit(u) || matches!(u, 0x2e | 0x7e | 0x2b | 0x2f | 0x3d | 0x2d) // . ~ + / = -
}

/// `text.replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "[REDACTED:pattern]")`, over UTF-16 units (`\b` and the
/// case folding are ASCII-only without the `u` flag; `\s` is JavaScript's).
pub fn mask_auth_scheme(text: &str) -> String {
    let u: Vec<u16> = text.encode_utf16().collect();
    let mut out: Vec<u16> = Vec::with_capacity(u.len());
    let lower = |x: u16| {
        if (0x41..=0x5a).contains(&x) {
            x + 0x20
        } else {
            x
        }
    };
    let mut i = 0;
    while i < u.len() {
        let boundary = crate::js::is_boundary(&u, i);
        let mut matched = None;
        if boundary {
            for word in ["bearer", "basic"] {
                let w: Vec<u16> = word.encode_utf16().collect();
                if u.len() >= i + w.len()
                    && u[i..i + w.len()]
                        .iter()
                        .zip(&w)
                        .all(|(a, b)| lower(*a) == *b)
                {
                    let mut j = i + w.len();
                    let spaces = j;
                    while j < u.len() && char::from_u32(u32::from(u[j])).is_some_and(is_js_space) {
                        j += 1;
                    }
                    if j == spaces {
                        continue;
                    }
                    let start = j;
                    while j < u.len() && is_class(u[j]) {
                        j += 1;
                    }
                    if j - start >= 8 {
                        matched = Some(j);
                        break;
                    }
                }
            }
        }
        match matched {
            Some(end) => {
                out.extend("[REDACTED:pattern]".encode_utf16());
                i = end;
            }
            None => {
                out.push(u[i]);
                i += 1;
            }
        }
    }
    String::from_utf16_lossy(&out)
}

/// `${v}` of a template literal for the members `targetOf` reads (`?? "-"` already applied by the caller).
fn template(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => js_number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_owned(),
        Value::Array(a) => a
            .iter()
            .map(|x| {
                if x.is_null() {
                    String::new()
                } else {
                    template(x)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

fn or_dash(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => "-".to_owned(),
        Some(x) => template(x),
    }
}

/// `targetOf(action, fields)`.
fn target_of(action: &str, f: &Value) -> String {
    if action.starts_with("grant.") {
        return format!("grant:{}", or_dash(f.get("grantId")));
    }
    if action.starts_with("approval.") || action.starts_with("attestation.") {
        return format!("approval:{}", or_dash(f.get("requestId")));
    }
    if action.starts_with("approvals.") {
        return "approvals".to_owned();
    }
    let tool = match f.get("tool") {
        None | Some(Value::Null) => f.get("capability"),
        some => some,
    };
    format!("tool:{}", or_dash(tool))
}

/// `createPolicyAudit({ sink, clock, host, redactor })`.
pub struct PolicyAudit<'a> {
    sink: &'a mut dyn AuditSink,
    clock: &'a dyn Fn() -> i64,
    host: String,
    redactor: &'a dyn TextRedactor,
}

impl<'a> PolicyAudit<'a> {
    /// A writer over `sink`, stamping `host` (the TypeScript default is `os.hostname()`; the caller passes it).
    pub fn new(
        sink: &'a mut dyn AuditSink,
        clock: &'a dyn Fn() -> i64,
        host: &str,
        redactor: &'a dyn TextRedactor,
    ) -> Self {
        PolicyAudit {
            sink,
            clock,
            host: host.to_owned(),
            redactor,
        }
    }

    /// The shared redactor's `key` rule turns `Authorization: Bearer <token>` into `Authorization: [..] <token>` and leaves
    /// the token; masking the scheme and credential first closes that gap here without touching the shared rules.
    fn text(&self, v: &str) -> String {
        let head = slice_units(v, MAX_PRE_REDACT);
        let redacted = self.redactor.text(&mask_auth_scheme(head));
        slice_units(&redacted, MAX_STRING).to_owned()
    }

    fn detail_of(&self, f: &Value) -> Vec<(String, Value)> {
        let mut d: Vec<(String, Value)> = Vec::new();
        for k in STRING_KEYS {
            if let Some(s) = f.get(k).and_then(Value::as_str) {
                d.push((k.to_owned(), json!(self.text(s))));
            }
        }
        for k in NUMBER_KEYS {
            if let Some(n) = f.get(k).filter(|v| v.is_number()) {
                if n.as_f64().is_some_and(f64::is_finite) {
                    d.push((k.to_owned(), n.clone()));
                }
            }
        }
        if let Some(Value::Array(t)) = f.get("targets") {
            let all: Vec<&str> = t.iter().filter_map(Value::as_str).collect();
            let listed: Vec<Value> = all
                .iter()
                .take(MAX_AUDIT_TARGETS)
                .map(|s| json!(self.text(s)))
                .collect();
            d.push(("targets".to_owned(), Value::Array(listed)));
            if all.len() > MAX_AUDIT_TARGETS {
                d.push(("targetsTotal".to_owned(), json!(all.len())));
            }
        }
        if let Some(flags) = f.get("flags").filter(|v| v.is_object() || v.is_array()) {
            let mut m = Map::new();
            for k in FLAG_KEYS {
                if let Some(b) = flags.get(k).and_then(Value::as_bool) {
                    m.insert(k.to_owned(), json!(b));
                }
            }
            if !m.is_empty() {
                d.push(("flags".to_owned(), Value::Object(m)));
            }
        }
        if let Some(Value::Array(rejected)) = f.get("rejected") {
            let mut rows = Vec::new();
            for r in rejected {
                let (id, reason) = (
                    r.get("id").and_then(Value::as_str),
                    r.get("reason").and_then(Value::as_str),
                );
                if let (Some(id), Some(reason)) = (id, reason) {
                    if REJECTIONS.contains(&reason) {
                        rows.push(
                            json!({ "id": slice_units(&self.text(id), MAX_ID), "reason": reason }),
                        );
                    }
                }
                if rows.len() >= MAX_REJECTED {
                    break;
                }
            }
            d.push(("rejected".to_owned(), Value::Array(rows)));
        }
        d
    }

    /// The event `record` would append (exposed so the flip and the tests see exactly what goes to the sink).
    pub fn event(&self, action: &str, fields: &Value) -> AuditEvent {
        let pick = |k: &str| {
            fields
                .get(k)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
        };
        let user = match (pick("person"), pick("by")) {
            (Some(p), _) => self.text(p),
            (None, Some(b)) => self.text(b),
            (None, None) => "core".to_owned(),
        };
        AuditEvent {
            at: (self.clock)(),
            user,
            host: self.host.clone(),
            action: action.to_owned(),
            target: self.text(&target_of(action, fields)),
            detail: self.detail_of(fields),
        }
    }

    /// `record(action, fields)`: one audit line; `Err` when the sink could not record it.
    pub fn record(&mut self, action: &str, fields: &Value) -> Result<(), String> {
        let event = self.event(action, fields);
        self.sink.append(&event)
    }
}
